// Package infra locates the infra/ directory for the commands that read or write files
// there by fixed path (regions.json, dist/, .cache/, .env). The Python scripts found it
// from their own location; a Go binary is built into a scratch directory, so lib.sh's
// go_run passes it in RATMAP_INFRA_DIR instead.
package infra

import (
	"errors"
	"os"
	"path/filepath"
)

// Dir is infra/, from RATMAP_INFRA_DIR.
func Dir() (string, error) {
	d := os.Getenv("RATMAP_INFRA_DIR")
	if d == "" {
		return "", errors.New("RATMAP_INFRA_DIR is not set — run this through its scripts/*.sh wrapper, or lib.sh's go_run")
	}
	return filepath.Abs(d)
}
