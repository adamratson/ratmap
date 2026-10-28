// Command normalize-landmarks normalizes OSM `man_made=mast|tower|survey_point|cairn|
// lighthouse` and wind turbines (`power=generator` + `generator:source=wind`) before
// tippecanoe.
//
//	normalize-landmarks IN.geojsonl OUT.geojsonl
//	normalize-landmarks --self-test
//
// The hill walker's reference points: transmitter masts and towers seen from miles off,
// trig pillars, cairns, lighthouses, wind turbines. Protomaps' POI layer keeps no
// `man_made` or `power` tag at all, so none of them reach the basemap — checked by decoding the Protomaps v4 z15 tiles over Great Dun
// Fell (2026-10-22), whose four `man_made=mast` nodes are in OSM and absent from the tiles.
//
// This does what still needs doing before tippecanoe:
//
//   - Map the tags to a `kind` (mast, tower, survey_point, cairn, lighthouse,
//     wind_turbine), the property src/overlays/landmarks.ts draws from.
//   - Drop the members of each family that are not landmarks. Floodlight poles are
//     `man_made=mast` + `tower:type=lighting` — 403 of Scotland's 2,363 masts (measured
//     against scotland-latest.osm.pbf, 2026-10-26), and 180 k planet-wide by taginfo's
//     count — and survey points include benchmark bolts and plaques set into walls,
//     which nobody navigates by. See excludedTowerTypes and excludedSurveyStructures.
//   - Drop anything also tagged as a summit. 81 of Scotland's 461 survey points and 52 of
//     its cairns are the summit node itself (`natural=peak`), and the peaks artifact
//     already draws that point with its name and height; a second symbol on top of the
//     summit dot only buries it.
//   - Reduce areas to a point. A tower drawn as a building outline, or a cairn as a
//     small closed way (25 k of the planet's 39 k cairns are ways), is still a single
//     symbol on the map — an icon on a polygon would repeat in every tile the polygon
//     touches. See osmpoint.Represent.
//   - Deduplicate by (@type, @id) across concatenated continent extracts, the seam
//     problem normalize-sac documents.
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
	"sort"
	"strings"

	"ratmap/infra/tools/internal/osmpoint"
	"ratmap/infra/tools/internal/rawjson"
)

// manMade maps the OSM value to the tile's `kind`.
var manMade = map[string]string{
	"mast":         "mast",
	"tower":        "tower",
	"survey_point": "survey_point",
	"cairn":        "cairn",
	"lighthouse":   "lighthouse",
}

// excludedTowerTypes are `tower:type` values on a mast or tower that make it street
// furniture or a training rig rather than a landmark. Everything else is kept, untyped
// included — communication masts, radar, observation and bell towers are what a walker
// takes a bearing on.
var excludedTowerTypes = map[string]bool{
	"lighting":             true,
	"lightning_protection": true,
	"siren":                true,
	"transition":           true, // power line cable transitions
	"advertising":          true,
	"climbing":             true,
	"diving":               true,
	"firefighter_training": true,
	"hose":                 true,
	"training":             true,
}

// excludedSurveyStructures are `survey_point:structure` values for marks too small to
// find on the ground: bolts, rivets and medallions set into walls and rock. Pillars,
// blocks, beacons and the untagged majority are kept — most of Britain's survey points
// are OS trig pillars with no structure tag at all (381 of Scotland's 461).
var excludedSurveyStructures = map[string]bool{
	"medallion":    true,
	"pin":          true,
	"indented_pin": true,
	"cut":          true,
	"plaque":       true,
	"rod":          true,
	"pipe":         true,
	"bracket":      true,
	"bolt":         true,
	"disc":         true,
	"plate":        true,
	"rivet":        true,
}

// summits are the `natural=` values the peaks artifact draws (build-peaks.sh).
var summits = map[string]bool{"peak": true, "volcano": true}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-landmarks IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-landmarks:", err)
		os.Exit(1)
	}
}

// classify is the kind a feature's tags make it, or "" with the reason it is dropped.
func classify(props map[string]json.RawMessage) (kind, dropped string) {
	value, _ := rawjson.String(props["man_made"])
	kind = manMade[value]
	if kind == "" && isWindTurbine(props) {
		kind = "wind_turbine"
	}
	if kind == "" {
		return "", "unrecognized"
	}
	if natural, ok := rawjson.String(props["natural"]); ok && summits[natural] {
		return "", "summit"
	}
	switch kind {
	case "mast", "tower":
		if t, ok := rawjson.String(props["tower:type"]); ok && excludedTowerTypes[t] {
			return "", "not a landmark"
		}
	case "survey_point":
		if s, ok := rawjson.String(props["survey_point:structure"]); ok && excludedSurveyStructures[s] {
			return "", "not a landmark"
		}
	}
	return kind, ""
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

	kept, duplicated := 0, 0
	dropped := map[string]int{}
	byKind := map[string]int{}
	// (@type, @id): OSM's node, way and relation id spaces are independent, and a tower
	// can be a node in one place and a building outline in the next.
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
			kind, reason := classify(props)
			if kind == "" {
				dropped[reason]++
			} else if key, ok := osmpoint.Key(props); ok && seen[key] {
				duplicated++
			} else {
				point, _, err := osmpoint.Represent(f["geometry"])
				if err != nil {
					return fail(fmt.Errorf("%s: line %d: %w", srcPath, n, err))
				}
				if ok {
					seen[key] = true
				}
				w.WriteString(`{"type":"Feature","geometry":{"type":"Point","coordinates":`)
				w.WriteString(point)
				w.WriteString(`},"properties":{"kind":`)
				w.Write(osmpoint.JSONString(kind))
				if name, ok := rawjson.String(props["name"]); ok {
					w.WriteString(`,"name":`)
					w.Write(osmpoint.JSONString(name))
				}
				w.WriteString("}}\n")
				kept++
				byKind[kind]++
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
	fmt.Fprintf(out, "  kept %d features; skipped %d with no recognized man_made= or wind generator tags, %d summits (the peaks artifact draws those), %d not landmarks (floodlights, benchmark bolts), %d already seen (continent seams)\n",
		kept, dropped["unrecognized"], dropped["summit"], dropped["not a landmark"], duplicated)
	if len(byKind) > 0 {
		var ks []string
		for k := range byKind {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		parts := make([]string, len(ks))
		for i, k := range ks {
			parts[i] = fmt.Sprintf("%s x%d", k, byKind[k])
		}
		fmt.Fprintf(out, "  by kind: %s\n", strings.Join(parts, ", "))
	}
	return nil
}

// isWindTurbine: `generator:source=wind` on a `power=generator`. The source tag alone also
// sits on whole wind farms (`power=plant`), which would put a turbine symbol in the middle
// of the site's outline, where there is none.
func isWindTurbine(props map[string]json.RawMessage) bool {
	power, _ := rawjson.String(props["power"])
	source, _ := rawjson.String(props["generator:source"])
	return power == "generator" && source == "wind"
}

// selfTest is --self-test: the kind mapping, the three ways a feature is dropped, and
// an area reduced to its centroid. It runs the real normalizer, so its report lines are
// printed too.
func selfTest(out io.Writer) error {
	square := `{"type": "MultiPolygon", "coordinates": [[[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]]}`
	point := `{"type": "Point", "coordinates": [5, 6]}`
	cases := []struct{ props, geometry, want string }{
		{`{"man_made": "mast", "tower:type": "communication", "@type": "node", "@id": 1}`, point,
			`{"kind": "mast", "at": [5, 6]}`},
		{`{"man_made": "tower", "@type": "way", "@id": 2, "name": "Radar"}`, square,
			`{"kind": "tower", "name": "Radar", "at": [1, 1]}`},
		{`{"man_made": "survey_point", "@type": "node", "@id": 3}`, point,
			`{"kind": "survey_point", "at": [5, 6]}`},
		{`{"man_made": "cairn", "@type": "node", "@id": 4}`, point,
			`{"kind": "cairn", "at": [5, 6]}`},
		{`{"man_made": "lighthouse", "@type": "way", "@id": 9}`, square,
			`{"kind": "lighthouse", "at": [1, 1]}`},
		{`{"power": "generator", "generator:source": "wind", "@type": "node", "@id": 10}`, point,
			`{"kind": "wind_turbine", "at": [5, 6]}`},
		// A whole wind farm: dropped, the turbines inside it are what is drawn.
		{`{"power": "plant", "generator:source": "wind", "@type": "way", "@id": 11}`, square, ``},
		// A floodlight, a benchmark bolt, a summit and not ours at all: all dropped.
		{`{"man_made": "mast", "tower:type": "lighting", "@type": "node", "@id": 5}`, point, ``},
		{`{"man_made": "survey_point", "survey_point:structure": "bolt", "@type": "node", "@id": 6}`, point, ``},
		{`{"man_made": "survey_point", "natural": "peak", "@type": "node", "@id": 7}`, point, ``},
		{`{"man_made": "water_tower", "@type": "node", "@id": 8}`, point, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-landmarks-")
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
		return fmt.Errorf("FAIL: normalize-landmarks self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-landmarks self-test OK (%d cases)\n", len(cases))
	return nil
}
