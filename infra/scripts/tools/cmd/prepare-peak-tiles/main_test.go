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

	"ratmap/infra/tools/internal/golden"
)

// testdata/untie.tsv is the world position and the untied coordinates for 28,706
// coordinates, 5,247 of them moved: coordinates aimed at a rounding tie on each axis at
// every zoom 0-14, and random ones. Written by the Python this replaced, whose replay of
// tippecanoe's arithmetic this matches. Both answers have to match: the world position
// is what decides a tie, and the move is what gets written.
func TestUntie(t *testing.T) {
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
			t.Errorf("worldXY(%s, %s): got %d, %d; want %s, %s", c[0], c[1], x, y, c[2], c[3])
		}
		nl, nt, err := untie(lon, lat)
		if err != nil {
			t.Fatal(err)
		}
		wl, _ := strconv.ParseFloat(c[4], 64)
		wt, _ := strconv.ParseFloat(c[5], 64)
		if nl != wl || nt != wt {
			t.Errorf("untie(%s, %s): got %v %v; want %s %s", c[0], c[1], nl, nt, c[4], c[5])
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

// testdata/edge.want.* are the report and output for testdata/edge.geojsonl: peaks beyond
// the limit and inside the margin, the known tie (Хонголдойский Голец), a tie with a third
// coordinate, names that are missing or not strings, blank lines. Lines left alone must
// be byte-identical; moved ones are compared parsed. -update rewrites them.
func TestEdgeCases(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	golden.Check(t, "report", report.Bytes(), "testdata/edge.want.stdout")
	got, _ := os.ReadFile(out)
	if *golden.Update {
		golden.Check(t, "output", got, "testdata/edge.want.geojsonl")
		return
	}
	wantOut, _ := os.ReadFile("testdata/edge.want.geojsonl")
	g, w := strings.Split(strings.TrimRight(string(got), "\n"), "\n"), strings.Split(strings.TrimRight(string(wantOut), "\n"), "\n")
	if len(g) != len(w) {
		t.Fatalf("%d lines, want %d", len(g), len(w))
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
			// An unchanged line is copied through untouched.
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
