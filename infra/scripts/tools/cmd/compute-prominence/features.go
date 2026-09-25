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
	"unicode"
	"unicode/utf8"

	"ratmap/infra/tools/internal/pyfloat"
)

// eachLine calls fn with every non-blank line of a line-delimited GeoJSON file, in order,
// stripped the way the Python stripped it: a leading RS (\x1e, RFC 8142's record
// separator) and surrounding whitespace.
func eachLine(path string, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		raw, err := r.ReadBytes('\n')
		if len(raw) > 0 {
			line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pyIsSpace)
			if len(line) > 0 {
				if ferr := fn(line); ferr != nil {
					return ferr
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// pyIsSpace is str.isspace(): Go's unicode.IsSpace plus the four ASCII separators
// (\x1c-\x1f) that Python counts as whitespace and Go does not.
func pyIsSpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}

// loadCoords reads every feature's point as two float64 slices indexed like the file —
// 16 bytes a peak. NaN for a feature with no coordinates: compute skips those, and NaN
// fails every bounds test.
func loadCoords(path string) ([]float64, []float64, error) {
	var lons, lats []float64
	n := 0
	err := eachLine(path, func(line []byte) error {
		n++
		var f struct {
			Geometry *struct {
				Coordinates []float64 `json:"coordinates"`
			} `json:"geometry"`
		}
		if err := json.Unmarshal(line, &f); err != nil {
			return fmt.Errorf("%s: feature %d: %w", path, n, err)
		}
		if f.Geometry == nil || len(f.Geometry.Coordinates) == 0 {
			lons, lats = append(lons, math.NaN()), append(lats, math.NaN())
			return nil
		}
		if len(f.Geometry.Coordinates) < 2 {
			return fmt.Errorf("%s: feature %d: coordinates has one value", path, n)
		}
		lons = append(lons, f.Geometry.Coordinates[0])
		lats = append(lats, f.Geometry.Coordinates[1])
		return nil
	})
	return lons, lats, err
}

// writeOutput streams the input to the output, adding `prom` where scored.
//
// The Python round-tripped every feature through json.loads/json.dumps. This splices
// `"prom": <value>` into each scored line's text instead and copies every other byte
// through. The input is normalize-peaks.py's output — itself json.dumps text — and
// json.dumps of json.loads of json.dumps text is that same text, so for the file this is
// ever given the result is byte-identical; the splice just does not depend on
// reproducing Python's JSON encoder for every value type.
func writeOutput(peaksIn, peaksOut string, prom map[int]float64) error {
	out, err := os.Create(peaksOut)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(out, 1<<20)
	i := 0
	err = eachLine(peaksIn, func(line []byte) error {
		defer func() { i++ }()
		if v, ok := prom[i]; ok {
			spliced, err := setProm(line, pyfloat.Repr(v))
			if err != nil {
				return fmt.Errorf("%s: feature %d: %w", peaksIn, i+1, err)
			}
			line = spliced
		}
		w.Write(line)
		return w.WriteByte('\n')
	})
	if err != nil {
		out.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// setProm is `feature.setdefault("properties", {})["prom"] = value` done on the JSON
// text: an existing "prom" has its value replaced in place, a new one is appended as the
// last property, and a feature with no "properties" gets one appended as its last
// member. Separators are json.dumps' own (", " and ": ").
func setProm(line []byte, value string) ([]byte, error) {
	i := skipWS(line, 0)
	if i >= len(line) || line[i] != '{' {
		return nil, errors.New("feature is not a JSON object")
	}
	members, closeAt, err := objectMembers(line, i)
	if err != nil {
		return nil, err
	}
	props, err := findMember(line, members, "properties")
	if err != nil {
		return nil, err
	}
	if props == nil {
		return insertMember(line, members, i, closeAt, `"properties": {"prom": `+value+`}`), nil
	}
	if line[props.valStart] != '{' {
		// Python would raise here too: None/list/number has no item assignment.
		return nil, fmt.Errorf(`"properties" is %s, not an object`, line[props.valStart:props.valEnd])
	}
	pm, pClose, err := objectMembers(line, props.valStart)
	if err != nil {
		return nil, err
	}
	prom, err := findMember(line, pm, "prom")
	if err != nil {
		return nil, err
	}
	if prom != nil {
		return concat(line[:prom.valStart], []byte(value), line[prom.valEnd:]), nil
	}
	return insertMember(line, pm, props.valStart, pClose, `"prom": `+value), nil
}

type member struct{ keyStart, keyEnd, valStart, valEnd int }

// objectMembers scans the object starting at line[open] == '{'.
func objectMembers(line []byte, open int) ([]member, int, error) {
	var ms []member
	i := skipWS(line, open+1)
	if i < len(line) && line[i] == '}' {
		return nil, i, nil
	}
	for {
		if i >= len(line) || line[i] != '"' {
			return nil, 0, errors.New("malformed JSON object: expected a key")
		}
		ke, err := scanString(line, i)
		if err != nil {
			return nil, 0, err
		}
		j := skipWS(line, ke)
		if j >= len(line) || line[j] != ':' {
			return nil, 0, errors.New("malformed JSON object: expected ':'")
		}
		vs := skipWS(line, j+1)
		ve, err := scanValue(line, vs)
		if err != nil {
			return nil, 0, err
		}
		ms = append(ms, member{i, ke, vs, ve})
		i = skipWS(line, ve)
		if i < len(line) && line[i] == ',' {
			i = skipWS(line, i+1)
			continue
		}
		if i < len(line) && line[i] == '}' {
			return ms, i, nil
		}
		return nil, 0, errors.New("malformed JSON object: expected ',' or '}'")
	}
}

// findMember returns the member whose decoded key is name. A duplicated key is refused:
// Python keeps the first position and the last value, which a text splice cannot
// honestly reproduce, and no writer in this pipeline emits one.
func findMember(line []byte, ms []member, name string) (*member, error) {
	var found *member
	for k := range ms {
		var key string
		if err := json.Unmarshal(line[ms[k].keyStart:ms[k].keyEnd], &key); err != nil {
			return nil, err
		}
		if key == name {
			if found != nil {
				return nil, fmt.Errorf("duplicate key %q", name)
			}
			found = &ms[k]
		}
	}
	return found, nil
}

func insertMember(line []byte, ms []member, open, closeAt int, text string) []byte {
	if len(ms) == 0 {
		return concat(line[:open+1], []byte(text), line[closeAt:])
	}
	at := ms[len(ms)-1].valEnd
	return concat(line[:at], []byte(", "+text), line[at:])
}

func concat(parts ...[]byte) []byte {
	var b []byte
	for _, p := range parts {
		b = append(b, p...)
	}
	return b
}

func skipWS(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\n' || b[i] == '\r') {
		i++
	}
	return i
}

// scanString returns the index just past the string starting at b[i] == '"'.
func scanString(b []byte, i int) (int, error) {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1, nil
		}
	}
	return 0, errors.New("unterminated JSON string")
}

// scanValue returns the index just past the JSON value starting at b[i]. It only finds
// the value's extent; json.Unmarshal of the whole line (loadCoords) is what validated it.
func scanValue(b []byte, i int) (int, error) {
	if i >= len(b) {
		return 0, errors.New("expected a JSON value")
	}
	switch b[i] {
	case '"':
		return scanString(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				e, err := scanString(b, j)
				if err != nil {
					return 0, err
				}
				j = e - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, errors.New("unterminated JSON container")
	default:
		j := i
		for j < len(b) && !bytes.ContainsRune([]byte(",}] \t\r\n"), rune(b[j])) {
			_, size := utf8.DecodeRune(b[j:])
			j += size
		}
		if j == i {
			return 0, errors.New("expected a JSON value")
		}
		return j, nil
	}
}
