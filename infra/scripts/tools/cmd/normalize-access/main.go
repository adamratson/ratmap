// Command normalize-access picks out the ways tagged private that a walker may use, before
// tippecanoe.
//
//	normalize-access IN.geojsonl OUT.geojsonl
//	normalize-access --self-test
//
// The route planner reads its network out of the Protomaps basemap (src/routes/router.ts),
// whose `roads` layer carries a way's `access` tag and nothing else about who may use it:
// no `foot`, no `designation`. The router has to drop `access=private` and `access=no`,
// because most of them are farm drives and estate tracks a walker has no business on — but
// some are public rights of way. The College Valley road (way 34571653) is
// `highway=track access=private foot=designated designation=public_bridleway`: private to
// cars, a bridleway on foot. Dropping it sent Hethpool → Mounthooly 15.6 km over the
// border ridge instead of 5.9 km up the valley (scotland-basemap.pmtiles, 2026-11-18).
// Of the paths and tracks tagged private or no, 10% in Cumbria and 12% in Scotland say a
// walker may use them; the rest do not, so keeping them all is no answer either.
//
// So this artifact is the exceptions: the router keeps a restricted basemap way only where
// one of these lies along it. What counts:
//
//   - A `highway` way whose `access` is `private` or `no` (the values the router drops).
//   - `foot` of `yes`, `designated` or `permissive` makes it walkable. Any other `foot`
//     (`no`, `private`, `customers`, `destination`, ...) makes it not, whatever else is
//     tagged: `foot` is the specific answer and wins over a designation.
//   - With no `foot`, a public right of way's `designation` makes it walkable: England and
//     Wales' public footpaths, bridleways, restricted byways and byways open to all
//     traffic, and Scotland's core paths.
//   - Lines only. A pedestrian area exported as a polygon is not something to route along.
//   - Deduplicated by (@type, @id) across concatenated continent extracts, the seam problem
//     normalize-sac documents.
//
// Kept features carry the `foot` and `designation` that admitted them, nothing else.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"ratmap/infra/tools/internal/osmpoint"
	"ratmap/infra/tools/internal/rawjson"
)

// restricted are the `access` values src/routes/path-tiles.ts drops (BLOCKED_ACCESS).
// Keep the two lists the same: a value only one of them knows is either dropped with no
// way back, or overridden when it was never dropped.
var restricted = map[string]bool{"private": true, "no": true}

// walkableFoot are `foot` values that let a walker through.
var walkableFoot = map[string]bool{"yes": true, "designated": true, "permissive": true}

// publicDesignation are the `designation` values that are a right of way on foot.
var publicDesignation = map[string]bool{
	"public_footpath":           true,
	"public_bridleway":          true,
	"restricted_byway":          true,
	"byway_open_to_all_traffic": true,
	"core_path":                 true,
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
		fmt.Fprintln(os.Stderr, "usage: normalize-access IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-access:", err)
		os.Exit(1)
	}
}

// classify says whether a way is kept, and if not, why.
func classify(props map[string]json.RawMessage, geometry string) (dropped string) {
	tag := func(key string) string {
		v, _ := rawjson.String(props[key])
		return v
	}
	switch {
	case tag("highway") == "":
		return "not a highway"
	case !restricted[tag("access")]:
		return "not restricted"
	case geometry != "LineString" && geometry != "MultiLineString":
		return "not a line"
	}
	if foot := tag("foot"); foot != "" {
		if walkableFoot[foot] {
			return ""
		}
		return "not walkable"
	}
	if publicDesignation[tag("designation")] {
		return ""
	}
	return "not walkable"
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

	kept, byFoot, byDesignation, duplicated := 0, 0, 0, 0
	dropped := map[string]int{}
	seen := map[string]bool{}

	fail := func(err error) error {
		dest.Close()
		return err
	}

	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimSpace(bytes.TrimLeft(raw, "\x1e")); len(line) > 0 {
			var f struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Geometry   json.RawMessage            `json:"geometry"`
			}
			if err := json.Unmarshal(line, &f); err != nil {
				return fail(fmt.Errorf("%s: line %d: %w", srcPath, n, err))
			}
			var shape struct{ Type string }
			json.Unmarshal(f.Geometry, &shape)

			if reason := classify(f.Properties, shape.Type); reason != "" {
				dropped[reason]++
			} else if key, ok := osmpoint.Key(f.Properties); ok && seen[key] {
				duplicated++
			} else {
				if ok {
					seen[key] = true
				}
				w.WriteString(`{"type":"Feature","geometry":`)
				w.Write(bytes.TrimSpace(f.Geometry))
				w.WriteString(`,"properties":{`)
				sep := ""
				for _, key := range []string{"foot", "designation"} {
					if v, ok := rawjson.String(f.Properties[key]); ok {
						w.WriteString(sep + `"` + key + `":`)
						w.Write(osmpoint.JSONString(v))
						sep = ","
					}
				}
				w.WriteString("}}\n")
				kept++
				if _, ok := rawjson.String(f.Properties["foot"]); ok {
					byFoot++
				} else {
					byDesignation++
				}
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
	fmt.Fprintf(out, "  kept %d restricted ways open on foot (%d by foot, %d by designation alone); skipped %d not walkable, %d not restricted, %d not a highway, %d not a line, %d already seen (continent seams)\n",
		kept, byFoot, byDesignation, dropped["not walkable"], dropped["not restricted"],
		dropped["not a highway"], dropped["not a line"], duplicated)
	return nil
}

// selfTest is --self-test: each way in, each way out, foot beating designation in both
// directions, and a seam duplicate. It runs the real normalizer, so its report line is
// printed too.
func selfTest(out io.Writer) error {
	line := `{"type": "LineString", "coordinates": [[-2.18, 55.52], [-2.17, 55.53]]}`
	area := `{"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]]}`
	cases := []struct{ props, geometry, want string }{
		// The College Valley road and College Valley Walk.
		{`{"highway": "track", "access": "private", "foot": "designated", "designation": "public_bridleway", "@type": "way", "@id": 34571653}`, line,
			`{"foot": "designated", "designation": "public_bridleway"}`},
		{`{"highway": "path", "access": "no", "foot": "yes", "@type": "way", "@id": 723066310}`, line,
			`{"foot": "yes"}`},
		{`{"highway": "track", "access": "private", "foot": "permissive", "@type": "way", "@id": 3}`, line,
			`{"foot": "permissive"}`},
		// A right of way nobody tagged `foot` on.
		{`{"highway": "track", "access": "private", "designation": "public_footpath", "@type": "way", "@id": 4}`, line,
			`{"designation": "public_footpath"}`},
		{`{"highway": "track", "access": "private", "designation": "core_path", "@type": "way", "@id": 5}`, line,
			`{"designation": "core_path"}`},
		// `foot` says no, whatever the designation says.
		{`{"highway": "track", "access": "private", "foot": "no", "designation": "public_footpath", "@type": "way", "@id": 6}`, line, ``},
		{`{"highway": "service", "access": "private", "foot": "customers", "@type": "way", "@id": 7}`, line, ``},
		// A bare private drive, a designation that is not a right of way, a way the router
		// never dropped, not a highway, an area, and the road again from the next extract.
		{`{"highway": "track", "access": "private", "@type": "way", "@id": 8}`, line, ``},
		{`{"highway": "track", "access": "private", "designation": "national_park", "@type": "way", "@id": 9}`, line, ``},
		{`{"highway": "track", "access": "permissive", "foot": "yes", "@type": "way", "@id": 10}`, line, ``},
		{`{"landuse": "farmyard", "access": "private", "foot": "yes", "@type": "way", "@id": 11}`, line, ``},
		{`{"highway": "pedestrian", "area": "yes", "access": "private", "foot": "yes", "@type": "way", "@id": 12}`, area, ``},
		{`{"highway": "track", "access": "private", "foot": "designated", "designation": "public_bridleway", "@type": "way", "@id": 34571653}`, line, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-access-")
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
	for _, l := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var f struct {
			Geometry   struct{ Type string }
			Properties map[string]any
		}
		if err := json.Unmarshal([]byte(l), &f); err != nil {
			return fmt.Errorf("FAIL: normalize-access self-test: unreadable output %q: %w", l, err)
		}
		if f.Geometry.Type != "LineString" {
			return fmt.Errorf("FAIL: normalize-access self-test: geometry %q not carried through", f.Geometry.Type)
		}
		outputs = append(outputs, any(f.Properties))
	}
	if !reflect.DeepEqual(outputs, expected) {
		return fmt.Errorf("FAIL: normalize-access self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-access self-test OK (%d cases)\n", len(cases))
	return nil
}
