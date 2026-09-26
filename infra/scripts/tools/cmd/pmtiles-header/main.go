// Command pmtiles-header reads and rewrites the parts of a PMTiles v3 archive the build
// scripts check, without reading any tile data.
//
//	pmtiles show --header-json A | pmtiles-header maxzoom      # build-region.sh, build-peaks.sh
//	pmtiles-header zooms ARCHIVE                                # build-region.sh archive_zooms
//	pmtiles-header tile-count ARCHIVE                           # build-region.sh archive_tile_count
//	pmtiles show --header-json A | pmtiles-header narrow LO HI OUT.json   # verify_wide_header
//
// Ports of the Python snippets those scripts carried inline, printing what they printed.
// `maxzoom` and `narrow` take `pmtiles show --header-json` on stdin rather than reading a
// file, because their archive can be a URL (build-region.sh cuts peaks from the published
// global archive).
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/pyjson"
	"ratmap/infra/tools/internal/pytext"
)

const usage = `usage: pmtiles-header maxzoom < HEADER_JSON
       pmtiles-header zooms ARCHIVE
       pmtiles-header tile-count ARCHIVE
       pmtiles-header narrow LO HI OUT_JSON < HEADER_JSON`

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		if err == errUsage {
			fmt.Fprintln(os.Stderr, usage)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var errUsage = errors.New("usage")

func run(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 {
		return errUsage
	}
	switch {
	case args[0] == "maxzoom" && len(args) == 1:
		h, err := readHeaderJSON(in)
		if err != nil {
			return err
		}
		v, ok := h.Get("maxzoom")
		if !ok {
			return errors.New(`header JSON has no "maxzoom"`)
		}
		s, _ := pyjson.Encode(v, pyjson.Options{})
		fmt.Fprintln(out, pytext.StrValue([]byte(s)))
		return nil
	case args[0] == "zooms" && len(args) == 2:
		return zooms(args[1], out)
	case args[0] == "tile-count" && len(args) == 2:
		return tileCount(args[1], out)
	case args[0] == "narrow" && len(args) == 4:
		return narrow(in, args[1], args[2], args[3])
	}
	return errUsage
}

func readHeaderJSON(in io.Reader) (*pyjson.Object, error) {
	data, err := io.ReadAll(in)
	if err != nil {
		return nil, err
	}
	v, err := pyjson.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("header JSON: %w", err)
	}
	o, ok := v.(*pyjson.Object)
	if !ok {
		return nil, errors.New("header JSON is not an object")
	}
	return o, nil
}

// narrow writes the header JSON with its zoom range set to lo..hi and the centre zoom
// moved inside it — `pmtiles verify` rejects "CenterZoom not within MinZoom/MaxZoom".
func narrow(in io.Reader, loArg, hiArg, outPath string) error {
	lo, err1 := strconv.Atoi(strings.TrimSpace(loArg))
	hi, err2 := strconv.Atoi(strings.TrimSpace(hiArg))
	if err1 != nil || err2 != nil {
		return fmt.Errorf("zooms %q %q are not integers", loArg, hiArg)
	}
	h, err := readHeaderJSON(in)
	if err != nil {
		return err
	}
	h.Set("minzoom", pyjson.FromInt(int64(lo)))
	h.Set("maxzoom", pyjson.FromInt(int64(hi)))
	cv, _ := h.Get("center")
	center, ok := cv.([]pyjson.Value)
	if !ok || len(center) < 3 {
		return errors.New(`header JSON has no three-value "center"`)
	}
	cz, ok := pyjson.Number(center[2])
	if !ok {
		return errors.New("center zoom is not a number")
	}
	// min(max(c, lo), hi), keeping c itself when it is already inside.
	v, vf := center[2], cz
	if vf < float64(lo) {
		v, vf = pyjson.FromInt(int64(lo)), float64(lo)
	}
	if vf > float64(hi) {
		v = pyjson.FromInt(int64(hi))
	}
	center[2] = v
	text, err := pyjson.Encode(h, pyjson.Options{EnsureASCII: true})
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, []byte(text), 0o644)
}

func readHeader(f *os.File) ([]byte, error) {
	header := make([]byte, 127)
	n, err := io.ReadFull(f, header)
	// A short or empty file is read as what it holds, as f.read(127) did.
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return header[:n], nil
}

// tileCount prints the number of tiles addressed (u64 at offset 72 of the fixed header,
// spec v3), or "invalid" for anything that is not a PMTiles file, so a truncated download
// can never be read as an empty region.
func tileCount(path string, out io.Writer) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	header, err := readHeader(f)
	if err != nil {
		return err
	}
	if len(header) < 7 || string(header[:7]) != "PMTiles" {
		fmt.Fprintln(out, "invalid")
		return nil
	}
	if len(header) < 80 {
		return errors.New("header too short for its tile count")
	}
	fmt.Fprintln(out, binary.LittleEndian.Uint64(header[72:]))
	return nil
}

// zooms prints "<tile min> <tile max> <header min> <header max>": the lowest and highest
// zoom the archive holds tiles at, read from its directories, then the header's own
// MinZoom and MaxZoom.
func zooms(path string, out io.Writer) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	header, err := readHeader(f)
	if err != nil {
		return err
	}
	if len(header) < 127 || string(header[:7]) != "PMTiles" || header[7] != 3 {
		return errors.New("not a PMTiles v3 archive")
	}
	rootOff := binary.LittleEndian.Uint64(header[8:])
	rootLen := binary.LittleEndian.Uint64(header[16:])
	leafOff := binary.LittleEndian.Uint64(header[40:])
	compression, headerMin, headerMax := header[97], header[100], header[101]
	if compression != 1 && compression != 2 { // none or gzip — all this pipeline's sources use
		return fmt.Errorf("unsupported internal compression %d", compression)
	}
	readDir := func(off, length uint64) ([]entry, error) {
		raw := make([]byte, length)
		if _, err := f.ReadAt(raw, int64(off)); err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if compression == 2 {
			zr, err := gzip.NewReader(bytes.NewReader(raw))
			if err != nil {
				return nil, err
			}
			if raw, err = io.ReadAll(zr); err != nil {
				return nil, err
			}
		}
		return entries(raw)
	}

	lo, hi := -1, -1
	pending := [][2]uint64{{rootOff, rootLen}}
	for len(pending) > 0 {
		d := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		es, err := readDir(d[0], d[1])
		if err != nil {
			return err
		}
		for _, e := range es {
			if e.run == 0 { // a leaf directory, not a tile
				pending = append(pending, [2]uint64{leafOff + e.offset, e.length})
				continue
			}
			first, last := zoomOf(e.tileID), zoomOf(e.tileID+e.run-1)
			if lo < 0 || first < lo {
				lo = first
			}
			if hi < 0 || last > hi {
				hi = last
			}
		}
	}
	if lo < 0 {
		return errors.New("no tiles")
	}
	fmt.Fprintf(out, "%d %d %d %d\n", lo, hi, headerMin, headerMax)
	return nil
}

type entry struct{ tileID, run, offset, length uint64 }

// entries decodes a directory (spec v3): a count, then delta-coded tile ids, run lengths,
// lengths and offsets, each a varint; an offset of 0 after the first entry means
// "straight after the previous entry".
func entries(buf []byte) ([]entry, error) {
	pos := 0
	next := func() (uint64, error) {
		var v uint64
		var shift uint
		for {
			if pos >= len(buf) {
				return 0, errors.New("directory ends inside a varint")
			}
			b := buf[pos]
			pos++
			v |= uint64(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				return v, nil
			}
		}
	}
	n, err := next()
	if err != nil {
		return nil, err
	}
	es := make([]entry, n)
	var id uint64
	for i := range es {
		d, err := next()
		if err != nil {
			return nil, err
		}
		id += d
		es[i].tileID = id
	}
	for i := range es {
		if es[i].run, err = next(); err != nil {
			return nil, err
		}
	}
	for i := range es {
		if es[i].length, err = next(); err != nil {
			return nil, err
		}
	}
	for i := range es {
		v, err := next()
		if err != nil {
			return nil, err
		}
		if v == 0 && i > 0 {
			es[i].offset = es[i-1].offset + es[i-1].length
		} else {
			es[i].offset = v - 1
		}
	}
	return es, nil
}

// zoomOf is the zoom a Hilbert tile id is at: ids are numbered zoom by zoom, 4^z of them
// at zoom z.
func zoomOf(id uint64) int {
	z := 0
	var first uint64
	for id >= first+(1<<(2*z)) {
		first += 1 << (2 * z)
		z++
	}
	return z
}
