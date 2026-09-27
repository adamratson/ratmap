package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

// testdata/ele.tsv is what 6,500-odd `ele` values read as ("None" for no elevation): the
// tail the package comment names, rounding ties, the range edges, digits in other
// scripts, and random mixtures. The first version was written by the Python this
// replaced; -update rewrites it.
func TestParseElevation(t *testing.T) {
	data, err := os.ReadFile("testdata/ele.tsv")
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	n := 0
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		value, _, _ := strings.Cut(line, "\t")
		out := "None"
		if v, ok := parseElevation(json.RawMessage(value)); ok {
			out = strconv.FormatFloat(v, 'f', -1, 64)
		}
		got.WriteString(value + "\t" + out + "\n")
		n++
	}
	if n < 6500 {
		t.Fatalf("only %d vectors", n)
	}
	golden.Check(t, "elevations", got.Bytes(), "testdata/ele.tsv")
}

// testdata/edge.want.* are the output and report for testdata/edge.geojsonl, compared as
// parsed features. -update rewrites them.
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
	if len(got) != len(wantF) {
		t.Fatalf("%d features, want %d", len(got), len(wantF))
	}
	for i := range wantF {
		if !reflect.DeepEqual(got[i], wantF[i]) {
			t.Errorf("feature %d:\n got  %v\n want %v", i+1, got[i], wantF[i])
		}
	}
}

// Key order counts too: an edited `ele` stays where it was, and a new `lists` goes last.
// (DeepEqual on maps cannot see order, so this checks it directly.)
func TestKeyOrder(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	if err := run("testdata/edge.geojsonl", out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	got, want := keyOrders(t, out), keyOrders(t, "testdata/edge.want.geojsonl")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("property key order:\n got  %v\n want %v", got, want)
	}
}

// A feature the normalizer does not change goes out byte for byte as it came in.
func TestUntouchedFeaturesPassThrough(t *testing.T) {
	line := []byte(`{"type":"Feature","geometry":{"type":"Point","coordinates":[-5.0036,56.7969]},"properties":{"@id":7,"natural":"peak","name":"Càrn Mòr Dearg"}}`)
	got, err := normalize(line, &counts{})
	if err != nil || !bytes.Equal(got, line) {
		t.Fatalf("got %s (%v)", got, err)
	}
}

// A line that is not a feature is an error: the export is broken.
func TestRefusesMalformedFeatures(t *testing.T) {
	for _, line := range []string{
		`[1]`,
		`{"properties": ["ele"]}`,
		`{"properties": "elevation"}`,
		`{"properties": {"ele": "1"}`,
	} {
		if _, err := normalize([]byte(line), &counts{}); err == nil {
			t.Errorf("normalize(%.60s): want an error", line)
		}
	}
	// Null properties pass through; an elevation too big for a float is none.
	for line, want := range map[string]string{
		`{"properties": null}`: `{"properties": null}`,
		`{"properties": {"ele": 1` + strings.Repeat("0", 400) + `}}`: `{"properties": {}}`,
	} {
		got, err := normalize([]byte(line), &counts{})
		if err != nil || string(got) != want {
			t.Errorf("normalize(%.60s) = %s, %v; want %s", line, got, err, want)
		}
	}
}

func features(t *testing.T, path string) []any {
	t.Helper()
	var out []any
	for _, line := range lines(t, path) {
		var v any
		if err := json.Unmarshal(line, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func keyOrders(t *testing.T, path string) [][]string {
	t.Helper()
	var out [][]string
	for _, line := range lines(t, path) {
		var f struct {
			Properties json.RawMessage `json:"properties"`
		}
		json.Unmarshal(line, &f)
		var keys []string
		if len(f.Properties) > 0 {
			dec := json.NewDecoder(bytes.NewReader(f.Properties))
			dec.Token()
			for dec.More() {
				k, _ := dec.Token()
				keys = append(keys, k.(string))
				var skip json.RawMessage
				dec.Decode(&skip)
			}
		}
		out = append(out, keys)
	}
	return out
}

func lines(t *testing.T, path string) [][]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out
}
