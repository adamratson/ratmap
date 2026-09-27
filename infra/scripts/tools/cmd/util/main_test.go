package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs url-quote and dem-tiles as vendor-assets.sh and fetch-dem.sh
// call them: non-ASCII and reserved characters; bboxes on whole degrees, across the
// equator and antimeridian, at the pole, empty, and written the way regions.json writes
// them. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }

// testdata/subset-keys.tsv is the OSM subset cache key for files of a given size and
// mtime and a given filter union (JSON), with times a few nanoseconds short of a second.
// -update rewrites the keys.
func TestSubsetKey(t *testing.T) {
	data, err := os.ReadFile("testdata/subset-keys.tsv")
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		cols := strings.Split(line, "\t")
		size, _ := strconv.Atoi(cols[0])
		ns, _ := strconv.ParseInt(cols[1], 10, 64)
		var union string
		if err := json.Unmarshal([]byte(cols[2]), &union); err != nil {
			t.Fatal(err)
		}
		src := filepath.Join(t.TempDir(), "src.osm.pbf")
		if err := os.WriteFile(src, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		mt := time.Unix(0, ns)
		if err := os.Chtimes(src, mt, mt); err != nil {
			t.Fatal(err)
		}
		got, err := subsetKey(src, union)
		if err != nil {
			t.Fatal(err)
		}
		out.WriteString(strings.Join(cols[:3], "\t") + "\t" + got + "\n")
	}
	golden.Check(t, "keys", out.Bytes(), "testdata/subset-keys.tsv")
}
