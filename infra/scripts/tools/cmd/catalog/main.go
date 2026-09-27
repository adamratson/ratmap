// Command catalog answers the build scripts' questions about regions.json.
//
//	catalog region-vars region    REGIONS_JSON ID           # build-region.sh
//	catalog region-vars contours  REGIONS_JSON ID           # build-contours.sh
//	catalog region-vars avalanche REGIONS_JSON ID ZMIN      # build-avalanche.sh
//	catalog ids       REGIONS_JSON [FLAG [REGEX]]           # build-global.sh region_ids
//	catalog bboxes    REGIONS_JSON ID...                    # build-global.sh region_bboxes
//	catalog dist-gb   REGIONS_JSON DIST_DIR                 # build-global.sh catalogue_dist_gb
//	catalog peaks-mem REGIONS_JSON RES WORKERS PER_FETCH_GB BYTES_PER_PX  # peaks_mem_gb
//
// `region-vars` output is eval'd, so it is shell assignments, quoted. Every catalogue
// number is written exactly as regions.json writes it — the bbox strings in particular,
// because fetch-dem.sh builds its DEM cache key from them and a different spelling would
// miss every cached DEM.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/shell"
)

const usage = `usage: catalog region-vars region|contours|avalanche REGIONS_JSON ID [ZMIN]
       catalog ids REGIONS_JSON [FLAG [REGEX]]
       catalog bboxes REGIONS_JSON ID...
       catalog dist-gb REGIONS_JSON DIST_DIR
       catalog peaks-mem REGIONS_JSON RES WORKERS PER_FETCH_GB BYTES_PER_PX`

// exitMsg is a message for the person running the script: printed on its own, status 1.
type exitMsg string

func (e exitMsg) Error() string { return string(e) }

func main() {
	err := run(os.Args[1:], os.Stdout)
	var m exitMsg
	switch {
	case err == nil:
	case errors.As(err, &m):
		fmt.Fprintln(os.Stderr, string(m))
		os.Exit(1)
	case err == errUsage:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	default:
		fmt.Fprintln(os.Stderr, "catalog:", err)
		os.Exit(1)
	}
}

var errUsage = errors.New("usage")

func run(args []string, out io.Writer) error {
	if len(args) < 2 {
		return errUsage
	}
	switch args[0] {
	case "region-vars":
		if len(args) < 4 {
			return errUsage
		}
		regions, err := load(args[2])
		if err != nil {
			return err
		}
		switch args[1] {
		case "region":
			return regionVars(out, regions, args[3])
		case "contours":
			return contoursVars(out, regions, args[3])
		case "avalanche":
			if len(args) < 5 {
				return errUsage
			}
			return avalancheVars(out, regions, args[3], args[4])
		}
		return errUsage
	case "ids":
		regions, err := load(args[1])
		if err != nil {
			return err
		}
		flag, pattern := "", ""
		if len(args) > 2 {
			flag = args[2]
		}
		if len(args) > 3 {
			pattern = args[3]
		}
		return ids(out, regions, flag, pattern)
	case "bboxes":
		regions, err := load(args[1])
		if err != nil {
			return err
		}
		return bboxes(out, regions, args[2:])
	case "dist-gb":
		if len(args) != 3 {
			return errUsage
		}
		regions, err := load(args[1])
		if err != nil {
			return err
		}
		return distGB(out, regions, args[2])
	case "peaks-mem":
		if len(args) != 6 {
			return errUsage
		}
		regions, err := load(args[1])
		if err != nil {
			return err
		}
		return peaksMem(out, regions, args[2:])
	}
	return errUsage
}

// region is one catalogue entry. Numbers stay as written (json.Number): the bbox text is
// what the scripts pass on to fetch-dem.sh, which builds its DEM cache key from it, so
// re-spelling a number would miss every cached DEM. Flags stay raw, so that any one can
// be asked for by name.
type region struct {
	ID             string        `json:"id"`
	Name           string        `json:"name"`
	BBox           []json.Number `json:"bbox"`
	BasemapMaxzoom *json.Number  `json:"basemapMaxzoom"`
	TerrainMaxzoom *json.Number  `json:"terrainMaxzoom"`
	EstimatedBytes json.Number   `json:"estimatedBytes"`
	fields         map[string]json.RawMessage
}

// flag reports whether the region sets key to true.
func (r *region) flag(key string) bool {
	return string(bytes.TrimSpace(r.fields[key])) == "true"
}

// wantsTerrain is true unless the region opts out with "terrain": false.
func (r *region) wantsTerrain() bool {
	return string(bytes.TrimSpace(r.fields["terrain"])) != "false"
}

func load(path string) ([]*region, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Regions []json.RawMessage `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if doc.Regions == nil {
		return nil, fmt.Errorf(`%s: no "regions" list`, path)
	}
	out := make([]*region, len(doc.Regions))
	for i, raw := range doc.Regions {
		r := &region{}
		if err := json.Unmarshal(raw, r); err != nil {
			return nil, fmt.Errorf("%s: region %d: %w", path, i, err)
		}
		if err := json.Unmarshal(raw, &r.fields); err != nil {
			return nil, fmt.Errorf("%s: region %d: %w", path, i, err)
		}
		out[i] = r
	}
	return out, nil
}

// find is the region with this id, or the message the scripts print when there is none.
func find(regions []*region, id string) (*region, error) {
	for _, r := range regions {
		if r.ID == id {
			return r, nil
		}
	}
	known := make([]string, len(regions))
	for i, r := range regions {
		known[i] = r.ID
	}
	return nil, exitMsg(fmt.Sprintf("Unknown region '%s'. Known: %s", id, strings.Join(known, ", ")))
}

// bbox is the region's west, south, east, north, as written and as floats.
func bbox(r *region) ([]string, [4]float64, error) {
	var f [4]float64
	if len(r.BBox) != 4 {
		return nil, f, fmt.Errorf("region %s: bbox is not four numbers", r.ID)
	}
	text := make([]string, 4)
	for i, n := range r.BBox {
		v, err := n.Float64()
		if err != nil {
			return nil, f, fmt.Errorf("region %s: bbox is not four numbers", r.ID)
		}
		f[i], text[i] = v, n.String()
	}
	return text, f, nil
}

func regionVars(out io.Writer, regions []*region, id string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	text, b, err := bbox(r)
	if err != nil {
		return err
	}
	if !(b[0] < b[2] && b[1] < b[3]) {
		return exitMsg(fmt.Sprintf("Region '%s' has an invalid bbox [%s] (need west<east, south<north). Fix regions.json before building.",
			r.ID, strings.Join(text, ", ")))
	}
	fmt.Fprintf(out, "REGION_NAME=%s\n", shell.Quote(r.Name))
	// Opt-out, not opt-in: every region gets terrain unless it says otherwise.
	want := "1"
	if !r.wantsTerrain() {
		want = "0"
	}
	fmt.Fprintf(out, "WANT_TERRAIN=%s\n", want)
	fmt.Fprintf(out, "BBOX=%s\n", shell.Quote(strings.Join(text, ",")))
	// Empty unless the catalogue caps this region below the defaults.
	for _, kv := range []struct {
		name string
		v    *json.Number
	}{{"REGION_BASEMAP_Z", r.BasemapMaxzoom}, {"REGION_TERRAIN_Z", r.TerrainMaxzoom}} {
		val := ""
		if kv.v != nil {
			val = kv.v.String()
		}
		fmt.Fprintf(out, "%s=%s\n", kv.name, val)
	}
	return nil
}

func contoursVars(out io.Writer, regions []*region, id string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	text, _, err := bbox(r)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "REGION_NAME=%s\n", shell.Quote(r.Name))
	for i, k := range []string{"WEST", "SOUTH", "EAST", "NORTH"} {
		fmt.Fprintf(out, "%s=%s\n", k, text[i])
	}
	return nil
}

const (
	demMetres = 30.0
	equator   = 40075016.685578488
	half      = equator / 2
)

// avalancheVars is build-avalanche.sh's region maths: the zoom range the DEM supports and
// the extent snapped to the tile grid at the finest zoom. See build-avalanche.sh for why
// each number is what it is. The float64() conversions stop Go fusing a multiply into
// the following add or subtract (FMA, which it may do on arm64), so each operation is
// rounded on its own and the grid comes out the same on every machine.
func avalancheVars(out io.Writer, regions []*region, id, zminArg string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	if !r.flag("avalanche") {
		return exitMsg(fmt.Sprintf("Region '%s' does not set \"avalanche\": true in regions.json. "+
			"This artifact is opt-in per region (A8) — add the flag if it is wanted here.", r.ID))
	}
	text, b, err := bbox(r)
	if err != nil {
		return err
	}
	west, south, east, north := b[0], b[1], b[2], b[3]
	if !(west < east && south < north) {
		return exitMsg(fmt.Sprintf("Region '%s' has an invalid bbox [%s].", r.ID, strings.Join(text, ", ")))
	}
	zminIn, err := strconv.Atoi(strings.TrimSpace(zminArg))
	if err != nil {
		return fmt.Errorf("ZMIN %q is not an integer", zminArg)
	}

	pi := math.Pi
	degToRad := pi / 180
	lat := float64((south+north)/2) * degToRad

	zmax := int(math.Ceil(math.Log2(float64(equator*math.Cos(lat)) / (512 * demMetres))))
	zmax = max(9, min(12, zmax))

	span := math.Max(east-west, north-south)
	zmin := max(zminIn, int(math.Ceil(math.Log2(360/span))))
	zmin = min(zmin, zmax)

	toMerc := func(lon, latitude float64) (float64, float64, error) {
		x := float64(lon*half) / 180.0
		t := math.Tan(pi/4 + float64(latitude*degToRad)/2)
		// At the pole tan is 0 and the log -Inf: no grid to snap to.
		if !(t > 0) {
			return 0, 0, fmt.Errorf("region %s: latitude %v has no Mercator y", r.ID, latitude)
		}
		y := float64(math.Log(t)*half) / pi
		return x, y, nil
	}
	x0, y0, err := toMerc(west, south)
	if err != nil {
		return err
	}
	x1, y1, err := toMerc(east, north)
	if err != nil {
		return err
	}
	tile := 2 * half / math.Pow(2, float64(zmax))
	snap := func(v float64, round func(float64) float64) float64 {
		return float64(round((v+half)/tile)*tile) - half
	}
	ax0, ay0 := snap(x0, math.Floor), snap(y0, math.Floor)
	ax1, ay1 := snap(x1, math.Ceil), snap(y1, math.Ceil)

	fmt.Fprintf(out, "REGION_NAME=%s\n", shell.Quote(r.Name))
	fmt.Fprintf(out, "BBOX=%s\n", shell.Quote(strings.Join(text, ",")))
	for i, k := range []string{"WEST", "SOUTH", "EAST", "NORTH"} {
		fmt.Fprintf(out, "%s=%s\n", k, text[i])
	}
	fmt.Fprintf(out, "ZMAX=%d\nZMIN=%d\n", zmax, zmin)
	// Quoted so `eval` assigns all four numbers to TE; the caller then leaves `$TE`
	// unquoted so it word-splits back into gdalwarp's four -te arguments.
	fmt.Fprintf(out, "TE=%s\n", shell.Quote(strings.Join([]string{
		metres(ax0), metres(ay0), metres(ax1), metres(ay1)}, " ")))
	fmt.Fprintf(out, "RES=%s\n", metres(2*half/math.Pow(2, float64(zmax))/512))
	return nil
}

// metres writes a Web Mercator coordinate or resolution for gdalwarp: the shortest digits
// that read back as the same double, never in exponent notation.
func metres(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// ids prints "<id> <wants-terrain>" for each region, optionally only those setting FLAG
// to true and whose id matches REGEX (RE2 syntax).
func ids(out io.Writer, regions []*region, flag, pattern string) error {
	var re *regexp.Regexp
	if pattern != "" {
		var err error
		if re, err = regexp.Compile(pattern); err != nil {
			return fmt.Errorf("RATMAP_REGION_FILTER %q: %w", pattern, err)
		}
	}
	for _, r := range regions {
		if flag != "" && !r.flag(flag) {
			continue
		}
		if re != nil && !re.MatchString(r.ID) {
			continue
		}
		terrain := 1
		if !r.wantsTerrain() {
			terrain = 0
		}
		fmt.Fprintf(out, "%s %d\n", r.ID, terrain)
	}
	return nil
}

// bboxes prints "<id> <w> <s> <e> <n>" for each id given, the numbers as regions.json
// writes them — exactly as build-contours.sh and build-avalanche.sh hand them to
// fetch-dem.sh, which is what makes a DEM fetched from here the cache entry those scripts
// look for.
func bboxes(out io.Writer, regions []*region, idList []string) error {
	by := map[string]*region{}
	for _, r := range regions {
		by[r.ID] = r
	}
	for _, id := range idList {
		r, ok := by[id]
		if !ok {
			return fmt.Errorf("no region %q in regions.json", id)
		}
		text, _, err := bbox(r)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, id+" "+strings.Join(text, " "))
	}
	return nil
}

// distGB is the GB the regions stage still has to write, from the catalogue's own
// estimates, counting only regions whose basemap is not already built, with 10% headroom.
func distGB(out io.Writer, regions []*region, dist string) error {
	var total float64
	for _, r := range regions {
		if _, err := os.Stat(filepath.Join(dist, "regions", r.ID, r.ID+"-basemap.pmtiles")); err == nil {
			continue
		}
		if r.EstimatedBytes != "" {
			n, err := r.EstimatedBytes.Float64()
			if err != nil {
				return fmt.Errorf("region %s: estimatedBytes %q", r.ID, r.EstimatedBytes)
			}
			total += n
		}
	}
	fmt.Fprintln(out, int64(total*1.1/1e9))
	return nil
}

// peaksMem is the memory the peaks stage's prominence pass needs, as
// "<GB> <largest region> <its Mpx>" — see build-global.sh's peaks_mem_gb.
func peaksMem(out io.Writer, regions []*region, args []string) error {
	nums := make([]float64, 4)
	for i, a := range args {
		f, err := strconv.ParseFloat(strings.TrimSpace(a), 64)
		if err != nil {
			return fmt.Errorf("%q is not a number", a)
		}
		nums[i] = f
	}
	res, perFetch, perPx := nums[0], nums[2], nums[3]
	workers, err := strconv.Atoi(strings.TrimSpace(args[1]))
	if err != nil {
		return fmt.Errorf("WORKERS %q is not an integer", args[1])
	}
	if len(regions) == 0 {
		return errors.New("no regions")
	}
	type entry struct {
		id   string
		area float64
	}
	order := make([]entry, len(regions))
	for i, r := range regions {
		_, b, err := bbox(r)
		if err != nil {
			return err
		}
		order[i] = entry{r.ID, (b[2] - b[0]) * (b[3] - b[1])}
	}
	sort.SliceStable(order, func(i, j int) bool { return order[i].area < order[j].area })
	n := len(order)
	need := math.Inf(-1)
	var last float64
	for k, e := range order {
		px := e.area / (res * res)
		last = px
		v := float64(px*perPx)/(1<<30) + float64(perFetch*float64(min(workers, n-1-k)))
		need = math.Max(need, v)
	}
	fmt.Fprintf(out, "%d %s %d\n", int64(math.Ceil(need)), order[n-1].id, int64(math.RoundToEven(last/1e6)))
	return nil
}
