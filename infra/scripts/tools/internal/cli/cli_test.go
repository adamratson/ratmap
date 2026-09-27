package cli

import (
	"flag"
	"reflect"
	"testing"
)

func TestParseInterleaved(t *testing.T) {
	for _, c := range []struct {
		args []string
		pos  []string
		zmax int
		webp bool
	}{
		{[]string{"dem.tif", "out", "--zmax", "11"}, []string{"dem.tif", "out"}, 11, false},
		{[]string{"--zmax=11", "dem.tif", "--webp", "out"}, []string{"dem.tif", "out"}, 11, true},
		{[]string{"-zmax", "11", "--", "--webp", "x"}, []string{"--webp", "x"}, 11, false},
		{nil, nil, 0, false},
	} {
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		zmax := fs.Int("zmax", 0, "")
		webp := fs.Bool("webp", false, "")
		pos := Parse(fs, "usage: t", c.args)
		if !reflect.DeepEqual(pos, c.pos) || *zmax != c.zmax || *webp != c.webp {
			t.Errorf("%q: positionals %q, zmax %d, webp %v", c.args, pos, *zmax, *webp)
		}
		if given := Given(fs); given["zmax"] != (c.zmax != 0) {
			t.Errorf("%q: given %v", c.args, given)
		}
	}
}
