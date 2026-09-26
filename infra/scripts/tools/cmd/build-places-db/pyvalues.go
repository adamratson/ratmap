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

	"ratmap/infra/tools/internal/pytext"
)

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
	s = strings.TrimFunc(s, pytext.IsSpace)
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
		d := pytext.DigitValue(r)
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
		s, _ := pytext.Str(raw)
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
