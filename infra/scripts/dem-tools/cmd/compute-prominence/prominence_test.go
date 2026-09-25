package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"ratmap/infra/dem-tools/internal/pyfloat"
)

// referenceCompute is compute-prominence.py's compute() transcribed as literally as Go
// allows: the whole raster relabelled (4-connected flood fill, scipy.ndimage.label's
// default structure) at every threshold. It exists to prove the union-find in compute()
// merges the same peaks at the same thresholds, which is the one place the port changes
// the algorithm rather than the language.
func referenceCompute(dem []float32, w, h int, gt [6]float64, lons, lats []float64, step, floor float64) map[int]float64 {
	type loc struct {
		i, row, col int
		ele         float64
	}
	var located []loc
	for i := range lons {
		col := int((lons[i] - gt[0]) / gt[1])
		row := int((lats[i] - gt[3]) / gt[5])
		if row >= 0 && row < h && col >= 0 && col < w {
			located = append(located, loc{i: i, row: row, col: col})
		}
	}
	if len(located) == 0 {
		return map[int]float64{}
	}
	for n := range located {
		p := &located[n]
		r0, r1 := max(0, p.row-2), min(h, p.row+3)
		c0, c1 := max(0, p.col-2), min(w, p.col+3)
		best, br, bc := float32(math.Inf(-1)), -1, -1
		for r := r0; r < r1; r++ {
			for c := c0; c < c1; c++ {
				if br < 0 || dem[r*w+c] > best {
					best, br, bc = dem[r*w+c], r, c
				}
			}
		}
		p.row, p.col, p.ele = br, bc, float64(dem[br*w+bc])
	}
	order := make([]int, len(located))
	for n := range order {
		order[n] = n
	}
	sort.SliceStable(order, func(a, b int) bool { return located[order[a]].ele > located[order[b]].ele })
	rank := make([]int, len(located))
	for r, n := range order {
		rank[n] = r
	}

	demMax, demMin := math.Inf(-1), math.Inf(1)
	for _, v := range dem {
		demMax = math.Max(demMax, float64(v))
		if float64(v) > -1000 {
			demMin = math.Min(demMin, float64(v))
		}
	}
	thresholds, _ := arange(math.Floor(demMax/step)*step, math.Max(floor, demMin)-step, -step)

	prom := map[int]float64{}
	resolved := map[int]bool{}
	labels := make([]int, w*h)
	for _, t := range thresholds {
		if len(resolved) >= len(located)-1 {
			break
		}
		// Label from scratch, in raster order, by flood fill.
		for i := range labels {
			labels[i] = 0
		}
		next := 0
		for s := range labels {
			if labels[s] != 0 || !(float64(dem[s]) >= t) {
				continue
			}
			next++
			stack := []int{s}
			labels[s] = next
			for len(stack) > 0 {
				c := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				r, col := c/w, c%w
				for _, nb := range [][2]int{{r - 1, col}, {r + 1, col}, {r, col - 1}, {r, col + 1}} {
					if nb[0] < 0 || nb[0] >= h || nb[1] < 0 || nb[1] >= w {
						continue
					}
					j := nb[0]*w + nb[1]
					if labels[j] == 0 && float64(dem[j]) >= t {
						labels[j] = next
						stack = append(stack, j)
					}
				}
			}
		}
		best := map[int]int{}
		for n, p := range located {
			l := labels[p.row*w+p.col]
			if l == 0 {
				continue
			}
			if cur, ok := best[l]; !ok || rank[n] < rank[cur] {
				best[l] = n
			}
		}
		for n, p := range located {
			l := labels[p.row*w+p.col]
			if l == 0 || resolved[n] || best[l] == n {
				continue
			}
			prom[p.i] = pyfloat.Round(math.Max(0, p.ele-t), 1)
			resolved[n] = true
		}
	}
	for n, p := range located {
		if !resolved[n] {
			prom[p.i] = pyfloat.Round(math.Max(0, p.ele-demMin), 1)
		}
	}
	return prom
}

// randomTerrain is a sum of random bumps on a tilted plane, quantised to 0.5 m so that
// equal heights (the tie-break paths) actually occur.
func randomTerrain(rng *rand.Rand, w, h int) []float32 {
	dem := make([]float32, w*h)
	type bump struct{ x, y, s, a float64 }
	var bumps []bump
	for k := 0; k < 3+rng.Intn(10); k++ {
		bumps = append(bumps, bump{rng.Float64() * float64(w), rng.Float64() * float64(h),
			2 + rng.Float64()*float64(w)/3, 50 + rng.Float64()*900})
	}
	tilt := rng.Float64() * 3
	for r := 0; r < h; r++ {
		for c := 0; c < w; c++ {
			v := tilt * float64(c)
			for _, b := range bumps {
				d2 := (float64(c)-b.x)*(float64(c)-b.x) + (float64(r)-b.y)*(float64(r)-b.y)
				v += b.a * math.Exp(-d2/(2*b.s*b.s))
			}
			v += rng.Float64() * 30
			dem[r*w+c] = float32(math.Round(v*2) / 2)
		}
	}
	return dem
}

func TestComputeMatchesPerThresholdLabelling(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 300; trial++ {
		w, h := 5+rng.Intn(60), 5+rng.Intn(60)
		dem := randomTerrain(rng, w, h)
		gt := [6]float64{-5.25, 0.01, 0, 57.5, 0, -0.01}
		var lons, lats []float64
		for k := 0; k < 1+rng.Intn(40); k++ {
			// Some fall just outside the raster, to exercise the in-raster test.
			lons = append(lons, gt[0]+(rng.Float64()*1.1-0.05)*float64(w)*gt[1])
			lats = append(lats, gt[3]+(rng.Float64()*1.1-0.05)*float64(h)*gt[5])
		}
		step := []float64{20, 10, 7.5, 1}[rng.Intn(4)]
		floor := []float64{0, 100}[rng.Intn(2)]

		got, err := compute(dem, w, h, gt, lons, lats, step, floor)
		if err != nil {
			t.Fatal(err)
		}
		want := referenceCompute(dem, w, h, gt, lons, lats, step, floor)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d (%dx%d, step %v, floor %v):\n got  %v\n want %v", trial, w, h, step, floor, got, want)
		}
	}
}

func TestComputeKnownRidge(t *testing.T) {
	// Two summits on one row joined by a col at 400 m: west 1000 m, east 700 m, ground at
	// 100 m. East's key col is the 400 m saddle, so 700 - 400 = 300. West never merges
	// with anything higher, so it gets 1000 - lowest cell = 900.
	row := []float32{100, 1000, 800, 600, 400, 500, 700, 100}
	w, h := len(row), 3
	dem := make([]float32, 0, w*h)
	for r := 0; r < h; r++ {
		dem = append(dem, row...)
	}
	gt := [6]float64{0, 1, 0, 0, 0, -1}
	lons := []float64{1.5, 6.5}
	lats := []float64{-1.5, -1.5}
	got, err := compute(dem, w, h, gt, lons, lats, 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]float64{0: 900, 1: 300}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestComputeSnapsToSummit(t *testing.T) {
	// The peak is placed two cells off its summit; snapping must find the 900 m cell, not
	// score the 300 m slope it was dropped on.
	w, h := 7, 7
	dem := make([]float32, w*h)
	for i := range dem {
		dem[i] = 100
	}
	dem[3*w+3] = 900
	dem[3*w+1] = 300
	gt := [6]float64{0, 1, 0, 0, 0, -1}
	got, _ := compute(dem, w, h, gt, []float64{1.5}, []float64{-3.5}, 20, 0)
	if got[0] != 800 {
		t.Fatalf("got %v, want 800 (900 summit - 100 ground)", got)
	}
}

func TestArangeMatchesNumpy(t *testing.T) {
	// Expected values from numpy 2.5.2: np.arange(1340.0, -20.0 - 20, -20.0) etc.
	cases := []struct {
		start, stop, step float64
		n                 int
		first, last       float64
	}{
		{1340, -40, -20, 69, 1340, -20},
		{1340, 80, -20, 63, 1340, 100},
		{20, 0, -20, 1, 20, 20},
		{0, 0, -20, 0, 0, 0},
		{100, 12.5, -7.5, 12, 100, 17.5},
	}
	for _, c := range cases {
		got, err := arange(c.start, c.stop, c.step)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != c.n {
			t.Errorf("arange(%v,%v,%v): %d values, want %d", c.start, c.stop, c.step, len(got), c.n)
			continue
		}
		if c.n > 0 && (got[0] != c.first || got[len(got)-1] != c.last) {
			t.Errorf("arange(%v,%v,%v): %v..%v, want %v..%v", c.start, c.stop, c.step, got[0], got[len(got)-1], c.first, c.last)
		}
	}
}

func TestDownsampleMax(t *testing.T) {
	dem := []float32{
		1, 2, 3, 4, 9,
		5, 6, 7, 8, 9,
		1, 1, 1, 1, 9,
	}
	got, w, h := downsampleMax(dem, 5, 3, 2)
	if w != 2 || h != 1 || !reflect.DeepEqual(got, []float32{6, 8}) {
		t.Fatalf("got %v (%dx%d)", got, w, h)
	}
	nan := float32(math.NaN())
	got, _, _ = downsampleMax([]float32{1, nan, 3, 4}, 2, 2, 2)
	if got[0] == got[0] {
		t.Fatalf("NaN in a block must propagate, as numpy's max does; got %v", got[0])
	}
}

func TestSetProm(t *testing.T) {
	cases := []struct{ in, want string }{
		// normalize-peaks.py's shape: prom appended as the last property.
		{`{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-5.0, 56.8]}, "properties": {"name": "Ben Nevis", "ele": 1345.0}}`,
			`{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-5.0, 56.8]}, "properties": {"name": "Ben Nevis", "ele": 1345.0, "prom": 1340.0}}`},
		// An existing prom is replaced where it stands.
		{`{"properties": {"prom": 5.0, "name": "x"}}`, `{"properties": {"prom": 1340.0, "name": "x"}}`},
		{`{"properties": {}}`, `{"properties": {"prom": 1340.0}}`},
		{`{"type": "Feature"}`, `{"type": "Feature", "properties": {"prom": 1340.0}}`},
		{`{}`, `{"properties": {"prom": 1340.0}}`},
		// Braces and quotes inside strings must not confuse the scanner.
		{`{"properties": {"name": "a \"}\" b", "x": [1, {"y": "}"}]}}`, `{"properties": {"name": "a \"}\" b", "x": [1, {"y": "}"}], "prom": 1340.0}}`},
	}
	for _, c := range cases {
		got, err := setProm([]byte(c.in), "1340.0")
		if err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("setProm(%s)\n got  %s\n want %s", c.in, got, c.want)
		}
		var v any
		if err := json.Unmarshal(got, &v); err != nil {
			t.Errorf("output is not JSON: %s", got)
		}
	}
	for _, bad := range []string{`{"properties": null}`, `{"properties": [1]}`, `[1]`} {
		if _, err := setProm([]byte(bad), "1.0"); err == nil {
			t.Errorf("setProm(%s): want an error, as Python raises", bad)
		}
	}
}

func TestPyStr(t *testing.T) {
	for in, want := range map[string]string{
		"-5": "-5", "-0": "0", "56.8": "56.8", "-7.50": "-7.5", "1e1": "10.0", "10.0": "10.0",
		"-8.6493305": "-8.6493305", "0.000833333": "0.000833333",
	} {
		if got := pyStr(json.Number(in)); got != want {
			t.Errorf("pyStr(%s) = %q, want %q", in, got, want)
		}
	}
}
