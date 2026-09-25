// Command reduce-paths reduces an osmium GeoJSONSeq export of walkable ways to the two
// properties the paths style reads, under Protomaps' own names.
//
//	reduce-paths RAW.geojsonl FINAL.geojsonl LABEL
//
// A port of the Python heredoc build-paths.sh ran as reduce_to_path_properties: same
// arguments, same features kept, same summary line. It is the one step in the pipeline
// that streams every walkable way on the planet — ~85 M of them — and the Python managed
// ~107 k ways a second (Scotland, 2026-09-25).
//
// The output is not the Python's bytes, on purpose. The Python round-tripped every line
// through json.loads/json.dumps, which respaced it and re-spelled every number; this
// copies osmium's geometry text through untouched and writes the new properties compactly.
// The file's only reader is tippecanoe, which parses it: tiled from both, Scotland's
// tiles came out identical (2026-09-25). Features are written as type, geometry and
// properties — all an `osmium export` without `-a` puts on one.
//
// `kind_detail` rather than something of our own so one set of paint expressions can drive
// both this source and the basemap's `roads` layer (see addPathLayers in
// src/regions/region-layers.ts) — the handoff at z14 has to be invisible, and the surest
// way to make two layers look identical is to give them the same expressions.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"unicode"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: reduce-paths RAW.geojsonl FINAL.geojsonl LABEL")
		os.Exit(2)
	}
	kept, skipped, err := reduce(os.Args[1], os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, "reduce-paths:", err)
		os.Exit(1)
	}
	fmt.Printf("  %s: %d walkable ways, skipped %d non-line features\n", os.Args[3], kept, skipped)
}

func reduce(srcPath, destPath string) (kept, skipped int, err error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return 0, 0, err
	}
	defer src.Close()
	dest, err := os.Create(destPath)
	if err != nil {
		return 0, 0, err
	}
	w := bufio.NewWriterSize(dest, 1<<20)
	r := bufio.NewReaderSize(src, 1<<20)

	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pyIsSpace)
		if len(line) > 0 {
			geometry, detail, ferr := classify(line)
			if ferr != nil {
				dest.Close()
				return kept, skipped, fmt.Errorf("%s: line %d: %w", srcPath, n, ferr)
			}
			if geometry == nil {
				skipped++
			} else {
				w.WriteString(`{"type":"Feature","geometry":`)
				w.Write(geometry)
				w.WriteString(`,"properties":{"kind":"path","kind_detail":"` + detail + `"}}` + "\n")
				kept++
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dest.Close()
			return kept, skipped, rerr
		}
	}
	if err := w.Flush(); err != nil {
		dest.Close()
		return kept, skipped, err
	}
	return kept, skipped, dest.Close()
}

// classify returns the geometry's JSON text and the kind_detail for a kept way, or a nil
// geometry for one that is skipped. Where the Python would have raised — a line that is
// not a JSON object, or a geometry or properties that is present but not an object — it
// returns an error, so the stage fails as it did.
//
// Maps rather than structs: encoding/json matches struct fields case-insensitively, and
// "Geometry" is not "geometry" to the Python.
func classify(line []byte) (json.RawMessage, string, error) {
	var feature map[string]json.RawMessage
	if err := json.Unmarshal(line, &feature); err != nil {
		return nil, "", err
	}

	// Ways only. The export already asks osmium for lines alone; this stays as the guard,
	// since a point or an area slipping through would be drawn as a path.
	geometry := feature["geometry"]
	geomType, err := member(geometry, "geometry", "type")
	if err != nil {
		return nil, "", err
	}
	if geomType != "LineString" && geomType != "MultiLineString" {
		return nil, "", nil
	}

	highway, err := member(feature["properties"], "properties", "highway")
	if err != nil {
		return nil, "", err
	}
	h, ok := highway.(string)
	if !ok {
		return nil, "", nil
	}
	// Vehicle-width or not: the one distinction the styling makes, and the only one worth
	// two zoom levels of bytes.
	if h == "track" {
		return geometry, "track", nil
	}
	return geometry, "path", nil
}

// member is Python's `feature.get(name, {}).get(key)`: nil if either is missing, an error
// if the object is present but not an object (AttributeError in Python).
func member(obj json.RawMessage, name, key string) (any, error) {
	if obj == nil {
		return nil, nil
	}
	var m map[string]json.RawMessage
	if len(obj) == 0 || obj[0] != '{' {
		return nil, fmt.Errorf("%s is %s, not an object", name, obj)
	}
	if err := json.Unmarshal(obj, &m); err != nil {
		return nil, err
	}
	raw, ok := m[key]
	if !ok {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// pyIsSpace is str.isspace(): Go's unicode.IsSpace plus the four ASCII separators
// (\x1c-\x1f) that Python counts as whitespace and Go does not.
func pyIsSpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}
