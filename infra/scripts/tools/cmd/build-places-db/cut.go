package main

// The indexes that ship, cut from the full one.
//
// A planet's places and summits come to ~5.1 M rows, a few hundred MB as an index, and the
// app holds its search indexes in memory to answer offline. So the full index is never
// shipped. What ships is:
//
//   - one index per catalogue region, `<id>-places-1.sqlite`, published beside the
//     region's archives and downloaded with them — every place and summit in its bbox;
//   - a global fallback, precached with the app shell, for search before any region is
//     downloaded: the largest cities and towns, and the highest summits notable enough to
//     have a Wikidata item. Small by construction, since the app shell precaches it.
//
// All three have the app's schema exactly (src/search/search.ts reads them alike); the
// working-only `notable` column stays behind in the full index.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The fallback's size. At ~80 bytes a row that is ~4 MB, under the 6 MiB the service
// worker precaches a file up to (vite.config.ts: maximumFileSizeToCacheInBytes), which
// build-places.sh checks.
const (
	defaultFallbackPlaces  = 30_000
	defaultFallbackSummits = 20_000
)

// regionIndexName is the artifact's filename: C3 unique through the region id, and
// versioned like peaks-1 because a device skips an artifact whose name it already holds,
// so a rebuild needs a new name to reach one.
func regionIndexName(id string) string { return id + "-places-1.sqlite" }

const shippedColumns = `name, kind, lat, lon, ele, population, rank`

// writeIndex writes dest as a search index holding the rows `query` selects from the full
// index (attached as `src`, returning shippedColumns), and returns how many there were.
// Built under a temporary name and renamed into place, so an interrupted run never leaves
// a half-built index where build-manifest and upload.sh would find it.
func writeIndex(full, dest, query string, args ...any) (int, error) {
	tmp := dest + ".building"
	os.Remove(tmp)
	n, err := func() (int, error) {
		db, err := sql.Open("sqlite", tmp)
		if err != nil {
			return 0, err
		}
		defer db.Close()
		db.SetMaxOpenConns(1)
		if err := execAll(db,
			`PRAGMA journal_mode = OFF`,
			`PRAGMA synchronous = OFF`,
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
			return 0, err
		}
		if _, err := db.Exec(`ATTACH DATABASE ? AS src`, full); err != nil {
			return 0, err
		}
		if _, err := db.Exec(`INSERT INTO places (`+shippedColumns+`) `+query, args...); err != nil {
			return 0, fmt.Errorf("%w in: %s", err, query)
		}
		if err := execAll(db, `DETACH DATABASE src`); err != nil {
			return 0, err
		}
		if err := finishIndex(db); err != nil {
			return 0, err
		}
		var n int
		return n, db.QueryRow(`SELECT COUNT(*) FROM places`).Scan(&n)
	}()
	if err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return n, os.Rename(tmp, dest)
}

// finishIndex adds the name index and the rank index to a filled places table, and
// compacts the file.
func finishIndex(db *sql.DB) error {
	return execAll(db,
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
		`CREATE INDEX IF NOT EXISTS idx_places_rank ON places(rank DESC)`,
		`VACUUM`,
	)
}

type catalogueRegion struct {
	ID   string    `json:"id"`
	BBox []float64 `json:"bbox"`
}

// cutRegions writes regions/<id>/<id>-places-1.sqlite under outDir for every region in
// the catalogue with anything in its bbox, and removes a stale one for a region that now
// has nothing.
func cutRegions(full, regionsJSON, outDir string, out io.Writer) error {
	data, err := os.ReadFile(regionsJSON)
	if err != nil {
		return err
	}
	var doc struct {
		Regions []catalogueRegion `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("%s: %w", regionsJSON, err)
	}

	db, err := sql.Open("sqlite", full)
	if err != nil {
		return err
	}
	defer db.Close()
	// For the bbox queries below; the full index is a working copy, never shipped.
	if err := execAll(db, `CREATE INDEX IF NOT EXISTS idx_places_lat ON places(lat)`); err != nil {
		return err
	}

	type written struct {
		id    string
		rows  int
		bytes int64
	}
	var done []written
	empty := 0
	for _, r := range doc.Regions {
		if r.ID == "" || strings.ContainsAny(r.ID, `/\`) || strings.Contains(r.ID, "..") {
			return fmt.Errorf("%s: region id %q cannot be a filename", regionsJSON, r.ID)
		}
		if len(r.BBox) != 4 {
			return fmt.Errorf("%s: region %s: bbox is not four numbers", regionsJSON, r.ID)
		}
		w, s, e, n := r.BBox[0], r.BBox[1], r.BBox[2], r.BBox[3]
		dir := filepath.Join(outDir, "regions", r.ID)
		dest := filepath.Join(dir, regionIndexName(r.ID))

		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
			s, n, w, e).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			// Nothing to search there — open ocean, ice. No artifact, and not yesterday's.
			if err := os.Remove(dest); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			empty++
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		rows, err := writeIndex(full, dest,
			`SELECT `+shippedColumns+` FROM src.places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY id`,
			s, n, w, e)
		if err != nil {
			return fmt.Errorf("region %s: %w", r.ID, err)
		}
		st, err := os.Stat(dest)
		if err != nil {
			return err
		}
		done = append(done, written{r.ID, rows, st.Size()})
	}

	var rows int
	var bytes int64
	for _, w := range done {
		rows += w.rows
		bytes += w.bytes
	}
	fmt.Fprintf(out, "region indexes: %d written, %d rows, %.1f MB in all; %d region(s) with no places\n",
		len(done), rows, float64(bytes)/1e6, empty)
	sort.Slice(done, func(i, j int) bool { return done[i].bytes > done[j].bytes })
	for _, w := range done[:min(3, len(done))] {
		fmt.Fprintf(out, "  %s: %d rows, %.1f MB\n", w.id, w.rows, float64(w.bytes)/1e6)
	}
	return nil
}

// cutFallback writes the global fallback: the `places` largest cities and towns (cities
// first, then by population) and the `summits` highest peaks and volcanoes with a
// Wikidata item.
func cutFallback(full, dest string, places, summits int, out io.Writer) error {
	rows, err := writeIndex(full, dest, `SELECT `+shippedColumns+` FROM (
            SELECT * FROM (SELECT * FROM src.places WHERE kind IN ('city', 'town')
                ORDER BY kind = 'city' DESC, COALESCE(population, 0) DESC, id LIMIT ?)
            UNION ALL
            SELECT * FROM (SELECT * FROM src.places WHERE kind IN ('peak', 'volcano') AND notable = 1
                ORDER BY ele IS NULL, ele DESC, id LIMIT ?)
        ) ORDER BY id`, places, summits)
	if err != nil {
		return fmt.Errorf("fallback: %w", err)
	}
	st, err := os.Stat(dest)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "fallback index: %d rows, %.1f MB -> %s\n", rows, float64(st.Size())/1e6, dest)
	return nil
}
