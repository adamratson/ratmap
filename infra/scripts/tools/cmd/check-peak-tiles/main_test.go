package main

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Each testdata/case-* is the Python's verdict (exit code and stdout) on the same source,
// decoded tiles and archive (testdata/gen-fixtures.py): every peak present; extra input
// peaks the archive lacks (named, unnamed, a Munro, one at the antimeridian, a null name);
// more than the 50 it lists; and a decoded coordinate moved onto a half pixel.
func TestMatchesPython(t *testing.T) {
	if _, err := exec.LookPath("tippecanoe-decode"); err != nil {
		t.Skip("tippecanoe-decode not on PATH; the failure cases decode the archive again")
	}
	for _, name := range []string{"ok", "missing", "many-missing", "unclear", "edge"} {
		t.Run(name, func(t *testing.T) {
			args, err := os.ReadFile(filepath.Join("testdata", "case-"+name+".args"))
			if err != nil {
				t.Fatal(err)
			}
			a := strings.Split(strings.TrimSpace(string(args)), "\n")
			z, _ := strconv.Atoi(a[2])
			decoded, err := os.Open(filepath.Join("testdata", a[1]))
			if err != nil {
				t.Fatal(err)
			}
			defer decoded.Close()
			var out bytes.Buffer
			ok, err := run(filepath.Join("testdata", a[0]), "testdata/peaks.pmtiles", z, decoded, &out)
			if err != nil {
				t.Fatal(err)
			}
			code := 0
			if !ok {
				code = 1
			}
			got := fmt.Sprintf("exit %d\n%s", code, out.String())
			want, _ := os.ReadFile(filepath.Join("testdata", "case-"+name+".want"))
			if got != string(want) {
				t.Errorf("got:\n%s\nPython:\n%s", got, want)
			}
		})
	}
}

func TestPixel(t *testing.T) {
	for v, want := range map[float64]string{10.0: "10", 10.25: "10", 10.26: "none", 10.5: "none", 10.74: "none", 10.75: "11", -0.2: "0", 4095.9: "4096"} {
		p, ok := pixel(v)
		got := "none"
		if ok {
			got = strconv.Itoa(p)
		}
		if got != want {
			t.Errorf("pixel(%v) = %s, want %s", v, got, want)
		}
	}
	_ = math.Pi
}

func TestPyMod(t *testing.T) {
	if pyMod(-1, 10) != 9 || pyMod(11, 10) != 1 || pyMod(0, 10) != 0 {
		t.Fatal("pyMod is not Python's %")
	}
}
