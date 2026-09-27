package main

import (
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const half = 20037508.342789244 // EPSG:3857's half width

// testRaster writes a 512x512 three-band Byte GeoTIFF exactly covering one z10 tile, with
// a pattern in each band (slope, aspect, zero), and returns its path.
func testRaster(t *testing.T, dir string) string {
	t.Helper()
	for _, tool := range []string{"gdal_translate", "gdalinfo"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not on PATH")
		}
	}
	const n = 512
	raw := make([]byte, 0, 3*n*n)
	for band := 0; band < 3; band++ {
		for i := 0; i < n*n; i++ {
			switch band {
			case 0:
				raw = append(raw, byte(25+(i*7)%36))
			case 1:
				raw = append(raw, byte(1+(i/n)%8))
			default:
				raw = append(raw, 0)
			}
		}
	}
	img := filepath.Join(dir, "rgb.img")
	os.WriteFile(img, raw, 0o644)
	os.WriteFile(filepath.Join(dir, "rgb.hdr"), []byte(fmt.Sprintf(
		"ENVI\nsamples = %d\nlines = %d\nbands = 3\nheader offset = 0\nfile type = ENVI Standard\n"+
			"data type = 1\ninterleave = bsq\nbyte order = 0\n", n, n)), 0o644)
	tileSize := 2 * half / 1024
	x0, y0 := -half+500*tileSize, half-300*tileSize // tile (500, 300) at z10
	tif := filepath.Join(dir, "rgb.tif")
	cmd := exec.Command("gdal_translate", "-q", "-a_srs", "EPSG:3857", "-a_ullr",
		fmt.Sprint(x0), fmt.Sprint(y0), fmt.Sprint(x0+tileSize), fmt.Sprint(y0-tileSize), img, tif)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gdal_translate: %v\n%s", err, out)
	}
	return tif
}

func readMBTiles(t *testing.T, path string) (map[string]string, []tile) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	meta := map[string]string{}
	rows, _ := db.Query("SELECT name, value FROM metadata")
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		meta[k] = v
	}
	rows.Close()
	_, tiles, err := levelTiles(path)
	if err != nil {
		t.Fatal(err)
	}
	return meta, tiles
}

func TestAssemblePNGAndWebP(t *testing.T) {
	dir := t.TempDir()
	tif := testRaster(t, dir)

	png := filepath.Join(dir, "png.mbtiles")
	if err := run(png, "test png", "-1.5,50.25,-1.25,50.5", false, 0, []string{"10:" + tif}); err != nil {
		t.Fatal(err)
	}
	meta, tiles := readMBTiles(t, png)
	want := map[string]string{
		"name": "test png", "format": "png", "type": "overlay", "version": "1",
		"description": "ratmap avalanche terrain (slope, aspect)",
		"bounds":      "-1.500000,50.250000,-1.250000,50.500000", "minzoom": "10", "maxzoom": "10",
	}
	for k, v := range want {
		if meta[k] != v {
			t.Errorf("metadata %s = %q, want %q", k, meta[k], v)
		}
	}
	if len(tiles) != 1 || tiles[0].z != 10 || tiles[0].x != 500 || tiles[0].y != 1023-300 {
		t.Fatalf("tiles: %+v", tiles)
	}

	if _, err := exec.LookPath("cwebp"); err != nil {
		t.Skip("cwebp not on PATH")
	}
	webp := filepath.Join(dir, "webp.mbtiles")
	if err := run(webp, "test webp", "-1.5,50.25,-1.25,50.5", true, 2, []string{"10:" + tif}); err != nil {
		t.Fatal(err)
	}
	meta, wtiles := readMBTiles(t, webp)
	if meta["format"] != "webp" || len(wtiles) != 1 || !strings.HasPrefix(string(wtiles[0].data[8:12]), "WEBP") {
		t.Fatalf("webp: format %q, %d tiles", meta["format"], len(wtiles))
	}
	// And the WebP tile decodes to the PNG tile's pixels — the property the pass proves.
	a, _ := os.CreateTemp(dir, "*.png")
	a.Write(tiles[0].data)
	a.Close()
	b, _ := os.CreateTemp(dir, "*.webp")
	b.Write(wtiles[0].data)
	b.Close()
	ra, err1 := decodeToRaw(a.Name(), dir, 90)
	rb, err2 := decodeToRaw(b.Name(), dir, 91)
	if err1 != nil || err2 != nil || string(ra) != string(rb) {
		t.Fatal("the WebP tile does not decode to the PNG tile's pixels")
	}
}

// A raster whose resolution is not its declared zoom's must be refused, not stacked onto
// the wrong level.
func TestZoomMismatchRefused(t *testing.T) {
	dir := t.TempDir()
	tif := testRaster(t, dir)
	err := run(filepath.Join(dir, "out.mbtiles"), "x", "0,0,1,1", false, 0, []string{"11:" + tif})
	var fail errFail
	if !errors.As(err, &fail) || fail.msg != "FAIL: raster for z11 tiled as [10]; resolution and tile grid disagree" {
		t.Fatalf("got %v", err)
	}
}

// A cwebp that returns different pixels must fail the pass: the proof is the point.
func TestWebPProofCatchesADifferentImage(t *testing.T) {
	real, err := exec.LookPath("cwebp")
	if err != nil {
		t.Skip("cwebp not on PATH")
	}
	dir := t.TempDir()
	tif := testRaster(t, dir)
	// A cwebp that flips one byte of the image before encoding it losslessly.
	shimDir := filepath.Join(dir, "shim")
	os.Mkdir(shimDir, 0o755)
	flipped := filepath.Join(dir, "flipped.png")
	os.WriteFile(filepath.Join(shimDir, "cwebp"), []byte(fmt.Sprintf(`#!/bin/sh
in="$6"; out="$8"
gdal_translate -q -of PNG -scale 0 255 1 255 "$in" %q >/dev/null 2>&1
exec %q -quiet -lossless -exact %q -o "$out"
`, flipped, real, flipped)), 0o755)
	t.Setenv("PATH", shimDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	err = run(filepath.Join(dir, "out.mbtiles"), "x", "0,0,1,1", true, 1, []string{"10:" + tif})
	var fail errFail
	if !errors.As(err, &fail) || !strings.Contains(fail.msg, "does not decode identically") {
		t.Fatalf("got %v", err)
	}
}

func TestIntList(t *testing.T) {
	if intList([]int64{10}) != "[10]" || intList([]int64{10, 11}) != "[10, 11]" || intList(nil) != "[]" {
		t.Fatal("intList")
	}
	_ = binary.LittleEndian
}
