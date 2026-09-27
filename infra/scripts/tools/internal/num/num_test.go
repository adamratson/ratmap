package num

import (
	"bufio"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// testdata/round.tsv is round(x, 1), round(x, 4) and round(x, 7) on 4,000-odd doubles
// (the first column, as its bits), written by CPython, whose round() is exact: ties to
// even on the exact binary value.
func TestRound(t *testing.T) {
	f, err := os.Open("testdata/round.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		col := strings.Split(sc.Text(), "\t")
		bits, err := strconv.ParseUint(col[0], 16, 64)
		if err != nil {
			t.Fatal(err)
		}
		x := math.Float64frombits(bits)
		for i, places := range []int{1, 4, 7} {
			want, err := strconv.ParseFloat(col[1+i], 64)
			if err != nil {
				t.Fatal(err)
			}
			got := Round(x, places)
			if math.Float64bits(got) != math.Float64bits(want) && !(math.IsNaN(got) && math.IsNaN(want)) {
				t.Errorf("Round(%v, %d) = %v, want %v", x, places, got, want)
			}
		}
		n++
	}
	if n < 4000 {
		t.Fatalf("only %d vectors", n)
	}
}

// Digit relies on every run of Nd characters in Go's Unicode tables being whole sets of
// ten starting at a zero; a future Unicode version that broke that would break it.
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

// Checked by hand against Unicode's own decimal values.
func TestDigit(t *testing.T) {
	for r, want := range map[rune]int{'7': 7, 0x0663: 3, 0xFF19: 9, 0x1D7D9: 1, 0x1D7FF: 9, 0x0966: 0, 'a': -1, 0x00B2: -1} {
		if got := Digit(r); got != want {
			t.Errorf("Digit(U+%04X) = %d, want %d", r, got, want)
		}
	}
}
