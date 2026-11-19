package pmtiles

import (
	"encoding/binary"
	"testing"
)

func TestZXYFollowsTheHilbertCurve(t *testing.T) {
	// Spec v3: zoom 0 is id 0; zoom 1 runs (0,0) (0,1) (1,1) (1,0).
	want := [][3]uint32{{0, 0, 0}, {1, 0, 0}, {1, 0, 1}, {1, 1, 1}, {1, 1, 0}}
	for id, w := range want {
		z, x, y := ZXY(uint64(id))
		if [3]uint32{uint32(z), x, y} != w {
			t.Errorf("ZXY(%d) = %d/%d/%d, want %v", id, z, x, y, w)
		}
	}
}

func TestTileIDRoundTrips(t *testing.T) {
	for z := 0; z <= 6; z++ {
		first, last := ZoomRange(z)
		seen := map[[2]uint32]bool{}
		for id := first; id <= last; id++ {
			gz, x, y := ZXY(id)
			if gz != z || TileID(z, x, y) != id {
				t.Fatalf("id %d -> %d/%d/%d -> %d", id, gz, x, y, TileID(z, x, y))
			}
			seen[[2]uint32{x, y}] = true
		}
		if len(seen) != 1<<(2*z) {
			t.Fatalf("zoom %d covers %d tiles, want %d", z, len(seen), 1<<(2*z))
		}
	}
	// Somewhere real: Scafell Pike's z12 tile.
	if z, x, y := ZXY(TileID(12, 2011, 1300)); z != 12 || x != 2011 || y != 1300 {
		t.Fatalf("z12 round trip gave %d/%d/%d", z, x, y)
	}
}

func TestEntriesDecodesADirectory(t *testing.T) {
	var buf []byte
	put := func(v uint64) { buf = binary.AppendUvarint(buf, v) }
	put(3) // entries
	put(5)
	put(1)
	put(10) // tile ids 5, 6, 16 (delta coded)
	put(1)
	put(2)
	put(0) // run lengths: the last is a leaf directory
	put(100)
	put(50)
	put(7) // lengths
	put(1)
	put(0)
	put(201) // offsets: 0, straight after (100), 200
	es, err := Entries(buf)
	if err != nil {
		t.Fatal(err)
	}
	want := []Entry{{5, 1, 0, 100}, {6, 2, 100, 50}, {16, 0, 200, 7}}
	for i := range want {
		if es[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, es[i], want[i])
		}
	}
	if _, err := Entries(buf[:len(buf)-1]); err == nil {
		t.Error("a truncated directory decoded without error")
	}
}
