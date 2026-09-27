// Command region-osm-sources prints the deduplicated OSM extracts covering every defined
// region, one per line.
//
// Run by the build scripts through lib.sh's go_run.
//
// peaks-global.pmtiles and places.sqlite are single global artifacts, but they have to
// cover whatever regions the catalogue publishes. Deriving their inputs from regions.json
// instead of a hardcoded default means adding a region can't silently ship a map with no
// summits and no search results — which is exactly what happened when Montenegro was
// added while both artifacts were still Scotland-only.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"ratmap/infra/tools/internal/infra"
)

func main() {
	dir, err := infra.Dir()
	if err == nil {
		err = run(filepath.Join(dir, "regions.json"), os.Stdout, os.Stderr)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "region-osm-sources:", err)
		os.Exit(1)
	}
}

func run(regionsJSON string, out, errOut io.Writer) error {
	data, err := os.ReadFile(regionsJSON)
	if err != nil {
		return err
	}
	var doc struct {
		Regions []struct {
			ID         string `json:"id"`
			OSMExtract string `json:"osmExtract"`
		} `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("%s: %w", regionsJSON, err)
	}
	if doc.Regions == nil {
		return fmt.Errorf(`%s: no "regions" list`, regionsJSON)
	}

	var seen []string
	for _, r := range doc.Regions {
		if r.OSMExtract == "" {
			fmt.Fprintf(errOut, "! %s has no osmExtract — its peaks/search will be missing\n", r.ID)
			continue
		}
		if !slices.Contains(seen, r.OSMExtract) {
			seen = append(seen, r.OSMExtract)
		}
	}

	// Once the catalogue is global its regions point at continent extracts, and this union
	// is Geofabrik's whole planet — 85 GB of source and days of processing. That is the
	// correct input for a global peaks/places build and a very expensive accident on a
	// laptop, so say which it is going to be before the first byte moves.
	if len(seen) > 2 {
		fmt.Fprintf(errOut, "! %d source extracts — this is a continental or planet-scale build.\n"+
			"  Expect tens of GB of downloads and hours to days of processing.\n"+
			"  Override with PEAKS_SOURCE_URLS / PLACES_SOURCE_URLS for a smaller run.\n", len(seen))
	}
	fmt.Fprintln(out, strings.Join(seen, "\n"))
	return nil
}
