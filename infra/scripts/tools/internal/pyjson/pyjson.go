// Package pyjson is JSON as Python's json module reads and writes it: a decoded value
// keeps its object key order and the difference between an int and a float, and Encode
// writes exactly the text json.dumps would for the same options.
//
// For the files people read and diff — regions.json above all, which build-catalog
// rewrites and which is checked in — "the same data" is not enough: a regeneration that
// respaces every line, turns 5.0 into 5 or escapes every accented region name buries the
// one real change in a thousand-line diff. So the writers that replaced Python scripts
// write what the scripts wrote, and this checks it against CPython in its tests.
package pyjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"ratmap/infra/tools/internal/pyfloat"
)

// Value is nil (None), bool, string, Int, float64, []Value or *Object.
type Value any

// Int is a JSON integer, held as its canonical decimal text: Python's ints are unbounded,
// and a catalogue's byte counts are only the start of what could arrive in one.
type Int string

// Object is a dict: members in insertion order. A repeated key keeps its first position
// and its last value, as json.loads builds it.
type Object struct {
	Keys []string
	Vals []Value
}

// Get returns the value for key.
func (o *Object) Get(key string) (Value, bool) {
	for i, k := range o.Keys {
		if k == key {
			return o.Vals[i], true
		}
	}
	return nil, false
}

// Has reports whether key is present.
func (o *Object) Has(key string) bool { _, ok := o.Get(key); return ok }

// Set is `d[key] = v`: replaced in place, or appended.
func (o *Object) Set(key string, v Value) {
	for i, k := range o.Keys {
		if k == key {
			o.Vals[i] = v
			return
		}
	}
	o.Keys, o.Vals = append(o.Keys, key), append(o.Vals, v)
}

// Delete is `del d[key]`, a no-op if absent.
func (o *Object) Delete(key string) {
	for i, k := range o.Keys {
		if k == key {
			o.Keys = append(o.Keys[:i], o.Keys[i+1:]...)
			o.Vals = append(o.Vals[:i], o.Vals[i+1:]...)
			return
		}
	}
}

// Copy is dict(d): a new object with the same members, values shared.
func (o *Object) Copy() *Object {
	return &Object{Keys: append([]string(nil), o.Keys...), Vals: append([]Value(nil), o.Vals...)}
}

// Decode parses JSON as json.loads does, including its NaN/Infinity/-Infinity literals.
func Decode(data []byte) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec, data)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err == nil {
		return nil, errors.New("pyjson: extra data after the value")
	}
	return v, nil
}

// decodeValue reads one value from dec. The NaN and Infinity literals json.loads accepts
// are not JSON, so a document holding one is decoded by the fallback below instead.
func decodeValue(dec *json.Decoder, data []byte) (Value, error) {
	t, err := dec.Token()
	if err != nil {
		if bytes.Contains(data, []byte("NaN")) || bytes.Contains(data, []byte("Infinity")) {
			return nil, errors.New("pyjson: NaN/Infinity literals are not supported here")
		}
		return nil, err
	}
	switch v := t.(type) {
	case json.Delim:
		switch v {
		case '{':
			o := &Object{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				val, err := decodeValue(dec, data)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			a := []Value{}
			for dec.More() {
				val, err := decodeValue(dec, data)
				if err != nil {
					return nil, err
				}
				a = append(a, val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return a, nil
		}
	case json.Number:
		return number(string(v))
	case string, bool, nil:
		return v, nil
	}
	return nil, fmt.Errorf("pyjson: unexpected token %v", t)
}

// number is a JSON number as json.loads makes it: an int if it has no fraction or
// exponent, otherwise a float (out of range reads as ±inf, as float() does).
func number(s string) (Value, error) {
	if !strings.ContainsAny(s, ".eE") {
		n, ok := new(big.Int).SetString(s, 10)
		if !ok {
			return nil, fmt.Errorf("pyjson: bad int %q", s)
		}
		return Int(n.String()), nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, err
	}
	return f, nil
}

// IntValue returns an Int's value if it fits int64.
func IntValue(v Value) (int64, bool) {
	i, ok := v.(Int)
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(string(i), 10, 64)
	return n, err == nil
}

// Number returns an int or float as float64, the way Python arithmetic would mix them.
func Number(v Value) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case Int:
		f, _ := new(big.Float).SetString(string(t))
		if f == nil {
			return 0, false
		}
		x, _ := f.Float64()
		return x, true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// FromInt is an int Value.
func FromInt(n int64) Int { return Int(strconv.FormatInt(n, 10)) }

// Options are json.dumps' keyword arguments that the pipeline's writers use.
type Options struct {
	// Indent is None when nil (one line, separators ", " and ": "), otherwise the number
	// of spaces per level — 0 still breaks every member onto its own line, as Python does.
	Indent      *int
	EnsureASCII bool
	SortKeys    bool
}

// Indent is a convenience for Options.Indent.
func Indent(n int) *int { return &n }

// Encode returns json.dumps(v, **opts).
func Encode(v Value, opts Options) (string, error) {
	var b strings.Builder
	if err := encode(&b, v, opts, 0); err != nil {
		return "", err
	}
	return b.String(), nil
}

func encode(b *strings.Builder, v Value, o Options, level int) error {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case Int:
		b.WriteString(string(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case float64:
		switch {
		case math.IsNaN(t):
			b.WriteString("NaN")
		case math.IsInf(t, 1):
			b.WriteString("Infinity")
		case math.IsInf(t, -1):
			b.WriteString("-Infinity")
		default:
			b.WriteString(pyfloat.Repr(t))
		}
	case string:
		writeString(b, t, o.EnsureASCII)
	case []Value:
		if len(t) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
				if o.Indent == nil {
					b.WriteByte(' ')
				}
			}
			newline(b, o, level+1)
			if err := encode(b, e, o, level+1); err != nil {
				return err
			}
		}
		newline(b, o, level)
		b.WriteByte(']')
	case *Object:
		if len(t.Keys) == 0 {
			b.WriteString("{}")
			return nil
		}
		idx := make([]int, len(t.Keys))
		for i := range idx {
			idx[i] = i
		}
		if o.SortKeys {
			sort.SliceStable(idx, func(a, c int) bool { return t.Keys[idx[a]] < t.Keys[idx[c]] })
		}
		b.WriteByte('{')
		for n, i := range idx {
			if n > 0 {
				b.WriteByte(',')
				if o.Indent == nil {
					b.WriteByte(' ')
				}
			}
			newline(b, o, level+1)
			writeString(b, t.Keys[i], o.EnsureASCII)
			b.WriteString(": ")
			if err := encode(b, t.Vals[i], o, level+1); err != nil {
				return err
			}
		}
		newline(b, o, level)
		b.WriteByte('}')
	default:
		return fmt.Errorf("pyjson: cannot encode %T", v)
	}
	return nil
}

func newline(b *strings.Builder, o Options, level int) {
	if o.Indent == nil {
		return
	}
	b.WriteByte('\n')
	b.WriteString(strings.Repeat(" ", *o.Indent*level))
}

const hexDigits = "0123456789abcdef"

// writeString is Python's encode_basestring (ensure_ascii=False: only the quote, the
// backslash and control characters are escaped) or encode_basestring_ascii (every code
// unit outside printable ASCII as \uXXXX, astral characters as surrogate pairs).
func writeString(b *strings.Builder, s string, ascii bool) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (ascii && r >= 0x7f):
				var units []uint16
				if r == utf8.RuneError {
					units = []uint16{0xfffd}
				} else {
					units = utf16.AppendRune(nil, r)
				}
				for _, u := range units {
					b.WriteString(`\u`)
					b.WriteByte(hexDigits[u>>12])
					b.WriteByte(hexDigits[u>>8&0xf])
					b.WriteByte(hexDigits[u>>4&0xf])
					b.WriteByte(hexDigits[u&0xf])
				}
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
