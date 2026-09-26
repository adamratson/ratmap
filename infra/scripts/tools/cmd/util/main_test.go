package main

import (
	"bufio"
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

// testdata/cases.tsv runs url-quote and dem-tiles against the Python they replaced
// (testdata/*.py, from vendor-assets.sh and fetch-dem.sh): non-ASCII and reserved
// characters; bboxes on whole degrees, across the equator and antimeridian, at the pole,
// empty, and written the way regions.json writes them. Regenerate with
// ../../internal/golden/gen-fixtures.sh.
func TestMatchesPython(t *testing.T) { golden.Run(t) }

// testdata/subset-keys.tsv is lib.sh's Python cache key for files of a given size and
// mtime (testdata/gen-subset-keys.py), with times a few nanoseconds short of a second.
func TestSubsetKeyMatchesPython(t *testing.T) {
	f, err := os.Open("testdata/subset-keys.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "\t")
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
		if got != cols[3] {
			t.Errorf("subset key of %d bytes at %d ns, %q: got %s, Python %s", size, ns, union, got, cols[3])
		}
		n++
	}
	if n == 0 {
		t.Fatal("no cases")
	}
}
