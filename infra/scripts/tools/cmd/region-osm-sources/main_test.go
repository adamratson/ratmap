package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// testdata/*.want.* are the Python's stdout and stderr (testdata/gen-fixtures.sh) on the
// real catalogue, on regions with a missing, empty or null osmExtract and repeated
// extracts, on three extracts (the planet-scale warning), and on none.
func TestMatchesPython(t *testing.T) {
	for _, name := range []string{"real", "mixed", "three", "empty"} {
		var out, errOut bytes.Buffer
		if err := run(filepath.Join("testdata", name+".json"), &out, &errOut); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		wantOut, _ := os.ReadFile(filepath.Join("testdata", name+".want.stdout"))
		wantErr, _ := os.ReadFile(filepath.Join("testdata", name+".want.stderr"))
		if out.String() != string(wantOut) || errOut.String() != string(wantErr) {
			t.Errorf("%s:\n stdout %q\n want   %q\n stderr %q\n want   %q", name, out.String(), wantOut, errOut.String(), wantErr)
		}
	}
}
