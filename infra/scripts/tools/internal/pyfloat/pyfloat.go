// Package pyfloat reproduces the two pieces of CPython float behaviour the pipeline's
// outputs depend on: `repr(x)` (which is what `json.dumps` writes for a float) and
// `round(x, n)`.
//
// Why this is not just strconv: the numbers match, the text and the ties do not.
//
//   - Go writes 708 as "708"; Python writes "708.0". Every GeoJSON line these tools emit
//     has to be byte-identical to what the Python they replace wrote, or none of the
//     byte-for-byte checks this pipeline has leaned on (compute-prominence.py's
//     docstring, fetch-dem.sh's cache) can tell a real change from a formatting one.
//   - Python's `round()` rounds an exact binary tie to even. Go's math.Round rounds it
//     away from zero, so a straight translation writes a different `prom` for some peaks.
//     strconv's fixed-precision formatting does round exact ties to even
//     (shouldRoundUp in strconv/decimal.go), which is what Round uses.
package pyfloat

import (
	"math"
	"strconv"
	"strings"
)

// Repr is Python's repr(float): the shortest digits that round-trip, in fixed notation
// with a trailing ".0" when integral, switching to exponent notation outside
// 1e-4 <= |x| < 1e16 (PyOS_double_to_string, mode 'r'). NaN and the infinities are
// written the way json.dumps writes them, since that is the only caller.
func Repr(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	}

	// Shortest round-trip digits, as "d.ddde±XX". Python uses David Gay's dtoa mode 0 and
	// Go uses Ryu; both produce the shortest string that round-trips and, among those, the
	// one closest to the true value.
	e := strconv.FormatFloat(x, 'e', -1, 64)
	sign := ""
	if e[0] == '-' {
		sign, e = "-", e[1:]
	}
	mant, expStr, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	decpt := exp + 1 // value = 0.digits x 10^decpt, dtoa's convention

	if decpt <= -4 || decpt > 16 {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		es := "+"
		if exp < 0 {
			es, exp = "-", -exp
		}
		ed := strconv.Itoa(exp)
		if len(ed) < 2 {
			ed = "0" + ed
		}
		return sign + m + "e" + es + ed
	}

	var out string
	switch {
	case decpt <= 0:
		out = "0." + strings.Repeat("0", -decpt) + digits
	case decpt >= len(digits):
		out = digits + strings.Repeat("0", decpt-len(digits)) + ".0"
	default:
		out = digits[:decpt] + "." + digits[decpt:]
	}
	return sign + out
}

// Round is Python's round(x, ndigits) for a float: the exact binary value rounded to
// ndigits decimal places, exact ties to even, read back as the nearest double.
func Round(x float64, ndigits int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	v, err := strconv.ParseFloat(strconv.FormatFloat(x, 'f', ndigits, 64), 64)
	if err != nil {
		panic(err) // FormatFloat's own output always parses
	}
	return v
}

// FormatG is Python's format(x, 'g'): six significant digits, trailing zeros dropped,
// exponent notation below 1e-4 or at 1e6 and above.
func FormatG(x float64) string {
	return strconv.FormatFloat(x, 'g', 6, 64)
}
