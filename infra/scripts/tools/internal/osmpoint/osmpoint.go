// Package osmpoint reduces an `osmium export` feature to the one point a symbol is drawn
// at, for the normalizers whose features are symbols however OSM maps them: a cairn or a
// car park is a node in one place and a closed way in the next (normalize-landmarks,
// normalize-parking). An icon on a polygon would repeat in every tile the polygon touches.
package osmpoint

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"ratmap/infra/tools/internal/rawjson"
)

// metresPerDegree is the length of a degree of latitude, and of longitude at the equator:
// the Earth's mean radius times pi/180. Planar areas from it are within a fraction of a
// percent at car park scale, which is all Represent's area is used for.
const metresPerDegree = 6371008.8 * math.Pi / 180

// Key is "<@type>/<@id>" as written; ok=false when the export carried no id. OSM's node,
// way and relation id spaces are independent, so the type is part of the key — what the
// normalizers deduplicate concatenated continent extracts on (the seam problem
// normalize-sac documents).
func Key(props map[string]json.RawMessage) (string, bool) {
	id, ok := props["@id"]
	if !ok || string(bytes.TrimSpace(id)) == "null" {
		return "", false
	}
	return rawjson.Text(props["@type"]) + "/" + string(bytes.TrimSpace(id)), true
}

type position [2]float64

// Represent is the GeoJSON coordinates of the one point drawn for a feature, and the area
// in square metres of the polygon it stands for: a Point's own coordinates as written,
// with no area; an area's centroid — the area-weighted centroid of its largest polygon's
// outer ring, which for anything tower-, cairn- or car-park-sized is inside it — with
// that ring's area.
func Represent(raw json.RawMessage) (point string, areaM2 float64, err error) {
	var g struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &g) != nil {
		return "", 0, fmt.Errorf("geometry is %s, not a GeoJSON geometry", raw)
	}
	var polygons [][][]position
	switch g.Type {
	case "Point":
		var p position
		if err := json.Unmarshal(g.Coordinates, &p); err != nil {
			return "", 0, fmt.Errorf("Point coordinates: %w", err)
		}
		return string(bytes.TrimSpace(g.Coordinates)), 0, nil
	case "Polygon":
		var p [][]position
		if err := json.Unmarshal(g.Coordinates, &p); err != nil {
			return "", 0, fmt.Errorf("Polygon coordinates: %w", err)
		}
		polygons = [][][]position{p}
	case "MultiPolygon":
		if err := json.Unmarshal(g.Coordinates, &polygons); err != nil {
			return "", 0, fmt.Errorf("MultiPolygon coordinates: %w", err)
		}
	default:
		// The build scripts export --geometry-types=point,polygon, so anything else is a
		// changed export, not data to guess about.
		return "", 0, fmt.Errorf("unexpected %s geometry", g.Type)
	}

	best, bestArea := position{}, -1.0
	for _, polygon := range polygons {
		if len(polygon) == 0 || len(polygon[0]) == 0 {
			continue
		}
		c, area := ringCentroid(polygon[0])
		if area > bestArea {
			best, bestArea = c, area
		}
	}
	if bestArea < 0 {
		return "", 0, fmt.Errorf("%s with no rings", g.Type)
	}
	// Degrees squared to square metres: a degree of longitude shrinks with latitude.
	m2 := bestArea * metresPerDegree * metresPerDegree * math.Cos(best[1]*math.Pi/180)
	return "[" + coord(best[0]) + "," + coord(best[1]) + "]", m2, nil
}

// ringCentroid is a ring's area-weighted centroid and its absolute area, in degrees —
// planar, which at tower and car park scale is exact enough. A degenerate ring (zero
// area) falls back to the mean of its vertices.
func ringCentroid(ring []position) (position, float64) {
	var a, cx, cy float64
	// Relative to the first vertex, so the products do not lose precision far from 0,0.
	o := ring[0]
	for i := 0; i+1 < len(ring); i++ {
		x0, y0 := ring[i][0]-o[0], ring[i][1]-o[1]
		x1, y1 := ring[i+1][0]-o[0], ring[i+1][1]-o[1]
		cross := x0*y1 - x1*y0
		a += cross
		cx += (x0 + x1) * cross
		cy += (y0 + y1) * cross
	}
	if a == 0 {
		var sx, sy float64
		for _, p := range ring {
			sx += p[0]
			sy += p[1]
		}
		return position{sx / float64(len(ring)), sy / float64(len(ring))}, 0
	}
	return position{o[0] + cx/(3*a), o[1] + cy/(3*a)}, math.Abs(a) / 2
}

// coord is a coordinate to 7 decimal places (~1 cm), osmium's own precision.
func coord(v float64) string {
	return strconv.FormatFloat(math.Round(v*1e7)/1e7, 'f', -1, 64)
}

// JSONString encodes s as JSON without Go's HTML escaping of <, > and &.
func JSONString(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return bytes.TrimRight(b.Bytes(), "\n")
}
