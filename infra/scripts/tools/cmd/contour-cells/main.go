// Command contour-cells prints the cells build-contours.sh traces a DEM in, one per line:
//
//	contour-cells CLIP.tif CELL_PX
//	<n> <xoff> <yoff> <xsize> <ysize> <xmin> <xmax> <ymin> <ymax>
//
// A port of the Python snippet build-contours.sh carried inline, printing what it
// printed. Cells are even (none is a sliver), each window runs one pixel past its seams
// so the squares either side of a seam are computed whole in both cells, and the bounds
// are pixel-centre coordinates, "-inf"/"inf" at the region's own edges — see
// build-contours.sh for why, and contour-cell for how they are used.
package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/gdal"
	"ratmap/infra/tools/internal/pyfloat"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: contour-cells CLIP.tif CELL_PX")
		os.Exit(2)
	}
	cell, err := strconv.Atoi(strings.TrimSpace(os.Args[2]))
	if err == nil && cell <= 0 {
		err = fmt.Errorf("CELL_PX must be positive")
	}
	if err == nil {
		var info gdal.Info
		if info, err = gdal.ReadInfo(os.Args[1]); err == nil {
			err = run(info, cell, os.Stdout)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// bound is a pixel-centre coordinate, or none at the region's own edge.
type bound struct {
	v    float64
	none bool
}

type span struct {
	first, last int
	lo, hi      bound
}

// seams splits size into even cells: n cells, seams at the pixel indices between them.
// round() is Python's: an exact half goes to the even neighbour.
func seams(size, cell int) []int {
	n := max(1, int(math.Ceil(float64(size)/float64(cell))))
	var cuts []int
	for k := 1; k < n; k++ {
		cuts = append(cuts, int(math.RoundToEven(float64(k*size)/float64(n))))
	}
	return cuts
}

// spans is each cell's (first pixel, last pixel, low bound, high bound), one pixel past
// each seam.
func spans(size int, cuts []int) []span {
	edges := append(append([]*int{nil}, ptrs(cuts)...), nil)
	var out []span
	for i := 0; i+1 < len(edges); i++ {
		lo, hi := edges[i], edges[i+1]
		s := span{first: 0, last: size - 1, lo: bound{none: true}, hi: bound{none: true}}
		if lo != nil {
			s.first, s.lo = *lo-1, bound{v: float64(*lo) + 0.5}
		}
		if hi != nil {
			s.last, s.hi = *hi+1, bound{v: float64(*hi) + 0.5}
		}
		out = append(out, s)
	}
	return out
}

func ptrs(xs []int) []*int {
	out := make([]*int, len(xs))
	for i := range xs {
		out[i] = &xs[i]
	}
	return out
}

func run(info gdal.Info, cell int, out io.Writer) error {
	gt := info.GeoTransform
	if gt[2] != 0 || gt[4] != 0 {
		return fmt.Errorf("build-contours.sh: rotated DEM geotransform, cells assume north-up")
	}
	// The float64() conversions stop Go fusing the multiply into the add (FMA, which it
	// may do on arm64): Python rounds each operation on its own.
	coord := func(origin, step float64, b bound, edge string) string {
		if b.none {
			return edge
		}
		return pyfloat.Repr(origin + float64(b.v*step))
	}
	n := 0
	for _, row := range spans(info.Height, seams(info.Height, cell)) {
		for _, col := range spans(info.Width, seams(info.Width, cell)) {
			n++
			// Rows run south as y grows: gt[5] < 0, so the bottom seam is the smaller
			// latitude.
			fmt.Fprintln(out, n, col.first, row.first, col.last-col.first+1, row.last-row.first+1,
				coord(gt[0], gt[1], col.lo, "-inf"), coord(gt[0], gt[1], col.hi, "inf"),
				coord(gt[3], gt[5], row.hi, "-inf"), coord(gt[3], gt[5], row.lo, "inf"))
		}
	}
	return nil
}
