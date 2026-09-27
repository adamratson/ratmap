package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each check, as build-peaks.sh, build-sac.sh and
// build-terrain-features.sh call it, on output that passes and on output broken each way
// a check fails: a wrong elevation, a Munro short, a wrong hardest grade, a collapsed
// scale, too few of a kind — and on what the peaks checks step over: RS prefixes, blank
// lines, multilingual names, missing properties, and elevations that are a string or a
// boolean rather than a number. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }
