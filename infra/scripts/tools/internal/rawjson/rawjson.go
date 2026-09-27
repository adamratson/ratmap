// Package rawjson reads single values out of JSON the tools leave undecoded: a feature's
// properties as json.RawMessage, most of which are passed through untouched.
package rawjson

import (
	"bytes"
	"encoding/json"
)

// String returns a JSON string's value; ok=false for any other type, null included.
func String(raw json.RawMessage) (string, bool) {
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

// Text is a value as a person reads it in a log line or uses it as a key: a string's
// value, and anything else as its JSON text, as written.
func Text(raw json.RawMessage) string {
	if s, ok := String(raw); ok {
		return s
	}
	return string(bytes.TrimSpace(raw))
}
