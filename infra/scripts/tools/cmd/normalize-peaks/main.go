// Command normalize-peaks normalizes peak GeoJSON before tippecanoe.
//
//	normalize-peaks IN.geojsonl OUT.geojsonl
//
// Run by build-peaks.sh and build-places.sh. Every feature keeps all its OSM tags; `ele`
// becomes a number or goes, and `lists` is added.
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
// Only the members that change are edited (internal/jsonedit), leaving osmium's text
// around them.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/jsonedit"
	"ratmap/infra/tools/internal/num"
	"ratmap/infra/tools/internal/rawjson"
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
		if line := bytes.TrimSpace(bytes.TrimLeft(raw, "\x1e")); len(line) > 0 {
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

	// With no properties, or null ones, there is nothing to normalize: the feature goes
	// out as it came. Properties that are some other kind of value are a broken export.
	pi, err := top.Find("properties")
	if err != nil || pi < 0 {
		return line, err
	}
	if v := top.Value(line, pi); string(v) == "null" {
		return line, nil
	} else if v[0] != '{' {
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
		if ele, ok := parseElevation(props.Value(line, ei)); ok {
			line, err = props.Set(line, "ele", []byte(strconv.FormatFloat(ele, 'f', -1, 64)))
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
		if s, ok := rawjson.String(props.Value(line, mi)); ok && s == "yes" {
			if line, err = props.Set(line, "lists", []byte(`"munro"`)); err != nil {
				return nil, err
			}
			c.munros++
		}
	}
	return line, nil
}

// parseElevation reads an `ele` tag: a JSON number, or in a string the first number
// (-?\d+(\.\d+)?) once thousands commas are removed, its digits in any script. Anything
// else, and anything outside -500..9000 m, is no elevation. Rounded to 0.1 m.
func parseElevation(raw json.RawMessage) (float64, bool) {
	raw = bytes.TrimSpace(raw)
	var text string
	switch {
	case len(raw) == 0:
		return 0, false
	case raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9'):
		text = string(raw)
	case raw[0] == '"':
		s, _ := rawjson.String(raw)
		n, ok := leadingNumber(strings.ReplaceAll(s, ",", ""))
		if !ok {
			return 0, false
		}
		text = n
	default:
		return 0, false
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || !(value >= minEleM && value <= maxEleM) {
		return 0, false
	}
	if value == 0 {
		value = 0 // no negative zero: "-0" is sea level
	}
	return num.Round(value, 1), true
}

// leadingNumber is the first -?\d+(\.\d+)? in s, \d being a decimal digit in any
// script, returned with ASCII digits so strconv can read it.
func leadingNumber(s string) (string, bool) {
	t := []rune(s)
	isDigit := func(i int) bool { return i < len(t) && num.Digit(t[i]) >= 0 }
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
			out = append(out, byte('0'+num.Digit(t[j])))
		}
		if j < len(t) && t[j] == '.' && isDigit(j+1) {
			out = append(out, '.')
			for j++; isDigit(j); j++ {
				out = append(out, byte('0'+num.Digit(t[j])))
			}
		}
		return string(out), true
	}
	return "", false
}
