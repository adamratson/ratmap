// Command compute-prominence computes topographic prominence for peaks from a DEM and
// writes it onto each feature as `prom`.
//
// A port of scripts/compute-prominence.py, which it replaces in build-peaks.sh: same
// arguments, same output bytes, no numpy/scipy. The Python's docstring is the full
// account of the method and its limits; the parts that decide behaviour are repeated at
// the code they govern, here and in prominence.go.
//
// # Why this exists
//
// Deciding which summits to show at which zoom needs a measure of how much a peak
// *stands out*, not how tall it is. Absolute elevation encodes an assumption about local
// terrain and does not travel: Scotland has ~4 peaks per square degree above 1000 m,
// Montenegro has ~674 (measured 2026-08-23). OSM tags `prominence` far too sparsely to
// rely on, so it is computed here.
//
// # Honest limitations (unchanged from the Python)
//
//   - Prominence is quantised to --step (default 20 m). Fine for ranking; do not present
//     these as surveyed figures.
//   - Summit heights come from the DEM, not OSM's `ele`: prominence is summit-minus-col
//     measured on one surface. OSM `ele` is still what the app displays.
//   - Prominence is computed within the supplied bbox only; a peak whose true key col lies
//     outside it is measured to the box edge, which over-states it. Bites at borders.
//   - The highest peak in the box never connects to anything higher, so it is assigned
//     elev - (lowest elevation in the box). That misfires when the box's true high ground
//     is a peak not in the OSM input (Montenegro's bbox clips Albania's Maja Jezercë).
//
// # Running it
//
//	compute-prominence --regions regions.json --fetch-dem fetch-dem.sh --res R \
//	    --work-dir DIR [--fetch-workers N] PEAKS_IN PEAKS_OUT
//	compute-prominence DEM PEAKS_IN PEAKS_OUT           # one raster, for spot checks
//
// With --regions it reads the peaks' coordinates once, fetches each region's DEM with
// fetch-dem.sh, scores the regions one after another smallest bbox first, and writes the
// output once at the end.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/dem-tools/internal/cli"
	"ratmap/infra/dem-tools/internal/gdal"
	"ratmap/infra/dem-tools/internal/pyfloat"
)

const usage = `usage: compute-prominence [--regions R --fetch-dem F --res X --work-dir D] [DEM] PEAKS_IN PEAKS_OUT

Topographic prominence for peaks, from Copernicus DEM clips.
With --regions: PEAKS_IN PEAKS_OUT, fetching every region's DEM.
Without: DEM PEAKS_IN PEAKS_OUT, scoring one raster (spot checks).`

func main() {
	a := cli.Parse(os.Args[1:], usage, []cli.Spec{
		{Name: "regions", Help: "regions.json — score every region in it"},
		{Name: "fetch-dem", Help: "fetch-dem.sh, with --regions"},
		{Name: "res", Help: "DEM degrees per pixel for fetch-dem.sh, with --regions"},
		{Name: "work-dir", Help: "where fetched DEMs land, with --regions"},
		{Name: "fetch-workers", Help: "DEM fetches in flight at once, with --regions (default 3)"},
		{Name: "step", Help: "metres per level set (default 20)"},
		{Name: "floor", Help: "stop descending here (default 0)"},
		{Name: "downsample", Help: "block-max factor (default 3)"},
	})
	usageErr := func(msg string) {
		fmt.Fprintf(os.Stderr, "%s\nerror: %s\n", usage, msg)
		os.Exit(2)
	}

	o := opts{
		step:         a.Float("step", 20),
		floor:        a.Float("floor", 0),
		factor:       max(1, a.Int("downsample", 3)),
		fetchWorkers: max(1, a.Int("fetch-workers", 3)),
		fetchDEM:     a.String("fetch-dem", ""),
		res:          a.String("res", ""),
		workDir:      a.String("work-dir", ""),
	}
	regions := a.String("regions", "")

	var demPath, peaksIn, peaksOut string
	if regions != "" {
		if len(a.Positionals) != 2 {
			usageErr("with --regions, give PEAKS_IN PEAKS_OUT")
		}
		if o.fetchDEM == "" || o.res == "" || o.workDir == "" {
			usageErr("--regions needs --fetch-dem, --res and --work-dir")
		}
		peaksIn, peaksOut = a.Positionals[0], a.Positionals[1]
	} else {
		if len(a.Positionals) != 3 {
			usageErr("give DEM PEAKS_IN PEAKS_OUT, or --regions with PEAKS_IN PEAKS_OUT")
		}
		demPath, peaksIn, peaksOut = a.Positionals[0], a.Positionals[1], a.Positionals[2]
	}

	if err := run(o, regions, demPath, peaksIn, peaksOut); err != nil {
		fmt.Fprintln(os.Stderr, "compute-prominence:", err)
		os.Exit(1)
	}
}

type opts struct {
	step, floor            float64
	factor, fetchWorkers   int
	fetchDEM, res, workDir string
}

func run(o opts, regions, demPath, peaksIn, peaksOut string) error {
	lons, lats, err := loadCoords(peaksIn)
	if err != nil {
		return err
	}

	var prom map[int]float64
	if regions != "" {
		if prom, err = runRegions(o, regions, lons, lats); err != nil {
			return err
		}
	} else {
		dem, w, h, gt, err := readDEM(demPath, o.factor)
		if err != nil {
			return err
		}
		var candidates int
		if prom, candidates, err = scoreRegion(dem, w, h, gt, lons, lats, o.step, o.floor); err != nil {
			return err
		}
		report(prom, candidates, len(lons), w, h, o.factor, o.step)
	}
	return writeOutput(peaksIn, peaksOut, prom)
}

// readDEM returns the DEM as float32 plus its size and geotransform, block-max
// downsampled by factor.
//
// A plain read into memory, not a mapping, for the reason the Python learned the hard
// way: a mapping outliving its temporary directory on a filesystem that renames a
// still-open file aside (NFS's .nfsXXXX, FUSE/VirtioFS's .fuse_hiddenXXXX; /work is a
// mounted volume) made the cleanup die with "Directory not empty" after the DEM fetch and
// before a single peak was scored (2026-08-24 planet run, lochaber).
func readDEM(path string, factor int) ([]float32, int, int, [6]float64, error) {
	var gt [6]float64
	tmp, err := os.MkdirTemp("", "prominence-")
	if err != nil {
		return nil, 0, 0, gt, err
	}
	defer os.RemoveAll(tmp)

	raw := filepath.Join(tmp, "dem.img")
	if err := gdal.TranslateENVIFloat32(path, raw); err != nil {
		return nil, 0, 0, gt, err
	}
	info, err := gdal.ReadInfo(path)
	if err != nil {
		return nil, 0, 0, gt, err
	}
	w, h := info.Width, info.Height
	// Cell indices are int32 in the union-find. The largest region in the catalogue is
	// 712 Mpx at 90 m (svalbard-janmayen, 2026-09-25); this is three times that.
	if int64(w)*int64(h) > math.MaxInt32 {
		return nil, 0, 0, gt, fmt.Errorf("%s: %d x %d px is too large to score", path, w, h)
	}
	dem, err := gdal.ReadFloat32(raw, w, h)
	if err != nil {
		return nil, 0, 0, gt, err
	}
	dem, w, h = downsampleMax(dem, w, h, factor)

	gt = info.GeoTransform
	if factor > 1 {
		gt[1] *= float64(factor)
		gt[5] *= float64(factor)
	}
	return dem, w, h, gt, nil
}

func report(scored map[int]float64, candidates, total, w, h, factor int, step float64) {
	fmt.Printf("prominence: %d of %d candidate peaks scored, %d in all (raster %dx%d @ %dx, %s m steps)\n",
		len(scored), candidates, total, w, h, factor, pyfloat.FormatG(step))
	values := make([]float64, 0, len(scored))
	for _, v := range scored {
		values = append(values, v)
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(values)))
	if len(values) > 0 {
		fmt.Printf("  max %.0f m | median %.0f m | P90 %.0f m\n",
			values[0], values[len(values)/2], values[len(values)/10])
	}
}

type region struct {
	ID   string        `json:"id"`
	BBox []json.Number `json:"bbox"`
}

func (r region) area() float64 {
	f := make([]float64, 4)
	for k := range f {
		f[k], _ = r.BBox[k].Float64()
	}
	return (f[2] - f[0]) * (f[3] - f[1])
}

type fetched struct {
	code int
	log  []byte
	dem  string
	err  error
}

// runRegions scores every region in the catalogue. Returns {feature_index: prominence_m}.
func runRegions(o opts, regionsPath string, lons, lats []float64) (map[int]float64, error) {
	data, err := os.ReadFile(regionsPath)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Regions []region `json:"regions"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("%s: %w", regionsPath, err)
	}
	for _, r := range doc.Regions {
		if len(r.BBox) != 4 {
			return nil, fmt.Errorf("%s: region %q has no four-number bbox", regionsPath, r.ID)
		}
	}

	// Smallest bbox first, so a larger region's pass overwrites a smaller overlapping one.
	// Lochaber and Cairngorms sit inside Scotland; prominence measured in the bigger box is
	// the better value, because a key col near the edge of a small box gets clipped to the
	// box and the peak's prominence is over-stated. Stable, so equal areas keep
	// regions.json order.
	order := append([]region(nil), doc.Regions...)
	sort.SliceStable(order, func(a, b int) bool { return order[a].area() < order[b].area() })

	fetch := func(r region) fetched {
		// The bbox exactly as Python's str() wrote it, byte for byte what build-peaks.sh
		// used to pass — and what fetch-dem.sh's cache key is built from, so a changed
		// spelling here would miss every cached DEM.
		args := []string{o.fetchDEM}
		for _, v := range r.BBox {
			args = append(args, pyStr(v))
		}
		dem := filepath.Join(o.workDir, "dem-"+r.ID+".tif")
		args = append(args, dem, o.res)

		var stdout, stderr bytes.Buffer
		cmd := exec.Command("bash", args...)
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		res := fetched{log: append(stdout.Bytes(), stderr.Bytes()...), dem: dem}
		if ee, ok := err.(*exec.ExitError); ok {
			// Killed by a signal reads -1: still "no DEM", as a negative returncode was.
			res.code = ee.ExitCode()
			if res.code == 0 {
				res.code = -1
			}
		} else if err != nil {
			res.err = err // bash itself would not start: fatal, as it was in Python
		}
		return res
	}

	// Fetches run ahead of the scoring, a few at a time. The fetch is the slow half and it
	// is network-bound: three similar regions took 70 s at once against 146 s one after
	// another (2026-09-23), with identical DEMs. Scoring stays sequential and in `order`,
	// so the overwrite rule above holds however the fetches finish, and only one DEM is
	// ever in memory.
	workers := o.fetchWorkers
	pending := map[int]chan fetched{}
	submit := func(k int) {
		ch := make(chan fetched, 1)
		pending[k] = ch
		go func(r region) { ch <- fetch(r) }(order[k])
	}
	for k := 0; k < min(workers, len(order)); k++ {
		submit(k)
	}

	prom := map[int]float64{}
	var noDEM []string
	for k, r := range order {
		res := <-pending[k]
		delete(pending, k)
		if res.err != nil {
			return nil, fmt.Errorf("fetch-dem for %s: %w", r.ID, res.err)
		}
		if k+workers < len(order) {
			submit(k + workers)
		}

		fmt.Printf("==> prominence: %s\n", r.ID)
		os.Stderr.Write(res.log)
		if res.code != 0 {
			fmt.Fprintf(os.Stderr, "  ! no DEM for %s — its peaks keep no prominence\n", r.ID)
			noDEM = append(noDEM, r.ID)
			continue
		}

		dem, w, h, gt, err := readDEM(res.dem, o.factor)
		if err != nil {
			return nil, err
		}
		if err := os.Remove(res.dem); err != nil {
			return nil, err
		}
		scored, candidates, err := scoreRegion(dem, w, h, gt, lons, lats, o.step, o.floor)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", r.ID, err)
		}
		for i, v := range scored {
			prom[i] = v
		}
		report(scored, candidates, len(lons), w, h, o.factor, o.step)

		// Hand this region's raster and union-find back before the next is read. Python's
		// `del dem` freed them on the spot; Go's collector would otherwise let the next
		// region's arrays grow the heap to about twice the live size first, so two
		// regions' rasters could be resident at once — against the one-region budget
		// build-global.sh sizes the fetch-ahead by.
		dem = nil
		debug.FreeOSMemory()
	}

	// Said once at the end as well as per region: one line per region is easy to lose in a
	// log this long, and a region with no `prom` falls back to elevation in the app.
	if len(noDEM) > 0 {
		fmt.Fprintf(os.Stderr, "prominence: %d of %d regions had no DEM, so their peaks keep no prominence: %s\n",
			len(noDEM), len(order), strings.Join(noDEM, " "))
	}
	return prom, nil
}

// pyStr is Python's str() of a JSON number as json.load parsed it: an integer literal
// stays an int (so "-0" is "0"), anything else is a float and prints as its repr.
func pyStr(n json.Number) string {
	s := n.String()
	if !strings.ContainsAny(s, ".eE") {
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return strconv.FormatInt(i, 10)
		}
		return s // beyond int64: JSON allows no leading zeros, so already canonical
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	return pyfloat.Repr(f)
}
