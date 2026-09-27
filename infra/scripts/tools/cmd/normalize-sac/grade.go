package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// The official scale.
var namedGrades = map[string]int{
	"hiking":                    1,
	"mountain_hiking":           2,
	"demanding_mountain_hiking": 3,
	"alpine_hiking":             4,
	"demanding_alpine_hiking":   5,
	"difficult_alpine_hiking":   6,
}

// byLength is the official names longest first, so a name embedded in a longer one
// ("mountain_hiking" inside "demanding_mountain_hiking") never wins over it.
var byLength = []string{
	"demanding_mountain_hiking",
	"demanding_alpine_hiking",
	"difficult_alpine_hiking",
	"mountain_hiking",
	"alpine_hiking",
	"hiking",
}

// parseGrade is the grade a `sac_scale` value means, ok=false if it means nothing we can
// use. See the package comment for the rules.
func parseGrade(raw json.RawMessage) (int, bool, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return 0, false, nil
	}
	switch c := raw[0]; {
	case c == '-' || (c >= '0' && c <= '9'):
		// A number, truncated toward zero: 2.9 is grade 2.
		f, err := strconv.ParseFloat(string(raw), 64)
		if err != nil {
			return 0, false, nil
		}
		v := math.Trunc(f)
		if v >= 1 && v <= 6 {
			return int(v), true, nil
		}
		return 0, false, nil
	case c != '"':
		return 0, false, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, false, nil
	}
	return parseGradeText(s)
}

func parseGradeText(raw string) (int, bool, error) {
	text := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(raw)), " ", "_")
	if g, ok := namedGrades[text]; ok {
		return g, true, nil
	}

	best, found := 0, false
	for _, part := range splitSeparators(text) {
		part = strings.TrimSpace(part)
		part = strings.Trim(part, "()[]")
		part = strings.Trim(part, "_")
		if part == "" {
			continue
		}
		g, ok := namedGrades[part]
		if !ok {
			g, ok = shorthand(strings.ReplaceAll(part, "_", ""))
		}
		if !ok {
			// Last resort: an official name embedded in something longer, e.g.
			// "alpine_hiking_(t4)". Longest first so the more specific name wins.
			for _, name := range byLength {
				if strings.Contains(part, name) {
					g, ok = namedGrades[name], true
					break
				}
			}
		}
		// Harder end of a range.
		if ok && (!found || g > best) {
			best, found = g, true
		}
	}
	return best, found, nil
}

// splitSeparators splits text on
//
//	[;,/|]|\s+-\s+|-|–|—|\bto\b|\bor\b
//
// with \s any Unicode space and \b a boundary between a word character (a letter, digit
// or underscore, in any script) and anything else. A hand-written scanner rather than
// Go's regexp, whose \b only knows ASCII word characters: "to" beside an accented letter
// is part of a word, not a separator. It takes the leftmost match, and at one position
// the first alternative that matches, not the longest.
func splitSeparators(text string) []string {
	t := []rune(text)
	n := len(t)
	word := func(i int) bool {
		return i >= 0 && i < n && (t[i] == '_' || unicode.IsLetter(t[i]) || unicode.IsNumber(t[i]))
	}
	boundary := func(i int) bool { return word(i-1) != word(i) }
	isWordAt := func(i int, w string) bool {
		return i+2 <= n && string(t[i:i+2]) == w && boundary(i) && boundary(i+2)
	}
	matchAt := func(i int) int {
		switch t[i] {
		case ';', ',', '/', '|':
			return 1
		}
		if unicode.IsSpace(t[i]) {
			j := i
			for j < n && unicode.IsSpace(t[j]) {
				j++
			}
			if j < n && t[j] == '-' && j+1 < n && unicode.IsSpace(t[j+1]) {
				k := j + 1
				for k < n && unicode.IsSpace(t[k]) {
					k++
				}
				return k - i
			}
		}
		switch t[i] {
		case '-', '–', '—':
			return 1
		}
		if isWordAt(i, "to") || isWordAt(i, "or") {
			return 2
		}
		return 0
	}

	var parts []string
	start := 0
	for i := 0; i < n; {
		if m := matchAt(i); m > 0 {
			parts = append(parts, string(t[start:i]))
			i += m
			start = i
			continue
		}
		i++
	}
	return append(parts, string(t[start:]))
}

// shorthand is `^t?\s*([1-6])\s*[+-]?$`: "T3", "t3", "3", "T3+", "t 3".
func shorthand(s string) (int, bool) {
	t := []rune(s)
	i := 0
	if i < len(t) && t[i] == 't' {
		i++
	}
	for i < len(t) && unicode.IsSpace(t[i]) {
		i++
	}
	if i >= len(t) || t[i] < '1' || t[i] > '6' {
		return 0, false
	}
	g := int(t[i] - '0')
	i++
	for i < len(t) && unicode.IsSpace(t[i]) {
		i++
	}
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	if i == len(t) {
		return g, true
	}
	return 0, false
}
