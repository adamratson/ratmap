package main

import (
	"bytes"
	"path/filepath"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

// testdata/*.want.* are the stdout and stderr on the real catalogue, on regions with a
// missing, empty or null osmExtract and repeated extracts, on three extracts (the
// planet-scale warning), and on none. -update rewrites them.
func TestGolden(t *testing.T) {
	for _, name := range []string{"real", "mixed", "three", "empty"} {
		var out, errOut bytes.Buffer
		if err := run(filepath.Join("testdata", name+".json"), &out, &errOut); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		golden.Check(t, name+" stdout", out.Bytes(), filepath.Join("testdata", name+".want.stdout"))
		golden.Check(t, name+" stderr", errOut.Bytes(), filepath.Join("testdata", name+".want.stderr"))
	}
}
