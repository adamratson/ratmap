package main

import (
	"fmt"
	"math"
	"sort"

	"ratmap/infra/tools/internal/pyfloat"
)

// downsampleMax is a block-max downsample. Max, not mean: it preserves summit
// elevations, which is what peaks are matched against. A block holding a NaN comes out
// NaN, as numpy's max does.
func downsampleMax(dem []float32, w, h, factor int) ([]float32, int, int) {
	if factor <= 1 {
		return dem, w, h
	}
	w2, h2 := w/factor, h/factor
	out := make([]float32, w2*h2)
	for r := 0; r < h2; r++ {
		for c := 0; c < w2; c++ {
			m := dem[(r*factor)*w+c*factor]
			for dr := 0; dr < factor; dr++ {
				row := dem[(r*factor+dr)*w+c*factor : (r*factor+dr)*w+c*factor+factor]
				for _, v := range row {
					if v != v || m != m {
						m = float32(math.NaN())
					} else if v > m {
						m = v
					}
				}
			}
			out[r*w2+c] = m
		}
	}
	return out, w2, h2
}

// scoreRegion runs compute over the peaks that can fall inside this raster, keyed by
// feature index. Returns ({feature_index: prominence_m}, number_of_candidates).
//
// Only a pre-filter: compute still makes the exact in-raster decision itself. The box is
// the raster's own extent padded by two pixels, a strict superset of what compute
// accepts — its truncation toward zero takes peaks up to one pixel past the west and north
// edges. Candidates keep file order, so compute sees the same peaks in the same order as
// when it was handed the whole file, and its ranking and tie-breaks come out identical.
func scoreRegion(dem []float32, w, h int, gt [6]float64, lons, lats []float64, step, floor float64) (map[int]float64, int, error) {
	lon0, dlon, lat0, dlat := gt[0], gt[1], gt[3], gt[5]
	padX, padY := 2*math.Abs(dlon), 2*math.Abs(dlat)
	xLo, xHi := sorted2(lon0, lon0+float64(float64(w)*dlon))
	yLo, yHi := sorted2(lat0, lat0+float64(float64(h)*dlat))

	var sel []int
	for j := range lons {
		// NaN (a feature with no coordinates) fails every one of these, as in numpy.
		if lons[j] >= xLo-padX && lons[j] <= xHi+padX && lats[j] >= yLo-padY && lats[j] <= yHi+padY {
			sel = append(sel, j)
		}
	}
	cl, ct := make([]float64, len(sel)), make([]float64, len(sel))
	for k, j := range sel {
		cl[k], ct[k] = lons[j], lats[j]
	}
	local, err := compute(dem, w, h, gt, cl, ct, step, floor)
	if err != nil {
		return nil, 0, err
	}
	out := make(map[int]float64, len(local))
	for pos, v := range local {
		out[sel[pos]] = v
	}
	return out, len(sel), nil
}

func sorted2(a, b float64) (float64, float64) {
	if b < a {
		return b, a
	}
	return a, b
}

type located struct {
	i        int // index into the peaks handed to compute
	row, col int
	ele      float64
}

// compute returns {peak_index: prominence_m} for the peaks inside the raster.
//
// Method — level-set, "descending water level":
//
//	for each threshold t, high to low:
//	    take the connected components of (dem >= t)
//	    any peak that now shares a component with a higher peak has just been connected
//	    to higher ground, so its key col is at t and its prominence is elev - t
//
// The Python relabelled the whole raster with scipy.ndimage.label at every threshold:
// (thresholds) x (raster) work. Here the components are kept in a union-find instead,
// and each threshold only adds the cells that have just come above water — every cell is
// added once over the whole descent. That is the same set of components at every
// threshold (4-connected, scipy's default structure), so the same peaks merge at the same
// t; only which number names a component differs, and nothing reads that.
func compute(dem []float32, w, h int, gt [6]float64, lons, lats []float64, step, floor float64) (map[int]float64, error) {
	lon0, dlon, lat0, dlat := gt[0], gt[1], gt[3], gt[5]

	// Map each peak to a raster cell.
	var peaks []located
	for i := range lons {
		if math.IsNaN(lons[i]) || math.IsNaN(lats[i]) {
			continue
		}
		// Go's float-to-int conversion truncates toward zero, as Python's int() does.
		col := int((lons[i] - lon0) / dlon)
		row := int((lats[i] - lat0) / dlat)
		if !(row >= 0 && row < h && col >= 0 && col < w) {
			continue
		}
		// Summit height for the prominence arithmetic comes from the DEM, never from OSM's
		// `ele`, even when OSM has one.
		//
		// Prominence is a property of a surface: summit height minus key col height, both
		// measured on the same surface. Mixing OSM's tagged elevation with a DEM-derived
		// col produced negative "prominence" for 29% of Montenegro's features — a node
		// tagged `ele=149` sitting on ground the DEM puts far higher merges at a threshold
		// above its tagged height. Negative values are not merely wrong, they fail the
		// app's `>= -1` sentinel check and would hide those peaks at every zoom.
		//
		// OSM `ele` remains what gets *displayed*: it matches the signage on the hill.
		peaks = append(peaks, located{i: i, row: row, col: col})
	}
	if len(peaks) == 0 {
		return map[int]float64{}, nil
	}

	// Snap each peak to the highest cell in a small neighbourhood. OSM summit coordinates
	// and a 30 m DEM disagree by a cell or two, and landing on a slope instead of the
	// summit would merge the peak into higher ground immediately and report ~0 prominence.
	const snap = 2
	for n := range peaks {
		p := &peaks[n]
		r0, r1 := max(0, p.row-snap), min(h, p.row+snap+1)
		c0, c1 := max(0, p.col-snap), min(w, p.col+snap+1)
		p.row, p.col = argmax(dem, w, r0, r1, c0, c1)
		p.ele = float64(dem[p.row*w+p.col])
	}

	// Highest first; equal heights keep input order (Python's sorted(reverse=True) is
	// stable too).
	order := make([]int, len(peaks))
	for n := range order {
		order[n] = n
	}
	sort.SliceStable(order, func(a, b int) bool { return peaks[order[a]].ele > peaks[order[b]].ele })
	rankOf := make([]int, len(peaks)) // 0 = highest peak
	for rank, n := range order {
		rankOf[n] = rank
	}

	demMax := math.Inf(-1)
	demMin := math.Inf(1) // over cells above -1000 m; NaN is not > -1000
	anyValid, anyNum := false, false
	for _, v32 := range dem {
		v := float64(v32)
		if v != v {
			continue
		}
		anyNum = true
		if v > demMax {
			demMax = v
		}
		if v > -1000 {
			anyValid = true
			if v < demMin {
				demMin = v
			}
		}
	}
	if !anyNum {
		return nil, fmt.Errorf("DEM is entirely NaN")
	}
	if !anyValid {
		demMin = 0
	}

	thresholds, err := arange(math.Floor(demMax/step)*step, pyMax(floor, demMin)-step, -step)
	if err != nil {
		return nil, err
	}

	// Per-row extremes, so a threshold's pass can skip rows with nothing crossing it.
	rowMax := make([]float64, h)
	rowMin := make([]float64, h)
	for r := 0; r < h; r++ {
		lo, hi := math.Inf(1), math.Inf(-1)
		for _, v32 := range dem[r*w : (r+1)*w] {
			v := float64(v32)
			if v != v {
				continue
			}
			lo, hi = math.Min(lo, v), math.Max(hi, v)
		}
		rowMin[r], rowMax[r] = lo, hi
	}

	// -1 = not yet above water. A cell's entry is set the threshold it first satisfies
	// dem >= t, so "parent >= 0" is exactly the Python's `mask`.
	parent := make([]int32, w*h)
	for i := range parent {
		parent[i] = -1
	}
	find := func(x int32) int32 {
		for parent[x] != x {
			parent[x] = parent[parent[x]] // path halving
			x = parent[x]
		}
		return x
	}
	union := func(a, b int32) {
		ra, rb := find(a), find(b)
		if ra == rb {
			return
		}
		if ra < rb {
			parent[rb] = ra
		} else {
			parent[ra] = rb
		}
	}

	prominence := make(map[int]float64, len(peaks))
	resolved := make([]bool, len(peaks))
	nResolved := 0
	peakRoot := make([]int32, len(peaks))
	bestInLabel := map[int32]int{}

	upper := math.Inf(1)
	for k, t := range thresholds {
		if nResolved >= len(peaks)-1 {
			break // only the summit of the box left; it has no key col by definition
		}

		// Bring up every cell with t <= dem < previous t, joining it to whichever of its
		// four neighbours are already up. A neighbour that comes up later in this same
		// pass joins back to it then, so the components are complete once the pass ends.
		for r := 0; r < h; r++ {
			if !(rowMax[r] >= t) || (k > 0 && rowMin[r] >= upper) {
				continue
			}
			base := r * w
			for c := 0; c < w; c++ {
				v := float64(dem[base+c])
				if !(v >= t) || (k > 0 && v >= upper) {
					continue
				}
				i := int32(base + c)
				parent[i] = i
				if c > 0 && parent[i-1] >= 0 {
					union(i, i-1)
				}
				if c+1 < w && parent[i+1] >= 0 {
					union(i, i+1)
				}
				if r > 0 && parent[i-int32(w)] >= 0 {
					union(i, i-int32(w))
				}
				if r+1 < h && parent[i+int32(w)] >= 0 {
					union(i, i+int32(w))
				}
			}
		}
		upper = t

		// Group peaks by component; within a component the highest peak "owns" it and
		// every lower peak has just been connected to higher ground.
		clear(bestInLabel)
		for n, p := range peaks {
			cell := int32(p.row*w + p.col)
			if parent[cell] < 0 {
				peakRoot[n] = -1 // not above the current water level yet
				continue
			}
			root := find(cell)
			peakRoot[n] = root
			if cur, ok := bestInLabel[root]; !ok || rankOf[n] < rankOf[cur] {
				bestInLabel[root] = n
			}
		}
		for n, p := range peaks {
			if peakRoot[n] < 0 || resolved[n] {
				continue
			}
			if bestInLabel[peakRoot[n]] == n {
				continue
			}
			// max(0, …) is a safety net, not the fix: with the summit height read from the
			// same DEM as the col, a merge cannot happen above the summit. Guards against
			// a future change reintroducing mixed sources.
			prominence[p.i] = pyfloat.Round(pyMax(0, p.ele-t), 1)
			resolved[n] = true
			nResolved++
		}
	}

	// Whatever never merged is the high point of the box.
	for n, p := range peaks {
		if !resolved[n] {
			prominence[p.i] = pyfloat.Round(pyMax(0, p.ele-demMin), 1)
		}
	}
	return prominence, nil
}

// argmax is numpy's argmax over dem[r0:r1, c0:c1]: the first maximum in row-major
// order, and the first NaN if there is one (numpy treats NaN as the maximum).
func argmax(dem []float32, w, r0, r1, c0, c1 int) (int, int) {
	br, bc := r0, c0
	best := dem[r0*w+c0]
	if best != best {
		return br, bc
	}
	for r := r0; r < r1; r++ {
		for c := c0; c < c1; c++ {
			v := dem[r*w+c]
			if v != v {
				return r, c
			}
			if v > best {
				best, br, bc = v, r, c
			}
		}
	}
	return br, bc
}

// pyMax is Python's max(a, b) for floats: b only if b > a, so NaN and -0.0 lose to a.
func pyMax(a, b float64) float64 {
	if b > a {
		return b
	}
	return a
}

// arange is numpy.arange(start, stop, step) for float64, value for value: the length is
// ceil((stop - start) / step), the first two entries are start and start + step, and
// every later one is start + i*delta with delta re-derived from those two
// (DOUBLE_fill, numpy/_core/src/multiarray/arraytypes.c.src).
//
// The explicit float64() conversions stop Go fusing a multiply and an add into one FMA
// instruction, which it may do on arm64 and which rounds differently. With the
// pipeline's integer --step every product here is exact anyway.
func arange(start, stop, step float64) ([]float64, error) {
	l := math.Ceil((stop - start) / step)
	if math.IsNaN(l) || math.IsInf(l, 0) {
		return nil, fmt.Errorf("arange: cannot compute length for (%v, %v, %v)", start, stop, step)
	}
	if l <= 0 {
		return nil, nil
	}
	n := int(l)
	out := make([]float64, n)
	out[0] = start
	if n == 1 {
		return out, nil
	}
	out[1] = start + step
	delta := out[1] - start
	for i := 2; i < n; i++ {
		out[i] = start + float64(float64(i)*delta)
	}
	return out, nil
}
