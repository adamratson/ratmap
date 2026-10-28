// Command normalize-parking normalizes OSM `amenity=parking` before tippecanoe.
//
//	normalize-parking IN.geojsonl OUT.geojsonl
//	normalize-parking --self-test
//
// Car parks, which on a hill map are trailheads: where a walk starts is usually where the
// car is left. The Protomaps basemap carries them, but not the ones that matter most —
// over the central Lake District it held 79 of 81 named public car parks and only 51 of
// 241 unnamed ones, and of the unnamed areas under 500 m² (laybys, small trailhead lots)
// just 25 of 181 (measured against the published england-north-west basemap's z15 tiles,
// 2026-10-28). So, like landmarks, this is its own artifact.
//
// This does what still needs doing before tippecanoe:
//
//   - Drop car parks a walker cannot use: `access=private`, `no`, permit holders,
//     residents, staff (see open below), and lock-up garages tagged as car parks
//     (`parking=garage_boxes` and the like). Customers-only car parks — pubs, hotels,
//     attractions — are kept, flagged `customers`, and placed after the rest in the app.
//   - Reduce areas to a point (osmpoint.Represent). 599 of the Lake District's 645 car
//     parks are closed ways, and an icon on a polygon would repeat in every tile it
//     touches.
//   - Keep each area's size, in square metres (0 for a node). The app ranks by it when
//     symbols collide, so at z13 the big lot at the head of a valley wins over a layby.
//   - Deduplicate by (@type, @id) across concatenated continent extracts, the seam
//     problem normalize-sac documents.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/osmpoint"
	"ratmap/infra/tools/internal/rawjson"
)

// open are the `access` values of a car park anyone may use. Unset is the majority (21,718
// of Scotland's 39,407) and means open; `unknown` says no more than unset does. Anything
// else — private (8,195), no, permit, residents, staff, employees, disabled, delivery and
// the rest of the long tail — restricts it to someone other than a walker.
var open = map[string]bool{
	"":            true,
	"yes":         true,
	"permissive":  true,
	"destination": true,
	"public":      true,
	"unknown":     true,
	"customers":   true,
}

// garages are `parking=` values for lock-ups and sheds tagged as car parks: rows of
// private garages on housing estates, not somewhere to leave a car for the day.
var garages = map[string]bool{
	"garage_boxes": true,
	"garage":       true,
	"carports":     true,
	"sheds":        true,
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-parking IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-parking:", err)
		os.Exit(1)
	}
}

// classify says whether a feature is a car park to draw — and if so, whether only
// customers may use it — or else why it is dropped.
func classify(props map[string]json.RawMessage) (keep, customers bool, dropped string) {
	if amenity, _ := rawjson.String(props["amenity"]); amenity != "parking" {
		return false, false, "unrecognized"
	}
	access, _ := rawjson.String(props["access"])
	if !open[access] {
		return false, false, "restricted"
	}
	if parking, _ := rawjson.String(props["parking"]); garages[parking] {
		return false, false, "garages"
	}
	return true, access == "customers", ""
}

func run(srcPath, destPath string, out io.Writer) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()
	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(dest, 1<<20)
	r := bufio.NewReaderSize(src, 1<<20)

	kept, customers, named, duplicated := 0, 0, 0, 0
	dropped := map[string]int{}
	seen := map[string]bool{}

	fail := func(err error) error {
		dest.Close()
		return err
	}

	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimSpace(bytes.TrimLeft(raw, "\x1e")); len(line) > 0 {
			var f map[string]json.RawMessage
			if err := json.Unmarshal(line, &f); err != nil {
				return fail(fmt.Errorf("%s: line %d: %w", srcPath, n, err))
			}
			// Properties present but not an object are a broken export.
			props := map[string]json.RawMessage{}
			if p, ok := f["properties"]; ok {
				if err := json.Unmarshal(p, &props); err != nil || props == nil {
					return fail(fmt.Errorf("%s: line %d: properties is %s, not an object", srcPath, n, p))
				}
			}
			keep, forCustomers, reason := classify(props)
			if !keep {
				dropped[reason]++
			} else if key, ok := osmpoint.Key(props); ok && seen[key] {
				duplicated++
			} else {
				point, area, err := osmpoint.Represent(f["geometry"])
				if err != nil {
					return fail(fmt.Errorf("%s: line %d: %w", srcPath, n, err))
				}
				if ok {
					seen[key] = true
				}
				w.WriteString(`{"type":"Feature","geometry":{"type":"Point","coordinates":`)
				w.WriteString(point)
				w.WriteString(`},"properties":{`)
				if name, ok := rawjson.String(props["name"]); ok {
					w.WriteString(`"name":`)
					w.Write(osmpoint.JSONString(name))
					w.WriteString(`,`)
					named++
				}
				if forCustomers {
					w.WriteString(`"customers":1,`)
					customers++
				}
				w.WriteString(`"size":`)
				w.WriteString(strconv.FormatFloat(math.Round(area), 'f', 0, 64))
				w.WriteString("}}\n")
				kept++
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return fail(rerr)
		}
	}
	if err := w.Flush(); err != nil {
		return fail(err)
	}
	if err := dest.Close(); err != nil {
		return err
	}
	fmt.Fprintf(out, "  kept %d car parks (%d named, %d customers only); skipped %d with no amenity=parking, %d restricted (private, permit, residents...), %d lock-up garages, %d already seen (continent seams)\n",
		kept, named, customers, dropped["unrecognized"], dropped["restricted"], dropped["garages"], duplicated)
	return nil
}

// selfTest is --self-test: what is kept, flagged and dropped, and an area reduced to its
// centroid with its size. It runs the real normalizer, so its report line is printed too.
func selfTest(out io.Writer) error {
	// 0.001 degrees square at the equator: 12,364 m².
	square := `{"type": "MultiPolygon", "coordinates": [[[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]]}`
	point := `{"type": "Point", "coordinates": [5, 6]}`
	cases := []struct{ props, geometry, want string }{
		{`{"amenity": "parking", "@type": "node", "@id": 1}`, point,
			`{"size": 0, "at": [5, 6]}`},
		{`{"amenity": "parking", "name": "Seathwaite", "fee": "no", "@type": "way", "@id": 2}`, square,
			`{"name": "Seathwaite", "size": 12364, "at": [0.0005, 0.0005]}`},
		{`{"amenity": "parking", "access": "customers", "name": "Old Dungeon Ghyll", "@type": "way", "@id": 3}`, square,
			`{"name": "Old Dungeon Ghyll", "customers": 1, "size": 12364, "at": [0.0005, 0.0005]}`},
		{`{"amenity": "parking", "access": "permissive", "parking": "layby", "@type": "node", "@id": 4}`, point,
			`{"size": 0, "at": [5, 6]}`},
		// Private, a residents' bay, lock-up garages and not a car park at all: dropped.
		{`{"amenity": "parking", "access": "private", "@type": "way", "@id": 5}`, square, ``},
		{`{"amenity": "parking", "access": "residents", "@type": "node", "@id": 6}`, point, ``},
		{`{"amenity": "parking", "parking": "garage_boxes", "@type": "way", "@id": 7}`, square, ``},
		{`{"amenity": "bicycle_parking", "@type": "node", "@id": 8}`, point, ``},
		// The first car park again, from the next continent's extract.
		{`{"amenity": "parking", "@type": "node", "@id": 1}`, point, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-parking-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	src, dest := filepath.Join(dir, "in.geojsonl"), filepath.Join(dir, "out.geojsonl")
	var in strings.Builder
	var expected []any
	for _, c := range cases {
		fmt.Fprintf(&in, `{"type": "Feature", "properties": %s, "geometry": %s}`+"\n", c.props, c.geometry)
		if c.want != "" {
			var v any
			json.Unmarshal([]byte(c.want), &v)
			expected = append(expected, v)
		}
	}
	if err := os.WriteFile(src, []byte(in.String()), 0o644); err != nil {
		return err
	}
	if err := run(src, dest, out); err != nil {
		return err
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		return err
	}
	var outputs []any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var f struct {
			Geometry   struct{ Coordinates any }
			Properties map[string]any
		}
		json.Unmarshal([]byte(line), &f)
		f.Properties["at"] = f.Geometry.Coordinates
		outputs = append(outputs, any(f.Properties))
	}
	if !reflect.DeepEqual(outputs, expected) {
		return fmt.Errorf("FAIL: normalize-parking self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-parking self-test OK (%d cases)\n", len(cases))
	return nil
}
