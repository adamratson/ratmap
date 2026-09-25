// Command encode-avalanche computes slope and aspect from a Web Mercator DEM, as two
// single-band Byte rasters per zoom, max-reduced down a pyramid.
//
// A port of scripts/encode-avalanche.py, which it replaces in build-avalanche.sh: same
// arguments, same files out, no numpy. The avalanche terrain layer
// (plans/avalanche-terrain.md) needs the *shape* of the ground — how steep, and which way
// it faces. Both are pure derivatives of the DEM, computed once at build time from
// Copernicus GLO-30 and shipped as tiles: no third-party feed, nothing live, nothing
// computed in the browser (C14).
//
// # The projection trap, which is the whole reason this is a program and not one gdaldem call
//
// `gdaldem slope` on a Web Mercator raster is **wrong, silently, and in the dangerous
// direction**. Mercator stretches horizontal distance by 1/cos(latitude); heights are
// still in real metres, so every gradient comes out too shallow by that factor. Measured
// over Ben Nevis (2026-09-08, 809 km²):
//
//	correct                                11.8% of terrain >= 30 deg, 5.9% >= 35
//	gdaldem on the 3857 raster              0.6%                        0.2%
//	gdaldem -s 111120 on the 4326 source    6.0%                        2.7%
//
// The first wrong answer erases 95% of Lochaber's avalanche terrain and renders a real
// 36-degree slope as 21. The second — the form GDAL's own docs suggest for geographic
// input — halves it, because a degree of longitude is cos(lat) as long as a degree of
// latitude. Both produce a completely plausible-looking map. This is constraint A1.
//
// The fix is exact rather than approximate: Mercator is *conformal*, so its scale
// distortion at a point is identical in x and y. The true ground cell size on a raster row
// is therefore `pixelSize * cos(lat)` in both axes, and a slope computed with that cell
// size is right, not merely closer. Each row in a 3857 raster is a constant latitude, so
// this is one multiply per row.
package main

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"ratmap/infra/tools/internal/cli"
	"ratmap/infra/tools/internal/gdal"
	"ratmap/infra/tools/internal/pyfloat"
)

const usage = `usage: encode-avalanche [--self-test] DEM OUT_DIR --zmax Z --zmin Z [--stats-json PATH]

Slope and aspect from a Web Mercator DEM, as slope-<z>/aspect-<z> Byte rasters per zoom.`

func main() {
	a := cli.Parse(os.Args[1:], usage, []cli.Spec{
		{Name: "self-test", Bool: true, Help: "check the maths against known planes and exit"},
		{Name: "zmax", Help: "zoom the DEM is gridded at"},
		{Name: "zmin", Help: "coarsest zoom to reduce down to"},
		{Name: "stats-json", Help: "write the class histogram here"},
	})
	if a.Has("self-test") {
		if failures := selfTest(os.Stdout); len(failures) > 0 {
			for _, f := range failures {
				fmt.Fprintf(os.Stderr, "  FAIL %s\n", f)
			}
			fmt.Fprintf(os.Stderr, "%d self-test failure(s)\n", len(failures))
			os.Exit(1)
		}
		fmt.Println("  self-test passed")
		return
	}
	if len(a.Positionals) != 2 || !a.Has("zmax") || !a.Has("zmin") {
		fmt.Fprintf(os.Stderr, "%s\nerror: dem, out_dir, --zmax and --zmin are required unless --self-test\n", usage)
		os.Exit(2)
	}
	err := run(a.Positionals[0], a.Positionals[1], a.Int("zmax", 0), a.Int("zmin", 0), a.String("stats-json", ""))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(demPath, outDir string, zmax, zmin int, statsPath string) error {
	// Converted to a flat float32 file and streamed, never read whole.
	demRaw := filepath.Join(outDir, "dem.img")
	if err := gdal.TranslateENVIFloat32(demPath, demRaw); err != nil {
		return err
	}
	info, err := gdal.ReadInfo(demPath)
	if err != nil {
		return err
	}
	w, h, gt := info.Width, info.Height, info.GeoTransform
	fmt.Printf("  raster: %d x %d px (%.1f Mpx)\n", w, h, float64(w*h)/1e6)

	levels, counts, err := computeLevels(demRaw, w, h, gt, outDir, zmax, zmin)
	if err != nil {
		return err
	}

	// Reported at the top zoom only. It is what the build asserts against, and every way
	// this can go wrong — the projection correction, the pyramid reduction, a resampling
	// fallback — moves it by a large factor rather than a subtle one.
	var total int64
	for _, n := range counts {
		total += n
	}
	maxSlope := maxNonzero(counts)
	fmt.Printf("  slope at z%d: max %d deg\n", zmax, maxSlope)
	var classes []string
	for _, b := range [][2]int{{25, 30}, {30, 35}, {35, 40}, {40, 45}, {45, 61}} {
		var n int64
		for v := b[0]; v < b[1]; v++ {
			n += counts[v]
		}
		pct := float64(100.0*float64(n)) / float64(max(1, total))
		classes = append(classes, fmt.Sprintf(`  "%d-%d": %s`, b[0], b[1]-1, pyfloat.Repr(pyfloat.Round(pct, 4))))
		fmt.Printf("    %d-%d deg: %6.2f%%\n", b[0], b[1]-1, pct)
	}

	levelGT := gt
	for z := zmax; z >= zmin; z-- {
		l, ok := levels[z]
		if !ok {
			break
		}
		if err := enviToTIF(l.slopeRaw, l.w, l.h, levelGT, filepath.Join(outDir, fmt.Sprintf("slope-%d.tif", z))); err != nil {
			return err
		}
		if err := enviToTIF(l.aspectRaw, l.w, l.h, levelGT, filepath.Join(outDir, fmt.Sprintf("aspect-%d.tif", z))); err != nil {
			return err
		}
		levelGT[1] *= 2
		levelGT[5] *= 2
	}

	if statsPath != "" {
		// json.dump(stats, indent=1)'s exact text, so anything diffing the file sees no
		// change from the Python.
		doc := fmt.Sprintf("{\n \"zmax\": %d,\n \"cells\": %d,\n \"max_slope\": %d,\n \"classes\": {\n%s\n }\n}",
			zmax, total, maxSlope, strings.Join(classes, ",\n"))
		if err := os.WriteFile(statsPath, []byte(doc), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// enviToTIF georeferences a flat byte array as a GeoTIFF, without copying it through
// memory.
func enviToTIF(raw string, w, h int, gt [6]float64, path string) error {
	if err := gdal.WriteENVIHeader(raw, w, h, 1); err != nil {
		return err
	}
	ulx, xres, uly, yres := gt[0], gt[1], gt[3], gt[5]
	cmd := exec.Command("gdal_translate", "-q", "-of", "GTiff", "-co", "COMPRESS=DEFLATE",
		"-a_srs", "EPSG:3857",
		"-a_ullr",
		pyfloat.Repr(ulx), pyfloat.Repr(uly),
		pyfloat.Repr(ulx+float64(float64(w)*xres)), pyfloat.Repr(uly+float64(float64(h)*yres)),
		raw, path)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("gdal_translate %s -> %s: %w", raw, path, err)
	}
	return nil
}

// slopeAspect is whole-array slope and aspect from a 3857 DEM, for the self-test: the
// same hornRow the streamed pass uses, with the top and bottom rows replicated.
func slopeAspect(dem [][]float64, gt [6]float64) ([][]float64, [][]float64) {
	h := len(dem)
	slope, aspect := make([][]float64, h), make([][]float64, h)
	for r := 0; r < h; r++ {
		slope[r], aspect[r] = make([]float64, len(dem[r])), make([]float64, len(dem[r]))
		hornRow(dem[max(r-1, 0)], dem[r], dem[min(r+1, h-1)], groundScale(gt, r), slope[r], aspect[r])
	}
	return slope, aspect
}

// selfTest asserts the maths against planes whose slope is known analytically, and
// returns what failed. Run on every build by build-avalanche.sh, and by `go test`.
//
// Earns its place for the same reason normalize-sac.py's does: the failure this guards
// against produces a map that looks right and reads low, and nothing downstream can
// detect it. In particular the regression guard fails loudly if the cos(lat) correction
// is ever dropped — which is the exact regression that would otherwise ship.
func selfTest(out *os.File) []string {
	var failures []string
	check := func(name string, got, want, tol float64) {
		if math.Abs(got-want) > tol {
			failures = append(failures, fmt.Sprintf("%s: got %.3f, want %.3f", name, got, want))
		} else {
			fmt.Fprintf(out, "  OK %s: %.2f (want %.2f)\n", name, got, want)
		}
	}

	// A plane at 57N. Pick a Mercator pixel size, derive the true ground cell from it, and
	// build a surface that rises by a known amount per *ground* metre — so the expected
	// slope is known without reference to any of the code under test.
	lat := 57.0 * math.Pi / 180
	yTop := rMercator * math.Asinh(math.Tan(lat))
	const xres = 38.2185141425881 // z11 at 512 px
	ground := xres * math.Cos(lat)
	const height, width = 64, 64
	gt := [6]float64{0, xres, 0, yTop, 0, -xres}

	// Falling towards +x (east) by rise per cell, so the downslope direction is due east.
	eastPlane := func(rise float64) [][]float64 {
		dem := make([][]float64, height)
		for r := range dem {
			dem[r] = make([]float64, width)
			for c := range dem[r] {
				dem[r][c] = float64(width-c) * rise
			}
		}
		return dem
	}

	for _, wantDeg := range []float64{10, 30, 45} {
		rise := math.Tan(wantDeg*math.Pi/180) * ground
		slope, aspect := slopeAspect(eastPlane(rise), gt)
		check(fmt.Sprintf("plane %.0f deg at 57N", wantDeg), slope[height/2][width/2], wantDeg, 0.05)
		_, octant := quantise(slope[height/2][width/2], aspect[height/2][width/2])
		if wantDeg >= slopeFloorDeg && octant != 3 {
			failures = append(failures, fmt.Sprintf("aspect east: got octant %d, want 3", octant))
		}
	}

	// Falling towards +y (south, since rows increase southwards): octant 5.
	rise := math.Tan(35.0*math.Pi/180) * ground
	south := make([][]float64, height)
	for r := range south {
		south[r] = make([]float64, width)
		for c := range south[r] {
			south[r][c] = float64(height-r) * rise
		}
	}
	slope, aspect := slopeAspect(south, gt)
	if _, octant := quantise(slope[height/2][width/2], aspect[height/2][width/2]); octant != 5 {
		failures = append(failures, fmt.Sprintf("aspect south: got octant %d, want 5", octant))
	} else {
		fmt.Fprintln(out, "  OK aspect south: octant 5")
	}

	// The regression guard. The same physical plane at two latitudes must read the same
	// slope; it only does if the projection correction is applied. Without it the 57N
	// reading collapses to about 21 degrees against 35 — which is the measured Ben Nevis
	// failure in miniature.
	slopeAt := func(latDeg, wantDeg float64) float64 {
		la := latDeg * math.Pi / 180
		gtL := [6]float64{0, xres, 0, rMercator * math.Asinh(math.Tan(la)), 0, -xres}
		rise := math.Tan(wantDeg*math.Pi/180) * xres * math.Cos(la)
		s, _ := slopeAspect(eastPlane(rise), gtL)
		return s[height/2][width/2]
	}
	check("same plane at 5N", slopeAt(5, 35), 35, 0.05)
	check("same plane at 57N", slopeAt(57, 35), 35, 0.05)
	check("same plane at 70N", slopeAt(70, 35), 35, 0.05)

	// Quantisation boundaries, including the direction each rounds.
	var gotS, gotO []uint8
	for _, v := range []float64{0, 24.99, 25, 29.99, 59.4, 61, 88} {
		asp := 10.0
		if v == 0 {
			asp = 0
		}
		s, o := quantise(v, asp)
		gotS, gotO = append(gotS, s), append(gotO, o)
	}
	if fmt.Sprint(gotS) != fmt.Sprint([]uint8{0, 0, 25, 29, 59, 60, 60}) {
		failures = append(failures, fmt.Sprintf("quantise slope: got %v", gotS))
	} else {
		fmt.Fprintln(out, "  OK quantise slope boundaries")
	}
	if fmt.Sprint(gotO) != fmt.Sprint([]uint8{0, 0, 1, 1, 1, 1, 1}) {
		failures = append(failures, fmt.Sprintf("quantise aspect mask: got %v", gotO))
	} else {
		fmt.Fprintln(out, "  OK quantise aspect masked below the floor")
	}

	// Pyramid reduction. A single steep cell hidden in gentle ground must survive, and
	// must carry its own aspect up with it — the exact case an averaging resampler loses.
	s0, s1 := []uint8{0, 0, 0, 0}, []uint8{0, 47, 0, 0}
	a0, a1 := []uint8{1, 1, 1, 1}, []uint8{1, 6, 1, 1}
	rs, ra := make([]uint8, 2), make([]uint8, 2)
	reduceRow(s0, s1, a0, a1, rs, ra)
	switch {
	case rs[0] != 47:
		failures = append(failures, fmt.Sprintf("reduce max: got %v", rs))
	case ra[0] != 6:
		failures = append(failures, fmt.Sprintf("reduce aspect follows the steepest cell: got %d", ra[0]))
	default:
		fmt.Fprintln(out, "  OK reduce keeps the steepest cell and its aspect")
	}
	if rs[1] != 0 {
		failures = append(failures, "reduce leaked a value into an untouched block")
	}
	return failures
}
