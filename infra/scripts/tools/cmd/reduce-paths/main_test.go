package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// testdata/edge.want.* were written by the Python this replaces (testdata/reduce-paths.py)
// from testdata/edge.geojsonl: lines, multilines, points, polygons, missing geometry or
// properties, non-string and empty highways, tracks, extra and reordered keys, a
// duplicated key, non-ASCII names, an RS prefix and blank lines.
//
// Compared as parsed JSON, not bytes: the output's only reader is tippecanoe, and its
// spacing and number spelling are deliberately osmium's rather than Python's (main.go).
func TestMatchesPython(t *testing.T) {
	out := filepath.Join(t.TempDir(), "final.geojsonl")
	kept, skipped, err := reduce("testdata/edge.geojsonl", out)
	if err != nil {
		t.Fatal(err)
	}
	wantStdout, _ := os.ReadFile("testdata/edge.want.stdout")
	if got := "edge: " + itoa(kept) + " walkable ways, skipped " + itoa(skipped) + " non-line features"; got != strings.TrimSpace(string(wantStdout)) {
		t.Fatalf("got %q, Python said %q", got, strings.TrimSpace(string(wantStdout)))
	}

	got, want := readFeatures(t, out), readFeatures(t, "testdata/edge.want.geojsonl")
	if len(got) != len(want) {
		t.Fatalf("%d features, Python wrote %d", len(got), len(want))
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

// Where the Python raised, this must fail too rather than write something new.
func TestRefusesWhatPythonRaisedOn(t *testing.T) {
	for _, line := range []string{
		`[1, 2]`,
		`{"geometry": null, "properties": {"highway": "path"}}`,
		`{"geometry": [1], "properties": {"highway": "path"}}`,
		`{"geometry": {"type": "LineString"}, "properties": null}`,
		`{"geometry": {"type": "LineString"}, "properties": "x"}`,
		`{"geometry": {"type": "LineString"}, "properties": {"highway": "path"}`,
	} {
		if _, _, err := classify([]byte(line)); err == nil {
			t.Errorf("classify(%s): want an error, as Python raises", line)
		}
	}
}

// Keys are matched exactly, as Python's dict does; encoding/json's struct matching would
// have taken "Geometry" for "geometry".
func TestKeysAreCaseSensitive(t *testing.T) {
	g, _, err := classify([]byte(`{"Geometry": {"type": "LineString"}, "properties": {"highway": "path"}}`))
	if err != nil || g != nil {
		t.Fatalf("got geometry %s, err %v; want skipped", g, err)
	}
}
