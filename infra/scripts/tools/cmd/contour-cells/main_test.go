package main

import (
	"os"
	"path/filepath"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs contour-cells against the Python build-contours.sh carried
// (testdata/contour-cells.py) on geotransforms of a real Copernicus clip, one across the
// antimeridian, odd sizes whose seams fall on exact halves, a single pixel, and a rotated
// one it refuses. testdata/bin/gdalinfo stands in for GDAL, printing the JSON it is given,
// so both read the same numbers without a raster. Regenerate with
// ../../internal/golden/gen-fixtures.sh.
func TestMatchesPython(t *testing.T) {
	bin, err := filepath.Abs("testdata/bin")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	golden.Run(t)
}
