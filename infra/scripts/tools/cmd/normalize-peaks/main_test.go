package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ratmap/infra/tools/internal/pyfloat"
)

// testdata/ele.tsv is the Python's parse_elevation on 6,500-odd values
// (testdata/gen-vectors.py): the tail the package comment names, rounding ties, the
// range edges, non-ASCII digits, and random mixtures.
func TestParseElevationMatchesPython(t *testing.T) {
	f, err := os.Open("testdata/ele.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<16), 1<<20)
	n := 0
	for sc.Scan() {
		value, want, _ := strings.Cut(sc.Text(), "\t")
		v, ok, err := parseElevation(json.RawMessage(value))
		got := "None"
		if err != nil {
			got = "ERROR"
		} else if ok {
			got = pyfloat.Repr(v)
		}
		if got != want {
			t.Errorf("parse_elevation(%s): got %s, Python %s", value, got, want)
		}
		n++
	}
	if n < 6500 {
		t.Fatalf("only %d vectors", n)
	}
}

// testdata/edge.want.* are the Python's output and report for testdata/edge.geojsonl.
// Compared as parsed features: the output keeps osmium's text where the Python
// re-encoded it (see the package comment), so the bytes differ by design.
func TestMatchesPython(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/edge.want.stdout")
	if report.String() != string(want) {
		t.Errorf("report:\n got  %s want %s", report.String(), want)
	}
	got, wantF := features(t, out), features(t, "testdata/edge.want.geojsonl")
	if len(got) != len(wantF) {
		t.Fatalf("%d features, Python wrote %d", len(got), len(wantF))
	}
	for i := range wantF {
		if !reflect.DeepEqual(got[i], wantF[i]) {
			t.Errorf("feature %d:\n got  %v\n want %v", i+1, got[i], wantF[i])
		}
	}
}

// Key order counts too, as a Python dict's: an edited `ele` stays where it was, and a new
// `lists` goes last. (DeepEqual on maps cannot see order, so this checks it directly.)
func TestKeyOrderMatchesPython(t *testing.T) {
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

// Where the Python raised, this must fail too rather than write something new.
func TestRefusesWhatPythonRaisedOn(t *testing.T) {
	for _, line := range []string{
		`[1]`,
		`{"properties": null}`,
		`{"properties": ["ele"]}`,
		`{"properties": "elevation"}`,
		`{"properties": {"ele": 1` + strings.Repeat("0", 400) + `}}`,
		`{"properties": {"ele": "1"}`,
	} {
		if _, err := normalize([]byte(line), &counts{}); err == nil {
			t.Errorf("normalize(%.60s): want an error, as Python raises", line)
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
