package main

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

// The report prints each unreadable value as Python printed it: `repr(str(value))`. These
// reproduce the two conversions for a decoded JSON value, so a report read today compares
// with one from before the port.

// pyStrValue is str() of a JSON value as json.loads decoded it.
func pyStrValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '"' {
		s, _ := str(raw)
		return s
	}
	return pyReprValue(raw)
}

// pyReprValue is repr() of a JSON value: strings quoted, lists and dicts with Python's
// brackets and ", " / ": " separators, None/True/False, ints as digits, floats as repr.
func pyReprValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	switch raw[0] {
	case '"':
		s, _ := str(raw)
		return pyReprString(s)
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
			parts[i] = pyReprValue(it)
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
			parts[i] = pyReprString(k) + ": " + pyReprValue(vals[k])
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

// pyReprString is repr() of a str: single quotes unless the text has a single quote and
// no double one; backslash and the chosen quote escaped; \t \n \r; other control
// characters as \xhh; and non-ASCII kept unless it is not printable (Python's
// str.isprintable, which Go's unicode.IsPrint matches), then \xhh, \uhhhh or \Uhhhhhhhh.
func pyReprString(s string) string {
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
