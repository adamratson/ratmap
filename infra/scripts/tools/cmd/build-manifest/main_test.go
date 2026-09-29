package main

import (
	"database/sql"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// testdata/valid.pmtiles is a real archive (Liechtenstein's avalanche layer). The checks
// below break copies of it the ways a real archive breaks.
func TestZoomRange(t *testing.T) {
	valid, err := os.ReadFile("testdata/valid.pmtiles")
	if err != nil {
		t.Fatal(err)
	}
	minZ, maxZ, err := zoomRange("testdata/valid.pmtiles")
	if err != nil || minZ != int(valid[100]) || maxZ != int(valid[101]) {
		t.Fatalf("valid archive: %d-%d, %v", minZ, maxZ, err)
	}

	dir := t.TempDir()
	write := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, data, 0o644)
		return p
	}
	v2 := append([]byte(nil), valid...)
	v2[7] = 2
	huge := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint64(huge[40:], ^uint64(0)-10) // offset + length would overflow uint64
	for name, c := range map[string]struct {
		data []byte
		want string
	}{
		"zeroed":    {make([]byte, 4096), "no PMTiles magic number"},
		"short":     {valid[:100], "no PMTiles magic number"},
		"version":   {v2, "spec version 2; this reads version 3"},
		"truncated": {valid[:len(valid)-1], "tile data runs past the end of the file"},
		"overflow":  {huge, "leaf directories runs past the end of the file"},
	} {
		_, _, err := zoomRange(write(name+".pmtiles", c.data))
		want := "FAIL: " + name + ".pmtiles is not a readable PMTiles archive (" + c.want + ").\n      Rebuild it; do not publish this manifest."
		if err == nil || err.Error() != want {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func TestArtifactKind(t *testing.T) {
	for name, want := range map[string]string{
		"scotland-basemap.pmtiles":            "basemap",
		"scotland-terrain.pmtiles":            "terrain",
		"scotland-terrain-features.pmtiles":   "terrain-features",
		"aragon-avalanche-1.pmtiles":          "avalanche",
		"aragon-avalanche-2.pmtiles":          "",
		"x-peaks-1.pmtiles":                   "peaks",
		".scotland-contours.building.pmtiles": "",
		"scotland-contours.pmtiles":           "contours",
		"scotland-places-1.sqlite":            "places",
		"scotland-places.sqlite":              "",
		"scotland-places-1.sqlite.building":   "",
	} {
		if got := artifactKind(name); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}

func TestPublicBaseURLFromEnvFile(t *testing.T) {
	t.Setenv("PUBLIC_BASE_URL", "")
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".env"), []byte("# comment\nOTHER=1\n PUBLIC_BASE_URL = \"https://example.test/\" \n"), 0o644)
	if got := publicBaseURL(dir); got != "https://example.test/" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("PUBLIC_BASE_URL", "https://env.test")
	if got := publicBaseURL(dir); got != "https://env.test" {
		t.Fatalf("environment should win: got %q", got)
	}
}

// A file rewritten while it was being hashed must not be cached under either version.
func TestCacheSkipsAFileThatChangedWhileHashed(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "regions", "x"), 0o755)
	p := filepath.Join(dir, "regions", "x", "x-basemap.pmtiles")
	os.WriteFile(p, []byte("one"), 0o644)
	c := loadHashCache(dir)
	st, _ := stampOf(p)
	c.put(p, "digest-of-one", st)
	if c.get(p) != "digest-of-one" {
		t.Fatal("an unchanged file should hit")
	}
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(p, []byte("two!"), 0o644)
	if c.get(p) != "" {
		t.Fatal("a rewritten file must miss")
	}
	if err := c.save(); err != nil {
		t.Fatal(err)
	}
	// Saved and read back: the entry and its stamp survive, keyed relative to dist/.
	back := loadHashCache(dir)
	if e, ok := back.entries["regions/x/x-basemap.pmtiles"]; !ok || e.SHA256 != "digest-of-one" || e != c.entries["regions/x/x-basemap.pmtiles"] {
		t.Fatalf("read back %+v", back.entries)
	}
}

// A real database passes; a truncated or padded copy, a zeroed one and a non-database do
// not — the ways an interrupted copy of a search index looks.
func TestCheckSQLite(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.sqlite")
	db, err := sql.Open("sqlite", good)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO places (name) VALUES ('Ben Nevis')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err := checkSQLite(good); err != nil {
		t.Fatalf("a real database: %v", err)
	}
	data, _ := os.ReadFile(good)
	for name, bad := range map[string][]byte{
		"truncated": data[:len(data)-1],
		"padded":    append(append([]byte(nil), data...), 0),
		"zeroed":    make([]byte, len(data)),
		"text":      []byte("<html>not found</html>"),
	} {
		path := filepath.Join(dir, name+".sqlite")
		os.WriteFile(path, bad, 0o644)
		if err := checkSQLite(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
