// Command terrarium-dem turns a PMTiles archive of Terrarium-encoded elevation tiles —
// Mapterhorn's — into a raster GDAL can read: one flat float32 array in Web Mercator, and
// a VRT that places it.
//
//	terrarium-dem ARCHIVE.pmtiles ZOOM OUT.vrt
//	terrarium-dem --self-test
//
// ARCHIVE is what `pmtiles extract --bbox ... --minzoom=Z --maxzoom=Z` wrote; every tile
// it holds at ZOOM goes into the raster, at its place in the tile grid. OUT.vrt is a
// mosaic of compressed GeoTIFF strips in OUT.vrt.d/, one per row of tiles; GDAL reads it
// like any other raster, so fetch-dem.sh can warp it onto whatever grid a consumer wants.
//
// Terrarium encodes metres as (R × 256 + G + B / 256) − 32768 — 1/256 m steps, far finer
// than any source. The tiles must therefore be lossless: a lossy WebP would perturb the
// low bits into noise, and a high-byte error is hundreds of metres. Mapterhorn's are
// lossless (VP8L); a lossy tile (VP8) fails the run rather than being decoded.
//
// A tile the archive does not hold is sea level. Mapterhorn publishes no tile where there
// is no land — open North Sea at z11, sampled 2026-11-18 — just as GLO-30 publishes no
// cell there and fetch-dem.sh's mosaic reads those as 0. It cannot be a hole from a
// failed download: `pmtiles extract` either writes the whole extract or fails.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/image/webp"

	"ratmap/infra/tools/internal/pmtiles"
)

const usage = `usage: terrarium-dem ARCHIVE.pmtiles ZOOM OUT.vrt
       terrarium-dem --self-test`

// What a tile the archive does not hold reads as: sea level (see the package comment).
const absent = 0

// Half the Web Mercator world's width, metres (EPSG:3857).
const originShift = 20037508.342789244

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(); err != nil {
			fmt.Fprintln(os.Stderr, "FAIL:", err)
			os.Exit(1)
		}
		fmt.Println("terrarium-dem self-test: OK")
		return
	}
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	z, err := strconv.Atoi(os.Args[2])
	if err != nil || z < 0 || z > 22 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err := run(os.Args[1], z, os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, "terrarium-dem:", err)
		os.Exit(1)
	}
}

type tileRef struct {
	x, y uint32
	data []byte
}

func run(archivePath string, z int, outVRT string) error {
	a, err := pmtiles.Open(archivePath)
	if err != nil {
		return err
	}
	defer a.Close()
	if a.Header.TileType != pmtiles.TileTypeWebP {
		return fmt.Errorf("%s: tiles are type %d, not WebP", archivePath, a.Header.TileType)
	}
	if a.Header.TileCompression != 1 && a.Header.TileCompression != 0 {
		return fmt.Errorf("%s: tile compression %d; a raster tile should be stored as it is", archivePath, a.Header.TileCompression)
	}

	// One pass for the extent and the tiles. Blobs are shared between the tiles of a run,
	// so holding them is the archive's own size, not the raster's.
	rows := map[uint32][]tileRef{}
	minX, minY, maxX, maxY := uint32(math.MaxUint32), uint32(math.MaxUint32), uint32(0), uint32(0)
	count := 0
	err = a.Each(z, func(x, y uint32, data []byte) error {
		rows[y] = append(rows[y], tileRef{x, y, data})
		minX, maxX = min(minX, x), max(maxX, x)
		minY, maxY = min(minY, y), max(maxY, y)
		count++
		return nil
	})
	if err != nil {
		return err
	}
	if count == 0 {
		return fmt.Errorf("%s: no tiles at zoom %d", archivePath, z)
	}

	// The tile size, from the first tile: Mapterhorn's are 512, and every tile must match.
	var size int
	for _, refs := range rows {
		img, err := decode(refs[0].data)
		if err != nil {
			return fmt.Errorf("tile %d/%d/%d: %w", z, refs[0].x, refs[0].y, err)
		}
		size = img.Bounds().Dx()
		break
	}

	cols := int(maxX-minX) + 1
	width := cols * size

	// The grid's place in EPSG:3857: tile (x, y) at zoom z spans world/2^z metres from the
	// north-west corner of the world.
	tileM := 2 * originShift / float64(uint64(1)<<z)
	pixel := tileM / float64(size)
	west := -originShift + float64(minX)*tileM

	// A row of tiles at a time, each written out as its own compressed GeoTIFF strip and
	// mosaicked by a VRT. Decoded in parallel within a row. Not one flat array: Vestlandet's
	// bbox at z11 is ~4 GB of float32 and Sweden's over 10, where its strips compressed are
	// a fraction of that (sea, all one value, to almost nothing). The next row decodes while
	// GDAL compresses the last.
	dir := outVRT + ".d"
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var strips []string
	empty := 0
	bands := [2][]float32{make([]float32, width*size), make([]float32, width*size)}
	done := make(chan error, 1)
	done <- nil
	for i, ty := 0, minY; ty <= maxY; i, ty = i+1, ty+1 {
		band := bands[i%2]
		for k := range band {
			band[k] = absent
		}
		if err := decodeRow(rows[ty], minX, size, width, band); err != nil {
			return fmt.Errorf("row %d: %w", ty, err)
		}
		empty += cols - len(rows[ty])
		// The previous strip must be written before this band's twin is reused.
		if err := <-done; err != nil {
			return err
		}
		base := filepath.Join(dir, fmt.Sprintf("strip-%06d", i))
		north := originShift - float64(ty)*tileM
		if err := writeRaw(base, band, width, size, west, north, pixel); err != nil {
			return err
		}
		strips = append(strips, base+".tif")
		go func() { done <- compress(base) }()
	}
	if err := <-done; err != nil {
		return err
	}

	list := filepath.Join(dir, "strips.txt")
	if err := os.WriteFile(list, []byte(strings.Join(strips, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	if out, err := exec.Command("gdalbuildvrt", "-q", "-overwrite", "-input_file_list", list, outVRT).CombinedOutput(); err != nil {
		return fmt.Errorf("gdalbuildvrt: %w: %s", err, out)
	}
	fmt.Fprintf(os.Stderr, "  terrarium z%d: %d tiles (%d x %d px, %.1f m a pixel at the equator), %d of the grid's %d not in the archive (sea)\n",
		z, count, width, len(strips)*size, pixel, empty, cols*len(strips))
	return nil
}

// writeRaw writes one strip as a flat float32 array and a VRT placing it.
func writeRaw(base string, band []float32, width, size int, west, north, pixel float64) error {
	f, err := os.Create(base + ".raw")
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<22)
	if err := binary.Write(w, binary.LittleEndian, band); err != nil {
		f.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	vrt := fmt.Sprintf(`<VRTDataset rasterXSize="%d" rasterYSize="%d">
  <SRS dataAxisToSRSAxisMapping="1,2">EPSG:3857</SRS>
  <GeoTransform>%s, %s, 0, %s, 0, %s</GeoTransform>
  <VRTRasterBand dataType="Float32" band="1" subClass="VRTRawRasterBand">
    <SourceFilename relativeToVRT="1">%s</SourceFilename>
    <ImageOffset>0</ImageOffset>
    <PixelOffset>4</PixelOffset>
    <LineOffset>%d</LineOffset>
    <ByteOrder>LSB</ByteOrder>
  </VRTRasterBand>
</VRTDataset>
`, width, size, g(west), g(pixel), g(north), g(-pixel), filepath.Base(base)+".raw", width*4)
	return os.WriteFile(base+".raw.vrt", []byte(vrt), 0o644)
}

// compress turns a raw strip into a compressed GeoTIFF and removes the raw one. DEFLATE
// with the floating-point predictor, as fetch-dem.sh writes its DEMs.
func compress(base string) error {
	out, err := exec.Command("gdal_translate", "-q", "-of", "GTiff",
		"-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", "-co", "NUM_THREADS=ALL_CPUS",
		base+".raw.vrt", base+".tif").CombinedOutput()
	if err != nil {
		return fmt.Errorf("gdal_translate %s: %w: %s", filepath.Base(base), err, out)
	}
	if err := os.Remove(base + ".raw"); err != nil {
		return err
	}
	return os.Remove(base + ".raw.vrt")
}

func g(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

func decodeRow(refs []tileRef, minX uint32, size, width int, band []float32) error {
	var wg sync.WaitGroup
	errs := make(chan error, len(refs))
	sem := make(chan struct{}, runtime.GOMAXPROCS(0))
	for _, r := range refs {
		wg.Add(1)
		sem <- struct{}{}
		go func(r tileRef) {
			defer wg.Done()
			defer func() { <-sem }()
			img, err := decode(r.data)
			if err != nil {
				errs <- fmt.Errorf("tile x=%d: %w", r.x, err)
				return
			}
			if b := img.Bounds(); b.Dx() != size || b.Dy() != size {
				errs <- fmt.Errorf("tile x=%d is %dx%d, not %d", r.x, b.Dx(), b.Dy(), size)
				return
			}
			x0 := int(r.x-minX) * size
			fill(img, band[x0:], width, size)
		}(r)
	}
	wg.Wait()
	close(errs)
	return <-errs
}

// fill writes img's elevations into dst, a band `stride` floats wide.
func fill(img image.Image, dst []float32, stride, size int) {
	b := img.Bounds()
	if n, ok := img.(*image.NRGBA); ok {
		for py := 0; py < size; py++ {
			row := n.Pix[py*n.Stride:]
			out := dst[py*stride:]
			for px := 0; px < size; px++ {
				out[px] = float32(Elevation(row[4*px], row[4*px+1], row[4*px+2]))
			}
		}
		return
	}
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			c := color.NRGBAModel.Convert(img.At(b.Min.X+px, b.Min.Y+py)).(color.NRGBA)
			dst[py*stride+px] = float32(Elevation(c.R, c.G, c.B))
		}
	}
}

// Elevation decodes one Terrarium pixel, metres.
func Elevation(r, g, b uint8) float64 {
	return float64(r)*256 + float64(g) + float64(b)/256 - 32768
}

// decode decodes one lossless WebP tile, refusing a lossy one (see the package comment).
func decode(data []byte) (image.Image, error) {
	// RIFF....WEBP then the first chunk: VP8L is lossless; VP8 is lossy; VP8X is the
	// extended format, which wraps either — look for the image chunk inside it.
	if len(data) < 16 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil, errors.New("not a WebP")
	}
	if !bytes.Contains(data[12:min(len(data), 64)], []byte("VP8L")) {
		return nil, errors.New("lossy WebP: Terrarium elevations need lossless tiles")
	}
	return webp.Decode(bytes.NewReader(data))
}

func selfTest() error {
	cases := []struct {
		r, g, b uint8
		want    float64
	}{
		{128, 0, 0, 0},         // sea level
		{131, 210, 128, 978.5}, // Scafell Pike-ish: 3*256 + 210 + 0.5
		{127, 255, 0, -1},      // a metre below
		{0, 0, 0, -32768},      // the floor
		{133, 64, 64, 1344.25}, // Ben Nevis-ish
	}
	for _, c := range cases {
		if got := Elevation(c.r, c.g, c.b); got != c.want {
			return fmt.Errorf("Elevation(%d,%d,%d) = %v, want %v", c.r, c.g, c.b, got, c.want)
		}
	}
	for _, id := range []uint64{0, 1, 4, 5, 20, 21, 12345, 5592404, 22369621} {
		z, x, y := pmtiles.ZXY(id)
		if back := pmtiles.TileID(z, x, y); back != id {
			return fmt.Errorf("tile id %d -> %d/%d/%d -> %d", id, z, x, y, back)
		}
	}
	return nil
}
