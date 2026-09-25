package main

import (
	"bytes"
	"math"
	"os"
	"strings"
	"testing"
)

// testdata/whole.geojsonl and box.geojsonl were written from testdata/cell.csv by the
// Python contour-cell.py this replaced (2026-09-25), so these hold the Go to its output
// byte for byte: rounding, float formatting, cuts, dropped touches, tags.
func TestMatchesThePythonItReplaced(t *testing.T) {
	inf := math.Inf(1)
	for _, c := range []struct {
		name   string
		bounds box
	}{
		{"whole.geojsonl", box{-inf, inf, -inf, inf}},
		{"box.geojsonl", box{0, 1, 0, 1}},
	} {
		in, err := os.Open("testdata/cell.csv")
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := run(in, &out, 50, c.bounds); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		in.Close()
		want, err := os.ReadFile("testdata/" + c.name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out.Bytes(), want) {
			t.Errorf("%s differs from the Python's output:\ngot:\n%s\nwant:\n%s", c.name, out.String(), want)
		}
	}
}

// Python's repr() of each, as json.dumps writes them.
func TestFormatsFloatsAsPython(t *testing.T) {
	for v, want := range map[float64]string{
		47.0:               "47.0",
		-1940.0:            "-1940.0",
		1e-05:              "1e-05",
		1.5e-05:            "1.5e-05",
		0.0001:             "0.0001",
		9.999999e-05:       "9.999999e-05",
		0.0:                "0.0",
		123.4567891:        "123.4567891",
		1e16:               "1e+16",
		9999999999999998.0: "9999999999999998.0",
		12345678.9:         "12345678.9",
		-0.00012:           "-0.00012",
	} {
		if got := pyRepr(v); got != want {
			t.Errorf("pyRepr(%v) = %q, Python writes %q", v, got, want)
		}
	}
	if got := pyRepr(math.Copysign(0, -1)); got != "-0.0" {
		t.Errorf("pyRepr(-0.0) = %q, Python writes \"-0.0\"", got)
	}
}

// Python's round(v, 7) of each.
func TestRoundsAsPython(t *testing.T) {
	for v, want := range map[float64]float64{
		0.30000000500000004: 0.3,
		0.7000000150000001:  0.7,
		2.00000015:          2.0000001,
		1.00000025:          1.0000003,
		6.41550119424282:    6.4155012,
		179.99999995:        179.9999999,
	} {
		if got, _ := round7(v); got != want {
			t.Errorf("round7(%v) = %v, Python rounds to %v", v, got, want)
		}
	}
	if got, _ := round7(-5e-08); got != 0 || !math.Signbit(got) {
		t.Errorf("round7(-5e-08) = %v, Python rounds to -0.0", got)
	}
}

// The whole point of the seams: a line cut by two neighbouring cells comes out as two
// pieces that meet at one and the same point.
func TestNeighboursMeetAtTheSeam(t *testing.T) {
	line := []point{{0.1, 0.13}, {0.37, 0.61}, {0.71, 0.29}, {0.93, 0.87}}
	inf := math.Inf(1)
	west, err := clipLine(line, box{-inf, 0.5, -inf, inf})
	if err != nil {
		t.Fatal(err)
	}
	east, err := clipLine(line, box{0.5, inf, -inf, inf})
	if err != nil {
		t.Fatal(err)
	}
	if len(west) != 1 || len(east) != 1 {
		t.Fatalf("want one piece a side, got %d west and %d east", len(west), len(east))
	}
	w, e := west[0][len(west[0])-1], east[0][0]
	if w != e || w.x != 0.5 {
		t.Errorf("west ends at %v, east starts at %v: want the same point on x = 0.5", w, e)
	}
}

func TestRefusesWhatGdalContourDidNotWrite(t *testing.T) {
	for name, csv := range map[string]string{
		"header":     "geometry,id,ele\n",
		"geometry":   "WKT,ID,ele\n\"MULTILINESTRING ((0 0,1 1))\",0,10\n",
		"coordinate": "WKT,ID,ele\n\"LINESTRING (0 0 5,1 1 5)\",0,10\n",
		"fields":     "WKT,ID,ele\n\"LINESTRING (0 0,1 1)\"\n",
		"empty":      "",
	} {
		var out bytes.Buffer
		if err := run(strings.NewReader(csv), &out, 50, box{-1, 1, -1, 1}); err == nil {
			t.Errorf("%s: accepted %q", name, csv)
		}
	}
}
