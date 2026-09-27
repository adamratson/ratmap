package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs every subcommand, as build-region.sh, build-contours.sh,
// build-avalanche.sh and docker/build-global.sh call it, on a catalogue of real regions
// and crafted ones: an ampersand and a quote in a name, integer and -0.0 coordinates
// (printed as written), an inverted bbox, flags set to 1 and 0 (neither is true or
// false, so neither opts in or out), a null zoom cap, the southern hemisphere, near the
// Mercator limit. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }
