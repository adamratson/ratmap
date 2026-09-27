package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each check as upload.sh calls it: bucket listings that are
// partial, complete, empty, null and not JSON (where only the exit status is compared:
// upload.sh only prints the parser's message before falling back to uploading
// everything); published manifests plain and gzipped, with a region dropped; served
// manifests with keys reordered, 1 written as 1.0 (the same) and as true (not), a changed
// value, and no, the wrong, or a later Content-Encoding. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }
