package pyfloat

import (
	"bufio"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
)

// testdata/python-vectors.tsv was written by CPython (testdata/gen-vectors.py), so these
// compare against Python itself rather than against a reading of its source.
func TestAgainstCPython(t *testing.T) {
	f, err := os.Open("testdata/python-vectors.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		col := strings.Split(sc.Text(), "\t")
		if len(col) != 6 {
			t.Fatalf("malformed vector line %q", sc.Text())
		}
		bits, err := strconv.ParseUint(col[0], 16, 64)
		if err != nil {
			t.Fatal(err)
		}
		x := math.Float64frombits(bits)

		if got := Repr(x); got != col[1] {
			t.Errorf("Repr(%v) = %q, Python %q", x, got, col[1])
		}
		for i, nd := range []int{1, 4, 7} {
			if got := Repr(Round(x, nd)); got != col[2+i] {
				t.Errorf("round(%s, %d) = %q, Python %q", col[1], nd, got, col[2+i])
			}
		}
		if got := FormatG(x); got != col[5] {
			t.Errorf("format(%s, 'g') = %q, Python %q", col[1], got, col[5])
		}
		n++
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if n < 4000 {
		t.Fatalf("only %d vectors read", n)
	}
}

func TestReprJSONSpecials(t *testing.T) {
	for x, want := range map[float64]string{math.Inf(1): "Infinity", math.Inf(-1): "-Infinity"} {
		if got := Repr(x); got != want {
			t.Errorf("Repr(%v) = %q, want %q", x, got, want)
		}
	}
	if got := Repr(math.NaN()); got != "NaN" {
		t.Errorf("Repr(NaN) = %q", got)
	}
}
