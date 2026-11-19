// Package pmtiles reads tiles out of a local PMTiles v3 archive: the header, the
// directories, and each tile's bytes with its z/x/y.
//
// Local files only, and only the parts the build needs. The network side — choosing a
// bbox and zoom range from a remote archive — is `pmtiles extract`'s job; this reads what
// it wrote.
package pmtiles

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// Header is the part of the fixed 127-byte header this package uses.
type Header struct {
	RootOffset, RootLength uint64
	LeafOffset             uint64
	DataOffset             uint64
	InternalCompression    byte
	TileCompression        byte
	TileType               byte
	MinZoom, MaxZoom       byte
}

// Tile types, spec v3.
const (
	TileTypeMVT  = 1
	TileTypePNG  = 2
	TileTypeJPEG = 3
	TileTypeWebP = 4
)

// Archive is an open local archive.
type Archive struct {
	f      *os.File
	Header Header
}

// Open reads path's header and checks it is an archive this package can read.
func Open(path string) (*Archive, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	raw := make([]byte, 127)
	if _, err := io.ReadFull(f, raw); err != nil || string(raw[:7]) != "PMTiles" || raw[7] != 3 {
		f.Close()
		return nil, fmt.Errorf("%s: not a PMTiles v3 archive", path)
	}
	h := Header{
		RootOffset:          binary.LittleEndian.Uint64(raw[8:]),
		RootLength:          binary.LittleEndian.Uint64(raw[16:]),
		LeafOffset:          binary.LittleEndian.Uint64(raw[40:]),
		DataOffset:          binary.LittleEndian.Uint64(raw[56:]),
		InternalCompression: raw[97],
		TileCompression:     raw[98],
		TileType:            raw[99],
		MinZoom:             raw[100],
		MaxZoom:             raw[101],
	}
	if h.InternalCompression != 1 && h.InternalCompression != 2 {
		f.Close()
		return nil, fmt.Errorf("%s: unsupported internal compression %d", path, h.InternalCompression)
	}
	return &Archive{f: f, Header: h}, nil
}

func (a *Archive) Close() error { return a.f.Close() }

// Entry is a directory entry: RunLength consecutive tile ids from TileID share one blob,
// or, with RunLength 0, a leaf directory.
type Entry struct{ TileID, RunLength, Offset, Length uint64 }

// Each calls fn for every tile in the archive at zoom z, in tile-id order, with its
// bytes. A run of identical tiles (open sea, say) is read once and handed to fn for each
// tile in the run.
func (a *Archive) Each(z int, fn func(x, y uint32, data []byte) error) error {
	first, last := ZoomRange(z)
	pending := [][2]uint64{{a.Header.RootOffset, a.Header.RootLength}}
	for len(pending) > 0 {
		d := pending[0]
		pending = pending[1:]
		es, err := a.directory(d[0], d[1])
		if err != nil {
			return err
		}
		var leaves [][2]uint64
		for _, e := range es {
			if e.RunLength == 0 {
				leaves = append(leaves, [2]uint64{a.Header.LeafOffset + e.Offset, e.Length})
				continue
			}
			if e.TileID+e.RunLength <= first || e.TileID > last {
				continue
			}
			data := make([]byte, e.Length)
			if _, err := a.f.ReadAt(data, int64(a.Header.DataOffset+e.Offset)); err != nil {
				return fmt.Errorf("reading tile %d: %w", e.TileID, err)
			}
			for id := max(e.TileID, first); id < e.TileID+e.RunLength && id <= last; id++ {
				_, x, y := ZXY(id)
				if err := fn(x, y, data); err != nil {
					return err
				}
			}
		}
		pending = append(leaves, pending...)
	}
	return nil
}

func (a *Archive) directory(off, length uint64) ([]Entry, error) {
	raw := make([]byte, length)
	if _, err := a.f.ReadAt(raw, int64(off)); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if a.Header.InternalCompression == 2 {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		if raw, err = io.ReadAll(zr); err != nil {
			return nil, err
		}
	}
	return Entries(raw)
}

// Entries decodes a directory (spec v3): a count, then delta-coded tile ids, run lengths,
// lengths and offsets, each a varint; an offset of 0 after the first entry means
// "straight after the previous entry".
func Entries(buf []byte) ([]Entry, error) {
	pos := 0
	next := func() (uint64, error) {
		v, n := binary.Uvarint(buf[pos:])
		if n <= 0 {
			return 0, errors.New("directory ends inside a varint")
		}
		pos += n
		return v, nil
	}
	n, err := next()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(buf)) {
		return nil, fmt.Errorf("directory claims %d entries in %d bytes", n, len(buf))
	}
	es := make([]Entry, n)
	var id uint64
	for i := range es {
		d, err := next()
		if err != nil {
			return nil, err
		}
		id += d
		es[i].TileID = id
	}
	for i := range es {
		if es[i].RunLength, err = next(); err != nil {
			return nil, err
		}
	}
	for i := range es {
		if es[i].Length, err = next(); err != nil {
			return nil, err
		}
	}
	for i := range es {
		v, err := next()
		if err != nil {
			return nil, err
		}
		if v == 0 && i > 0 {
			es[i].Offset = es[i-1].Offset + es[i-1].Length
		} else {
			es[i].Offset = v - 1
		}
	}
	return es, nil
}

// ZoomRange is the first and last tile id at zoom z: ids are numbered zoom by zoom, 4^z
// of them at zoom z, each zoom along a Hilbert curve.
func ZoomRange(z int) (first, last uint64) {
	for i := 0; i < z; i++ {
		first += 1 << (2 * i)
	}
	return first, first + (1 << (2 * z)) - 1
}

// ZXY turns a tile id back into its zoom and position.
func ZXY(id uint64) (z int, x, y uint32) {
	var acc uint64
	for acc+(1<<(2*z)) <= id {
		acc += 1 << (2 * z)
		z++
	}
	pos := id - acc
	n := uint64(1) << z
	var tx, ty uint64
	for s := uint64(1); s < n; s *= 2 {
		rx := 1 & (pos / 2)
		ry := 1 & (pos ^ rx)
		if ry == 0 {
			if rx == 1 {
				tx, ty = s-1-tx, s-1-ty
			}
			tx, ty = ty, tx
		}
		tx += s * rx
		ty += s * ry
		pos /= 4
	}
	return z, uint32(tx), uint32(ty)
}

// TileID is ZXY's inverse.
func TileID(z int, x, y uint32) uint64 {
	first, _ := ZoomRange(z)
	n := uint64(1) << z
	tx, ty := uint64(x), uint64(y)
	var d uint64
	for s := n / 2; s > 0; s /= 2 {
		var rx, ry uint64
		if tx&s > 0 {
			rx = 1
		}
		if ty&s > 0 {
			ry = 1
		}
		d += s * s * ((3 * rx) ^ ry)
		if ry == 0 {
			if rx == 1 {
				tx, ty = s-1-tx, s-1-ty
			}
			tx, ty = ty, tx
		}
	}
	return first + d
}
