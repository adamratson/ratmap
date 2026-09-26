package main

// Python's value semantics, as build-places-db.py applied them to a feature's JSON. Each
// is the exact expression it replaces, because the rows it decides are the search index a
// phone ships with: a population that parsed in Python and not here is a town that sorts
// below a hamlet.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// pyIsSpace is str.isspace(): Go's unicode.IsSpace plus the four ASCII separators
// (\x1c-\x1f) that Python counts as whitespace and Go does not.
func pyIsSpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}

// toInt is `int(str(value).replace(",", "").strip())`, returning ok=false where that
// raised TypeError or ValueError (the Python's to_int returned None), and an error where
// the result would not fit SQLite's INTEGER (Python raised OverflowError binding it).
func toInt(raw json.RawMessage) (int64, bool, error) {
	s, ok := pyStr(raw)
	if !ok {
		return 0, false, nil
	}
	return pyInt(strings.ReplaceAll(s, ",", ""))
}

// pyStr is str(value) for the two JSON types whose str() int() can ever accept: a string
// (itself) and an int (its digits). A float's str() always carries a '.', 'e', 'inf' or
// 'nan', and True/False/None/list/dict print as words or brackets, so int() rejects every
// one of them; ok=false stands for all of those.
func pyStr(raw json.RawMessage) (string, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", false
	}
	switch c := raw[0]; {
	case c == '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return "", false
		}
		return s, true
	case c == '-' || (c >= '0' && c <= '9'):
		if bytes.ContainsAny(raw, ".eE") {
			return "", false
		}
		return string(raw), true
	}
	return "", false
}

// pyInt is int(s) in base 10: surrounding whitespace, an optional sign, and Unicode
// decimal digits (Arabic-Indic, Devanagari, fullwidth… — OSM has them) with single
// underscores between digits.
func pyInt(s string) (int64, bool, error) {
	s = strings.TrimFunc(s, pyIsSpace)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg, s = s[0] == '-', s[1:]
	}
	if s == "" {
		return 0, false, nil
	}
	digits := make([]byte, 0, len(s))
	if neg {
		digits = append(digits, '-')
	}
	afterUnderscore := true // so a leading underscore is refused
	for _, r := range s {
		if r == '_' {
			if afterUnderscore {
				return 0, false, nil
			}
			afterUnderscore = true
			continue
		}
		d := digitValue(r)
		if d < 0 {
			return 0, false, nil
		}
		digits = append(digits, byte('0'+d))
		afterUnderscore = false
	}
	if afterUnderscore {
		return 0, false, nil // a trailing underscore
	}
	n, err := strconv.ParseInt(string(digits), 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("population %q does not fit a 64-bit integer", s)
	}
	return n, true, nil
}

// digitValue is the decimal value of a Unicode Nd (decimal digit) character, or -1.
// Nd characters come in runs of whole 0-9 sets, each starting at a zero — the
// mathematical digits are five sets back to back — so the value is the distance from the
// start of the run, mod 10. Checked against Python's unicodedata.decimal for every Nd
// character (2026-09-25), and the run shape against Go's own tables in the tests.
func digitValue(r rune) int {
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

// num is a JSON value as Python's round() and float() saw it: an int or float, or a bool,
// which is an int in Python (True is 1). ok=false for anything else. Out of range reads
// as ±Inf, as Python's float() does.
func num(raw json.RawMessage) (float64, bool) {
	raw = bytes.TrimSpace(raw)
	switch string(raw) {
	case "true":
		return 1, true
	case "false":
		return 0, true
	}
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, false
	}
	return f, true
}

// str returns a JSON string's value; ok=false for any other type.
func str(raw json.RawMessage) (string, bool) {
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

// unhashable is a list or dict: `x in some_set` raised TypeError for those.
func unhashable(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && (raw[0] == '[' || raw[0] == '{')
}

// falsy is Python's truth test on a decoded JSON value: null, false, zero, "", [] and {}.
func falsy(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return true
	}
	switch raw[0] {
	case 'n', 'f':
		return true
	case 't':
		return false
	case '"':
		s, _ := str(raw)
		return s == ""
	case '[':
		var a []json.RawMessage
		return json.Unmarshal(raw, &a) == nil && len(a) == 0
	case '{':
		var m map[string]json.RawMessage
		return json.Unmarshal(raw, &m) == nil && len(m) == 0
	}
	f, ok := num(raw)
	return ok && f == 0
}
