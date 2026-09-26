package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"ratmap/infra/tools/internal/pyfloat"
)

// testdata/untie.tsv is the Python's world_xy and untie on 28,706 coordinates, 5,247 of
// them moved: coordinates aimed at a rounding tie on each axis at every zoom 0-14, and
// random ones (testdata/gen-vectors.py). Both answers have to match: the world position
// is what decides a tie, and the move is what gets written.
func TestUntieMatchesPython(t *testing.T) {
	f, err := os.Open("testdata/untie.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n, moved := 0, 0
	for sc.Scan() {
		c := strings.Split(sc.Text(), "\t")
		lon, _ := strconv.ParseFloat(c[0], 64)
		lat, _ := strconv.ParseFloat(c[1], 64)
		x, y := worldXY(lon, lat)
		if strconv.FormatInt(x, 10) != c[2] || strconv.FormatInt(y, 10) != c[3] {
			t.Errorf("world_xy(%s, %s): got %d, %d; Python %s, %s", c[0], c[1], x, y, c[2], c[3])
		}
		nl, nt, err := untie(lon, lat)
		if err != nil {
			t.Fatal(err)
		}
		if got := pyfloat.Repr(nl) + " " + pyfloat.Repr(nt); got != pyNum(c[4])+" "+pyNum(c[5]) {
			t.Errorf("untie(%s, %s): got %s; Python %s %s", c[0], c[1], got, c[4], c[5])
		}
		if nl != lon || nt != lat {
			moved++
		}
		n++
	}
	if n < 28000 || moved < 5000 {
		t.Fatalf("%d vectors, %d moved: the tie cases are missing", n, moved)
	}
}

// pyNum is a Python repr from the TSV, as pyfloat.Repr writes the same value (the file
// has ints where the Python kept an int).
func pyNum(s string) string {
	f, _ := strconv.ParseFloat(s, 64)
	return pyfloat.Repr(f)
}

func TestMercatorLimitMatchesPython(t *testing.T) {
	// math.degrees(math.atan(math.sinh(math.pi))) in CPython: 85.0511287798066.
	if got := pyfloat.Repr(mercatorLimit); got != "85.0511287798066" {
		t.Fatalf("got %s", got)
	}
}

// testdata/edge.want.* are the Python's report and output for testdata/edge.geojsonl:
// peaks beyond the limit and inside the margin, the known tie (Хонголдойский Голец), a
// tie with a third coordinate, names that are missing or not strings, blank lines.
// Lines left alone must be byte-identical; moved ones are compared parsed.
func TestMatchesPython(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/edge.want.stdout")
	if report.String() != string(want) {
		t.Errorf("report:\n got  %s want %s", report.String(), want)
	}
	got, _ := os.ReadFile(out)
	wantOut, _ := os.ReadFile("testdata/edge.want.geojsonl")
	g, w := strings.Split(strings.TrimRight(string(got), "\n"), "\n"), strings.Split(strings.TrimRight(string(wantOut), "\n"), "\n")
	if len(g) != len(w) {
		t.Fatalf("%d lines, Python wrote %d", len(g), len(w))
	}
	input, _ := os.ReadFile("testdata/edge.geojsonl")
	copied := map[string]bool{}
	for _, l := range strings.Split(string(input), "\n") {
		copied[l] = true
	}
	for i := range w {
		if g[i] == w[i] {
			continue
		}
		if copied[w[i]] {
			// The Python copied this line through untouched; so must this.
			t.Errorf("line %d was rewritten:\n got  %s\n want %s", i+1, g[i], w[i])
			continue
		}
		var a, b any
		json.Unmarshal([]byte(g[i]), &a)
		json.Unmarshal([]byte(w[i]), &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("line %d:\n got  %s\n want %s", i+1, g[i], w[i])
		}
	}
}

func TestLlround(t *testing.T) {
	for v, want := range map[float64]int64{0.5: 1, -0.5: -1, 1.49: 1, 2.5: 3, -2.5: -3, 4294967295.5: 4294967296} {
		if got := llround(v); got != want {
			t.Errorf("llround(%v) = %d, want %d", v, got, want)
		}
	}
	_ = math.Pi
}
