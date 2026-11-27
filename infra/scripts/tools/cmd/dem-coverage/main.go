// Command dem-coverage measures, for each contour region, how much of its land Mapterhorn
// covers with lidar or a fine national model rather than Copernicus GLO-30 — the number
// behind each region's "contourDemZoom" in regions.json.
//
//	dem-coverage REGIONS_JSON [ID...]
//
// Reads two things of Mapterhorn's over HTTP: attribution.json, every source with its
// resolution, and the z8 coverage tiles, where each source's footprint is a polygon tagged
// with its name. A region's land is sampled on a 0.05° grid; a point counts as land when
// any source covers it, and as fine when the finest source there is 10 m or better. By
// default every region with "contours": true; ids name others.
//
// Prints a line a region, finest first — its land samples, the fine share, its top three
// sources — and then what regions.json should say: contourDemZoom 12 where the fine share
// is at least half, and nothing where it is not. Regions whose regions.json disagrees are
// marked. It writes nothing: the setting is a call on cost against detail (build-contours.sh
// has the measurements), so a person edits regions.json.
//
// The method is the one the 2026-11-18 lidar work used (as a Node script then) and gives
// the same shares: the grid starts half a step in from the bbox's south-west corner, and a
// point is inside a footprint by the even-odd rule over all its rings.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	attributionURL = "https://download.mapterhorn.com/attribution.json"
	coverageURL    = "https://single-archive-tiles.mapterhorn.com/coverage/%d/%d/%d.mvt"
	coverageZoom   = 8
	step           = 0.05 // degrees between samples
	fineMetres     = 10.0 // a source this fine or finer counts as lidar-class
	fineShare      = 0.5  // at least this much of the land fine: contourDemZoom 12
	fineZoom       = 12
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dem-coverage REGIONS_JSON [ID...]")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2:], os.Stdout, httpFetch); err != nil {
		fmt.Fprintln(os.Stderr, "dem-coverage:", err)
		os.Exit(1)
	}
}

// fetcher returns a URL's body, or nil where there is nothing (404, 204).
type fetcher func(url string) ([]byte, error)

func httpFetch(url string) ([]byte, error) {
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
		resp, err := http.Get(url)
		if err != nil {
			last = err
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		switch {
		// No coverage there at all (open sea): Mapterhorn answers 204, or 404.
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusNoContent:
			return nil, nil
		case resp.StatusCode != http.StatusOK:
			last = fmt.Errorf("%s: %s", url, resp.Status)
		case err != nil:
			last = err
		default:
			return body, nil
		}
	}
	return nil, last
}

type region struct {
	ID       string           `json:"id"`
	BBox     []float64        `json:"bbox"`
	Contours bool             `json:"contours"`
	Zoom     *json.RawMessage `json:"contourDemZoom"`
}

type result struct {
	id      string
	land    int
	fine    float64
	top     string
	setZoom string // what regions.json says now, "" when unset
}

func run(regionsPath string, ids []string, out io.Writer, fetch fetcher) error {
	data, err := os.ReadFile(regionsPath)
	if err != nil {
		return err
	}
	var doc struct {
		Regions []region `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("%s: %w", regionsPath, err)
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var chosen []region
	for _, r := range doc.Regions {
		if (len(ids) == 0 && r.Contours) || want[r.ID] {
			chosen = append(chosen, r)
			delete(want, r.ID)
		}
	}
	for id := range want {
		return fmt.Errorf("no region %q in %s", id, regionsPath)
	}

	attr, err := fetch(attributionURL)
	if err != nil {
		return err
	}
	if attr == nil {
		return errors.New(attributionURL + ": not found")
	}
	var sources []struct {
		Source     string   `json:"source"`
		Resolution *float64 `json:"resolution"`
	}
	if err := json.Unmarshal(attr, &sources); err != nil {
		return fmt.Errorf("attribution.json: %w", err)
	}
	res := map[string]float64{}
	for _, s := range sources {
		if s.Resolution != nil {
			res[s.Source] = *s.Resolution
		}
	}
	if len(res) == 0 {
		return errors.New("attribution.json lists no source with a resolution")
	}

	tiles := map[[2]int][]footprint{}
	tile := func(x, y int) ([]footprint, error) {
		if fp, ok := tiles[[2]int{x, y}]; ok {
			return fp, nil
		}
		body, err := fetch(fmt.Sprintf(coverageURL, coverageZoom, x, y))
		if err != nil {
			return nil, err
		}
		fp, err := footprints(body)
		if err != nil {
			return nil, fmt.Errorf("coverage tile %d/%d/%d: %w", coverageZoom, x, y, err)
		}
		tiles[[2]int{x, y}] = fp
		return fp, nil
	}

	n := float64(int(1) << coverageZoom)
	var results []result
	for _, r := range chosen {
		if len(r.BBox) != 4 {
			return fmt.Errorf("region %s: bbox is not [w, s, e, n]", r.ID)
		}
		w, s, e, nn := r.BBox[0], r.BBox[1], r.BBox[2], r.BBox[3]
		land, fine := 0, 0
		bySource := map[string]int{}
		for lat := s + step/2; lat < nn; lat += step {
			for lon := w + step/2; lon < e; lon += step {
				fx := (lon + 180) / 360 * n
				rad := lat * math.Pi / 180
				fy := (1 - math.Log(math.Tan(rad)+1/math.Cos(rad))/math.Pi) / 2 * n
				x, y := int(math.Floor(fx)), int(math.Floor(fy))
				fps, err := tile(x, y)
				if err != nil {
					return err
				}
				best, bestSrc := math.Inf(1), ""
				for _, f := range fps {
					if !f.contains((fx-float64(x))*f.extent, (fy-float64(y))*f.extent) {
						continue
					}
					m, ok := res[f.source]
					if !ok {
						m = math.Inf(1)
					}
					if bestSrc == "" || m < best {
						best, bestSrc = m, f.source
					}
				}
				if bestSrc == "" {
					continue
				}
				land++
				bySource[bestSrc]++
				if best <= fineMetres {
					fine++
				}
			}
		}
		share := 0.0
		if land > 0 {
			share = float64(fine) / float64(land)
		}
		set := ""
		if r.Zoom != nil {
			set = strings.TrimSpace(string(*r.Zoom))
		}
		results = append(results, result{r.ID, land, share, topSources(bySource, land), set})
	}

	sort.SliceStable(results, func(i, j int) bool { return results[i].fine > results[j].fine })
	fmt.Fprintf(out, "%-34s %6s %5s  %s\n", "region", "land", "fine", "finest source at each sample, top three")
	var agree, disagree []string
	for _, r := range results {
		fmt.Fprintf(out, "%-34s %6d %4.0f%%  %s\n", r.id, r.land, 100*r.fine, r.top)
		should := ""
		if r.fine >= fineShare {
			should = fmt.Sprint(fineZoom)
		}
		if should == r.setZoom {
			agree = append(agree, r.id)
			continue
		}
		have := "unset"
		if r.setZoom != "" {
			have = r.setZoom
		}
		want := "unset"
		if should != "" {
			want = should
		}
		disagree = append(disagree, fmt.Sprintf("  %s: contourDemZoom %s, measured says %s", r.id, have, want))
	}
	fmt.Fprintf(out, "\ncontourDemZoom %d at %.0f%% fine or more: %d of %d region(s) agree with regions.json\n",
		fineZoom, 100*fineShare, len(agree), len(results))
	for _, d := range disagree {
		fmt.Fprintln(out, d)
	}
	return nil
}

func topSources(by map[string]int, land int) string {
	type kv struct {
		k string
		v int
	}
	var all []kv
	for k, v := range by {
		all = append(all, kv{k, v})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].v != all[j].v {
			return all[i].v > all[j].v
		}
		return all[i].k < all[j].k
	})
	var parts []string
	for i, e := range all {
		if i == 3 {
			break
		}
		parts = append(parts, fmt.Sprintf("%s %.0f%%", e.k, 100*float64(e.v)/float64(land)))
	}
	return strings.Join(parts, ", ")
}

// footprint is one source's polygon in a coverage tile, in tile coordinates.
type footprint struct {
	source string
	extent float64
	rings  [][][2]float64
}

// contains is the even-odd rule over every ring, so holes count against.
func (f footprint) contains(px, py float64) bool {
	in := false
	for _, ring := range f.rings {
		for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
			a, b := ring[i], ring[j]
			if (a[1] > py) != (b[1] > py) && px < (b[0]-a[0])*(py-a[1])/(b[1]-a[1])+a[0] {
				in = !in
			}
		}
	}
	return in
}

// footprints decodes the "coverage" layer of a Mapbox Vector Tile: each feature's
// "source" tag and its polygon rings. Nil for a missing tile (open sea).
func footprints(data []byte) ([]footprint, error) {
	if data == nil {
		return nil, nil
	}
	if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		if data, err = io.ReadAll(zr); err != nil {
			return nil, err
		}
	}
	var out []footprint
	err := fields(data, func(num int, wire int, v uint64, b []byte) error {
		if num != 3 || wire != 2 {
			return nil
		}
		fp, err := layer(b)
		out = append(out, fp...)
		return err
	})
	return out, err
}

func layer(data []byte) ([]footprint, error) {
	var name string
	var keys []string
	var values []string // string values only; others are never a source name
	var feats [][]byte
	extent := 4096.0
	err := fields(data, func(num int, wire int, v uint64, b []byte) error {
		switch {
		case num == 1 && wire == 2:
			name = string(b)
		case num == 2 && wire == 2:
			feats = append(feats, b)
		case num == 3 && wire == 2:
			keys = append(keys, string(b))
		case num == 4 && wire == 2:
			s := ""
			if err := fields(b, func(n int, w int, _ uint64, vb []byte) error {
				if n == 1 && w == 2 {
					s = string(vb)
				}
				return nil
			}); err != nil {
				return err
			}
			values = append(values, s)
		case num == 5 && wire == 0:
			extent = float64(v)
		}
		return nil
	})
	if err != nil || name != "coverage" {
		return nil, err
	}
	var out []footprint
	for _, fb := range feats {
		var tags, geom []uint64
		err := fields(fb, func(num int, wire int, v uint64, b []byte) error {
			switch {
			case num == 2 && wire == 2:
				p, err := packed(b)
				tags = p
				return err
			case num == 4 && wire == 2:
				p, err := packed(b)
				geom = p
				return err
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		fp := footprint{extent: extent}
		for i := 0; i+1 < len(tags); i += 2 {
			if int(tags[i]) < len(keys) && keys[tags[i]] == "source" && int(tags[i+1]) < len(values) {
				fp.source = values[tags[i+1]]
			}
		}
		if fp.rings, err = rings(geom); err != nil {
			return nil, err
		}
		out = append(out, fp)
	}
	return out, nil
}

// rings decodes MVT geometry commands into rings: MoveTo starts one, LineTo extends it.
func rings(cmds []uint64) ([][][2]float64, error) {
	var out [][][2]float64
	var x, y int64
	for i := 0; i < len(cmds); {
		id, count := cmds[i]&7, int(cmds[i]>>3)
		i++
		switch id {
		case 1, 2:
			if i+2*count > len(cmds) {
				return nil, errors.New("geometry ends inside a command")
			}
			for k := 0; k < count; k++ {
				x += zigzag(cmds[i])
				y += zigzag(cmds[i+1])
				i += 2
				if id == 1 {
					out = append(out, nil)
				}
				if len(out) == 0 {
					return nil, errors.New("LineTo before MoveTo")
				}
				out[len(out)-1] = append(out[len(out)-1], [2]float64{float64(x), float64(y)})
			}
		case 7: // ClosePath: the ring test closes every ring anyway
		default:
			return nil, fmt.Errorf("unknown geometry command %d", id)
		}
	}
	return out, nil
}

func zigzag(v uint64) int64 { return int64(v>>1) ^ -int64(v&1) }

// fields walks a protobuf message, calling f with each field's number, wire type, and its
// varint value or its bytes.
func fields(data []byte, f func(num, wire int, v uint64, b []byte) error) error {
	for i := 0; i < len(data); {
		key, n := uvarint(data[i:])
		if n <= 0 {
			return errors.New("bad protobuf key")
		}
		i += n
		num, wire := int(key>>3), int(key&7)
		switch wire {
		case 0:
			v, n := uvarint(data[i:])
			if n <= 0 {
				return errors.New("bad varint")
			}
			i += n
			if err := f(num, wire, v, nil); err != nil {
				return err
			}
		case 1:
			i += 8
		case 2:
			l, n := uvarint(data[i:])
			if n <= 0 || i+n+int(l) > len(data) {
				return errors.New("bad length")
			}
			i += n
			if err := f(num, wire, 0, data[i:i+int(l)]); err != nil {
				return err
			}
			i += int(l)
		case 5:
			i += 4
		default:
			return fmt.Errorf("unsupported wire type %d", wire)
		}
		if i > len(data) {
			return errors.New("message ends inside a field")
		}
	}
	return nil
}

func packed(b []byte) ([]uint64, error) {
	var out []uint64
	for i := 0; i < len(b); {
		v, n := uvarint(b[i:])
		if n <= 0 {
			return nil, errors.New("bad packed varint")
		}
		out = append(out, v)
		i += n
	}
	return out, nil
}

func uvarint(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < len(b) && i < 10; i++ {
		v |= uint64(b[i]&0x7f) << (7 * i)
		if b[i] < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}
