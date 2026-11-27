package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A hand-encoded coverage tile, so the test needs no network: protobuf written field by
// field, as Mapterhorn's tiles are.
func varint(v uint64) []byte {
	var b []byte
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func field(num int, payload []byte) []byte {
	return append(append(varint(uint64(num)<<3|2), varint(uint64(len(payload)))...), payload...)
}

func zz(v int64) uint64 { return uint64((v << 1) ^ (v >> 63)) }

func packedOf(vs ...uint64) []byte {
	var b []byte
	for _, v := range vs {
		b = append(b, varint(v)...)
	}
	return b
}

// square is a closed ring command list for the box [x0,x1]x[y0,y1] in tile units.
func square(x0, y0, x1, y1 int64) []uint64 {
	return []uint64{
		1<<3 | 1, zz(x0), zz(y0),
		3<<3 | 2, zz(x1 - x0), 0, 0, zz(y1 - y0), zz(x0 - x1), 0,
		1<<3 | 7,
	}
}

func feature(valueIndex uint64, geom []uint64) []byte {
	f := field(2, packedOf(0, valueIndex))
	f = append(f, 3<<3|0, 3) // type: polygon
	return append(f, field(4, packedOf(geom...))...)
}

// tileWith: a coverage layer of 4096 extent where "fine1" covers the western half and
// "glo30" the whole tile.
func tileWith() []byte {
	var l []byte
	l = append(l, field(1, []byte("coverage"))...)
	l = append(l, field(2, feature(0, square(0, 0, 2048, 4096)))...)
	l = append(l, field(2, feature(1, square(0, 0, 4096, 4096)))...)
	l = append(l, field(3, []byte("source"))...)
	l = append(l, field(4, field(1, []byte("fine1")))...)
	l = append(l, field(4, field(1, []byte("glo30")))...)
	l = append(l, 5<<3|0)
	l = append(l, varint(4096)...)
	return field(3, l)
}

func TestRun(t *testing.T) {
	dir := t.TempDir()
	regions := filepath.Join(dir, "regions.json")
	// z8 tile 128/79 spans lon 0 to 1.40625 and lat ~55.78 to ~56.56. "west" lies in
	// the tile's western half, "east" in its eastern, "half" across the middle; "glo"
	// opts out of contours and is named on the command line in the second run.
	if err := os.WriteFile(regions, []byte(`{"regions": [
	  {"id": "west", "bbox": [0.1, 56.0, 0.6, 56.3], "contours": true},
	  {"id": "east", "bbox": [0.8, 56.0, 1.3, 56.3], "contours": true, "contourDemZoom": 12},
	  {"id": "half", "bbox": [0.2, 56.0, 1.2, 56.3], "contours": true, "contourDemZoom": 12},
	  {"id": "glo", "bbox": [0.8, 56.0, 1.3, 56.3]}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	fetch := func(url string) ([]byte, error) {
		switch {
		case url == attributionURL:
			return []byte(`[{"source": "fine1", "resolution": 1.0}, {"source": "glo30", "resolution": 30}]`), nil
		case url == fmt.Sprintf(coverageURL, 8, 128, 79):
			return tileWith(), nil
		}
		return nil, nil
	}
	var out bytes.Buffer
	if err := run(regions, nil, &out, fetch); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"west                                   60  100%  fine1 100%",
		"east                                   60    0%  glo30 100%",
		"half                                  120   50%  fine1 50%, glo30 50%",
		"1 of 3 region(s) agree",
		"west: contourDemZoom unset, measured says 12",
		"east: contourDemZoom 12, measured says unset",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "glo ") {
		t.Errorf("a region without contours was measured unasked:\n%s", got)
	}

	out.Reset()
	if err := run(regions, []string{"glo"}, &out, fetch); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "glo                                    60    0%") {
		t.Errorf("a region named on the command line was not measured:\n%s", out.String())
	}
	if err := run(regions, []string{"nosuch"}, &out, fetch); err == nil {
		t.Error("an unknown id was accepted")
	}
}

func TestContainsHole(t *testing.T) {
	f := footprint{rings: [][][2]float64{
		{{0, 0}, {10, 0}, {10, 10}, {0, 10}},
		{{4, 4}, {6, 4}, {6, 6}, {4, 6}},
	}}
	if !f.contains(2, 2) || f.contains(5, 5) || f.contains(11, 5) {
		t.Error("even-odd rule: want inside the outer ring, outside the hole and beyond")
	}
}
