// Command prepare-peak-tiles makes peaks safe to tile: every one that goes in has to come
// out drawable.
//
//	prepare-peak-tiles IN.geojsonl OUT.geojsonl
//
// Run by build-peaks.sh. Lines it does not change are copied through byte for byte.
//
// MapLibre draws a point only from a tile that holds it, 0 <= x, y < extent in that
// tile's own coordinates: points in a tile's buffer are skipped, so none is drawn twice
// (`addSymbolAtAnchor` in symbol_layout.ts, and circle_bucket.ts, read at maplibre-gl
// 5.24.0). A point that tippecanoe leaves outside every tile is on no map at all. Two
// kinds of peak end up that way, and build-peaks.sh's tile check failed the planet build
// over both (2026-09-25):
//
//   - Beyond Web Mercator. Tiles stop at +-85.0511 degrees, and tippecanoe drops anything
//     beyond without a word: 181 Transantarctic summits. Also left out: anything within
//     margin of that line. Close enough to it, a peak snaps onto the bottom edge of the
//     bottom row, pixel 4096 of 4096, and is drawn by no tile (half a pixel is 0.0005
//     degrees there at z3 and less deeper). No peak in OSM is that close, the nearest are
//     six at exactly -85.05, which stay.
//
//   - On a rounding tie at a tile edge. tippecanoe rounds a point's position to tile
//     pixels with std::round, half away from zero. A peak exactly half a pixel short of an
//     edge rounds up to 4096 in its own tile and down to -1 in its neighbour's buffer:
//     outside both. Хонголдойский Голец (node 4707311223, lon 101.2496567) sits exactly
//     there, half a z7 pixel west of 101.25, in 32-bit world units: 33550336 into tile
//     99, -4096 from tile 100 (replayed in C with tippecanoe's own arithmetic). About one
//     peak in the planet's 1.2 M should hit this at a given zoom. Each one found is moved
//     step west or north, into the tile it belongs to, which is OSM's own last digit,
//     ~1 cm.
//
// The tie test replays tippecanoe 2.79.0: lonlat2tile(lon, lat, 32) in projection.cpp for
// the world position (same double arithmetic, same rounding), and to_tile_scale in
// geometry.cpp for the pixel, at detail 12. That holds because
// `--extend-zooms-if-still-dropping` sets geometry_scale to 0 (main.cpp): no coarser
// rounding before the tile scale. Zooms 0-14 are covered, whichever one ends up the top
// zoom.
//
// The replay's log, tan and cos are Go's, where tippecanoe's were the C library's, and
// the two can differ in the last bit. Measured against the Python (which called the C
// library too) on 3,017,563 coordinates — 3 M random ones and every local peak,
// 2026-09-26 — the rounded world x agreed on all of them and y on all but 2, both at
// high southern latitudes where the unrounded value sat within 2e-6 of a half, and
// neither a tie either way. That is the same order of disagreement as between two C
// libraries: the Python on macOS was never bit-exact with tippecanoe on the image's
// glibc either. The tile check after tippecanoe is what proves it: if this replay were
// ever wrong, that check fails and names the peak.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/jsonedit"
	"ratmap/infra/tools/internal/num"
	"ratmap/infra/tools/internal/rawjson"
)

const (
	margin = 0.001
	world  = 1 << 32
	detail = 12
	minZ   = 0
	maxZ   = 14
	step   = 1e-7
)

// mercatorLimit is the latitude where Web Mercator's square world ends:
// degrees(atan(sinh(pi))) as the C library computes it, as tippecanoe does. Written out rather
// than recomputed because Go's math.Sinh(math.Pi) is one ulp above the C library's
// (11.548739357257748 against ...746), which carries through to a limit one ulp lower.
const mercatorLimit = 85.0511287798066

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: prepare-peak-tiles IN.geojsonl OUT.geojsonl")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "prepare-peak-tiles:", err)
		os.Exit(1)
	}
}

func run(srcPath, destPath string, out io.Writer) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()
	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(dest, 1<<20)
	r := bufio.NewReaderSize(src, 1<<20)

	limit := mercatorLimit - margin
	kept := 0
	var beyond []json.RawMessage // names, as their JSON values
	var moved []string
	for n := 1; ; n++ {
		line, rerr := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			result, name, note, err := prepare(line, limit)
			if err != nil {
				dest.Close()
				return fmt.Errorf("%s: line %d: %w", srcPath, n, err)
			}
			switch {
			case result == nil:
				beyond = append(beyond, name)
			default:
				if note != "" {
					moved = append(moved, note)
				}
				w.Write(result)
				if !bytes.HasSuffix(result, []byte("\n")) {
					w.WriteByte('\n')
				}
				kept++
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dest.Close()
			return rerr
		}
	}
	if err := w.Flush(); err != nil {
		dest.Close()
		return err
	}
	if err := dest.Close(); err != nil {
		return err
	}

	first := fmt.Sprintf("  %d peaks to tile; %d beyond Web Mercator (+-%.4f) left out", kept, len(beyond), limit)
	if len(beyond) > 0 {
		var names []string
		for _, raw := range beyond[:min(5, len(beyond))] {
			names = append(names, rawjson.Text(raw))
		}
		first += ", e.g. " + strings.Join(names, ", ")
	}
	fmt.Fprintln(out, first)
	second := fmt.Sprintf("  %d moved 1e-7 degrees off a tile-edge rounding tie", len(moved))
	if len(moved) > 0 {
		second += ": " + strings.Join(moved[:min(10, len(moved))], "; ")
	}
	fmt.Fprintln(out, second)
	return nil
}

// prepare decides one feature. It returns the line to write (the input itself when
// nothing changes), or nil for a peak beyond Web Mercator along with its name; note
// describes a move for the report.
func prepare(line []byte, limit float64) ([]byte, json.RawMessage, string, error) {
	// Maps, not a struct: encoding/json matches struct fields case-insensitively, and a
	// "Geometry" member is not the geometry.
	var feature map[string]json.RawMessage
	if err := json.Unmarshal(line, &feature); err != nil {
		return nil, nil, "", err
	}
	var geometry map[string]json.RawMessage
	if err := json.Unmarshal(feature["geometry"], &geometry); err != nil || geometry == nil {
		return nil, nil, "", fmt.Errorf("geometry is %s, not an object", feature["geometry"])
	}
	var coords []json.RawMessage
	if err := json.Unmarshal(geometry["coordinates"], &coords); err != nil || len(coords) < 2 {
		return nil, nil, "", fmt.Errorf("coordinates %s: not a list of two or more", geometry["coordinates"])
	}
	lonRaw, latRaw := coords[0], coords[1]
	lon, ok1 := number(lonRaw)
	lat, ok2 := number(latRaw)
	if !ok1 || !ok2 {
		return nil, nil, "", fmt.Errorf("coordinates %s, %s are not numbers", lonRaw, latRaw)
	}

	name := json.RawMessage(`"(unnamed)"`)
	if p, ok := feature["properties"]; ok {
		var props map[string]json.RawMessage
		if err := json.Unmarshal(p, &props); err != nil {
			return nil, nil, "", fmt.Errorf("properties is %s, not an object", p)
		}
		if v, ok := props["name"]; ok {
			name = v
		}
	}

	if math.Abs(lat) > limit {
		return nil, name, "", nil
	}
	newLon, newLat, err := untie(lon, lat)
	if err != nil {
		return nil, nil, "", err
	}
	if newLon == lon && newLat == lat {
		return line, nil, "", nil
	}

	// The moved position replaces the whole list: a third coordinate, if any, goes.
	top, err := jsonedit.Parse(line, 0)
	if err != nil {
		return nil, nil, "", err
	}
	gi, err := top.Find("geometry")
	if err != nil {
		return nil, nil, "", err
	}
	geom, err := jsonedit.Parse(line, top.Members[gi].ValueStart)
	if err != nil {
		return nil, nil, "", err
	}
	edited, err := geom.Set(line, "coordinates",
		[]byte("["+strconv.FormatFloat(newLon, 'f', -1, 64)+", "+strconv.FormatFloat(newLat, 'f', -1, 64)+"]"))
	if err != nil {
		return nil, nil, "", err
	}
	note := fmt.Sprintf("%s (%s, %s)", rawjson.Text(name), rawjson.Text(lonRaw), rawjson.Text(latRaw))
	return edited, nil, note, nil
}

// number reads a coordinate: a JSON number, and nothing else.
func number(raw json.RawMessage) (float64, bool) {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	return f, true
}

// llround is C's llround: halves go away from zero.
func llround(v float64) int64 {
	if v >= 0 {
		return int64(math.Floor(v + 0.5))
	}
	return -int64(math.Floor(-v + 0.5))
}

// worldXY is tippecanoe's lonlat2tile(lon, lat, 32), operation for operation. The
// float64() conversions stop Go fusing a multiply into the next add or subtract (FMA,
// which it may do on arm64): C rounds each operation on its own.
func worldXY(lon, lat float64) (int64, int64) {
	latRad := float64(lat*math.Pi) / 180
	x := llround(float64(world * ((lon + 180) / 360)))
	y := llround(float64(world*(1-(math.Log(math.Tan(latRad)+1/math.Cos(latRad))/math.Pi))) / 2)
	return x, y
}

// tieZoom reports whether world coordinate w is exactly half a pixel short of a tile edge
// at some zoom in 0-14.
func tieZoom(w int64) bool {
	for z := minZ; z <= maxZ; z++ {
		tile := int64(1) << (32 - z)
		half := int64(1) << (32 - z - detail - 1)
		if floorMod(w+half, tile) == 0 {
			return true
		}
	}
	return false
}

// floorMod is a mod b rounded toward negative infinity: never negative for a positive b,
// where Go's % takes the sign of a.
func floorMod(a, b int64) int64 {
	m := a % b
	if m < 0 {
		m += b
	}
	return m
}

// untie moves (lon, lat) off any tie, west and north (y grows southward): into its own
// tile.
func untie(lon, lat float64) (float64, float64, error) {
	for range 10 {
		x, y := worldXY(lon, lat)
		tx, ty := tieZoom(x), tieZoom(y)
		if !tx && !ty {
			return lon, lat, nil
		}
		if tx {
			lon = num.Round(lon-step, 7)
		}
		if ty {
			lat = num.Round(lat+step, 7)
		}
	}
	return 0, 0, fmt.Errorf("could not move (%v, %v) off a tile-edge tie", lon, lat)
}
