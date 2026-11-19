package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSupersededFiles(t *testing.T) {
	dist := t.TempDir()
	write := func(rel string) {
		p := filepath.Join(dist, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range []string{
		// Current names: kept.
		"regions/lakes/lakes-basemap.pmtiles",
		"regions/lakes/lakes-terrain.pmtiles",
		"regions/lakes/lakes-terrain-features.pmtiles",
		"regions/lakes/lakes-contours-1.pmtiles",
		"regions/lakes/lakes-avalanche-2.pmtiles",
		"regions/lakes/lakes-peaks-2.pmtiles",
		"regions/lakes/lakes-places-1.sqlite",
		// Older names of those kinds: superseded.
		"regions/lakes/lakes-contours.pmtiles",
		"regions/lakes/lakes-avalanche-1.pmtiles",
		"regions/lakes/lakes-peaks-1.pmtiles",
		"regions/lakes/lakes-places.sqlite",
		// Not this table's business: kept.
		"regions/lakes/.lakes-contours-1.building.pmtiles",
		"regions/lakes/lakes-contours-1.pmtiles.bak",
		"regions/lakes/lakes-contours-beta.pmtiles",
		"regions/lakes/lakes-hillshade.pmtiles",
		"regions/lakes/notes.txt",
		"regions/manifest.json",
		// A hyphenated region id whose old name looks like a kind of another region.
		"regions/lake-district/lake-district-avalanche-1.pmtiles",
		"regions/lake-district/lake-district-avalanche-2.pmtiles",
		// Global files sit outside regions/: never touched.
		"peaks-global.pmtiles",
	} {
		write(rel)
	}

	got, err := supersededFiles(dist)
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	for _, rel := range []string{
		"regions/lake-district/lake-district-avalanche-1.pmtiles",
		"regions/lakes/lakes-avalanche-1.pmtiles",
		"regions/lakes/lakes-contours.pmtiles",
		"regions/lakes/lakes-peaks-1.pmtiles",
		"regions/lakes/lakes-places.sqlite",
	} {
		want = append(want, filepath.Join(dist, rel))
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("supersededFiles =\n  %v\nwant\n  %v", got, want)
	}
}

func TestSupersededFilesWithoutRegions(t *testing.T) {
	got, err := supersededFiles(t.TempDir())
	if err != nil || got != nil {
		t.Fatalf("got %v, %v; want nothing", got, err)
	}
}
