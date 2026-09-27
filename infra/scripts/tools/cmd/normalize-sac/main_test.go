package main

import (
	"bufio"
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

func TestSelfTest(t *testing.T) {
	if f := selfTest(); len(f) > 0 {
		t.Fatalf("self-test failed:\n  %s", strings.Join(f, "\n  "))
	}
}

// testdata/grades.tsv is the grade for each of 6,000-odd sac_scale values — the
// documented ones, the oddities taginfo lists, and random mixtures of every separator,
// shorthand form, bracket, Unicode space, dash, digit and case trap the parser meets.
// "None" is no grade. The first version was written by the Python parser this replaced;
// -update rewrites it from this one.
func TestParseGrade(t *testing.T) {
	data, err := os.ReadFile("testdata/grades.tsv")
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	n := 0
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		value := strings.Split(line, "\t")[0]
		g, ok, err := parseGrade(json.RawMessage(value))
		if err != nil {
			t.Fatalf("parseGrade(%s): %v", value, err)
		}
		grade := "None"
		if ok {
			grade = strconv.Itoa(g)
		}
		got.WriteString(value + "\t" + grade + "\n")
		n++
	}
	if n < 6000 {
		t.Fatalf("only %d vectors", n)
	}
	golden.Check(t, "grades", got.Bytes(), "testdata/grades.tsv")
}

// testdata/edge.want.* are the output and report for testdata/edge.geojsonl: every drop
// reason, numbers and bools and lists as grades, names that are not strings, @id
// duplicates (only an id written the same way twice: 5, 5.0, true and "5" are four ids),
// no @id, and more unreadable values than the report lists. Features are compared parsed,
// not as bytes. -update rewrites them.
func TestEdgeCases(t *testing.T) {
	out := filepath.Join(t.TempDir(), "final.geojsonl")
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
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []any
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var v any
		if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

// A line that is not a feature is an error, not a skipped line: the export is broken.
func TestRefusesMalformedFeatures(t *testing.T) {
	line := `{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}`
	for _, bad := range []string{
		`[1]`,
		`{"geometry": [1], "properties": {"sac_scale": "hiking"}}`,
		`{"geometry": ` + line + `, "properties": [1]}`,
	} {
		c := counts{unparsed: map[string]int{}}
		var buf bytes.Buffer
		if err := feature([]byte(bad), bufio.NewWriter(&buf), map[string]struct{}{}, &c); err == nil {
			t.Errorf("feature(%s): want an error", bad)
		}
	}
	// A missing or null geometry is not a line, null properties carry no grade, and a
	// number too big to be a grade is not one.
	for _, ok := range []string{
		`{"geometry": null, "properties": {"sac_scale": "hiking"}}`,
		`{"geometry": ` + line + `, "properties": null}`,
		`{"geometry": ` + line + `, "properties": {"sac_scale": 1e400}}`,
	} {
		c := counts{unparsed: map[string]int{}}
		var buf bytes.Buffer
		if err := feature([]byte(ok), bufio.NewWriter(&buf), map[string]struct{}{}, &c); err != nil || c.kept != 0 {
			t.Errorf("feature(%s): err %v, kept %d", ok, err, c.kept)
		}
	}
}
