// Command util holds the small helpers the shell scripts used Python for.
//
//	util subset-key SRC UNION     # lib.sh osm_subset: the cache key of a shared OSM subset
//	util url-quote TEXT           # vendor-assets.sh: urllib.parse.quote(TEXT)
//	util dem-tiles W S E N        # fetch-dem.sh: the Copernicus GLO-30 tiles covering a bbox
//
// Ports of the Python snippets those scripts carried inline, printing what they printed.
// subset-key in particular has to: it names cached subsets, and a different key would
// orphan every one already built.
package main

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/pytext"
)

const usage = `usage: util subset-key SRC UNION
       util url-quote TEXT
       util dem-tiles WEST SOUTH EAST NORTH`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		if err == errUsage {
			fmt.Fprintln(os.Stderr, usage)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "util:", err)
		os.Exit(1)
	}
}

var errUsage = fmt.Errorf("usage")

func run(args []string, out io.Writer) error {
	switch {
	case len(args) == 3 && args[0] == "subset-key":
		key, err := subsetKey(args[1], args[2])
		if err != nil {
			return err
		}
		fmt.Fprintln(out, key)
		return nil
	case len(args) == 2 && args[0] == "url-quote":
		fmt.Fprintln(out, urlQuote(args[1]))
		return nil
	case len(args) == 5 && args[0] == "dem-tiles":
		return demTiles(args[1:], out)
	}
	return errUsage
}

// subsetKey is "<sha1 of the normalised filter union, 12 hex>-<size>-<mtime>": any change
// to the filters or the source extract makes a new key, so a stale subset is never used.
// The mtime is int(os.stat().st_mtime): CPython's st_mtime is sec + nsec*1e-9 as a double,
// which can round a time just short of a whole second up to it, so this does the same
// arithmetic rather than taking the seconds field.
func subsetKey(src, union string) (string, error) {
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	sum := sha1.Sum([]byte(strings.Join(strings.FieldsFunc(union, pytext.IsSpace), " ")))
	mt := st.ModTime()
	sec, nsec := mt.Unix(), mt.Nanosecond()
	mtime := float64(sec) + float64(float64(nsec)*1e-9)
	return fmt.Sprintf("%s-%d-%d", hex.EncodeToString(sum[:])[:12], st.Size(), int64(mtime)), nil
}

// urlQuote is urllib.parse.quote with its default safe="/": letters, digits, "_.-~" and
// "/" as themselves, every other byte of the UTF-8 text as %XX.
func urlQuote(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.IndexByte("_.-~/", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// demTiles prints one Copernicus GLO-30 COG URL per 1-degree cell the bbox touches.
func demTiles(args []string, out io.Writer) error {
	v := make([]float64, 4)
	for i, a := range args {
		f, err := strconv.ParseFloat(strings.TrimSpace(a), 64)
		if err != nil {
			return fmt.Errorf("%q is not a number", a)
		}
		v[i] = f
	}
	west, south, east, north := v[0], v[1], v[2], v[3]
	const base = "https://copernicus-dem-30m.s3.amazonaws.com"
	for lat := int(math.Floor(south)); lat < int(math.Ceil(north)); lat++ {
		for lon := int(math.Floor(west)); lon < int(math.Ceil(east)); lon++ {
			ns, ew := "N", "E"
			if lat < 0 {
				ns = "S"
			}
			if lon < 0 {
				ew = "W"
			}
			name := fmt.Sprintf("Copernicus_DSM_COG_10_%s%02d_00_%s%03d_00_DEM", ns, abs(lat), ew, abs(lon))
			fmt.Fprintf(out, "%s/%s/%s.tif\n", base, name, name)
		}
	}
	return nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
