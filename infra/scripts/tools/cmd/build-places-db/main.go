// Command build-places-db builds places.sqlite, the offline search index (C9: no
// geocoding API, ever).
//
//	build-places-db SOURCE.geojsonl... DEST.sqlite
//
// A port of scripts/build-places-db.py, which it replaces in build-places.sh: same
// arguments, same summary, and the same database — built from the same input, the two
// files differ only in the header bytes recording which SQLite version wrote them
// (2026-09-25: Scotland, Montenegro and Liechtenstein, and 1.5 M synthetic places; every
// row identical to the float bit and storage type, and the app's own search, through its
// sqlite-wasm 3.41.2, returning identical results from both).
//
// Input: one or more line-delimited GeoJSON files of point features (places and peaks), as
// produced by normalize-peaks.py. Output: a SQLite DB with an FTS5 index over names.
//
// SQLite is modernc.org/sqlite: SQLite's C translated to Go, so no C compiler and no
// system library, and FTS5 with the unicode61 tokenizer's diacritic folding built in —
// the one pure-Go driver of three tried that had it (2026-09-25). It is slower than the C
// library Python used (11.4 s against 7.3 s on 1.5 M places) and it is the reason this
// module has dependencies at all; what it buys is not holding every row in memory, which
// the Python did (349 MB against 809 MB on those 1.5 M).
//
// Schema note: FTS5 is used in `content=` (external content) mode, so names aren't stored
// twice. The whole DB ships to the client and is queried in-browser, so every byte counts.
package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	_ "modernc.org/sqlite"

	"ratmap/infra/tools/internal/pyfloat"
)

// Settlement kinds worth searching. Deliberately excludes isolated_dwelling/farm/locality:
// they add tens of thousands of rows for names nobody searches on a mountain map.
var placeKinds = map[string]bool{"city": true, "town": true, "village": true, "hamlet": true, "suburb": true}
var peakKinds = map[string]bool{"peak": true, "volcano": true, "saddle": true}

// Higher sorts first when scores tie. Settlements above summits: someone typing "Fort"
// most likely wants Fort William the town, not a nearby cairn.
var kindRank = map[string]int64{
	"city":          60,
	"town":          50,
	"village":       40,
	"suburb":        35,
	"hamlet":        30,
	"peak":          25,
	"volcano":       25,
	"saddle":        12,
	"mountain_pass": 12,
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: build-places-db SOURCE.geojsonl... DEST.sqlite")
		os.Exit(2)
	}
	if err := run(os.Args[1:len(os.Args)-1], os.Args[len(os.Args)-1], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "build-places-db:", err)
		os.Exit(1)
	}
}

// run builds dest, and removes it if the build fails: not left behind looking like an
// index. The Python left a half-built file there, in dist/, for upload.sh to find.
func run(sources []string, dest string, out io.Writer) error {
	err := build(sources, dest, out)
	if err != nil {
		os.Remove(dest)
	}
	return err
}

func build(sources []string, dest string, out io.Writer) error {
	db, err := sql.Open("sqlite", dest)
	if err != nil {
		return err
	}
	defer db.Close()
	// One connection: the pragmas below are per connection, and database/sql would
	// otherwise hand later statements a fresh one without them.
	db.SetMaxOpenConns(1)

	if err := execAll(db,
		`PRAGMA journal_mode = OFF`,
		`PRAGMA synchronous = OFF`,
		`DROP TABLE IF EXISTS places`,
		`CREATE TABLE places (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            kind       TEXT NOT NULL,
            lat        REAL NOT NULL,
            lon        REAL NOT NULL,
            ele        REAL,
            population INTEGER,
            rank       INTEGER NOT NULL
        )`,
	); err != nil {
		return err
	}

	// Rows go in as they are read, in one transaction, rather than being collected first
	// as the Python did: same rows, same order, same ids, and memory is the dedupe set
	// rather than every row (349 MB against the Python's 809 MB on 1.5 M places).
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	insert, err := tx.Prepare(`INSERT INTO places (name, kind, lat, lon, ele, population, rank)` +
		` VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	seen := map[dedupeKey]struct{}{}
	for _, path := range sources {
		err := eachLine(path, func(line []byte) error {
			r, ok, err := placeRow(line)
			if err != nil || !ok {
				return err
			}
			// The same feature can appear in overlapping extracts; dedupe on
			// name+rounded position rather than OSM id, which differs across sources.
			k := dedupeKey{r.name, r.kind, pyfloat.Round(r.lat, 4), pyfloat.Round(r.lon, 4)}
			if _, dup := seen[k]; dup {
				return nil
			}
			seen[k] = struct{}{}
			_, err = insert.Exec(r.name, r.kind, r.lat, r.lon, r.ele, r.population, r.rank)
			return err
		})
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	if err := execAll(db,
		`DROP TABLE IF EXISTS places_fts`,
		`CREATE VIRTUAL TABLE places_fts USING fts5(
            name,
            content='places',
            content_rowid='id',
            tokenize="unicode61 remove_diacritics 2"
        )`,
		`INSERT INTO places_fts (rowid, name) SELECT id, name FROM places`,
		// Distance ranking is done in the client against the live viewport, so the only
		// index worth carrying is the one FTS5 needs plus a rank index for tie-breaks.
		`CREATE INDEX idx_places_rank ON places(rank DESC)`,
		`VACUUM`,
	); err != nil {
		return err
	}
	return report(db, out)
}

func execAll(db *sql.DB, stmts ...string) error {
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("%w in: %s", err, s)
		}
	}
	return nil
}

func report(db *sql.DB, out io.Writer) error {
	type kindCount struct {
		kind  string
		count int
	}
	rows, err := db.Query(`SELECT kind, COUNT(*) FROM places GROUP BY kind`)
	if err != nil {
		return err
	}
	var counts []kindCount
	for rows.Next() {
		var c kindCount
		if err := rows.Scan(&c.kind, &c.count); err != nil {
			rows.Close()
			return err
		}
		counts = append(counts, c)
	}
	rows.Close()
	var total int
	if err := db.QueryRow(`SELECT COUNT(*) FROM places`).Scan(&total); err != nil {
		return err
	}
	// Stable, so equal counts keep the query's order — Python's sorted() on the same rows.
	sort.SliceStable(counts, func(a, b int) bool { return counts[a].count > counts[b].count })
	fmt.Fprintf(out, "places.sqlite: %d rows\n", total)
	for _, c := range counts {
		fmt.Fprintf(out, "  %s: %d\n", c.kind, c.count)
	}
	return nil
}

// eachLine calls fn with every non-blank line of a line-delimited GeoJSON file, stripped
// of an RFC 8142 record separator and surrounding whitespace.
func eachLine(path string, fn func([]byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pyIsSpace); len(line) > 0 {
			if err := fn(line); err != nil {
				return fmt.Errorf("%s: line %d: %w", path, n, err)
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

type dedupeKey struct {
	name, kind string
	lat, lon   float64
}

type place struct {
	name, kind string
	lat, lon   float64
	ele        any // float64, or nil for NULL
	population any // int64, or nil for NULL
	rank       int64
}

// placeRow turns one feature into a row, ok=false to skip it. It errs where the Python
// raised — properties that are not an object, a place or natural tag that is a list or
// dict, a geometry that is truthy but not an object, a Point without two numeric
// coordinates — so the stage fails where it failed.
func placeRow(line []byte) (place, bool, error) {
	var feature map[string]json.RawMessage
	if err := json.Unmarshal(line, &feature); err != nil {
		return place{}, false, err
	}

	// feature.get("properties", {})
	props := map[string]json.RawMessage{}
	if p, ok := feature["properties"]; ok {
		if err := json.Unmarshal(p, &props); err != nil || props == nil {
			return place{}, false, fmt.Errorf("properties is %s, not an object", p)
		}
	}
	name, ok := str(props["name"])
	if !ok || name == "" {
		return place{}, false, nil
	}

	kind, population, ok, err := classify(props)
	if err != nil || !ok {
		return place{}, false, err
	}

	// (feature.get("geometry") or {}).get("type") != "Point"
	var geometry map[string]json.RawMessage
	if g, ok := feature["geometry"]; ok && !falsy(g) {
		if err := json.Unmarshal(g, &geometry); err != nil {
			return place{}, false, fmt.Errorf("geometry is %s, not an object", g)
		}
	}
	if t, ok := str(geometry["type"]); !ok || t != "Point" {
		return place{}, false, nil
	}

	// lon, lat = geometry["coordinates"][:2]
	c, ok := geometry["coordinates"]
	if !ok {
		return place{}, false, errors.New("Point has no coordinates")
	}
	var coords []json.RawMessage
	if err := json.Unmarshal(c, &coords); err != nil || len(coords) < 2 {
		return place{}, false, fmt.Errorf("coordinates %s: not a list of two or more", c)
	}
	lon, ok1 := num(coords[0])
	lat, ok2 := num(coords[1])
	if !ok1 || !ok2 {
		return place{}, false, fmt.Errorf("coordinates %s are not numbers", c)
	}

	r := place{name: name, kind: kind, lat: lat, lon: lon}
	// float(ele) if isinstance(ele, (int, float)) else None
	if e, ok := num(props["ele"]); ok {
		r.ele = e
	}
	// population or None: an unset or zero population is NULL, not 0.
	if population != 0 {
		r.population = population
	}
	r.rank = kindRank[kind] + min(floorDiv(population, 1000), 40)
	return r, true, nil
}

// classify returns (kind, population), ok=false to skip the feature.
func classify(props map[string]json.RawMessage) (string, int64, bool, error) {
	if p, ok := props["place"]; ok {
		if unhashable(p) {
			return "", 0, false, fmt.Errorf("place is %s (unhashable in Python)", p)
		}
		if s, ok := str(p); ok && placeKinds[s] {
			// Population drives ranking among settlements; a city with no population tag
			// still outranks a hamlet via the kind ordering.
			var population int64
			if raw, ok := props["population"]; ok {
				n, ok, err := toInt(raw)
				if err != nil {
					return "", 0, false, err
				}
				if ok {
					population = n
				}
			}
			return s, population, true, nil
		}
	}
	if n, ok := props["natural"]; ok {
		if unhashable(n) {
			return "", 0, false, fmt.Errorf("natural is %s (unhashable in Python)", n)
		}
		if s, ok := str(n); ok && peakKinds[s] {
			return s, 0, true, nil
		}
	}
	if s, ok := str(props["mountain_pass"]); ok && s == "yes" {
		return "mountain_pass", 0, true, nil
	}
	return "", 0, false, nil
}

// floorDiv is Python's //: it rounds toward negative infinity, where Go's / truncates.
// A population of -5 is rank - 1 in Python, not rank + 0.
func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}
