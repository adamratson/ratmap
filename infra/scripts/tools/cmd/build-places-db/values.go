package main

// How a feature's values are read. Each rule decides rows of the search index a phone
// ships with: a population that fails to read is a town that sorts below a hamlet.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/num"
	"ratmap/infra/tools/internal/rawjson"
)

// population reads a population tag: a JSON integer, or a string of digits with thousands
// commas and surrounding space allowed, and an optional leading "+". Digits may be in any
// script (OSM has Arabic-Indic and Devanagari ones). ok=false for anything else — a
// fraction, a word, a negative number, or one too big for SQLite's INTEGER.
func population(raw json.RawMessage) (int64, bool) {
	raw = bytes.TrimSpace(raw)
	s, isString := rawjson.String(raw)
	if !isString {
		s = string(raw) // a JSON integer's digits; anything else fails below
	}
	s = strings.TrimPrefix(strings.TrimSpace(strings.ReplaceAll(s, ",", "")), "+")
	if s == "" {
		return 0, false
	}
	digits := make([]byte, 0, len(s))
	for _, r := range s {
		d := num.Digit(r)
		if d < 0 {
			return 0, false
		}
		digits = append(digits, byte('0'+d))
	}
	n, err := strconv.ParseInt(string(digits), 10, 64)
	return n, err == nil
}

// number is a JSON number's value, ok=false for anything else (a boolean included) and
// for one too big for a float.
func number(raw json.RawMessage) (float64, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	return f, err == nil
}
