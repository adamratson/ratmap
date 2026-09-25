// contour-cell turns one cell's traced contours into tagged GeoJSONSeq, clipped to the
// part of the region it owns.
//
//	contour-cell IN.csv OUT.geojsonl INDEX_EVERY XMIN XMAX YMIN YMAX
//
// build-contours.sh builds it from this directory and runs it once per cell. It was
// Python until 2026-09-25, and still writes exactly what the Python wrote, byte for byte:
// the same rounding, the same float formatting, the same cuts. It is Go for speed alone:
// 2.7 s against 7.6 s on a full 3600-pixel cell, where gdal_contour itself takes 9.5 s,
// which made tracing in cells cost less CPU than the old single pass rather than 30% more.
//
// IN is gdal_contour's CSV output with WKT geometry (`-f CSV -lco GEOMETRY=AS_WKT`), not
// its GeoJSON: GDAL's GeoJSON writers keep ~17 bytes of memory for every byte they write,
// for the life of the process. Measured 2026-09-25 on one 3602-pixel cell (GDAL 3.13.3):
// 2967 MB writing GeoJSONSeq, 3088 MB GeoJSON, 3065 MB for `ogr2ogr` from FlatGeobuf to
// GeoJSONSeq, against 205 MB Shapefile, 204 MB FlatGeobuf and 206 MB CSV. The memory grew
// in step with the output while it was being written, so it is held, not buffered. The
// one measurement on the image's GDAL 3.10.3 fits the same ratio: 6.4 GB for Corsica's
// 365 MB of GeoJSONSeq (2026-09-03). So GDAL writes CSV, and this writes the GeoJSON,
// rounded to 7 decimal places as GDAL's GeoJSON writer rounds (its RFC 7946 default), in
// the same key order.
//
// build-contours.sh traces a region in cells so that gdal_contour's memory is bounded by
// a cell, not by the region (see there). Each cell is traced from a window reaching one
// pixel past its seams, and this keeps only what lies within XMIN..XMAX, YMIN..YMAX: the
// seams are pixel-centre lines, where both neighbours computed the very same marching
// squares from the very same pixels, so a line cut on a seam by one cell carries on from
// the same point in the next. `inf` / `-inf` for a side that is the region's own edge,
// which is not cut at all. A line wholly inside is written whole, and that is nearly every
// line.
//
// Index contours are tagged here rather than computed in a style expression: doing it
// once at build time keeps the renderer trivial and avoids float modulo in the style.
//
// Streaming, one line at a time: this never holds more than one contour.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
)

type point struct{ x, y float64 }

// box is the part of the region a cell owns, closed on every side.
type box struct{ xmin, xmax, ymin, ymax float64 }

func (b box) whole() bool {
	return math.IsInf(b.xmin, -1) && math.IsInf(b.xmax, 1) && math.IsInf(b.ymin, -1) && math.IsInf(b.ymax, 1)
}

func (b box) holds(p point) bool {
	return b.xmin <= p.x && p.x <= b.xmax && b.ymin <= p.y && p.y <= b.ymax
}

// pyRepr formats a float as Python's repr() does, which is what json.dumps wrote: the
// shortest digits that read back to the same double, ".0" on a whole number, and exponent
// form below 1e-4 or from 1e16 (Python switches on the decimal exponent, and a double's
// shortest digits are never a power of ten it is not).
func pyRepr(v float64) string {
	if v == 0 {
		if math.Signbit(v) {
			return "-0.0"
		}
		return "0.0"
	}
	if a := math.Abs(v); a < 1e-4 || a >= 1e16 {
		return strconv.FormatFloat(v, 'e', -1, 64) // 1e-05, 1.5e+16: Python's spelling too
	}
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}

// round7 is Python's round(v, 7): the decimal correctly rounded from the exact binary
// value, half to even, read back to the nearest double. strconv's fixed-precision
// formatting rounds the same way.
func round7(v float64) (float64, error) {
	return strconv.ParseFloat(strconv.FormatFloat(v, 'f', 7, 64), 64)
}

// clipSegment is Liang-Barsky: the part of a segment inside the box, as t0..t1, in the
// same order of edges and the same arithmetic as the Python it replaced.
func clipSegment(a, b point, bx box) (t0, t1 float64, ok bool) {
	t0, t1 = 0, 1
	dx, dy := b.x-a.x, b.y-a.y
	ps := [4]float64{-dx, dx, -dy, dy}
	qs := [4]float64{a.x - bx.xmin, bx.xmax - a.x, a.y - bx.ymin, bx.ymax - a.y}
	for i := range ps {
		p, q := ps[i], qs[i]
		switch {
		case p == 0:
			if q < 0 {
				return 0, 0, false
			}
		case p < 0:
			t := q / p
			if t > t1 {
				return 0, 0, false
			}
			if t > t0 {
				t0 = t
			}
		default:
			t := q / p
			if t < t0 {
				return 0, 0, false
			}
			if t < t1 {
				t1 = t
			}
		}
	}
	return t0, t1, true
}

// cut is the point t along a..b, rounded like every other coordinate. The float64()
// conversions round the product before the sum: Go may otherwise fuse them into one
// multiply-add (it does on arm64), and the point would differ from the Python's, and from
// one architecture to another, in its last bit.
func cut(a, b point, t float64) (point, error) {
	x, err := round7(a.x + float64(t*(b.x-a.x)))
	if err != nil {
		return point{}, err
	}
	y, err := round7(a.y + float64(t*(b.y-a.y)))
	return point{x, y}, err
}

// clipLine is the pieces of a polyline inside the box: a line can leave and come back.
func clipLine(coords []point, bx box) ([][]point, error) {
	var pieces [][]point
	current := -1
	for i := 0; i+1 < len(coords); i++ {
		a, b := coords[i], coords[i+1]
		t0, t1, ok := clipSegment(a, b, bx)
		if !ok {
			current = -1
			continue
		}
		// Ends of the original segment are kept exactly, never recomputed from t. A cut
		// is made on the very segment the cell across the seam cuts too, at the same
		// seam, so both compute the same point (bit for bit, all 7,372 seam ends of a
		// 12-cell test, 2026-09-25).
		start, end := a, b
		var err error
		if t0 != 0 {
			if start, err = cut(a, b, t0); err != nil {
				return nil, err
			}
		}
		if t1 != 1 {
			if end, err = cut(a, b, t1); err != nil {
				return nil, err
			}
		}
		if current < 0 || t0 > 0 {
			pieces = append(pieces, []point{start})
			current = len(pieces) - 1
		}
		pieces[current] = append(pieces[current], end)
		if t1 < 1 {
			current = -1
		}
	}
	// A piece that only touches the box, a single point, is no line.
	kept := pieces[:0]
	for _, piece := range pieces {
		for _, q := range piece[1:] {
			if q != piece[0] {
				kept = append(kept, piece)
				break
			}
		}
	}
	return kept, nil
}

// parseRow reads one row of gdal_contour's CSV: "LINESTRING (x y,x y,...)",ID,ele.
func parseRow(row string) (ele float64, coords []point, err error) {
	// WKT first and quoted, commas inside it: the last two fields are ID and ele.
	last := strings.LastIndexByte(row, ',')
	if last < 0 {
		return 0, nil, fmt.Errorf("expected WKT,ID,ele, got %.40q", row)
	}
	mid := strings.LastIndexByte(row[:last], ',')
	if mid < 0 {
		return 0, nil, fmt.Errorf("expected WKT,ID,ele, got %.40q", row)
	}
	if ele, err = strconv.ParseFloat(row[last+1:], 64); err != nil {
		return 0, nil, fmt.Errorf("ele: %w", err)
	}
	wkt := strings.Trim(row[:mid], `"`)
	const prefix = "LINESTRING ("
	if !strings.HasPrefix(wkt, prefix) || !strings.HasSuffix(wkt, ")") {
		return 0, nil, fmt.Errorf("expected a LINESTRING from gdal_contour, got %.40q", wkt)
	}
	pairs := strings.Split(wkt[len(prefix):len(wkt)-1], ",")
	coords = make([]point, len(pairs))
	for i, pair := range pairs {
		x, y, found := strings.Cut(pair, " ")
		if !found || strings.Contains(y, " ") {
			return 0, nil, fmt.Errorf("expected \"x y\", got %q", pair)
		}
		px, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, nil, err
		}
		py, err := strconv.ParseFloat(y, 64)
		if err != nil {
			return 0, nil, err
		}
		if px, err = round7(px); err != nil {
			return 0, nil, err
		}
		if py, err = round7(py); err != nil {
			return 0, nil, err
		}
		coords[i] = point{px, py}
	}
	return ele, coords, nil
}

func writeFeature(w *bufio.Writer, ele float64, idx int, coords []point) {
	w.WriteString(`{"type":"Feature","properties":{"ele":`)
	w.WriteString(pyRepr(ele))
	w.WriteString(`,"idx":`)
	w.WriteString(strconv.Itoa(idx))
	w.WriteString(`},"geometry":{"type":"LineString","coordinates":[`)
	for i, p := range coords {
		if i > 0 {
			w.WriteByte(',')
		}
		w.WriteByte('[')
		w.WriteString(pyRepr(p.x))
		w.WriteByte(',')
		w.WriteString(pyRepr(p.y))
		w.WriteByte(']')
	}
	w.WriteString("]}}\n")
}

// run converts a cell's CSV on in to GeoJSONSeq on out.
func run(in io.Reader, out io.Writer, indexEvery int, bx box) error {
	r := bufio.NewReaderSize(in, 1<<20)
	w := bufio.NewWriterSize(out, 1<<20)
	whole := bx.whole()

	// ReadString, not a Scanner: one contour can run to tens of MB of WKT, past any
	// Scanner's token limit.
	header, err := r.ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && header != "") {
		return fmt.Errorf("reading the CSV header: %w", err)
	}
	if h := strings.TrimSpace(header); h != "WKT,ID,ele" {
		return fmt.Errorf("unexpected CSV header %q from gdal_contour", h)
	}
	for {
		row, err := r.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		row = strings.TrimRight(row, "\r\n")
		if row != "" {
			ele, coords, perr := parseRow(row)
			if perr != nil {
				return perr
			}
			// Truncating conversion, as Python's int() and SQLite's CAST before it; the
			// sign of a non-zero remainder does not matter, only equality to zero does.
			idx := 0
			if int(ele)%indexEvery == 0 {
				idx = 1
			}
			inside := whole
			if !inside {
				inside = true
				for _, p := range coords {
					if !bx.holds(p) {
						inside = false
						break
					}
				}
			}
			if inside {
				writeFeature(w, ele, idx, coords)
			} else {
				pieces, cerr := clipLine(coords, bx)
				if cerr != nil {
					return cerr
				}
				for _, piece := range pieces {
					writeFeature(w, ele, idx, piece)
				}
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	return w.Flush()
}

func main() {
	if len(os.Args) != 8 {
		fmt.Fprintln(os.Stderr, "usage: contour-cell IN.csv OUT.geojsonl INDEX_EVERY XMIN XMAX YMIN YMAX")
		os.Exit(2)
	}
	fail := func(err error) {
		fmt.Fprintf(os.Stderr, "contour-cell: %v\n", err)
		os.Exit(1)
	}
	indexEvery, err := strconv.Atoi(os.Args[3])
	if err != nil || indexEvery <= 0 {
		fail(fmt.Errorf("INDEX_EVERY must be a positive integer, got %q", os.Args[3]))
	}
	var bounds [4]float64
	for i := range bounds {
		if bounds[i], err = strconv.ParseFloat(os.Args[4+i], 64); err != nil {
			fail(fmt.Errorf("bound %q: %w", os.Args[4+i], err))
		}
	}
	in, err := os.Open(os.Args[1])
	if err != nil {
		fail(err)
	}
	defer in.Close()
	out, err := os.Create(os.Args[2])
	if err != nil {
		fail(err)
	}
	if err := run(in, out, indexEvery, box{bounds[0], bounds[1], bounds[2], bounds[3]}); err != nil {
		out.Close()
		fail(err)
	}
	// Close's error too: on a full disk it is where a write can first fail.
	if err := out.Close(); err != nil {
		fail(err)
	}
}
