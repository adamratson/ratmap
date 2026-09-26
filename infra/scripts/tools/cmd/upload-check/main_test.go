package main

import (
	"testing"

	"ratmap/infra/tools/internal/golden"
)

func TestMain(m *testing.M) { golden.Main(m, main) }

// testdata/cases.tsv runs each check against the Python upload.sh carried
// (testdata/*.py): bucket listings that are partial, complete, empty, null and not JSON
// (where only the exit status is compared: the Python's message quoted its own parser's
// error, and upload.sh only prints it before falling back to uploading everything);
// published manifests plain and gzipped, with a region dropped; served manifests with
// keys reordered, 1 as 1.0 and true, a changed value, and no, the wrong, or a later
// Content-Encoding. Regenerate with ../../internal/golden/gen-fixtures.sh.
func TestMatchesPython(t *testing.T) { golden.Run(t) }
