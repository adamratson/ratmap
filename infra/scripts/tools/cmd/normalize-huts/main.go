// Command normalize-huts normalizes OSM huts, shelters, campsites and water before
// tippecanoe.
//
//	normalize-huts IN.geojsonl OUT.geojsonl
//	normalize-huts --self-test
//
// Where a walker can get out of the weather, sleep or fill a bottle. The Protomaps basemap
// keeps most of these in its `pois` layer, but loses what tells them apart: it has no
// `shelter_type`, so a bus shelter and a hill shelter are one kind (642 of Scotland's
// 1,282 `amenity=shelter` are bus shelters); it gives a bothy tagged both
// `tourism=wilderness_hut` and `amenity=shelter` the kind `shelter` (36 in Scotland,
// Corrour among them); it has no `man_made=water_tap` (0 of Scotland's 93 in its tiles);
// and it keeps almost none of them below z15. Measured against scotland-latest.osm.pbf and
// the scotland-basemap z14/z15 tiles, 2026-11-18. So, like car parks, this is its own
// artifact.
//
// This does what still needs doing before tippecanoe:
//
//   - Map the tags to a `kind` — hut, shelter, campsite, water, spring — the property
//     src/overlays/huts-water.ts draws from. A hut tag wins over a shelter tag, and so does
//     `shelter_type=basic_hut`: a bothy is a hut however else it is tagged.
//   - Drop shelters that are not cover for a walker: bus shelters, gazebos, pavilions,
//     smoking shelters and animals' field shelters (see notCover). An untyped shelter is
//     kept: in Scotland 295 of the 338 unnamed untyped ones are not within 30 m of a bus
//     stop, and leaving the rest out would lose the weather shelters nobody typed.
//   - Drop water that is not drinking water: anything tagged `drinking_water=no`, and taps
//     not tagged `drinking_water=yes` (88 of Scotland's 136 say nothing either way).
//     Springs are kept whatever they say, as springs: the app never presents one as safe.
//   - Drop what a walker may not use: `access=private` or `no`, and campsites tagged
//     `tents=no`, which take caravans only.
//   - Reduce areas to a point (osmpoint.Represent). Campsites are mostly areas, and an icon
//     on a polygon would repeat in every tile it touches.
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
	"strings"

	"ratmap/infra/tools/internal/osmpoint"
	"ratmap/infra/tools/internal/rawjson"
)

// kinds, in the order the report prints them.
var kinds = []string{"hut", "shelter", "campsite", "water", "spring"}

// notCover are `shelter_type` values that are no shelter for a walker caught out: bus
// shelters (642 in Scotland), garden gazebos (55) and pergolas (4), sports pavilions (23),
// smoking shelters (7), shelters for livestock (6) and for supermarket trolleys (2).
// Everything else is kept: weather shelters, lean-tos, rock shelters, picnic shelters and
// untyped ones.
var notCover = map[string]bool{
	"public_transport": true,
	"gazebo":           true,
	"pergola":          true,
	"pavilion":         true,
	"smoking":          true,
	"field_shelter":    true,
	"animal_shelter":   true,
	"trolley":          true,
	"trolley_park":     true,
}

// restricted are `access` values that keep a walker out.
var restricted = map[string]bool{"private": true, "no": true}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-huts IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-huts:", err)
		os.Exit(1)
	}
}

// classify gives a feature's kind, or else why it is dropped.
func classify(props map[string]json.RawMessage) (kind, dropped string) {
	tag := func(key string) string {
		v, _ := rawjson.String(props[key])
		return v
	}
	tourism, amenity := tag("tourism"), tag("amenity")
	drinkable := tag("drinking_water")

	switch {
	case tourism == "alpine_hut" || tourism == "wilderness_hut" ||
		(amenity == "shelter" && tag("shelter_type") == "basic_hut"):
		kind = "hut"
	case amenity == "shelter":
		if notCover[tag("shelter_type")] {
			return "", "not cover"
		}
		kind = "shelter"
	case tourism == "camp_site":
		if tag("tents") == "no" {
			return "", "no tents"
		}
		kind = "campsite"
	case amenity == "drinking_water" || amenity == "water_point":
		if drinkable == "no" {
			return "", "not drinkable"
		}
		kind = "water"
	case tag("man_made") == "water_tap":
		if drinkable != "yes" {
			return "", "not drinkable"
		}
		kind = "water"
	case tag("natural") == "spring":
		kind = "spring"
	default:
		return "", "unrecognized"
	}
	if restricted[tag("access")] {
		return "", "restricted"
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

	kept, named, duplicated := map[string]int{}, 0, 0
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
				w.WriteString(`},"properties":{"kind":"`)
				w.WriteString(kind)
				w.WriteString(`"`)
				if name, ok := rawjson.String(props["name"]); ok {
					w.WriteString(`,"name":`)
					w.Write(osmpoint.JSONString(name))
					named++
				}
				w.WriteString("}}\n")
				kept[kind]++
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
	parts := make([]string, len(kinds))
	total := 0
	for i, k := range kinds {
		parts[i] = fmt.Sprintf("%s x%d", k, kept[k])
		total += kept[k]
	}
	fmt.Fprintf(out, "  kept %d (%s; %d named); skipped %d unrecognized, %d shelters that are not cover, %d campsites without tents, %d not drinking water, %d restricted, %d already seen (continent seams)\n",
		total, strings.Join(parts, ", "), named, dropped["unrecognized"], dropped["not cover"],
		dropped["no tents"], dropped["not drinkable"], dropped["restricted"], duplicated)
	return nil
}

// selfTest is --self-test: each kind, each reason to drop, a hut tagged as a shelter too,
// and an area reduced to its centroid. It runs the real normalizer, so its report line is
// printed too.
func selfTest(out io.Writer) error {
	square := `{"type": "MultiPolygon", "coordinates": [[[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]]}`
	point := `{"type": "Point", "coordinates": [5, 6]}`
	cases := []struct{ props, geometry, want string }{
		{`{"tourism": "wilderness_hut", "amenity": "shelter", "name": "Corrour Bothy", "@type": "node", "@id": 1}`, point,
			`{"kind": "hut", "name": "Corrour Bothy", "at": [5, 6]}`},
		{`{"tourism": "alpine_hut", "@type": "way", "@id": 2}`, square,
			`{"kind": "hut", "at": [0.0005, 0.0005]}`},
		{`{"amenity": "shelter", "shelter_type": "basic_hut", "@type": "node", "@id": 3}`, point,
			`{"kind": "hut", "at": [5, 6]}`},
		{`{"amenity": "shelter", "shelter_type": "weather_shelter", "@type": "node", "@id": 4}`, point,
			`{"kind": "shelter", "at": [5, 6]}`},
		{`{"amenity": "shelter", "@type": "node", "@id": 5}`, point,
			`{"kind": "shelter", "at": [5, 6]}`},
		{`{"tourism": "camp_site", "name": "Glen Nevis", "@type": "way", "@id": 6}`, square,
			`{"kind": "campsite", "name": "Glen Nevis", "at": [0.0005, 0.0005]}`},
		{`{"amenity": "drinking_water", "@type": "node", "@id": 7}`, point,
			`{"kind": "water", "at": [5, 6]}`},
		{`{"man_made": "water_tap", "drinking_water": "yes", "@type": "node", "@id": 8}`, point,
			`{"kind": "water", "at": [5, 6]}`},
		{`{"natural": "spring", "drinking_water": "no", "@type": "node", "@id": 9}`, point,
			`{"kind": "spring", "at": [5, 6]}`},
		// A bus shelter, a tap of unknown water, undrinkable water, a caravan-only site, a
		// private hut and not one of these at all: dropped.
		{`{"amenity": "shelter", "shelter_type": "public_transport", "@type": "node", "@id": 10}`, point, ``},
		{`{"man_made": "water_tap", "@type": "node", "@id": 11}`, point, ``},
		{`{"amenity": "drinking_water", "drinking_water": "no", "@type": "node", "@id": 12}`, point, ``},
		{`{"tourism": "camp_site", "tents": "no", "@type": "way", "@id": 13}`, square, ``},
		{`{"tourism": "wilderness_hut", "access": "private", "@type": "node", "@id": 14}`, point, ``},
		{`{"amenity": "bench", "@type": "node", "@id": 15}`, point, ``},
		// The first bothy again, from the next continent's extract.
		{`{"tourism": "wilderness_hut", "amenity": "shelter", "name": "Corrour Bothy", "@type": "node", "@id": 1}`, point, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-huts-")
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
		return fmt.Errorf("FAIL: normalize-huts self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-huts self-test OK (%d cases)\n", len(cases))
	return nil
}
