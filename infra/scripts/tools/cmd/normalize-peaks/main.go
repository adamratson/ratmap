// Command normalize-peaks normalizes peak GeoJSON before tippecanoe.
//
//	normalize-peaks IN.geojsonl OUT.geojsonl
//
// A port of scripts/normalize-peaks.py, which it replaces in build-peaks.sh and
// build-places.sh: same arguments, same report, and the same features out — every one
// keeps all its OSM tags, `ele` becomes a number or goes, `lists` is added.
//
// OSM `ele` is free text and always arrives as a string: mostly "1345", but a small tail
// of "~340", "1141m", "480~", "1,345", "664.4m". Cleaning it here rather than in a
// MapLibre style expression means the tiles carry a real number, the renderer stays
// trivial, and a bad value can never surface as "NaN m" at a summit — a wrong elevation
// on a mountain is worse than a missing one.
//
// Also derives `lists`, a semicolon-delimited summit-list membership string (docs/
// IMPLEMENTATION.md Phase 3.5, C19 — never transcribe an editorial table; only join from
// a CC0/ODbL source). Today that's just `munro`, straight off OSM's own `munro=yes` tag:
// taginfo shows exactly 282 uses, matching the SMC's current published Munro count, so no
// separate editorial join is needed. Wainwrights are deliberately not derived here — no
// OSM tag exists for them and Wikidata carries no structured list membership either
// (verified 2026-09-11); the one dataset that has it (DoBIH) is CC BY, not CC0/ODbL, so
// there is no compliant source yet.
//
// Streamed, a line at a time: a planet-scale peaks export is ~1.2 M features.
//
// The output is not the Python's bytes: the Python re-encoded every feature with
// json.dumps, and this edits only the members that change (internal/jsonedit), leaving
// osmium's text around them. Its readers — compute-prominence, build-places-db,
// build-peaks.sh's checks and tippecanoe — all parse it, and see the same features.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"

	"ratmap/infra/tools/internal/jsonedit"
	"ratmap/infra/tools/internal/pyfloat"
	"ratmap/infra/tools/internal/pytext"
)

// Everest 8849 m; Dead Sea shore about -430 m. Outside this is a tagging error (feet
// entered as metres, stray digits), so drop the value rather than render it.
const (
	minEleM = -500
	maxEleM = 9000
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-peaks IN.geojsonl OUT.geojsonl")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-peaks:", err)
		os.Exit(1)
	}
}

type counts struct{ total, keptEle, droppedEle, munros int }

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

	var c counts
	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		// RFC8142 puts an RS (0x1e) before each record. Our callers turn that off, but
		// stripping it anyway means this also works on a plain geojsonseq export.
		if line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pytext.IsSpace); len(line) > 0 {
			edited, err := normalize(line, &c)
			if err != nil {
				dest.Close()
				return fmt.Errorf("%s: line %d: %w", srcPath, n, err)
			}
			w.Write(edited)
			w.WriteByte('\n')
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
	fmt.Fprintf(out, "normalize-peaks: %d features, %d with usable ele, %d unparseable ele dropped, %d munros\n",
		c.total, c.keptEle, c.droppedEle, c.munros)
	return nil
}

// normalize edits one feature's properties: `ele` parsed or deleted, `lists` set.
func normalize(line []byte, c *counts) ([]byte, error) {
	if !json.Valid(line) {
		var v any
		return nil, json.Unmarshal(line, &v) // for its error message
	}
	top, err := jsonedit.Parse(line, 0)
	if err != nil {
		return nil, fmt.Errorf("feature: %w", err)
	}
	c.total++

	// feature.get("properties", {}): with no properties the Python edited a fresh dict
	// that was never written back, so the feature goes out as it came.
	pi, err := top.Find("properties")
	if err != nil || pi < 0 {
		return line, err
	}
	if v := top.Value(line, pi); v[0] != '{' {
		// null, a list, a string or a number: every one raised, at `"ele" in props` or at
		// props.get.
		return nil, fmt.Errorf("properties is %s, not an object", v)
	}
	props, err := jsonedit.Parse(line, top.Members[pi].ValueStart)
	if err != nil {
		return nil, err
	}

	ei, err := props.Find("ele")
	if err != nil {
		return nil, err
	}
	if ei >= 0 {
		ele, ok, err := parseElevation(props.Value(line, ei))
		if err != nil {
			return nil, err
		}
		if ok {
			line, err = props.Set(line, "ele", []byte(pyfloat.Repr(ele)))
			c.keptEle++
		} else {
			line, err = props.Delete(line, "ele")
			c.droppedEle++
		}
		if err != nil {
			return nil, err
		}
		if props, err = jsonedit.Parse(line, top.Members[pi].ValueStart); err != nil {
			return nil, err
		}
	}

	// Semicolon-delimited list membership. See the package comment for sourcing.
	mi, err := props.Find("munro")
	if err != nil {
		return nil, err
	}
	if mi >= 0 {
		if s, ok := pytext.Str(props.Value(line, mi)); ok && s == "yes" {
			if line, err = props.Set(line, "lists", []byte(`"munro"`)); err != nil {
				return nil, err
			}
			c.munros++
		}
	}
	return line, nil
}

// parseElevation is the Python's parse_elevation: a number (a bool counts — True is 1 in
// Python) as a float; a string as the first -?\d+(\.\d+)? in it once commas are removed,
// with Python's Unicode \d (so Arabic-Indic digits read, as float() then accepts them);
// anything else, anything non-finite and anything outside -500..9000 m as no elevation.
// Rounded to 0.1 m with Python's round().
func parseElevation(raw json.RawMessage) (float64, bool, error) {
	raw = bytes.TrimSpace(raw)
	var value float64
	switch {
	case len(raw) == 0:
		return 0, false, nil
	case string(raw) == "true":
		value = 1
	case string(raw) == "false":
		value = 0
	case raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9'):
		f, err := strconv.ParseFloat(string(raw), 64)
		if errors.Is(err, strconv.ErrRange) && math.IsInf(f, 0) && !bytes.ContainsAny(raw, ".eE") {
			// An int too big for a float: float() raised OverflowError. (A float literal
			// that big was already inf to json.loads, and is simply out of range.)
			return 0, false, fmt.Errorf("ele %s does not fit a float", raw)
		}
		value = f
		if f == 0 && !bytes.ContainsAny(raw, ".eE") {
			value = 0 // the int -0 is 0 in Python, so float() of it is 0.0, not -0.0
		}
	case raw[0] == '"':
		s, _ := pytext.Str(raw)
		num, ok := leadingNumber(bytes.ReplaceAll([]byte(s), []byte(","), nil))
		if !ok {
			return 0, false, nil
		}
		f, err := strconv.ParseFloat(num, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false, fmt.Errorf("ele %q: %w", num, err)
		}
		value = f
	default:
		return 0, false, nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || !(value >= minEleM && value <= maxEleM) {
		return 0, false, nil
	}
	return pyfloat.Round(value, 1), true, nil
}

// leadingNumber is re.search(r"-?\d+(?:\.\d+)?", s) with Python's Unicode \d, returned
// with its digits as ASCII so strconv can read it (float() accepted any decimal digit).
func leadingNumber(b []byte) (string, bool) {
	t := []rune(string(b))
	isDigit := func(i int) bool { return i < len(t) && pytext.DigitValue(t[i]) >= 0 }
	for i := range t {
		j := i
		if t[j] == '-' {
			j++
		}
		if !isDigit(j) {
			continue
		}
		var out []byte
		if j > i {
			out = append(out, '-')
		}
		for ; isDigit(j); j++ {
			out = append(out, byte('0'+pytext.DigitValue(t[j])))
		}
		if j < len(t) && t[j] == '.' && isDigit(j+1) {
			out = append(out, '.')
			for j++; isDigit(j); j++ {
				out = append(out, byte('0'+pytext.DigitValue(t[j])))
			}
		}
		return string(out), true
	}
	return "", false
}
