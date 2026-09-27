package main

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/vectors.json is the building blocks' answers on real Geofabrik features and on
// made-up inputs, checked one by one. It was written by the Python this replaced, and
// differs in one place: "İstanbul" is now the id "istanbul", where Python's lower-casing
// of the dotted capital I made it "i-stanbul".
type vectors struct {
	RegionBoxes map[string][][4]float64 `json:"region_boxes"`
	CleanName   [][2]json.RawMessage    `json:"clean_name"`
	SafeID      [][2]string             `json:"safe_id"`
	CellLabel   []struct {
		Box   [4]float64
		Label [2]string
	} `json:"-"`
	CellLabelRaw    [][2]json.RawMessage `json:"cell_label"`
	CompassLabelRaw [][3]json.RawMessage `json:"compass_label"`
	ParseSize       [][2]json.RawMessage `json:"parse_size"`
}

func load(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRegionBoxes(t *testing.T) {
	v := load(t)
	data, _ := os.ReadFile("testdata/features.json")
	var features []*feature
	if err := json.Unmarshal(data, &features); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, f := range features {
		id := f.Properties.ID
		got, err := regionBoxes(f)
		if err != nil {
			t.Fatal(err)
		}
		want := v.RegionBoxes[id]
		if len(got) != len(want) {
			t.Errorf("%s: %v, want %v", id, got, want)
			continue
		}
		for i := range want {
			if box(want[i]) != got[i] {
				t.Errorf("%s box %d: %v, want %v", id, i, got[i], want[i])
			}
		}
		n++
	}
	if n != 15 {
		t.Fatalf("%d features checked", n)
	}
}

func TestCleanNameAndSafeID(t *testing.T) {
	v := load(t)
	for _, c := range v.CleanName {
		var p featureProps
		if err := json.Unmarshal(c[0], &p); err != nil {
			t.Fatal(err)
		}
		var want string
		json.Unmarshal(c[1], &want)
		if got := cleanName(&p); got != want {
			t.Errorf("clean_name(%s) = %q, want %q", c[0], got, want)
		}
	}
	for _, c := range v.SafeID {
		if got := safeID(c[0]); got != c[1] {
			t.Errorf("safe_id(%q) = %q, want %q", c[0], got, c[1])
		}
	}
	if len(v.CleanName) < 500 || len(v.SafeID) < 500 {
		t.Fatal("vectors missing")
	}
}

func TestLabels(t *testing.T) {
	v := load(t)
	for _, c := range v.CellLabelRaw {
		var b [4]float64
		var want [2]string
		json.Unmarshal(c[0], &b)
		json.Unmarshal(c[1], &want)
		name, suffix := cellLabel(box(b))
		if name != want[0] || suffix != want[1] {
			t.Errorf("cell_label(%v) = %q %q, want %q", b, name, suffix, want)
		}
	}
	for _, c := range v.CompassLabelRaw {
		var b, p [4]float64
		var want [2]string
		json.Unmarshal(c[0], &b)
		json.Unmarshal(c[1], &p)
		json.Unmarshal(c[2], &want)
		name, suffix := compassLabel(box(b), box(p))
		if name != want[0] || suffix != want[1] {
			t.Errorf("compass_label(%v, %v) = %q %q, want %q", b, p, name, suffix, want)
		}
	}
}

func TestParseSize(t *testing.T) {
	v := load(t)
	for _, c := range v.ParseSize {
		var text string
		json.Unmarshal(c[0], &text)
		got, ok := parseSize(text)
		want := string(c[1])
		if (want == "null") == ok || (ok && want != jsonInt(got)) {
			t.Errorf("parse_size(%q) = %d %v, want %s", text, got, ok, want)
		}
	}
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

// The estimate cache's keys must not change spelling, or every cached measurement is
// taken again: each coordinate to six significant digits, %g.
func TestEstimateKey(t *testing.T) {
	got := key(request{basemapSource, box{-7.5247, 35.70641234, 180, -0.000012345}, 15})
	if got != "basemap|-7.5247,35.7064,180,-1.2345e-05|z15" {
		t.Fatalf("got %q", got)
	}
	if key(request{terrainSource, box{1, 2, 3, 4}, 11}) != "terrain|1,2,3,4|z11" {
		t.Fatal("terrain key")
	}
}
