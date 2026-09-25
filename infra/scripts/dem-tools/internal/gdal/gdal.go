// Package gdal reads and writes rasters through GDAL's command-line tools, the way the
// Python this replaces did: `gdal_translate -of ENVI` for a flat binary array plus a text
// header, and `gdalinfo -json` for the size and geotransform.
//
// Through the CLI rather than cgo bindings for the same reason the Python avoided the
// osgeo bindings: the toolchain image already has gdal-bin, and a static Go binary that
// links nothing is the point of the port.
package gdal

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Info is the part of `gdalinfo -json` both tools use.
type Info struct {
	Width, Height int
	// GDAL's affine geotransform: originX, pixelWidth, rowRotation, originY,
	// columnRotation, pixelHeight (negative for north-up).
	GeoTransform [6]float64
}

// ReadInfo runs `gdalinfo -json` on path.
func ReadInfo(path string) (Info, error) {
	out, err := exec.Command("gdalinfo", "-json", path).Output()
	if err != nil {
		return Info{}, fmt.Errorf("gdalinfo -json %s: %w%s", path, err, stderrOf(err))
	}
	var doc struct {
		Size         []int      `json:"size"`
		GeoTransform *[]float64 `json:"geoTransform"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return Info{}, fmt.Errorf("gdalinfo -json %s: %w", path, err)
	}
	if len(doc.Size) != 2 {
		return Info{}, fmt.Errorf("gdalinfo -json %s: no size", path)
	}
	// Refused rather than defaulted: without a geotransform nothing can say where a pixel
	// is, and the Python raised KeyError here too.
	if doc.GeoTransform == nil || len(*doc.GeoTransform) != 6 {
		return Info{}, fmt.Errorf("gdalinfo -json %s: no geoTransform", path)
	}
	info := Info{Width: doc.Size[0], Height: doc.Size[1]}
	copy(info.GeoTransform[:], *doc.GeoTransform)
	return info, nil
}

// TranslateENVIFloat32 converts src to a flat little-endian float32 array at raw, with
// GDAL's .hdr sidecar beside it.
func TranslateENVIFloat32(src, raw string) error {
	cmd := exec.Command("gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", src, raw)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("gdal_translate %s -> ENVI: %w", src, err)
	}
	return checkLittleEndian(raw)
}

// checkLittleEndian reads GDAL's ENVI header and refuses a big-endian array. The Python
// read the file in native order and never looked; every host this runs on is
// little-endian, so this only ever turns an impossible silent misread into an error.
func checkLittleEndian(raw string) error {
	hdr := strings.TrimSuffix(raw, filepath.Ext(raw)) + ".hdr"
	f, err := os.Open(hdr)
	if err != nil {
		return fmt.Errorf("ENVI header for %s: %w", raw, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, val, ok := strings.Cut(sc.Text(), "=")
		if ok && strings.TrimSpace(key) == "byte order" && strings.TrimSpace(val) != "0" {
			return fmt.Errorf("%s: ENVI byte order %s, expected 0 (little-endian)", hdr, strings.TrimSpace(val))
		}
	}
	return sc.Err()
}

// ReadFloat32 reads a flat little-endian float32 array of exactly w*h values.
func ReadFloat32(raw string, w, h int) ([]float32, error) {
	f, err := os.Open(raw)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	n := w * h
	if st.Size() != int64(n)*4 {
		return nil, fmt.Errorf("%s: %d bytes, expected %d x %d float32 = %d", raw, st.Size(), w, h, int64(n)*4)
	}
	out := make([]float32, n)
	// In chunks, so the file never sits in memory twice: one copy of the raster, as the
	// Python's np.fromfile made.
	buf := make([]byte, 1<<20)
	for i := 0; i < n; {
		want := min(len(buf)/4, n-i)
		if _, err := io.ReadFull(f, buf[:want*4]); err != nil {
			return nil, fmt.Errorf("%s: %w", raw, err)
		}
		for j := 0; j < want; j++ {
			out[i+j] = math.Float32frombits(binary.LittleEndian.Uint32(buf[j*4:]))
		}
		i += want
	}
	return out, nil
}

// RowReader streams a flat float32 ENVI array one row at a time, for rasters too big to
// hold (encode-avalanche works on gigapixel regions).
type RowReader struct {
	f   *os.File
	br  *bufio.Reader
	buf []byte
	W   int
}

func OpenRows(raw string, w, h int) (*RowReader, error) {
	f, err := os.Open(raw)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.Size() != int64(w)*int64(h)*4 {
		f.Close()
		return nil, fmt.Errorf("%s: %d bytes, expected %d x %d float32", raw, st.Size(), w, h)
	}
	return &RowReader{f: f, br: bufio.NewReaderSize(f, 1<<20), buf: make([]byte, w*4), W: w}, nil
}

// Next fills dst (length W) with the next row, widened to float64 exactly.
func (r *RowReader) Next(dst []float64) error {
	if _, err := io.ReadFull(r.br, r.buf); err != nil {
		return err
	}
	for j := range dst {
		dst[j] = float64(math.Float32frombits(binary.LittleEndian.Uint32(r.buf[j*4:])))
	}
	return nil
}

func (r *RowReader) Close() error { return r.f.Close() }

// WriteENVIHeader writes the sidecar GDAL needs to read a flat single-band array. dtype
// is ENVI's code: 1 = byte.
func WriteENVIHeader(raw string, w, h, dtype int) error {
	hdr := strings.TrimSuffix(raw, filepath.Ext(raw)) + ".hdr"
	return os.WriteFile(hdr, []byte(fmt.Sprintf(
		"ENVI\nsamples = %d\nlines = %d\nbands = 1\n"+
			"header offset = 0\nfile type = ENVI Standard\ndata type = %d\n"+
			"interleave = bsq\nbyte order = 0\n", w, h, dtype)), 0o644)
}

func stderrOf(err error) string {
	if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
		return ": " + strings.TrimSpace(string(ee.Stderr))
	}
	return ""
}
