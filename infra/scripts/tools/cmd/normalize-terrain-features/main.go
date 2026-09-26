// Command normalize-terrain-features normalizes OSM `natural=scree|shingle|rock|stone`
// before tippecanoe.
//
//	normalize-terrain-features IN.geojsonl OUT.geojsonl
//	normalize-terrain-features --self-test
//
// A port of scripts/normalize-terrain-features.py, which it replaces in
// build-terrain-features.sh: same arguments, same features kept, same report.
//
// Unlike `sac_scale` (normalize-sac) these are clean enum values in practice — no free
// text to parse. This exists for three things that still need doing before tippecanoe:
//
//   - Rename `natural` to `kind` on the way out, so the tile property matches what
//     src/overlays/terrain-features.ts and every other artifact's convention expect.
//   - Drop the `natural` values this artifact does not cover — load-bearing, not just
//     defence in depth. Filtering `scotland-latest.osm.pbf` to
//     `nwr/natural=scree,shingle,rock,stone` and exporting it (2026-09-18) still yielded
//     1,176 features tagged `coastline`, `heath`, `wood`, `grassland`, `bare_rock` and
//     others alongside the 10,551 wanted ones: `osmium tags-filter` keeps every member of a
//     matched multipolygon relation to make its geometry buildable, OSM landcover polygons
//     routinely share boundary ways with their neighbours, and `osmium export` then
//     assembles an area for every recognized tag it finds. The filter narrows the input;
//     this is what actually enforces the four kinds.
//   - Deduplicate by (kind, @id) across concatenated continent extracts — the same seam
//     problem normalize-sac documents, far less likely to bite here, kept because it is
//     cheap.
//
// The geometry duplication this does *not* handle, because the export already avoids it:
// by default `osmium export` emits a closed way as both a LineString and a MultiPolygon;
// build-terrain-features.sh exports `--geometry-types=point,polygon`.
//
// The output is not the Python's bytes: it copies osmium's geometry text through rather
// than re-serializing it, and writes the new properties compactly. Its readers —
// build-terrain-features.sh's check and tippecanoe — parse it.
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

	"ratmap/infra/tools/internal/pytext"
)

var kinds = map[string]bool{"scree": true, "shingle": true, "rock": true, "stone": true}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-terrain-features IN.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-terrain-features:", err)
		os.Exit(1)
	}
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

	kept, unrecognized, duplicated := 0, 0, 0
	byKind := map[string]int{}
	// (kind, @id) rather than @id alone: a node and a way can share a numeric id (OSM's
	// node and way id spaces are independent), and `rock`/`stone` are the two kinds that
	// actually carry both geometry types.
	seen := map[string]bool{}

	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pytext.IsSpace); len(line) > 0 {
			var f map[string]json.RawMessage
			if err := json.Unmarshal(line, &f); err != nil {
				dest.Close()
				return fmt.Errorf("%s: line %d: %w", srcPath, n, err)
			}
			// feature.get("properties", {}): present but not an object raised in Python.
			props := map[string]json.RawMessage{}
			if p, ok := f["properties"]; ok {
				if err := json.Unmarshal(p, &props); err != nil || props == nil {
					dest.Close()
					return fmt.Errorf("%s: line %d: properties is %s, not an object", srcPath, n, p)
				}
			}
			nat := bytes.TrimSpace(props["natural"])
			if len(nat) > 0 && (nat[0] == '[' || nat[0] == '{') {
				dest.Close()
				return fmt.Errorf("%s: line %d: natural is %s (unhashable in Python)", srcPath, n, nat)
			}
			kind, ok := pytext.Str(nat)
			if !ok || !kinds[kind] {
				unrecognized++
			} else {
				dup := false
				if id, ok := props["@id"]; ok && string(bytes.TrimSpace(id)) != "null" {
					k, err := pytext.HashKey(id)
					if err != nil {
						dest.Close()
						return fmt.Errorf("%s: line %d: %w", srcPath, n, err)
					}
					if seen[kind+"\x00"+k] {
						duplicated++
						dup = true
					} else {
						seen[kind+"\x00"+k] = true
					}
				}
				if !dup {
					w.WriteString(`{"type":"Feature","geometry":`)
					geom := f["geometry"]
					if geom == nil {
						geom = json.RawMessage("null")
					}
					w.Write(geom)
					w.WriteString(`,"properties":{"kind":`)
					w.Write(jsonString(kind))
					if name, ok := pytext.Str(props["name"]); ok {
						w.WriteString(`,"name":`)
						w.Write(jsonString(name))
					}
					w.WriteString("}}\n")
					kept++
					byKind[kind]++
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dest.Close()
			return rerr
		}
	}
	if err := w.Flush(); err != nil {
		dest.Close()
		return err
	}
	if err := dest.Close(); err != nil {
		return err
	}
	fmt.Fprintf(out, "  kept %d features; skipped %d with an unrecognized natural= value, %d already seen (continent seams)\n",
		kept, unrecognized, duplicated)
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

// jsonString encodes s as JSON without Go's HTML escaping of <, > and &.
func jsonString(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return bytes.TrimRight(b.Bytes(), "\n")
}

// selfTest is the Python's --self-test, case for case: thin on purpose — there is no
// free-text parsing here to stress — but a change to the kind/dedup/rename logic still
// has something to break against, the standard every normalize step here holds to. Like
// the Python it runs the real normalizer, so its report lines are printed too.
func selfTest(out io.Writer) error {
	cases := []struct{ props, want string }{
		{`{"natural": "scree", "@id": 1}`, `{"kind": "scree"}`},
		{`{"natural": "shingle", "@id": 2, "name": "Cùil Bay shingle"}`, `{"kind": "shingle", "name": "Cùil Bay shingle"}`},
		{`{"natural": "rock", "@id": 3, "name": null}`, `{"kind": "rock"}`},
		// Not one of ours — should be dropped, not passed through with a stray kind.
		{`{"natural": "wood", "@id": 4}`, ``},
		{`{"natural": "bare_rock", "@id": 5}`, ``},
	}
	dir, err := os.MkdirTemp("", "normalize-terrain-features-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	src, dest := filepath.Join(dir, "in.geojsonl"), filepath.Join(dir, "out.geojsonl")
	var in strings.Builder
	var expected []any
	for _, c := range cases {
		fmt.Fprintf(&in, `{"type": "Feature", "properties": %s, "geometry": {"type": "Point", "coordinates": [0, 0]}}`+"\n", c.props)
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
		var f struct{ Properties any }
		json.Unmarshal([]byte(line), &f)
		outputs = append(outputs, f.Properties)
	}
	if !reflect.DeepEqual(outputs, expected) {
		return fmt.Errorf("FAIL: normalize-terrain-features self-test\n  expected %v\n  got %v", expected, outputs)
	}
	fmt.Fprintf(out, "  normalize-terrain-features self-test OK (%d cases)\n", len(cases))
	return nil
}
