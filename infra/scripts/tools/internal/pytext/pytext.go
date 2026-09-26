// Package pytext is the Python behaviour the ported pipeline scripts depended on, for
// text and for values as json.loads decoded them: what counts as whitespace, a word
// character or a decimal digit to Python, and what str() and repr() print. Each port
// checks its own use of these against CPython's output in its tests.
package pytext

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"

	"ratmap/infra/tools/internal/pyfloat"
)

// IsSpace is str.isspace(): Go's unicode.IsSpace plus the four ASCII separators
// (\x1c-\x1f) that Python counts as whitespace and Go does not.
func IsSpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}

// IsWord is Python's regex \w for str patterns: underscore, or str.isalnum().
func IsWord(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r)
}

// DigitValue is the decimal value of a Unicode Nd (decimal digit) character, or -1.
// Nd characters come in runs of whole 0-9 sets, each starting at a zero — the
// mathematical digits are five sets back to back — so the value is the distance from the
// start of the run, mod 10. Checked against Python's unicodedata.decimal for every Nd
// character (2026-09-25), and the run shape against Go's own tables in the tests.
func DigitValue(r rune) int {
	if r >= '0' && r <= '9' {
		return int(r - '0')
	}
	if !unicode.Is(unicode.Nd, r) {
		return -1
	}
	start := r
	for unicode.Is(unicode.Nd, start-1) {
		start--
	}
	return int((r - start) % 10)
}

// Str returns a JSON string's value; ok=false for any other type.
func Str(raw json.RawMessage) (string, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// StrValue is str() of a JSON value as json.loads decoded it.
func StrValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '"' {
		s, _ := Str(raw)
		return s
	}
	return ReprValue(raw)
}

// ReprValue is repr() of a JSON value: strings quoted, lists and dicts with Python's
// brackets and ", " / ": " separators, None/True/False, ints as digits, floats as repr.
func ReprValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	switch raw[0] {
	case '"':
		s, _ := Str(raw)
		return ReprString(s)
	case 'n':
		return "None"
	case 't':
		return "True"
	case 'f':
		return "False"
	case '[':
		var items []json.RawMessage
		json.Unmarshal(raw, &items)
		parts := make([]string, len(items))
		for i, it := range items {
			parts[i] = ReprValue(it)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case '{':
		// Key order as written: a Python dict keeps insertion order, and a repeated key
		// keeps its first position with its last value.
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.Token()
		var keys []string
		vals := map[string]json.RawMessage{}
		for dec.More() {
			t, _ := dec.Token()
			k := t.(string)
			var v json.RawMessage
			dec.Decode(&v)
			if _, dup := vals[k]; !dup {
				keys = append(keys, k)
			}
			vals[k] = v
		}
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = ReprString(k) + ": " + ReprValue(vals[k])
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	// A number.
	if !bytes.ContainsAny(raw, ".eE") {
		if i, err := strconv.ParseInt(string(raw), 10, 64); err == nil {
			return strconv.FormatInt(i, 10) // "-0" is 0
		}
		return string(raw)
	}
	f, _ := strconv.ParseFloat(string(raw), 64)
	switch {
	case math.IsInf(f, 1):
		return "inf"
	case math.IsInf(f, -1):
		return "-inf"
	}
	return pyfloat.Repr(f)
}

// ReprString is repr() of a str: single quotes unless the text has a single quote and
// no double one; backslash and the chosen quote escaped; \t \n \r; other control
// characters as \xhh; and non-ASCII kept unless it is not printable (Python's
// str.isprintable, which Go's unicode.IsPrint matches), then \xhh, \uhhhh or \Uhhhhhhhh.
func ReprString(s string) string {
	quote := '\''
	if strings.ContainsRune(s, '\'') && !strings.ContainsRune(s, '"') {
		quote = '"'
	}
	var b strings.Builder
	b.WriteRune(quote)
	for _, r := range s {
		switch {
		case r == quote || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r < ' ' || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r < 0x7f:
			b.WriteRune(r)
		case unicode.IsPrint(r):
			b.WriteRune(r)
		case r <= 0xff:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r <= 0xffff:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			fmt.Fprintf(&b, `\U%08x`, r)
		}
	}
	b.WriteRune(quote)
	return b.String()
}

// Lower is str.lower(). Go's ToLower uses the simple case mappings; Python applies the
// full ones, and the one unconditional difference is U+0130 (İ), which Python lowers to
// "i" plus a combining dot rather than to a bare "i" — so "hİking" is not "hiking".
func Lower(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "\u0130", "i\u0307"))
}

// Title is str.title(): each cased letter that follows a character which is not cased
// (a letter with case) is title-cased, every other cased letter lower-cased. So digits and
// punctuation start a new word — "o'neil" is "O'Neil", "3d" is "3D".
func Title(s string) string {
	var b strings.Builder
	prevCased := false
	for _, r := range s {
		cased := unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r)
		switch {
		case cased && prevCased:
			b.WriteString(Lower(string(r)))
		case cased:
			b.WriteRune(unicode.ToTitle(r))
		default:
			b.WriteRune(r)
		}
		prevCased = cased
	}
	return b.String()
}
