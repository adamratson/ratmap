package pytext

import (
	"testing"
	"unicode"
)

// DigitValue relies on every run of Nd characters in Go's Unicode tables being whole sets
// of ten starting at a zero; a future Unicode version that broke that would break it.
func TestDecimalDigitRunsAreWholeSetsOfTen(t *testing.T) {
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if unicode.Is(unicode.Nd, r) && !unicode.Is(unicode.Nd, r-1) {
			end := r
			for unicode.Is(unicode.Nd, end+1) {
				end++
			}
			if (end-r+1)%10 != 0 {
				t.Errorf("Nd run U+%04X..U+%04X is %d long", r, end, end-r+1)
			}
			r = end
		}
	}
}

// A few values checked by hand against unicodedata.decimal; the ports' own tests check
// DigitValue against CPython's int() and float() on thousands more.
func TestDigitValue(t *testing.T) {
	for r, want := range map[rune]int{'7': 7, 0x0663: 3, 0xFF19: 9, 0x1D7D9: 1, 0x1D7FF: 9, 0x0966: 0, 'a': -1, 0x00B2: -1} {
		if got := DigitValue(r); got != want {
			t.Errorf("DigitValue(U+%04X) = %d, want %d", r, got, want)
		}
	}
}
