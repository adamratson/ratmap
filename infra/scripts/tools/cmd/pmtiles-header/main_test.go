package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each subcommand as build-region.sh and build-peaks.sh call it:
// zooms and tile counts on archives with leaf directories (gzip and not, a run crossing
// a zoom boundary, headers that disagree with the tiles) and real ones, and "invalid"
// for files that are not PMTiles; maxzoom and narrow on real headers and a crafted one
// with a float zoom and non-ASCII text, narrowing inside, below, above and to an empty
// range. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }
