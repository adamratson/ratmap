package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// testdata/edge.want.* were written by the Python this replaced, from
// testdata/edge.geojsonl read twice, and dumped as dumpRows does. The fixture walks every rule: each
// population spelling int() accepts or refuses, negative and zero populations, bool
// values standing in for ints, the kind precedence, skipped names and geometries,
// duplicates to the 4th decimal including -0.0, a record separator and a blank line.
func TestMatchesPython(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "places.sqlite")
	var out bytes.Buffer
	if err := build([]string{"testdata/edge.geojsonl", "testdata/edge.geojsonl"}, dest, &out); err != nil {
		t.Fatal(err)
	}
	wantOut, _ := os.ReadFile("testdata/edge.want.stdout")
	if out.String() != string(wantOut) {
		t.Errorf("summary differs:\n got:\n%s\n want:\n%s", out.String(), wantOut)
	}

	got := dumpRows(t, dest)
	want := strings.Split(strings.TrimRight(readFile(t, "testdata/edge.want.rows"), "\n"), "\n")
	if len(got) != len(want) {
		t.Fatalf("%d rows, Python wrote %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d:\n got  %s\n want %s", i+1, got[i], want[i])
		}
	}
}

// dumpRows renders each row of places, in id order, as the golden dump did: one JSON
// array per row, each value with its SQLite storage type, and every REAL as the hex of
// its IEEE 754 bits, so the comparison is exact.
func dumpRows(t *testing.T, path string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cols := []string{"id", "name", "kind", "lat", "lon", "ele", "population", "rank"}
	var sel []string
	for _, c := range cols {
		sel = append(sel, c, "typeof("+c+")")
	}
	rows, err := db.Query("SELECT " + strings.Join(sel, ", ") + " FROM places ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		vals := make([]any, 2*len(cols))
		ptrs := make([]any, len(vals))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		var parts []string
		for i := 0; i < len(vals); i += 2 {
			kind := vals[i+1].(string)
			var v string
			switch kind {
			case "real":
				v = fmt.Sprintf(`"%016x"`, math.Float64bits(vals[i].(float64)))
			case "null":
				v = "null"
			case "text":
				b, _ := json.Marshal(vals[i])
				v = string(b)
			default:
				v = strconv.FormatInt(vals[i].(int64), 10)
			}
			parts = append(parts, fmt.Sprintf(`["%s", %s]`, kind, v))
		}
		out = append(out, "["+strings.Join(parts, ", ")+"]")
	}
	return out
}

// The index has to answer the app's queries: prefix, multi-token, and diacritic-folded
// (remove_diacritics 2 — someone typing "palu" wants Piz Palü).
func TestSearchIndex(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "places.sqlite")
	if err := build([]string{"testdata/edge.geojsonl"}, dest, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	db, _ := sql.Open("sqlite", dest)
	defer db.Close()
	for match, want := range map[string]string{
		`"palu"*`:              "Piz Palü",
		`"skrlat"*`:            "Škrlatica",
		`"ben" "nevis"*`:       "Ben Nevis",
		`"fort" "w"*`:          "Fort William",
		`"bealach" "na" "ba"*`: "Bealach na Bà",
	} {
		var name string
		err := db.QueryRow(`SELECT p.name FROM places_fts f JOIN places p ON p.id = f.rowid
			WHERE places_fts MATCH ? ORDER BY p.rank DESC LIMIT 1`, match).Scan(&name)
		if err != nil || name != want {
			t.Errorf("MATCH %s: got %q (%v), want %q", match, name, err, want)
		}
	}
	var check string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil || check != "ok" {
		t.Errorf("integrity_check: %q %v", check, err)
	}
	if _, err := db.Exec(`INSERT INTO places_fts(places_fts) VALUES('integrity-check')`); err != nil {
		t.Errorf("FTS5 integrity-check: %v", err)
	}
}

// testdata/python-int.tsv is CPython's int() on 3,000-odd population strings.
func TestToIntMatchesCPython(t *testing.T) {
	f, err := os.Open("testdata/python-int.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		in, want, _ := strings.Cut(sc.Text(), "\t")
		v, ok, err := toInt(json.RawMessage(in))
		got := "ERR"
		if err != nil {
			got = "OVERFLOW"
		} else if ok {
			got = strconv.FormatInt(v, 10)
		}
		if got != want {
			t.Errorf("int(%s): got %s, Python %s", in, got, want)
		}
		n++
	}
	if n < 3000 {
		t.Fatalf("only %d vectors", n)
	}
	// Python's int is unbounded; SQLite's INTEGER is not, and binding it raised.
	if _, _, err := toInt(json.RawMessage(`"99999999999999999999"`)); err == nil {
		t.Error("a population past int64 must fail, as binding it did in Python")
	}
	// Non-strings, as str() would have spelled them.
	for raw, want := range map[string]string{`5000`: "5000", `-0`: "0", `1.5e6`: "ERR", `1000.0`: "ERR", `true`: "ERR", `null`: "ERR", `[1]`: "ERR"} {
		v, ok, _ := toInt(json.RawMessage(raw))
		got := "ERR"
		if ok {
			got = strconv.FormatInt(v, 10)
		}
		if got != want {
			t.Errorf("to_int(%s): got %s, want %s", raw, got, want)
		}
	}
}

// Where the Python raised, this must fail too rather than write a row it never wrote.
func TestRefusesWhatPythonRaisedOn(t *testing.T) {
	for _, line := range []string{
		`[1]`,
		`{"properties": null}`,
		`{"properties": [1]}`,
		`{"properties": {"name": "x", "place": ["city"]}}`,
		`{"properties": {"name": "x", "natural": {"a": 1}}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": "point"}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": [1]}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point"}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": [1]}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": "ab"}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": ["a", "b"]}}`,
		`{"properties": {"name": "x", "place": "town", "population": "99999999999999999999"}, "geometry": {"type": "Point", "coordinates": [1, 2]}}`,
	} {
		if _, _, err := placeRow([]byte(line)); err == nil {
			t.Errorf("placeRow(%s): want an error, as Python raises", line)
		}
	}
}

// A failed build must not leave a half-built index where upload.sh would find it.
func TestFailedBuildLeavesNoFile(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.geojsonl")
	good := "testdata/edge.geojsonl"
	os.WriteFile(bad, []byte(`{"properties": null}`+"\n"), 0o644)
	dest := filepath.Join(dir, "places.sqlite")
	// The good file first, so rows exist when the bad one fails.
	if err := run([]string{good, bad}, dest, &bytes.Buffer{}); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("a failed build left %s behind", dest)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
