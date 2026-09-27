package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

// testdata/selftest.want.stdout is what --self-test prints.
func TestSelfTest(t *testing.T) {
	var out bytes.Buffer
	if err := selfTest(&out); err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/selftest.want.stdout")
	if out.String() != string(want) {
		t.Errorf("self-test output differs:\n got:\n%s\n want:\n%s", out.String(), want)
	}
}

// testdata/edge.want.* are the output and report for testdata/edge.geojsonl: every
// recognised kind, values it drops, a name with characters JSON escapes, and seam
// duplicates (only an id written the same way twice: 1, 1.0, true and "1" are four ids).
// The features are compared parsed, not as bytes. -update rewrites them.
func TestEdgeCases(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	golden.Check(t, "report", report.Bytes(), "testdata/edge.want.stdout")
	if *golden.Update {
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		golden.Check(t, "features", data, "testdata/edge.want.geojsonl")
		return
	}
	got, wantF := features(t, out), features(t, "testdata/edge.want.geojsonl")
	if !reflect.DeepEqual(got, wantF) {
		t.Fatalf("features differ:\n got  %v\n want %v", got, wantF)
	}
}

func features(t *testing.T, path string) []any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fs []any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		fs = append(fs, v)
	}
	return fs
}
