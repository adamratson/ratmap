package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

// testdata/edge.want.* are the summary and output for testdata/edge.geojsonl: lines,
// multilines, points, polygons, missing geometry or properties, non-string and empty
// highways, tracks, extra and reordered keys, a duplicated key, non-ASCII names, an RS
// prefix and blank lines. The output is compared as parsed JSON, not bytes: its only
// reader is tippecanoe. -update rewrites them.
func TestEdgeCases(t *testing.T) {
	out := filepath.Join(t.TempDir(), "final.geojsonl")
	kept, skipped, err := reduce("testdata/edge.geojsonl", out)
	if err != nil {
		t.Fatal(err)
	}
	summary := "  edge: " + itoa(kept) + " walkable ways, skipped " + itoa(skipped) + " non-line features\n"
	golden.Check(t, "summary", []byte(summary), "testdata/edge.want.stdout")
	if *golden.Update {
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		golden.Check(t, "output", data, "testdata/edge.want.geojsonl")
		return
	}

	got, want := readFeatures(t, out), readFeatures(t, "testdata/edge.want.geojsonl")
	if len(got) != len(want) {
		t.Fatalf("%d features, want %d", len(got), len(want))
	}
	for i := range want {
		for _, k := range []string{"type", "geometry", "properties"} {
			if !reflect.DeepEqual(got[i][k], want[i][k]) {
				t.Errorf("feature %d %s:\n got  %v\n want %v", i+1, k, got[i][k], want[i][k])
			}
		}
	}
}

func readFeatures(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out = append(out, m)
	}
	return out
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// A line that is not a feature is an error: the export is broken.
func TestRefusesMalformedFeatures(t *testing.T) {
	for _, line := range []string{
		`[1, 2]`,
		`{"geometry": [1], "properties": {"highway": "path"}}`,
		`{"geometry": {"type": "LineString"}, "properties": "x"}`,
		`{"geometry": {"type": "LineString"}, "properties": {"highway": "path"}`,
	} {
		if _, _, err := classify([]byte(line)); err == nil {
			t.Errorf("classify(%s): want an error", line)
		}
	}
	// A null geometry is not a way, and null properties have no highway: both skipped.
	for _, line := range []string{
		`{"geometry": null, "properties": {"highway": "path"}}`,
		`{"geometry": {"type": "LineString"}, "properties": null}`,
	} {
		if g, _, err := classify([]byte(line)); err != nil || g != nil {
			t.Errorf("classify(%s): geometry %s, err %v; want skipped", line, g, err)
		}
	}
}

// Keys are matched exactly; encoding/json's struct matching would have taken "Geometry"
// for "geometry".
func TestKeysAreCaseSensitive(t *testing.T) {
	g, _, err := classify([]byte(`{"Geometry": {"type": "LineString"}, "properties": {"highway": "path"}}`))
	if err != nil || g != nil {
		t.Fatalf("got geometry %s, err %v; want skipped", g, err)
	}
}
