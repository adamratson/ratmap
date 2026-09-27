// Package jsonedit edits one member of a JSON object in place, leaving every other byte
// of the text as it was.
//
// Editing only the member that changes keeps the rest of a feature exactly as osmium (or
// whoever) wrote it, rather than re-encoding every value. An existing key is replaced
// where it stands; a new one goes last.
//
// It scans, it does not validate: callers json.Unmarshal the whole text first.
package jsonedit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

// Object is a JSON object's members, located in the text they came from.
type Object struct {
	Open, Close int // offsets of { and }
	Members     []Member
}

// Member is one "key": value, as offsets into the text.
type Member struct {
	Key                  string // decoded
	KeyStart, KeyEnd     int
	ValueStart, ValueEnd int
}

// Parse locates the object whose '{' is the first non-space byte at or after start.
func Parse(text []byte, start int) (Object, error) {
	open := skipWS(text, start)
	if open >= len(text) || text[open] != '{' {
		return Object{}, errors.New("not a JSON object")
	}
	o := Object{Open: open}
	i := skipWS(text, open+1)
	if i < len(text) && text[i] == '}' {
		o.Close = i
		return o, nil
	}
	for {
		if i >= len(text) || text[i] != '"' {
			return Object{}, errors.New("malformed JSON object: expected a key")
		}
		ke, err := scanString(text, i)
		if err != nil {
			return Object{}, err
		}
		var key string
		if err := json.Unmarshal(text[i:ke], &key); err != nil {
			return Object{}, err
		}
		j := skipWS(text, ke)
		if j >= len(text) || text[j] != ':' {
			return Object{}, errors.New("malformed JSON object: expected ':'")
		}
		vs := skipWS(text, j+1)
		ve, err := scanValue(text, vs)
		if err != nil {
			return Object{}, err
		}
		o.Members = append(o.Members, Member{key, i, ke, vs, ve})
		i = skipWS(text, ve)
		if i < len(text) && text[i] == ',' {
			i = skipWS(text, i+1)
			continue
		}
		if i < len(text) && text[i] == '}' {
			o.Close = i
			return o, nil
		}
		return Object{}, errors.New("malformed JSON object: expected ',' or '}'")
	}
}

// Find returns the index of the member named key, or -1. A repeated key is refused: which
// of the two a reader takes differs between parsers, so there is no one member to edit,
// and no writer in this pipeline emits one.
func (o Object) Find(key string) (int, error) {
	found := -1
	for i, m := range o.Members {
		if m.Key == key {
			if found >= 0 {
				return -1, fmt.Errorf("duplicate key %q", key)
			}
			found = i
		}
	}
	return found, nil
}

// Value is the text of member i's value.
func (o Object) Value(text []byte, i int) []byte {
	return text[o.Members[i].ValueStart:o.Members[i].ValueEnd]
}

// Set sets key to value (JSON text): replaced in place if the key exists, appended last
// if not, compactly, as osmium writes.
func (o Object) Set(text []byte, key string, value []byte) ([]byte, error) {
	i, err := o.Find(key)
	if err != nil {
		return nil, err
	}
	if i >= 0 {
		m := o.Members[i]
		return join(text[:m.ValueStart], value, text[m.ValueEnd:]), nil
	}
	k, _ := json.Marshal(key)
	member := append(append(k, ':'), value...)
	if len(o.Members) == 0 {
		return join(text[:o.Open+1], member, text[o.Close:]), nil
	}
	at := o.Members[len(o.Members)-1].ValueEnd
	return join(text[:at], []byte(","), member, text[at:]), nil
}

// Delete removes key, taking the separating comma with it. Deleting a key that is not
// there is a no-op.
func (o Object) Delete(text []byte, key string) ([]byte, error) {
	i, err := o.Find(key)
	if err != nil || i < 0 {
		return text, err
	}
	m := o.Members[i]
	switch {
	case len(o.Members) == 1:
		return join(text[:m.KeyStart], text[m.ValueEnd:]), nil
	case i < len(o.Members)-1:
		// Up to the next key: the comma and whatever spacing followed it go too.
		return join(text[:m.KeyStart], text[o.Members[i+1].KeyStart:]), nil
	default:
		// The last member: from the end of the one before it, comma included.
		return join(text[:o.Members[i-1].ValueEnd], text[m.ValueEnd:]), nil
	}
}

func join(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
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

// scanValue returns the index just past the JSON value starting at b[i].
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
