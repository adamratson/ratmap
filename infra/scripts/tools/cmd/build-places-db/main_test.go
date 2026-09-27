package main

import (
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

	"ratmap/infra/tools/internal/golden"
)

// testdata/edge.want.* are the summary and every row for testdata/edge.geojsonl read
// twice, dumped as dumpRows does. The fixture walks every rule: population spellings read
// and refused, negative and zero populations, bool values standing in for numbers, the
// kind precedence, skipped names and geometries, duplicates to the 4th decimal including
// -0.0, a record separator and a blank line. -update rewrites them.
func TestEdgeCases(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "places.sqlite")
	var out bytes.Buffer
	if err := build([]string{"testdata/edge.geojsonl", "testdata/edge.geojsonl"}, dest, &out); err != nil {
		t.Fatal(err)
	}
	golden.Check(t, "summary", out.Bytes(), "testdata/edge.want.stdout")
	golden.Check(t, "rows", []byte(strings.Join(dumpRows(t, dest), "\n")+"\n"), "testdata/edge.want.rows")
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

// testdata/population.tsv is each of 3,000-odd population values (JSON) and what it reads
// as, or ERR: thousands separators, signs, spaces of every kind, digits in other scripts,
// underscores, fractions and words. -update rewrites it.
func TestPopulation(t *testing.T) {
	data, err := os.ReadFile("testdata/population.tsv")
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	n := 0
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		in, _, _ := strings.Cut(line, "\t")
		v, ok := population(json.RawMessage(in))
		out := "ERR"
		if ok {
			out = strconv.FormatInt(v, 10)
		}
		got.WriteString(in + "\t" + out + "\n")
		n++
	}
	if n < 3000 {
		t.Fatalf("only %d vectors", n)
	}
	golden.Check(t, "populations", got.Bytes(), "testdata/population.tsv")
	for raw, want := range map[string]string{`5000`: "5000", `-0`: "ERR", `-5`: "ERR", `"+5"`: "5", `"99999999999999999999"`: "ERR",
		`1.5e6`: "ERR", `1000.0`: "ERR", `true`: "ERR", `null`: "ERR", `[1]`: "ERR"} {
		v, ok := population(json.RawMessage(raw))
		got := "ERR"
		if ok {
			got = strconv.FormatInt(v, 10)
		}
		if got != want {
			t.Errorf("population(%s): got %s, want %s", raw, got, want)
		}
	}
}

// A line that is not a feature is an error, not a skipped line: the export is broken.
func TestRefusesMalformedFeatures(t *testing.T) {
	for _, line := range []string{
		`[1]`,
		`{"properties": [1]}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": "point"}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": [1]}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point"}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": [1]}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": "ab"}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": ["a", "b"]}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": {"type": "Point", "coordinates": [true, 46.5]}}`,
		`{"properties": {"name": "x", "natural": "peak"}, "geometry": 0}`,
	} {
		if _, _, err := placeRow([]byte(line)); err == nil {
			t.Errorf("placeRow(%s): want an error", line)
		}
	}
	// Values that are merely unusable skip the feature, or the value.
	for _, line := range []string{
		`{"properties": null}`,
		`{"properties": {"name": "x", "place": ["city"]}}`,
		`{"properties": {"name": "x", "natural": {"a": 1}}}`,
	} {
		if _, ok, err := placeRow([]byte(line)); ok || err != nil {
			t.Errorf("placeRow(%s): ok %v, err %v; want skipped", line, ok, err)
		}
	}
	r, ok, err := placeRow([]byte(`{"properties": {"name": "x", "place": "town", "population": "99999999999999999999"}, "geometry": {"type": "Point", "coordinates": [1, 2]}}`))
	if !ok || err != nil || r.population != nil {
		t.Errorf("a population past int64: row %+v, ok %v, err %v; want a row with no population", r, ok, err)
	}
}

// A failed build must not leave a half-built index where upload.sh would find it.
func TestFailedBuildLeavesNoFile(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.geojsonl")
	good := "testdata/edge.geojsonl"
	os.WriteFile(bad, []byte(`{"properties": [1]}`+"\n"), 0o644)
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
