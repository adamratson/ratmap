// Command check-peak-tiles checks that a peaks archive's top zoom holds every peak it was
// built from.
//
//	tippecanoe-decode -zZ -ZZ ARCHIVE | check-peak-tiles SOURCE ARCHIVE Z
//
// A port of scripts/check-peak-tiles.py, which it replaces in build-peaks.sh: same
// arguments, same verdict, same report.
//
// SOURCE is the line-delimited GeoJSON tippecanoe was given, ARCHIVE the .pmtiles it made
// and Z its top zoom, the zoom the app overzooms from, so every peak and every Munro has
// to be there. The published archive once went two weeks with no `lists` property at all,
// every Munro marker and badge silently absent (found 2026-09-24), because nothing
// checked what tippecanoe made of its input.
//
// Streamed, a line at a time: decoded in one piece the global archive is hundreds of MB of
// JSON. tippecanoe-decode writes each tile's header on a line of its own ("zoom", "x",
// "y") and each feature on a line of its own.
//
// Counted, not matched by position: tippecanoe snaps coordinates to its tile grid, so
// positions do not match the input's, and a peak near an edge is also copied into the
// neighbouring tile's buffer. A feature counts where MapLibre would draw it: only in the
// tile that holds it, 0 <= x, y < extent in that tile's own pixels. MapLibre skips the
// rest so nothing is drawn twice (`addSymbolAtAnchor` in symbol_layout.ts, and
// circle_bucket.ts, read at maplibre-gl 5.24.0). A peak in no tile by that rule is on no
// map. See prepare-peak-tiles for the two ways tippecanoe leaves one there.
//
// Tested in pixels, not degrees. tippecanoe-decode prints six decimals, and a point
// snapped onto a latitude edge could print on either side of it, so a comparison in
// degrees counted a point at pixel 4096, which no tile draws, about half the time (found
// 2026-09-25). Printed to 1e-6 degrees, a pixel is recovered to within 1/100 at z7
// anywhere, and to within a quarter up to z11 even at the Mercator limit, where a
// latitude pixel is shortest. A point that cannot be pinned to a pixel that well fails
// the check rather than being guessed.
//
// On failure it names the missing peaks. It decodes the archive a second time and matches
// every input peak to a counted one of the same name within a few pixels, greedily. What
// is left unmatched is what went missing. A named peak comes out exactly. An unnamed one
// can only be matched by position, so in a dense cluster the one listed may be a neighbour
// of the one lost (6 of 25 in a test with 3,000 unnamed saddles in a few km², all within
// 150 m). It checks every peak, not only the tiles that came up short, since a loss in a
// tile that also gained a neighbour's edge-snapped peak nets to zero there. Only on
// failure: the first pass stays one stream with nothing held.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/pytext"
)

var (
	tileRE   = regexp.MustCompile(`"zoom": (\d+), "x": (\d+), "y": (\d+)`)
	extentRE = regexp.MustCompile(`"extent": (\d+)`)
)

const maxListed = 50

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: tippecanoe-decode -zZ -ZZ ARCHIVE | check-peak-tiles SOURCE ARCHIVE Z")
		os.Exit(2)
	}
	z, err := strconv.Atoi(os.Args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, "check-peak-tiles: Z must be an integer:", os.Args[3])
		os.Exit(2)
	}
	ok, err := run(os.Args[1], os.Args[2], z, os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "check-peak-tiles:", err)
		os.Exit(1)
	}
	if !ok {
		os.Exit(1)
	}
}

// peak is a feature as far as this check reads it.
type peak struct {
	props    map[string]json.RawMessage
	lon, lat float64
	// The coordinates as written, for printing them as Python's str() did.
	lonRaw, latRaw json.RawMessage
}

func (p peak) name() json.RawMessage { return p.props["name"] }

func isMunro(props map[string]json.RawMessage) bool {
	// "munro" in str(props.get("lists", "")).split(";")
	lists := ""
	if v, ok := props["lists"]; ok {
		lists = pytext.StrValue(v)
	}
	for _, s := range strings.Split(lists, ";") {
		if s == "munro" {
			return true
		}
	}
	return false
}

func run(source, archive string, z int, decoded io.Reader, out io.Writer) (bool, error) {
	expected, expectedMunros := 0, 0
	if err := readSource(source, func(p peak) error {
		expected++
		if isMunro(p.props) {
			expectedMunros++
		}
		return nil
	}); err != nil {
		return false, err
	}

	count, munros := 0, 0
	var unclear []unclearFeature
	if err := countedFeatures(decoded, z, &unclear, func(p peak, extent int) {
		count++
		if isMunro(p.props) {
			munros++
		}
	}); err != nil {
		return false, err
	}

	if count == expected && munros == expectedMunros && len(unclear) == 0 {
		fmt.Fprintf(out, "  OK z%d tiles hold all %d peaks and %d munros\n", z, count, munros)
		return true, nil
	}

	for _, u := range unclear[:min(maxListed, len(unclear))] {
		fmt.Fprintf(out, "FAIL: cannot tell which pixel of tile %d/%d/%d holds %s (%s, %s)\n",
			z, u.tx, u.ty, nameOr(u.peak.props, "(unnamed)"), pytext.StrValue(u.peak.lonRaw), pytext.StrValue(u.peak.latRaw))
	}
	if count != expected {
		fmt.Fprintf(out, "FAIL: %d peaks in the z%d tiles, %d in the input\n", count, z, expected)
	}
	if munros != expectedMunros {
		fmt.Fprintf(out, "FAIL: %d munros in the z%d tiles, %d in the input\n", munros, z, expectedMunros)
	}
	missing, err := missingPeaks(source, archive, z)
	if err != nil {
		return false, err
	}
	head := fmt.Sprintf("  %d input peaks have no match in the tiles", len(missing))
	if len(missing) > maxListed {
		head += fmt.Sprintf(" (first %d):", maxListed)
	} else {
		head += ":"
	}
	fmt.Fprintln(out, head)
	for _, p := range missing[:min(maxListed, len(missing))] {
		fmt.Fprintf(out, "    node %s  %s  %.6f, %.6f\n", nameOr(p.props, "?", "@id"), nameOr(p.props, "(unnamed)"), p.lon, p.lat)
	}
	return false, nil
}

// nameOr is str(props.get(key, def)), key defaulting to "name".
func nameOr(props map[string]json.RawMessage, def string, key ...string) string {
	k := "name"
	if len(key) > 0 {
		k = key[0]
	}
	if v, ok := props[k]; ok {
		return pytext.StrValue(v)
	}
	return def
}

// readSource calls fn with every feature of a line-delimited GeoJSON file.
func readSource(path string, fn func(peak) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pytext.IsSpace); len(line) > 0 {
			p, err := parsePeak(line)
			if err != nil {
				return fmt.Errorf("%s: line %d: %w", path, n, err)
			}
			if err := fn(p); err != nil {
				return err
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// parsePeak reads a feature's properties and first two coordinates, erring where the
// Python's indexing raised.
func parsePeak(text []byte) (peak, error) {
	var feature map[string]json.RawMessage
	if err := json.Unmarshal(text, &feature); err != nil {
		return peak{}, err
	}
	p := peak{props: map[string]json.RawMessage{}}
	if raw, ok := feature["properties"]; ok {
		if err := json.Unmarshal(raw, &p.props); err != nil || p.props == nil {
			return peak{}, fmt.Errorf("properties is %s, not an object", raw)
		}
	}
	var geometry map[string]json.RawMessage
	if err := json.Unmarshal(feature["geometry"], &geometry); err != nil || geometry == nil {
		return peak{}, fmt.Errorf("geometry is %s, not an object", feature["geometry"])
	}
	var coords []json.RawMessage
	if err := json.Unmarshal(geometry["coordinates"], &coords); err != nil || len(coords) < 2 {
		return peak{}, fmt.Errorf("coordinates %s: not a list of two or more", geometry["coordinates"])
	}
	p.lonRaw, p.latRaw = coords[0], coords[1]
	var err1, err2 error
	p.lon, err1 = strconv.ParseFloat(string(bytes.TrimSpace(p.lonRaw)), 64)
	p.lat, err2 = strconv.ParseFloat(string(bytes.TrimSpace(p.latRaw)), 64)
	if err1 != nil || err2 != nil {
		return peak{}, fmt.Errorf("coordinates %s, %s are not numbers", p.lonRaw, p.latRaw)
	}
	return p, nil
}

type unclearFeature struct {
	tx, ty int
	peak   peak
}

// pixel is the whole pixel a decoded coordinate stands for, ok=false if it is too near a
// half. (round() rounds half to even in Python, but a value that near a half is refused
// either way, so the mode never matters.)
func pixel(value float64) (int, bool) {
	whole := math.Round(value)
	if math.Abs(value-whole) <= 0.25 {
		return int(whole), true
	}
	return 0, false
}

// countedFeatures calls fn with every feature MapLibre would draw from its tile at zoom
// z. Features that cannot be pinned to a pixel go to *unclear, when it is not nil, and
// are not counted.
//
// The float64() conversions stop Go fusing a multiply into the following subtraction
// (FMA, which it may do on arm64): Python rounds each operation on its own.
func countedFeatures(stream io.Reader, z int, unclear *[]unclearFeature, fn func(peak, int)) error {
	n := float64(int64(1) << z)
	piv := math.Pi
	degToRad := piv / 180
	haveTile := false
	var tx, ty int
	extent := 4096
	r := bufio.NewReaderSize(stream, 1<<20)
	for {
		line, rerr := r.ReadString('\n')
		if len(line) > 0 {
			if m := tileRE.FindStringSubmatch(line); m != nil && strings.Contains(line, `"FeatureCollection"`) {
				// Only the zoom asked for: a tile from any other zoom has no business here.
				tz, _ := strconv.Atoi(m[1])
				haveTile = tz == z
				tx, _ = strconv.Atoi(m[2])
				ty, _ = strconv.Atoi(m[3])
			} else if strings.Contains(line, `"FeatureCollection"`) {
				if e := extentRE.FindStringSubmatch(line); e != nil {
					extent, _ = strconv.Atoi(e[1])
				}
			} else if text := strings.TrimRight(strings.TrimFunc(line, pytext.IsSpace), ","); haveTile && strings.HasPrefix(text, `{ "type": "Feature"`) {
				p, err := parsePeak([]byte(text))
				if err != nil {
					return err
				}
				fx := float64(float64((p.lon+180)/360)*n) - float64(tx)
				px, okx := pixel(float64(fx * float64(extent)))
				fy := float64((1-math.Asinh(math.Tan(float64(p.lat*degToRad)))/piv)/2*n) - float64(ty)
				py, oky := pixel(float64(fy * float64(extent)))
				if !okx || !oky {
					if unclear != nil {
						*unclear = append(*unclear, unclearFeature{tx, ty, p})
					}
				} else if px >= 0 && px < extent && py >= 0 && py < extent {
					fn(p, extent)
				}
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

type indexKey struct {
	name   string // the name's Python value, keyed as a dict would key it
	cx, cy int64
}

type entry struct {
	lon, lat float64
	used     bool
}

// nameKey keys a name value the way a Python dict did: strings by their text, and a
// missing name and a null one alike (props.get("name") was None for both).
func nameKey(raw json.RawMessage) string {
	if raw == nil || string(bytes.TrimSpace(raw)) == "null" {
		return "None"
	}
	if s, ok := pytext.Str(raw); ok {
		return "s" + s
	}
	return "v" + pytext.ReprValue(raw)
}

// missingPeaks is the input peaks with no counted peak of the same name within a few
// pixels of them.
func missingPeaks(source, archive string, z int) ([]peak, error) {
	cmd := exec.Command("tippecanoe-decode", fmt.Sprintf("-z%d", z), fmt.Sprintf("-Z%d", z), archive)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var tol float64
	var cells int64
	haveTol := false
	index := map[indexKey][]*entry{}
	err = countedFeatures(stdout, z, nil, func(p peak, extent int) {
		if !haveTol {
			// Four pixels of the top zoom, in longitude degrees: tippecanoe rounds more
			// than once, and a latitude degree is never shorter than a longitude degree.
			tol = 4 * 360 / float64(float64(int64(1)<<z)*float64(extent))
			cells = int64(math.Ceil(360 / tol))
			haveTol = true
		}
		k := indexKey{nameKey(p.name()), pyMod(int64(math.Floor((p.lon+180)/tol)), cells), int64(math.Floor((p.lat + 90) / tol))}
		index[k] = append(index[k], &entry{p.lon, p.lat, false})
	})
	if waitErr := cmd.Wait(); err == nil {
		err = waitErr
	}
	if err != nil {
		return nil, err
	}

	var missing []peak
	if !haveTol {
		err := readSource(source, func(p peak) error { missing = append(missing, p); return nil })
		return missing, err
	}
	err = readSource(source, func(p peak) error {
		cx := pyMod(int64(math.Floor((p.lon+180)/tol)), cells)
		cy := int64(math.Floor((p.lat + 90) / tol))
		name := nameKey(p.name())
		var best *entry
		bestD := 0.0
		for _, dx := range []int64{-1, 0, 1} {
			for _, dy := range []int64{-1, 0, 1} {
				for _, e := range index[indexKey{name, pyMod(cx+dx, cells), cy + dy}] {
					if e.used {
						continue
					}
					dlon := math.Abs(e.lon - p.lon)
					dlon = math.Min(dlon, 360-dlon) // 180° and -180° are the same meridian
					d := math.Max(dlon, math.Abs(e.lat-p.lat))
					if d <= tol && (best == nil || d < bestD) {
						best, bestD = e, d
					}
				}
			}
		}
		if best == nil {
			missing = append(missing, p)
		} else {
			best.used = true
		}
		return nil
	})
	return missing, err
}

// pyMod is Python's %, never negative for a positive divisor: a peak just west of -180
// wraps to the last column.
func pyMod(a, b int64) int64 {
	m := a % b
	if m < 0 {
		m += b
	}
	return m
}
