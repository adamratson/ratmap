package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"

	"ratmap/infra/dem-tools/internal/gdal"
)

// Web Mercator sphere radius, as EPSG:3857 defines it.
const rMercator = 6378137.0

// Below this the layer draws nothing, so the raster stores 0 (constraint A7: that means
// "below the threshold", never "measured flat"). Collapsing the gentle 80% of the ground
// to a single value is also the single biggest lever on artifact size — measured 5.5x.
const slopeFloorDeg = 25

// Above this, avalanche behaviour stops changing in a way more numbers would capture:
// snow sluffs continuously off very steep ground rather than building slabs. Clamping
// keeps the byte range tight and costs nothing the map would have shown.
const slopeCeilDeg = 60

// rad2deg is numpy's npy_rad2deg constant, 180.0/NPY_PI evaluated as a double division.
// Written with a variable so Go does not fold it at arbitrary precision first, which
// could land one ulp away from C's.
var rad2deg = func() float64 { pi := math.Pi; return 180.0 / pi }()

// latitude of raster row r's centre, in radians, from its Mercator northing.
//
// The float64() conversion keeps Go from fusing the multiply into the add as one FMA
// instruction (it may on arm64): numpy evaluates these as separate, separately rounded
// array operations, and so must this.
func latitude(gt [6]float64, r int) float64 {
	y := gt[3] + float64((float64(r)+0.5)*gt[5])
	return math.Atan(math.Sinh(y / rMercator))
}

// groundScale is Horn's denominator for row r: 8 x the true ground cell size.
//
// Constraint A1. `xres` is in Mercator units; multiplying by cos(lat) gives true ground
// metres, identically in both axes because Mercator is conformal. Drop this and a real
// 36-degree slope in Scotland reads 21 — see the self-test's regression guard.
func groundScale(gt [6]float64, r int) float64 {
	cell := math.Abs(gt[1]) * math.Cos(latitude(gt, r))
	return 8 * cell
}

// hornRow computes slope (degrees) and aspect (compass degrees) for one output row, from
// that row and its neighbours above and below. Columns are edge-replicated here; rows are
// replicated by the caller passing the same row twice at the raster's top or bottom edge.
//
// Horn's 3x3 method, the one `gdaldem` uses, so anyone cross-checking a value against
// gdaldem on a *metric* raster gets the same number and any difference is the projection
// correction rather than a different estimator. The sums are accumulated in exactly the
// order encode-avalanche.py's buffer arithmetic used, so the results are the same doubles.
func hornRow(above, row, below []float64, scale float64, slope, aspect []float64) {
	w := len(row)
	for c := 0; c < w; c++ {
		cl, cr := max(c-1, 0), min(c+1, w-1)
		a, b, cc := above[cl], above[c], above[cr]
		d, f := row[cl], row[cr]
		g, h, i := below[cl], below[c], below[cr]

		dzdx := ((cc + i) + f) + f
		dzdx = (dzdx - (((a + g) + d) + d)) / scale
		dzdy := ((g + i) + h) + h
		dzdy = (dzdy - (((a + cc) + b) + b)) / scale

		slope[c] = float64(math.Atan(math.Hypot(dzdx, dzdy)) * rad2deg)

		asp := float64(math.Atan2(-dzdx, dzdy)*rad2deg) + 360.0
		aspect[c] = pyMod(asp, 360.0)
	}
}

// pyMod is numpy's float remainder (npy_divmod): fmod, moved into the divisor's sign, and
// +0.0 rather than -0.0 for an exact zero.
func pyMod(a, b float64) float64 {
	m := math.Mod(a, b)
	if m != 0 {
		if (b < 0) != (m < 0) {
			m += b
		}
	} else {
		m = math.Copysign(0, b)
	}
	return m
}

// quantise turns a slope and aspect into the bytes the artifact stores.
//
// Slope: whole degrees, floored, 0 below the draw threshold and clamped at the ceiling.
// 1 degree is already finer than the 5-degree classes the map draws and far finer than a
// 30 m DEM can justify; it also makes `max` pyramid reduction exact per channel.
//
// Aspect: octant 1-8 (N, NE, E, SE, S, SW, W, NW), 0 wherever slope is 0.
//
// A NaN slope or aspect stores 0, which is what numpy's cast of NaN to uint8 gives on
// both amd64 and arm64 — made explicit here because Go's conversion is undefined for it.
func quantise(slope, aspect float64) (uint8, uint8) {
	s := math.Floor(slope)
	if s < slopeFloorDeg {
		s = 0
	}
	if s > slopeCeilDeg {
		s = slopeCeilDeg
	}
	if s != s {
		return 0, 0
	}
	if s == 0 {
		return 0, 0
	}
	o := math.Floor(pyMod(aspect+22.5, 360.0)/45.0) + 1
	if o != o {
		return uint8(s), 0
	}
	return uint8(s), uint8(o)
}

// reduceRow halves resolution for one output row: slope by 2x2 maximum, aspect following
// the cell that won (the first one in [top-left, top-right, bottom-left, bottom-right]
// order on a tie, as numpy's argmax picks).
//
// Constraint A4. Averaging — which is what every default resampler does — dissolves a
// 40-degree gully inside a 25-degree hillside, so the layer stops warning about the
// feature it exists for at exactly the zoom where someone is deciding whether to go and
// look. The error is silent and it under-warns, which is the direction that matters.
//
// Aspect takes the direction of the steepest cell in the block rather than the majority
// direction: the coarse cell reads "the steepest thing here is 38 degrees, facing
// north-east" — one coherent statement about one real cell.
//
// Done here and not with `gdal_translate -r max`, because GDAL does not implement it: it
// warns "GDAL_RASTERIO_RESAMPLING = max not supported" and quietly falls back to nearest.
func reduceRow(s0, s1, a0, a1 []uint8, outS, outA []uint8) {
	for c := range outS {
		k := 2 * c
		bs, ba := s0[k], a0[k]
		if s0[k+1] > bs {
			bs, ba = s0[k+1], a0[k+1]
		}
		if s1[k] > bs {
			bs, ba = s1[k], a1[k]
		}
		if s1[k+1] > bs {
			bs, ba = s1[k+1], a1[k+1]
		}
		outS[c], outA[c] = bs, ba
	}
}

// level is one zoom's slope and aspect, as flat byte arrays on disk.
type level struct {
	slopeRaw, aspectRaw string
	w, h                int
}

// computeLevels computes slope and aspect at zmax, then the max-reduced pyramid down to
// zmin, streaming rows through files. Returns the levels and the per-degree histogram at
// the top zoom.
//
// Nothing larger than three DEM rows is ever held: Scotland's bbox at this layer's zoom
// is 1.6 gigapixels, 12.4 GB as float64. The Python bounded itself with 16 MB strips and
// a one-row halo; a strip is only a batch of rows, so reading one row at a time with the
// same halo gives the same cells.
func computeLevels(demRaw string, w, h int, gt [6]float64, work string, zmax, zmin int) (map[int]level, [256]int64, error) {
	var counts [256]int64
	levels := map[int]level{}

	rr, err := gdal.OpenRows(demRaw, w, h)
	if err != nil {
		return nil, counts, err
	}
	defer rr.Close()

	top := level{filepath.Join(work, fmt.Sprintf("slope-%d.img", zmax)),
		filepath.Join(work, fmt.Sprintf("aspect-%d.img", zmax)), w, h}
	sw, err := newRawWriter(top.slopeRaw)
	if err != nil {
		return nil, counts, err
	}
	aw, err := newRawWriter(top.aspectRaw)
	if err != nil {
		return nil, counts, err
	}

	// Three rows in a ring: r-1, r, r+1. One real row of context on each side where it
	// exists; replicated only at the raster's true edges. That is what keeps the result
	// free of invented cliffs along any internal boundary.
	var ring [3][]float64
	for k := range ring {
		ring[k] = make([]float64, w)
	}
	rowAt := func(r int) []float64 { return ring[min(max(r, 0), h-1)%3] }
	if err := rr.Next(ring[0]); err != nil {
		return nil, counts, err
	}
	slope, aspect := make([]float64, w), make([]float64, w)
	sb, ab := make([]uint8, w), make([]uint8, w)
	for r := 0; r < h; r++ {
		if r+1 < h {
			if err := rr.Next(ring[(r+1)%3]); err != nil {
				return nil, counts, err
			}
		}
		hornRow(rowAt(r-1), rowAt(r), rowAt(r+1), groundScale(gt, r), slope, aspect)
		for c := 0; c < w; c++ {
			sb[c], ab[c] = quantise(slope[c], aspect[c])
			counts[sb[c]]++
		}
		sw.Write(sb)
		aw.Write(ab)
	}
	if err := sw.close(); err != nil {
		return nil, counts, err
	}
	if err := aw.close(); err != nil {
		return nil, counts, err
	}
	levels[zmax] = top
	prevMax := maxNonzero(counts)

	for z := zmax - 1; z >= zmin; z-- {
		parent := levels[z+1]
		cw, ch := parent.w/2, parent.h/2
		if cw < 1 || ch < 1 {
			break
		}
		child := level{filepath.Join(work, fmt.Sprintf("slope-%d.img", z)),
			filepath.Join(work, fmt.Sprintf("aspect-%d.img", z)), cw, ch}
		levelMax, err := reduceLevel(parent, child)
		if err != nil {
			return nil, counts, err
		}
		// The point of reducing by maximum, asserted rather than assumed: coarsening must
		// never lower the steepest slope on the sheet. This is the check that would have
		// caught `gdal_translate -r max` silently falling back to nearest.
		if levelMax != prevMax {
			return nil, counts, fmt.Errorf("FAIL: reducing z%d -> z%d changed the maximum slope %d -> %d",
				z+1, z, prevMax, levelMax)
		}
		levels[z] = child
	}
	return levels, counts, nil
}

func reduceLevel(parent, child level) (int, error) {
	ps, err := os.Open(parent.slopeRaw)
	if err != nil {
		return 0, err
	}
	defer ps.Close()
	pa, err := os.Open(parent.aspectRaw)
	if err != nil {
		return 0, err
	}
	defer pa.Close()
	psr, par := bufio.NewReaderSize(ps, 1<<20), bufio.NewReaderSize(pa, 1<<20)

	cs, err := newRawWriter(child.slopeRaw)
	if err != nil {
		return 0, err
	}
	ca, err := newRawWriter(child.aspectRaw)
	if err != nil {
		return 0, err
	}

	pw := parent.w
	s0, s1, a0, a1 := make([]uint8, pw), make([]uint8, pw), make([]uint8, pw), make([]uint8, pw)
	outS, outA := make([]uint8, child.w), make([]uint8, child.w)
	levelMax := 0
	// An odd last row or column of the parent is dropped, as the Python's reshape trimmed
	// it — and if that is where the steepest cell was, the max check above says so.
	for r := 0; r < child.h; r++ {
		for _, rd := range []struct {
			r    io.Reader
			dst  []uint8
			path string
		}{{psr, s0, parent.slopeRaw}, {psr, s1, parent.slopeRaw}, {par, a0, parent.aspectRaw}, {par, a1, parent.aspectRaw}} {
			if _, err := io.ReadFull(rd.r, rd.dst); err != nil {
				return 0, fmt.Errorf("reading %s: %w", rd.path, err)
			}
		}
		reduceRow(s0, s1, a0, a1, outS, outA)
		for _, v := range outS {
			levelMax = max(levelMax, int(v))
		}
		cs.Write(outS)
		ca.Write(outA)
	}
	if err := cs.close(); err != nil {
		return 0, err
	}
	return levelMax, ca.close()
}

func maxNonzero(counts [256]int64) int {
	for v := len(counts) - 1; v >= 0; v-- {
		if counts[v] != 0 {
			return v
		}
	}
	return -1
}

type rawWriter struct {
	f *os.File
	*bufio.Writer
}

func newRawWriter(path string) (*rawWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &rawWriter{f, bufio.NewWriterSize(f, 1<<20)}, nil
}

func (w *rawWriter) close() error {
	if err := w.Flush(); err != nil {
		w.f.Close()
		return err
	}
	return w.f.Close()
}
