// Package num holds the number handling the standard library leaves out.
package num

import (
	"math"
	"strconv"
	"unicode"
)

// Round rounds x to places decimal places: the exact binary value, with exact ties to
// even, read back as the nearest double. Not math.Round(x*10^n)/10^n, which rounds the
// scaled value instead of x (2.675 is really 2.67499999..., so it rounds down) and sends
// ties away from zero. strconv's fixed-precision formatting does it exactly.
func Round(x float64, places int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	v, err := strconv.ParseFloat(strconv.FormatFloat(x, 'f', places, 64), 64)
	if err != nil {
		panic(err) // FormatFloat's own output always parses
	}
	return v
}

// Digit is the value of r as a decimal digit in any script — Arabic-Indic, Devanagari,
// fullwidth, as OSM's free-text numbers are sometimes written — or -1 if it is not one.
// Unicode's decimal digits (category Nd) come in runs of whole 0-9 sets, each starting
// at zero, so the value is the distance from the start of the run, mod 10.
func Digit(r rune) int {
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
