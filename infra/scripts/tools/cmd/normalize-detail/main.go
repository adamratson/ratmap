// Command normalize-detail normalizes the OSM field detail a hill map draws — walls,
// fences, power lines and pylons, gates, stiles, cattle grids and fords — before
// tippecanoe.
//
//	normalize-detail IN.geojsonl OUT.geojsonl
//	normalize-detail --self-test
//
// None of it is in the basemap: Protomaps' tiles have no power, barrier or ford data at
// all (checked by decoding scotland-basemap z15 tiles over the Cairngorms, 2026-10-27 —
// no layer carries any of it). Walls, fences and power lines are the handrails a walker
// navigates along; gates, stiles and fords are where a path gets through them.
//
// This does what still needs doing before tippecanoe:
//
//   - Map the tags to a `kind` (see classify), the property src/overlays/detail.ts draws
//     from. Kissing gates are drawn as gates, and stepping stones as fords.
//   - Reduce a way to a point where the kind is a point: a gate or ford mapped as a short
//     way across the path is one symbol, placed halfway along it.
//   - Give each kind the zoom it starts at, as tippecanoe's per-feature `minzoom` — see
//     minZoom. That is what keeps the z12-13 tiles to power lines alone: walls and fences
//     are the bulk of this artifact (about 200 k of each in Scotland) and would swamp the
//     low zooms for nothing, since they are only drawn from z14.
//
// Unlike normalize-landmarks it does not deduplicate continent-seam features: walls,
// fences and gates run to tens of millions planet-wide, and holding their ids costs more
// than drawing a few seam features twice — build-paths.sh makes the same call. A doubled
// line draws exactly over itself, and a doubled symbol collides with its twin.
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
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/rawjson"
)

// minZoom is the zoom each kind is drawn from, and so the first zoom its tiles carry it.
// Power lines from z12, as on a 1:50 000 sheet; the field boundaries and fords from z14,
// where the gaps between them are wide enough to read; the furniture on a path from z15.
var minZoom = map[string]int{
	"power_line":       12,
	"minor_power_line": 14,
	"wall":             14,
	"fence":            14,
	"ford":             14,
	"pylon":            15,
	"gate":             15,
	"stile":            15,
	"cattle_grid":      15,
}

// points are the kinds drawn as a symbol; the rest are lines.
var points = map[string]bool{"pylon": true, "gate": true, "stile": true, "cattle_grid": true, "ford": true}

var barriers = map[string]string{
	"wall":         "wall",
	"fence":        "fence",
	"gate":         "gate",
	"kissing_gate": "gate",
	"stile":        "stile",
	"cattle_grid":  "cattle_grid",
}

var power = map[string]string{
	"line":       "power_line",
	"minor_line": "minor_power_line",
	"tower":      "pylon",
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
		fmt.Fprintln(os.Stderr, "usage: normalize-detail IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-detail:", err)
		os.Exit(1)
	}
}

// classify is the kind a feature's tags make it, or "".
func classify(props map[string]json.RawMessage) string {
	if v, ok := rawjson.String(props["barrier"]); ok && barriers[v] != "" {
		return barriers[v]
	}
	if v, ok := rawjson.String(props["power"]); ok && power[v] != "" {
		return power[v]
	}
	// Any value but "no": `yes`, `stepping_stones` and the odd `boat`, `seasonal` are all
	// a place the path meets water without a bridge.
	if v, ok := rawjson.String(props["ford"]); ok && v != "no" {
		return "ford"
	}
	return ""
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

	kept, unrecognized, misshapen := 0, 0, 0
	byKind := map[string]int{}
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
			props := map[string]json.RawMessage{}
			if p, ok := f["properties"]; ok {
				if err := json.Unmarshal(p, &props); err != nil || props == nil {
					return fail(fmt.Errorf("%s: line %d: properties is %s, not an object", srcPath, n, p))
				}
			}
			kind := classify(props)
			if kind == "" {
				unrecognized++
			} else {
				geometry, err := shape(f["geometry"], points[kind])
				if err != nil {
					return fail(fmt.Errorf("%s: line %d: %w", srcPath, n, err))
				}
				if geometry == "" {
					// A wall or fence that is a lone node: nothing to draw as a line. (The
					// reverse, a point kind mapped as a way, is reduced to its midpoint.)
					misshapen++
				} else {
					fmt.Fprintf(w, `{"type":"Feature","tippecanoe":{"minzoom":%d},"geometry":%s,"properties":{"kind":"%s"}}`+"\n",
						minZoom[kind], geometry, kind)
					kept++
					byKind[kind]++
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
	fmt.Fprintf(out, "  kept %d features; skipped %d with no recognized tags, %d with a geometry their kind is not drawn as\n",
		kept, unrecognized, misshapen)
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

type position [2]float64

// shape is the GeoJSON geometry to write for a feature drawn as a point (asPoint) or a
// line, or "" when its geometry cannot be one: a line kind needs a LineString, a point
// kind takes a Point as written or the midpoint of a LineString. build-detail.sh exports
// --geometry-types=point,linestring, so anything else is a changed export.
func shape(raw json.RawMessage, asPoint bool) (string, error) {
	var g struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &g) != nil {
		return "", fmt.Errorf("geometry is %s, not a GeoJSON geometry", raw)
	}
	switch g.Type {
	case "Point":
		if !asPoint {
			return "", nil
		}
		return string(bytes.TrimSpace(raw)), nil
	case "LineString":
		if !asPoint {
			return string(bytes.TrimSpace(raw)), nil
		}
		var line []position
		if err := json.Unmarshal(g.Coordinates, &line); err != nil || len(line) == 0 {
			return "", fmt.Errorf("LineString coordinates: %s", g.Coordinates)
		}
		m := midpoint(line)
		return `{"type":"Point","coordinates":[` + coord(m[0]) + "," + coord(m[1]) + "]}", nil
	default:
		return "", fmt.Errorf("unexpected %s geometry", g.Type)
	}
}

// midpoint is the point halfway along a line, by planar length in degrees — exact enough
// for a gate or ford a few metres long.
func midpoint(line []position) position {
	total := 0.0
	for i := 1; i < len(line); i++ {
		total += math.Hypot(line[i][0]-line[i-1][0], line[i][1]-line[i-1][1])
	}
	half := total / 2
	for i := 1; i < len(line); i++ {
		step := math.Hypot(line[i][0]-line[i-1][0], line[i][1]-line[i-1][1])
		if step > 0 && half <= step {
			t := half / step
			return position{
				line[i-1][0] + t*(line[i][0]-line[i-1][0]),
				line[i-1][1] + t*(line[i][1]-line[i-1][1]),
			}
		}
		half -= step
	}
	return line[0]
}

// coord is a coordinate to 7 decimal places (~1 cm), osmium's own precision.
func coord(v float64) string {
	return strconv.FormatFloat(math.Round(v*1e7)/1e7, 'f', -1, 64)
}

// selfTest is --self-test: the kind mapping, the point/line split and the per-kind zoom.
// It runs the real normalizer, so its report lines are printed too.
func selfTest(out io.Writer) error {
	line := `{"type": "LineString", "coordinates": [[0, 0], [4, 0]]}`
	point := `{"type": "Point", "coordinates": [5, 6]}`
	cases := []struct{ props, geometry, want string }{
		{`{"barrier": "wall"}`, line, `{"kind": "wall", "minzoom": 14, "type": "LineString"}`},
		{`{"barrier": "fence"}`, line, `{"kind": "fence", "minzoom": 14, "type": "LineString"}`},
		{`{"power": "line"}`, line, `{"kind": "power_line", "minzoom": 12, "type": "LineString"}`},
		{`{"power": "tower"}`, point, `{"kind": "pylon", "minzoom": 15, "type": "Point"}`},
		{`{"barrier": "kissing_gate"}`, point, `{"kind": "gate", "minzoom": 15, "type": "Point"}`},
		{`{"barrier": "gate"}`, line, `{"kind": "gate", "minzoom": 15, "type": "Point"}`},
		{`{"ford": "stepping_stones"}`, point, `{"kind": "ford", "minzoom": 14, "type": "Point"}`},
		// Not ours, or not drawable as its kind: dropped.
		{`{"ford": "no"}`, point, ``},
		{`{"power": "pole"}`, point, ``},
		{`{"barrier": "wall"}`, point, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-detail-")
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
			Tippecanoe struct{ Minzoom float64 }
			Geometry   struct{ Type string }
			Properties map[string]any
		}
		json.Unmarshal([]byte(l), &f)
		f.Properties["minzoom"] = f.Tippecanoe.Minzoom
		f.Properties["type"] = f.Geometry.Type
		outputs = append(outputs, any(f.Properties))
	}
	if !reflect.DeepEqual(outputs, expected) {
		return fmt.Errorf("FAIL: normalize-detail self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-detail self-test OK (%d cases)\n", len(cases))
	return nil
}
