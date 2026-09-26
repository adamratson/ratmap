package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each subcommand against the Python it replaced (testdata/*.py,
// from build-region.sh and build-peaks.sh): zooms and tile counts on archives with leaf
// directories (gzip and not, a run crossing a zoom boundary, headers that disagree with
// the tiles; testdata/gen-archives.py) and real ones, and "invalid" for files that are
// not PMTiles; maxzoom and narrow on real headers and a crafted one with a float zoom and
// non-ASCII text, narrowing inside, below, above and to an empty range.
// Regenerate with ../../internal/golden/gen-fixtures.sh.
func TestMatchesPython(t *testing.T) { golden.Run(t) }
