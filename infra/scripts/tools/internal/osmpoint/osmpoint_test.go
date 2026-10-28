package osmpoint

import (
	"encoding/json"
	"math"
	"testing"
)

func TestRepresent(t *testing.T) {
	cases := []struct {
		name, geometry, point string
		areaM2                float64
	}{
		{"a point as written", `{"type": "Point", "coordinates": [-3.1, 54.5]}`, "[-3.1, 54.5]", 0},
		// 0.001 x 0.001 degrees at the equator: 111.2 m square.
		{"a square at its centre", `{"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]}`,
			"[0.0005,0.0005]", 12364},
		// The same square at 60 N covers half the ground.
		{"an area shrunk by latitude", `{"type": "Polygon", "coordinates": [[[0, 60], [0.001, 60], [0.001, 60.001], [0, 60.001], [0, 60]]]}`,
			"[0.0005,60.0005]", 6182},
		{"a multipolygon's largest part", `{"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[10, 0], [12, 0], [12, 2], [10, 2], [10, 0]]]]}`,
			"[11,1]", 4 * metresPerDegree * metresPerDegree * math.Cos(1*math.Pi/180)},
		{"a degenerate ring at its vertices' mean", `{"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [0, 0]]]}`,
			"[0.6666667,0]", 0},
	}
	for _, c := range cases {
		point, area, err := Represent(json.RawMessage(c.geometry))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if point != c.point {
			t.Errorf("%s: point %s, want %s", c.name, point, c.point)
		}
		if math.Abs(area-c.areaM2) > c.areaM2*0.001+0.5 {
			t.Errorf("%s: area %.1f m², want %.1f", c.name, area, c.areaM2)
		}
	}
}

func TestRepresentRejectsOtherGeometry(t *testing.T) {
	for _, g := range []string{`{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}`, `null`, `{"type": "MultiPolygon", "coordinates": []}`} {
		if _, _, err := Represent(json.RawMessage(g)); err == nil {
			t.Errorf("%s: no error", g)
		}
	}
}

func TestKey(t *testing.T) {
	props := map[string]json.RawMessage{"@type": json.RawMessage(`"way"`), "@id": json.RawMessage(` 42 `)}
	if key, ok := Key(props); !ok || key != "way/42" {
		t.Errorf("Key = %q, %v", key, ok)
	}
	if _, ok := Key(map[string]json.RawMessage{"@id": json.RawMessage(`null`)}); ok {
		t.Error("a null id gave a key")
	}
}

func TestJSONString(t *testing.T) {
	if got := string(JSONString(`Fish & "Chips" <car park>`)); got != `"Fish & \"Chips\" <car park>"` {
		t.Errorf("JSONString = %s", got)
	}
}
