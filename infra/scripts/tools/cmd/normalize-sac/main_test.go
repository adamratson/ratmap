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
)

func TestSelfTest(t *testing.T) {
	if f := selfTest(); len(f) > 0 {
		t.Fatalf("self-test failed:\n  %s", strings.Join(f, "\n  "))
	}
}

// testdata/grades.tsv is the Python's parse_grade, and repr(str(value)) as its report
// printed it, on 6,000-odd values (testdata/gen-vectors.py): the documented ones, the
// oddities taginfo lists, and random mixtures of every separator, shorthand form, bracket,
// Unicode space, dash, digit and case trap the parser meets.
func TestParseGradeMatchesPython(t *testing.T) {
	f, err := os.Open("testdata/grades.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "\t")
		value, wantGrade := json.RawMessage(cols[0]), cols[1]
		var wantRepr string
		json.Unmarshal([]byte(cols[2]), &wantRepr)

		g, ok, err := parseGrade(value)
		got := "None"
		if err != nil {
			got = "ERROR " + err.Error()
		} else if ok {
			got = strconv.Itoa(g)
		}
		if got != wantGrade {
			t.Errorf("parse_grade(%s): got %s, Python %s", value, got, wantGrade)
		}
		if r := pyReprString(pyStrValue(value)); r != wantRepr {
			t.Errorf("repr(str(%s)): got %s, Python %s", value, r, wantRepr)
		}
		n++
	}
	if n < 6000 {
		t.Fatalf("only %d vectors", n)
	}
}

// testdata/edge.want.* are the Python's output and report for testdata/edge.geojsonl:
// every drop reason, numbers and bools and lists as grades, names that are not strings,
// @id duplicates by Python's rules (5 == 5.0 == True-as-1, "5" is not), no @id, and more
// unreadable values than the report lists. Features are compared parsed, not as bytes.
func TestMatchesPython(t *testing.T) {
	out := filepath.Join(t.TempDir(), "final.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/edge.want.stdout")
	if report.String() != string(want) {
		t.Errorf("report differs:\n got:\n%s\n want:\n%s", report.String(), want)
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

// Where the Python raised, this must fail too rather than write something new.
func TestRefusesWhatPythonRaisedOn(t *testing.T) {
	line := `{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}`
	for _, bad := range []string{
		`[1]`,
		`{"geometry": null, "properties": {"sac_scale": "hiking"}}`,
		`{"geometry": [1], "properties": {"sac_scale": "hiking"}}`,
		`{"geometry": ` + line + `, "properties": null}`,
		`{"geometry": ` + line + `, "properties": {"sac_scale": "hiking", "@id": [1]}}`,
		`{"geometry": ` + line + `, "properties": {"sac_scale": 1e400}}`,
	} {
		c := counts{unparsed: map[string]int{}}
		var buf bytes.Buffer
		if err := feature([]byte(bad), bufio.NewWriter(&buf), map[string]struct{}{}, &c); err == nil {
			t.Errorf("feature(%s): want an error, as Python raises", bad)
		}
	}
	// And where it did not: properties that are not an object were only read on a line.
	c := counts{unparsed: map[string]int{}}
	var buf bytes.Buffer
	if err := feature([]byte(`{"geometry": {"type": "Point"}, "properties": null}`), bufio.NewWriter(&buf), map[string]struct{}{}, &c); err != nil || c.notALine != 1 {
		t.Errorf("a non-line with null properties: err %v, notALine %d; Python skipped it", err, c.notALine)
	}
}
