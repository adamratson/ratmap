package main

import (
	"bytes"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func feature(name, key, value string, lon, lat float64, extra string) string {
	return fmt.Sprintf(`{"type":"Feature","geometry":{"type":"Point","coordinates":[%v,%v]},"properties":{"name":%q,%q:%q%s}}`,
		lon, lat, name, key, value, extra)
}

// names runs query against the index at path and returns the first column, in order.
func names(t *testing.T, path, query string, args ...any) []string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func TestCutRegionsAndFallback(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.geojsonl")
	lines := []string{
		feature("Fort William", "place", "town", -5.1, 56.82, `,"population":"10459","wikidata":"Q1"`),
		feature("Onich", "place", "village", -5.22, 56.71, ``),
		feature("Ben Nevis", "natural", "peak", -5.0036, 56.7969, `,"ele":1345,"wikidata":"Q2"`),
		feature("Carn Beag", "natural", "peak", -5.01, 56.79, `,"ele":900`),
		feature("Podgorica", "place", "city", 19.26, 42.44, `,"population":"150977"`),
		feature("Bobotov Kuk", "natural", "peak", 19.03, 43.13, `,"ele":2523,"wikidata":"Q3"`),
	}
	os.WriteFile(src, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	regions := filepath.Join(dir, "regions.json")
	os.WriteFile(regions, []byte(`{"regions": [
		{"id": "lochaber", "bbox": [-5.5, 56.6, -4.6, 57.0]},
		{"id": "montenegro", "bbox": [18.4, 41.8, 20.4, 43.6]},
		{"id": "sea", "bbox": [-20.0, 50.0, -19.0, 51.0]}]}`), 0o644)
	out := filepath.Join(dir, "dist")
	// A stale index for a region that now has nothing must not survive a rebuild.
	os.MkdirAll(filepath.Join(out, "regions", "sea"), 0o755)
	os.WriteFile(filepath.Join(out, "regions", "sea", "sea-places-1.sqlite"), []byte("old"), 0o644)

	full := filepath.Join(dir, "full.sqlite")
	var report bytes.Buffer
	if err := run([]string{src}, full, &report); err != nil {
		t.Fatal(err)
	}
	if err := cutRegions(full, regions, out, &report); err != nil {
		t.Fatal(err)
	}
	fallback := filepath.Join(out, "places.sqlite")
	if err := cutFallback(full, fallback, 10, 10, &report); err != nil {
		t.Fatal(err)
	}

	lochaber := filepath.Join(out, "regions", "lochaber", "lochaber-places-1.sqlite")
	if got := names(t, lochaber, `SELECT name FROM places ORDER BY name`); !reflect.DeepEqual(got,
		[]string{"Ben Nevis", "Carn Beag", "Fort William", "Onich"}) {
		t.Errorf("lochaber holds %q", got)
	}
	// Searchable as the app searches it.
	if got := names(t, lochaber, `SELECT p.name FROM places_fts f JOIN places p ON p.id = f.rowid
		WHERE places_fts MATCH ?`, `"onic"*`); !reflect.DeepEqual(got, []string{"Onich"}) {
		t.Errorf("MATCH onic*: %q", got)
	}
	// The app's schema exactly: the working-only notable column stays behind.
	if got := names(t, lochaber, `SELECT name FROM pragma_table_info('places') ORDER BY cid`); !reflect.DeepEqual(got,
		[]string{"id", "name", "kind", "lat", "lon", "ele", "population", "rank"}) {
		t.Errorf("columns %q", got)
	}
	if got := names(t, filepath.Join(out, "regions", "montenegro", "montenegro-places-1.sqlite"),
		`SELECT name FROM places ORDER BY name`); !reflect.DeepEqual(got, []string{"Bobotov Kuk", "Podgorica"}) {
		t.Errorf("montenegro holds %q", got)
	}
	if _, err := os.Stat(filepath.Join(out, "regions", "sea", "sea-places-1.sqlite")); !os.IsNotExist(err) {
		t.Errorf("sea: a stale index survived (%v)", err)
	}
	// Cities and towns, and only the summits with a Wikidata item: no village, no Carn Beag.
	if got := names(t, fallback, `SELECT name FROM places ORDER BY name`); !reflect.DeepEqual(got,
		[]string{"Ben Nevis", "Bobotov Kuk", "Fort William", "Podgorica"}) {
		t.Errorf("fallback holds %q", got)
	}
	// Limits taken largest first: cities before towns, higher summits before lower.
	small := filepath.Join(dir, "small.sqlite")
	if err := cutFallback(full, small, 1, 1, &report); err != nil {
		t.Fatal(err)
	}
	if got := names(t, small, `SELECT name FROM places ORDER BY name`); !reflect.DeepEqual(got,
		[]string{"Bobotov Kuk", "Podgorica"}) {
		t.Errorf("fallback of one each holds %q", got)
	}
	if strings.Contains(report.String(), ".building") {
		t.Errorf("report mentions a temporary file: %s", report.String())
	}
	matches, _ := filepath.Glob(filepath.Join(out, "regions", "*", "*.building"))
	if len(matches) > 0 {
		t.Errorf("left behind %q", matches)
	}
}
