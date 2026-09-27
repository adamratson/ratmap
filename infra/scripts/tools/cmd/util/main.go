// Command util holds small helpers for the shell scripts.
//
//	util subset-key SRC UNION     # lib.sh osm_subset: the cache key of a shared OSM subset
//	util url-quote TEXT           # vendor-assets.sh: TEXT percent-encoded for a URL path
//	util dem-tiles W S E N        # fetch-dem.sh: the Copernicus GLO-30 tiles covering a bbox
//
// subset-key names cached subsets: changing how it is built orphans every one already
// built, so it changes only deliberately.
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

// subsetKey is "<sha1 of the filter union, spaces collapsed, 12 hex>-<size>-<mtime in
// whole seconds>": any change to the filters or the source extract makes a new key, so a
// stale subset is never used.
func subsetKey(src, union string) (string, error) {
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	sum := sha1.Sum([]byte(strings.Join(strings.Fields(union), " ")))
	return fmt.Sprintf("%s-%d-%d", hex.EncodeToString(sum[:])[:12], st.Size(), st.ModTime().Unix()), nil
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
