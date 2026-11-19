package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// supersededFiles lists the region files under distDir/regions that an older build named
// and the current one no longer does: `<id>-contours.pmtiles` once contours are
// `-contours-1`, `<id>-avalanche-1.pmtiles` once avalanche is `-2`. A rebuild under a new
// name (artifactKinds says why names change) writes beside the old file and never removes
// it, so without this every bump leaves a second copy of the kind on disk for good.
//
// They are dead weight locally and nowhere else. This scan skips them as unrecognised,
// so they were never going into a manifest again; upload.sh never deletes from the
// bucket, so the copy the live catalogue points at stays where it is.
//
// A file counts only when it is the name of a kind in artifactKinds with a different
// version, or none: `<id><stem>.<ext>` or `<id><stem>-<digits>.<ext>`, where the kind's
// current suffix is `<stem>[-<digits>].<ext>`, and it is not itself any kind's current
// name. So `<id>-terrain-features.pmtiles` is never taken for an old `-terrain`, and a
// file this table has no kind for at all is left alone — dotted leftovers of a killed
// copy included, which prune-caches.sh handles by age.
func supersededFiles(distDir string) ([]string, error) {
	regionsDir := filepath.Join(distDir, "regions")
	dirs, err := os.ReadDir(regionsDir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		id := d.Name()
		files, err := os.ReadDir(filepath.Join(regionsDir, id))
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if f.Type().IsRegular() && isSuperseded(id, f.Name()) {
				out = append(out, filepath.Join(regionsDir, id, f.Name()))
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

func isSuperseded(id, name string) bool {
	if artifactKind(name) != "" {
		return false
	}
	rest, ok := strings.CutPrefix(name, id)
	if !ok {
		return false
	}
	for _, k := range artifactKinds {
		ext := filepath.Ext(k.suffix)
		stem := unversioned(strings.TrimSuffix(k.suffix, ext))
		got, ok := strings.CutSuffix(rest, ext)
		if !ok {
			continue
		}
		if unversioned(got) == stem {
			return true
		}
	}
	return false
}

// unversioned strips a trailing "-<digits>": "-contours-1" → "-contours".
func unversioned(stem string) string {
	i := strings.LastIndexByte(stem, '-')
	if i < 0 || i == len(stem)-1 {
		return stem
	}
	for _, c := range stem[i+1:] {
		if c < '0' || c > '9' {
			return stem
		}
	}
	return stem[:i]
}
