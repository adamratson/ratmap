package main

import (
	"os"
	"testing"
)

func TestSelfTest(t *testing.T) {
	if err := selfTest(); err != nil {
		t.Fatal(err)
	}
}

// ramp-lossless.webp is a 16 px tile written with `cwebp -lossless -exact`, pixel (x, y)
// encoding 100x + y + 0.5 m.
func TestDecodesALosslessTile(t *testing.T) {
	data, err := os.ReadFile("testdata/ramp-lossless.webp")
	if err != nil {
		t.Fatal(err)
	}
	img, err := decode(data)
	if err != nil {
		t.Fatal(err)
	}
	const size = 16
	band := make([]float32, 2*size*size)
	fill(img, band[size:], 2*size, size) // the right-hand tile of a two-tile band
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			want := float32(100*x+y) + 0.5
			if got := band[y*2*size+size+x]; got != want {
				t.Fatalf("pixel %d,%d = %v, want %v", x, y, got, want)
			}
			if band[y*2*size+x] != 0 {
				t.Fatalf("pixel %d,%d of the left tile was written", x, y)
			}
		}
	}
}

// The same tile through `cwebp -q 90`: a lossy WebP would decode to elevations metres
// off, so it is refused rather than read.
func TestRefusesALossyTile(t *testing.T) {
	data, err := os.ReadFile("testdata/ramp-lossy.webp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decode(data); err == nil {
		t.Fatal("a lossy WebP decoded without error")
	}
	if _, err := decode([]byte("not a webp at all")); err == nil {
		t.Fatal("garbage decoded without error")
	}
}
