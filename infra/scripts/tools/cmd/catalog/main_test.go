package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs every subcommand against the Python snippets it replaced
// (testdata/*.py, from build-region.sh, build-contours.sh, build-avalanche.sh and
// docker/build-global.sh) on a catalogue of real regions and crafted ones: an ampersand
// and a quote in a name, integer and -0.0 coordinates, an inverted bbox, flags set to 1
// and 0 rather than true and false, the southern hemisphere, near the Mercator limit.
// Regenerate with ../../internal/golden/gen-fixtures.sh.
func TestMatchesPython(t *testing.T) { golden.Run(t) }
