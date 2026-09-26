package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each check against the Python it replaced (the heredocs build-peaks.sh, build-sac.sh and build-terrain-features.sh carried) on output
// that passes and on output broken each way a check fails: a wrong elevation, a boolean
// one, a Munro short, a wrong hardest grade, a collapsed scale, too few of a kind — and
// on the RS prefixes, blank lines, multilingual names and missing properties the peaks
// checks step over.
func TestMatchesPython(t *testing.T) { golden.Run(t) }
