package main

import (
	"encoding/binary"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelfTest(t *testing.T) {
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()
	if failures := selfTest(devnull); len(failures) > 0 {
		t.Fatalf("self-test failed:\n  %s", strings.Join(failures, "\n  "))
	}
}

// The self-test's regression guard must actually bite: with the cos(lat) correction
// removed, the plane at 57N has to read far too gentle.
func TestProjectionCorrectionMatters(t *testing.T) {
	lat := 57.0 * math.Pi / 180
	gt := [6]float64{0, 38.2185141425881, 0, rMercator * math.Asinh(math.Tan(lat)), 0, -38.2185141425881}
	rise := math.Tan(35*math.Pi/180) * gt[1] * math.Cos(lat)
	row := make([]float64, 8)
	for c := range row {
		row[c] = float64(8-c) * rise
	}
	s, a := make([]float64, 8), make([]float64, 8)
	hornRow(row, row, row, 8*gt[1], s, a) // uncorrected: Mercator metres as ground metres
	if s[4] > 22 {
		t.Fatalf("uncorrected slope %.1f: the guard would not notice the correction going missing", s[4])
	}
	hornRow(row, row, row, groundScale(gt, 0), s, a)
	if math.Abs(s[4]-35) > 0.1 {
		t.Fatalf("corrected slope %.2f, want 35", s[4])
	}
}

func TestPyMod(t *testing.T) {
	for _, c := range [][3]float64{{370, 360, 10}, {360, 360, 0}, {-10, 360, 350}, {382.5, 360, 22.5}, {179.9, 360, 179.9}} {
		if got := pyMod(c[0], c[1]); got != c[2] {
			t.Errorf("pyMod(%v, %v) = %v, want %v", c[0], c[1], got, c[2])
		}
	}
	if got := pyMod(-360, 360); math.Signbit(got) {
		t.Errorf("pyMod(-360, 360) = -0, numpy gives +0")
	}
}

func TestQuantiseOctants(t *testing.T) {
	// Octant boundaries sit at 22.5 + 45k degrees; each octant is [lower, upper).
	cases := map[float64]uint8{0: 1, 22.4: 1, 22.5: 2, 67.5: 3, 90: 3, 180: 5, 270: 7, 337.4: 8, 337.5: 1, 359.9: 1}
	for asp, want := range cases {
		if _, o := quantise(40, asp); o != want {
			t.Errorf("aspect %v: octant %d, want %d", asp, o, want)
		}
	}
	if s, o := quantise(math.NaN(), math.NaN()); s != 0 || o != 0 {
		t.Errorf("NaN: got (%d, %d), want (0, 0) as numpy's uint8 cast gives", s, o)
	}
	if s, o := quantise(90, math.NaN()); s != 60 || o != 0 {
		t.Errorf("steep with NaN aspect: got (%d, %d), want (60, 0)", s, o)
	}
}

func TestReduceRowTieTakesFirstCell(t *testing.T) {
	// numpy's argmax picks the first maximum in [TL, TR, BL, BR] order; aspect follows it.
	outS, outA := make([]uint8, 1), make([]uint8, 1)
	reduceRow([]uint8{30, 30}, []uint8{30, 30}, []uint8{1, 2}, []uint8{3, 4}, outS, outA)
	if outS[0] != 30 || outA[0] != 1 {
		t.Fatalf("tie: got (%d, %d), want (30, 1)", outS[0], outA[0])
	}
	reduceRow([]uint8{30, 31}, []uint8{31, 29}, []uint8{1, 2}, []uint8{3, 4}, outS, outA)
	if outS[0] != 31 || outA[0] != 2 {
		t.Fatalf("tie between TR and BL: got (%d, %d), want (31, 2)", outS[0], outA[0])
	}
}

// computeLevels streams row by row; this checks it against the whole-array computation
// on rasters with odd sizes, including one row and one column, and that each pyramid
// level is the 2x2 max of the one above.
func TestComputeLevelsMatchesWholeArray(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for _, size := range [][2]int{{1, 1}, {1, 9}, {9, 1}, {2, 2}, {37, 23}, {64, 64}, {101, 50}} {
		w, h := size[0], size[1]
		dir := t.TempDir()
		lat := 46.5 * math.Pi / 180
		gt := [6]float64{1000000, 19.109, 0, rMercator * math.Asinh(math.Tan(lat)), 0, -19.109}

		dem := make([][]float64, h)
		raw := make([]byte, 0, w*h*4)
		for r := range dem {
			dem[r] = make([]float64, w)
			for c := range dem[r] {
				v := float32(2000 + 600*math.Sin(float64(c)/5)*math.Cos(float64(r)/7) + rng.Float64()*40)
				dem[r][c] = float64(v)
				raw = binary.LittleEndian.AppendUint32(raw, math.Float32bits(v))
			}
		}
		demRaw := filepath.Join(dir, "dem.img")
		if err := os.WriteFile(demRaw, raw, 0o644); err != nil {
			t.Fatal(err)
		}

		zmax, zmin := 12, 12-3
		levels, counts, err := computeLevels(demRaw, w, h, gt, dir, zmax, zmin)
		if err != nil {
			// The max check may legitimately fire when trimming an odd edge drops the
			// steepest cell; the Python failed the same way. Only accept that error.
			if strings.Contains(err.Error(), "changed the maximum slope") {
				t.Logf("%dx%d: skipped, %v", w, h, err)
				continue
			}
			t.Fatalf("%dx%d: %v", w, h, err)
		}

		slope, aspect := slopeAspect(dem, gt)
		wantS, wantA := make([]byte, 0, w*h), make([]byte, 0, w*h)
		var wantCounts [256]int64
		for r := 0; r < h; r++ {
			for c := 0; c < w; c++ {
				s, a := quantise(slope[r][c], aspect[r][c])
				wantS, wantA = append(wantS, s), append(wantA, a)
				wantCounts[s]++
			}
		}
		if counts != wantCounts {
			t.Errorf("%dx%d: histogram differs", w, h)
		}
		gotS, _ := os.ReadFile(levels[zmax].slopeRaw)
		gotA, _ := os.ReadFile(levels[zmax].aspectRaw)
		if string(gotS) != string(wantS) || string(gotA) != string(wantA) {
			t.Fatalf("%dx%d: streamed top level differs from whole-array", w, h)
		}

		// Each coarser level is the first-max 2x2 reduction of the level above.
		ps, pa, pw, ph := wantS, wantA, w, h
		for z := zmax - 1; z >= zmin; z-- {
			cw, ch := pw/2, ph/2
			l, ok := levels[z]
			if cw < 1 || ch < 1 {
				if ok {
					t.Fatalf("%dx%d: z%d should not exist", w, h, z)
				}
				break
			}
			cs, ca := make([]byte, cw*ch), make([]byte, cw*ch)
			for r := 0; r < ch; r++ {
				reduceRow(ps[2*r*pw:(2*r+1)*pw], ps[(2*r+1)*pw:(2*r+2)*pw], pa[2*r*pw:(2*r+1)*pw], pa[(2*r+1)*pw:(2*r+2)*pw],
					cs[r*cw:(r+1)*cw], ca[r*cw:(r+1)*cw])
			}
			gs, _ := os.ReadFile(l.slopeRaw)
			ga, _ := os.ReadFile(l.aspectRaw)
			if string(gs) != string(cs) || string(ga) != string(ca) {
				t.Fatalf("%dx%d: z%d differs", w, h, z)
			}
			ps, pa, pw, ph = cs, ca, cw, ch
		}
	}
}

func TestMaxCheckFiresWhenTrimDropsSteepestCell(t *testing.T) {
	// A 5-wide raster's last column is dropped by the first halving. Make it the only
	// ground over the draw threshold and the reduction must refuse, not quietly lose it.
	// A single raised cell in the corner: Horn gives the edge column three times the
	// gradient of its neighbour (the replicated edge counts it twice), so with this rise
	// column 4 reads ~30 degrees and column 3 ~15, which quantises to 0.
	dir := t.TempDir()
	w, h := 5, 2
	vals := []float32{0, 0, 0, 0, 0, 0, 0, 0, 0, 44}
	raw := make([]byte, 0, 40)
	for _, v := range vals {
		raw = binary.LittleEndian.AppendUint32(raw, math.Float32bits(v))
	}
	demRaw := filepath.Join(dir, "dem.img")
	os.WriteFile(demRaw, raw, 0o644)
	gt := [6]float64{0, 30, 0, 0, 0, -30}
	_, _, err := computeLevels(demRaw, w, h, gt, dir, 12, 11)
	if err == nil || !strings.Contains(err.Error(), "FAIL: reducing z12 -> z11 changed the maximum slope") {
		t.Fatalf("want the max-check failure, got %v", err)
	}
}
