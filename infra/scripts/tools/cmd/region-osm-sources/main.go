// Command region-osm-sources prints the deduplicated OSM extracts covering every defined
// region, one per line.
//
// A port of scripts/region-osm-sources.py, which it replaces in the build scripts (run
// through lib.sh's go_run): same output, same warnings.
//
// peaks-global.pmtiles and places.sqlite are single global artifacts, but they have to
// cover whatever regions the catalogue publishes. Deriving their inputs from regions.json
// instead of a hardcoded default means adding a region can't silently ship a map with no
// summits and no search results — which is exactly what happened when Montenegro was
// added while both artifacts were still Scotland-only.
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"ratmap/infra/tools/internal/infra"
	"ratmap/infra/tools/internal/pyjson"
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
	doc, err := pyjson.Decode(data)
	if err != nil {
		return fmt.Errorf("%s: %w", regionsJSON, err)
	}
	top, ok := doc.(*pyjson.Object)
	if !ok {
		return fmt.Errorf("%s: not an object", regionsJSON)
	}
	rv, _ := top.Get("regions")
	regions, ok := rv.([]pyjson.Value)
	if !ok {
		return fmt.Errorf(`%s: no "regions" list`, regionsJSON)
	}

	var seen []string
	for _, r := range regions {
		region, ok := r.(*pyjson.Object)
		if !ok {
			return fmt.Errorf("%s: a region is not an object", regionsJSON)
		}
		url, _ := region.Get("osmExtract")
		if falsy(url) {
			id, ok := region.Get("id")
			if !ok {
				return fmt.Errorf("%s: a region has neither osmExtract nor id", regionsJSON)
			}
			ids, _ := pyjson.Encode(id, pyjson.Options{})
			if s, isStr := id.(string); isStr {
				ids = s
			}
			fmt.Fprintf(errOut, "! %s has no osmExtract — its peaks/search will be missing\n", ids)
			continue
		}
		s, ok := url.(string)
		if !ok {
			// "\n".join() of a non-string raised TypeError.
			return fmt.Errorf("%s: osmExtract %v is not a string", regionsJSON, url)
		}
		dup := false
		for _, u := range seen {
			if u == s {
				dup = true
				break
			}
		}
		if !dup {
			seen = append(seen, s)
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

// falsy is Python's truth test: None, False, 0, 0.0, "" and empty containers.
func falsy(v pyjson.Value) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case string:
		return t == ""
	case pyjson.Int:
		return t == "0"
	case float64:
		return t == 0
	case []pyjson.Value:
		return len(t) == 0
	case *pyjson.Object:
		return len(t.Keys) == 0
	}
	return false
}
