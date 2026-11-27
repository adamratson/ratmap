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
// value, and no, the wrong, or a later Content-Encoding. And prune-bucket.sh's: a history
// whose chain reaches back past the window (one file deletable, one waiting on a manifest
// replaced inside it, one on its own upload), the same a week later, a chain broken by a
// manifest replaced without being kept, a live manifest that changed after the listing,
// a history file not fetched, a listing without ages, a manifest listing nothing, a listing to the millisecond
// with unquoted ETags (rclone's serve s3) against get-object's seconds and quotes, and
// what upload.sh keeps a replaced manifest as. -update rewrites the goldens.
func TestGolden(t *testing.T) { golden.Run(t) }
