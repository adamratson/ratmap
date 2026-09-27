// Command assemble-avalanche assembles per-zoom slope/aspect rasters into one MBTiles
// pyramid, losslessly.
//
//	assemble-avalanche --out OUT.mbtiles --name NAME --bounds=W,S,E,N [--webp] [--jobs N] Z:RASTER...
//
// A port of scripts/assemble-avalanche.py, which it replaces in build-avalanche.sh: same
// arguments, same tiles, same metadata, same report.
//
// # Why this is not `gdaladdo`
//
// The pyramid for this layer must reduce by **maximum**, not by average (constraint A4):
// averaging dissolves a 40-degree gully inside a 25-degree hillside, so the layer quietly
// stops warning about exactly the feature it exists for, and it does so in the direction
// that under-warns. `gdaladdo -r max` does not exist — GDAL 3.13 answers "Unsupported
// resampling method 'max'" for single- and multi-band alike — and
// `gdal_translate -tr ... -r max`, which looks like the way round it, only *warns*
// ("GDAL_RASTERIO_RESAMPLING = max not supported") and silently falls back to nearest. So
// encode-avalanche does the reduction itself and hands the whole stack to this, which
// only has to tile and merge.
//
// Aspect is not reduced independently: it follows whichever cell won the slope maximum,
// so a coarse cell reads "the steepest thing here is 38 degrees, facing north-east" — one
// coherent statement about one real cell.
//
// # Why the encoding is checked rather than trusted
//
// These RGB bytes are three numbers, not a colour. GDAL's MBTiles driver offers WEBP only
// through `QUALITY`, which is lossy at every value including 100 — measured, a channel
// written as the constant 128 came back spread over 92-133. Decoded as a DEM that is a
// +/-9216-degree error per corrupted byte, scattered as plausible-looking noise across the
// map (constraint A3). So tiles are written as PNG, and the optional WebP pass re-encodes
// them with `cwebp -lossless -exact` and then **decodes every re-encoded tile back and
// compares it byte for byte** with the PNG it came from. A pass that cannot prove itself
// does not run.
package main

import (
	"bytes"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	_ "modernc.org/sqlite"

	"ratmap/infra/tools/internal/cli"
)

type tile struct {
	z, x, y int64
	data    []byte
}

// errFail is a check that failed: its FAIL message printed on its own, exit status 1.
type errFail struct{ msg string }

func (e errFail) Error() string { return e.msg }

const usage = `usage: assemble-avalanche --out OUT --name NAME --bounds W,S,E,N [--webp] [--jobs N] Z:RASTER [Z:RASTER ...]`

func main() {
	fs := flag.NewFlagSet("assemble-avalanche", flag.ExitOnError)
	out := fs.String("out", "", "the MBTiles to write")
	name := fs.String("name", "", "its metadata name")
	bounds := fs.String("bounds", "", "w,s,e,n in degrees")
	webp := fs.Bool("webp", false, "re-encode tiles as lossless WebP")
	jobs := fs.Int("jobs", 0, "tiles to re-encode at once (0: half the cores). Set this below "+
		"the core count when several regions build in parallel.")
	levels := cli.Parse(fs, usage, os.Args[1:])
	given := cli.Given(fs)
	for _, req := range []string{"out", "name", "bounds"} {
		if !given[req] {
			cli.Fail(fs, "--%s is required", req)
		}
	}
	if len(levels) == 0 {
		cli.Fail(fs, "at least one Z:RASTER is required")
	}
	err := run(*out, *name, *bounds, *webp, *jobs, levels)
	if err != nil {
		var fail errFail
		if errors.As(err, &fail) {
			fmt.Fprintln(os.Stderr, fail.msg)
		} else {
			fmt.Fprintln(os.Stderr, "assemble-avalanche:", err)
		}
		os.Exit(1)
	}
}

func run(out, name, boundsArg string, webp bool, jobs int, levels []string) error {
	// Batch work, explicitly deprioritised. Costs nothing when the machine is idle and is
	// the difference between "the build is running" and "the laptop is gone" when it is
	// not. Children inherit it, so this covers every cwebp and gdal_translate below.
	lowerPriority(10)

	work, err := os.MkdirTemp("", "assemble-avalanche-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	var all []tile
	var zooms []int64
	for _, spec := range levels {
		zText, raster, ok := strings.Cut(spec, ":")
		if !ok {
			return fmt.Errorf("level %q is not Z:RASTER", spec)
		}
		z, err := strconv.ParseInt(strings.TrimSpace(zText), 10, 64)
		if err != nil {
			return fmt.Errorf("level %q: %w", spec, err)
		}
		levelDB := filepath.Join(work, fmt.Sprintf("l%d.mbtiles", z))
		if err := gdalTranslateMBTiles(raster, levelDB); err != nil {
			return err
		}
		got, rows, err := levelTiles(levelDB)
		if err != nil {
			return err
		}
		// The driver picks a zoom from the raster's resolution. Every level here is built
		// at exactly one zoom's resolution, so a mismatch means the resolution maths and the
		// tile grid have drifted apart — which would silently stack two levels on top of
		// each other in the merged archive.
		if len(got) != 1 || got[0] != z {
			return errFail{fmt.Sprintf("FAIL: raster for z%d tiled as %s; resolution and tile grid disagree", z, intList(got))}
		}
		fmt.Printf("  z%d: %d tiles\n", z, len(rows))
		all = append(all, rows...)
		zooms = append(zooms, z)
	}

	format := "png"
	if webp {
		converted, err := toLosslessWebP(all, work, jobs)
		if err != nil {
			return err
		}
		if converted != nil {
			pngBytes, webpBytes := totalBytes(all), totalBytes(converted)
			fmt.Printf("  lossless WebP: %.0f kB (%.0f%% of PNG), all %d tiles verified identical after decode\n",
				float64(webpBytes)/1024, float64(100*webpBytes)/float64(pngBytes), len(converted))
			all, format = converted, "webp"
		}
	}

	var bounds []float64
	for _, v := range strings.Split(boundsArg, ",") {
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return fmt.Errorf("--bounds %q: %w", boundsArg, err)
		}
		bounds = append(bounds, f)
	}
	minZ, maxZ := zooms[0], zooms[0]
	for _, z := range zooms {
		minZ, maxZ = min(minZ, z), max(maxZ, z)
	}
	if err := writeMBTiles(out, all, name, format, bounds, minZ, maxZ); err != nil {
		return err
	}
	fmt.Printf("  %d tiles, %.0f kB of tile data, z%d-z%d, %s\n",
		len(all), float64(totalBytes(all))/1024, minZ, maxZ, format)
	return nil
}

func totalBytes(rows []tile) int64 {
	var n int64
	for _, r := range rows {
		n += int64(len(r.data))
	}
	return n
}

// intList writes ints as "[10, 11]".
func intList(v []int64) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.FormatInt(n, 10)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func command(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

func gdalTranslateMBTiles(src, dst string) error {
	return command("gdal_translate", "-q", "-of", "MBTILES",
		"-co", "TILE_FORMAT=PNG",
		"-co", "BLOCKSIZE=512",
		// The input is already at this zoom's exact resolution and snapped to the tile
		// grid, so the driver has nothing to resample. NEAREST makes that explicit: any
		// interpolation here would blend two slope classes into a value that exists in
		// neither cell.
		"-co", "RESAMPLING=NEAREST",
		src, dst)
}

// levelTiles is a single-level MBTiles' zooms and tiles, in the order SQLite scans them.
func levelTiles(path string) ([]int64, []tile, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()
	zr, err := db.Query("SELECT DISTINCT zoom_level FROM tiles")
	if err != nil {
		return nil, nil, err
	}
	var zooms []int64
	for zr.Next() {
		var z int64
		if err := zr.Scan(&z); err != nil {
			zr.Close()
			return nil, nil, err
		}
		zooms = append(zooms, z)
	}
	zr.Close()
	rows, err := db.Query("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var out []tile
	for rows.Next() {
		var t tile
		if err := rows.Scan(&t.z, &t.x, &t.y, &t.data); err != nil {
			return nil, nil, err
		}
		out = append(out, t)
	}
	return zooms, out, rows.Err()
}

// decodeToRaw decodes an image to a raw band-sequential array via GDAL.
//
// `INTERLEAVE=BSQ` is not a detail. Left to itself GDAL picks the interleave that suits
// each source driver — BIP for PNG, BSQ for WebP — so comparing the two raw dumps of
// *identical* pixels reports 65% of bytes differing while every band statistic matches.
// That is exactly what the first run of this check did, and it failed the build on a
// lossless re-encode that was in fact perfect. Pinning the layout compares pixels.
func decodeToRaw(path, work string, index int) ([]byte, error) {
	out := filepath.Join(work, fmt.Sprintf("d%d.img", index))
	stem := strings.TrimSuffix(out, filepath.Ext(out))
	for _, stale := range []string{out, out + ".aux.xml", stem + ".hdr"} {
		os.Remove(stale)
	}
	if err := command("gdal_translate", "-q", "-of", "ENVI", "-co", "INTERLEAVE=BSQ", path, out); err != nil {
		return nil, err
	}
	return os.ReadFile(out)
}

// webpEffort is cwebp's compression effort. Measured on a real tile from this pipeline
// (2026-09-08):
//
//	-z 0    69 728 bytes   0.01 s
//	-z 3    51 594 bytes   0.03 s
//	-z 6    50 986 bytes   0.05 s
//	-z 9    48 508 bytes   2.71 s
//
// `-z 9` costs **54x the CPU of -z 6 for 4.9% smaller files**. That is the whole reason
// this pass used to saturate a laptop: eight threads each holding a core at 100% for
// minutes, to save about 2 MB on a 40 MB region. 6 is the knee of the curve. Raise it
// with AVALANCHE_WEBP_EFFORT on a machine that has time to spare and nothing else to do.
func webpEffort() string {
	if v, ok := os.LookupEnv("AVALANCHE_WEBP_EFFORT"); ok {
		return v
	}
	return "6"
}

// webpOne re-encodes one tile and proves it decodes identically.
func webpOne(t tile, work string, index int) (tile, error) {
	png := filepath.Join(work, fmt.Sprintf("t%d.png", index))
	webp := filepath.Join(work, fmt.Sprintf("t%d.webp", index))
	if err := os.WriteFile(png, t.data, 0o644); err != nil {
		return tile{}, err
	}
	if err := command("cwebp", "-quiet", "-lossless", "-z", webpEffort(), "-exact", png, "-o", webp); err != nil {
		return tile{}, err
	}
	a, err := decodeToRaw(png, work, index)
	if err != nil {
		return tile{}, err
	}
	b, err := decodeToRaw(webp, work, index)
	if err != nil {
		return tile{}, err
	}
	if !bytes.Equal(a, b) {
		return tile{}, errFail{fmt.Sprintf("FAIL: WebP re-encode of tile %d/%d/%d does not decode identically", t.z, t.x, t.y)}
	}
	data, err := os.ReadFile(webp)
	return tile{t.z, t.x, t.y, data}, err
}

// toLosslessWebP re-encodes PNG tiles as lossless WebP, proving each one decodes
// identically. It returns nil if cwebp is unavailable. Any tile that fails to round-trip
// aborts the build rather than being silently kept as PNG — a pyramid that is half one
// format and half another, with no record of which, is worse than a larger one.
//
// Run across `jobs` workers, half the cores by default. Each tile costs a cwebp plus two
// gdal_translate decodes for the proof — about 0.43 s at the default effort, of which
// 0.38 s is the two decodes. `jobs` exists because this is not the only thing running:
// the avalanche stage builds several regions at once (RATMAP_AVALANCHE_PARALLEL), and a
// worker per core in each of them is several times the machine's cores in cwebp
// processes. Taking a share rather than the lot is what makes the outer number a
// throughput setting instead of a queueing one.
func toLosslessWebP(rows []tile, work string, jobs int) ([]tile, error) {
	if _, err := exec.LookPath("cwebp"); err != nil {
		fmt.Println("  cwebp not found — keeping PNG tiles")
		return nil, nil
	}
	// Half the cores by default, not all of them. This is a build tool that people run on
	// the laptop they are also using: taking every core (including the efficiency cores
	// macOS runs background work on) makes the machine unusable for the duration, which
	// is exactly what happened on the first Aragón run. A build box can have the lot via
	// --jobs. (runtime.NumCPU counts the cores this process may run on.)
	want := jobs
	if want <= 0 {
		want = max(1, runtime.NumCPU()/2)
	}
	workers := max(1, min(len(rows), want))
	fmt.Printf("  re-encoding %d tiles as WebP, %d at a time\n", len(rows), workers)

	out := make([]tile, len(rows))
	errs := make([]error, len(rows))
	next := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				out[i], errs[i] = webpOne(rows[i], work, i)
			}
		}()
	}
	for i := range rows {
		next <- i
	}
	close(next)
	wg.Wait()
	// The first failure in tile order, as pool.map raised it.
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func writeMBTiles(path string, rows []tile, name, format string, bounds []float64, minZ, maxZ int64) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, s := range []string{
		"CREATE TABLE metadata (name text, value text)",
		"CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)",
		"CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)",
	} {
		if _, err := tx.Exec(s); err != nil {
			tx.Rollback()
			return err
		}
	}
	ins, err := tx.Prepare("INSERT INTO tiles VALUES (?,?,?,?)")
	if err != nil {
		tx.Rollback()
		return err
	}
	for _, t := range rows {
		if _, err := ins.Exec(t.z, t.x, t.y, t.data); err != nil {
			tx.Rollback()
			return err
		}
	}
	b := make([]string, len(bounds))
	for i, v := range bounds {
		b[i] = fmt.Sprintf("%.6f", v)
	}
	for _, kv := range [][2]string{
		{"name", name},
		{"format", format},
		{"type", "overlay"},
		{"version", "1"},
		{"description", "ratmap avalanche terrain (slope, aspect)"},
		{"bounds", strings.Join(b, ",")},
		{"minzoom", strconv.FormatInt(minZ, 10)},
		{"maxzoom", strconv.FormatInt(maxZ, 10)},
	} {
		if _, err := tx.Exec("INSERT INTO metadata VALUES (?,?)", kv[0], kv[1]); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
