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
// Ports of the Python snippets those scripts carried inline, each printing what its
// snippet printed: `region-vars` output is eval'd, so it is shell assignments quoted with
// shlex.quote's rules, and every number is written as Python's str() wrote it — the bbox
// strings in particular, because fetch-dem.sh builds its DEM cache key from them and a
// different spelling would miss every cached DEM.
package main

import (
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

	"ratmap/infra/tools/internal/pyfloat"
	"ratmap/infra/tools/internal/pyjson"
	"ratmap/infra/tools/internal/pytext"
)

const usage = `usage: catalog region-vars region|contours|avalanche REGIONS_JSON ID [ZMIN]
       catalog ids REGIONS_JSON [FLAG [REGEX]]
       catalog bboxes REGIONS_JSON ID...
       catalog dist-gb REGIONS_JSON DIST_DIR
       catalog peaks-mem REGIONS_JSON RES WORKERS PER_FETCH_GB BYTES_PER_PX`

// exitMsg is sys.exit("..."): the message on stderr, status 1.
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

func load(path string) ([]*pyjson.Object, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc, err := pyjson.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	top, _ := doc.(*pyjson.Object)
	if top == nil {
		return nil, fmt.Errorf("%s: not an object", path)
	}
	rv, _ := top.Get("regions")
	list, ok := rv.([]pyjson.Value)
	if !ok {
		return nil, fmt.Errorf(`%s: no "regions" list`, path)
	}
	out := make([]*pyjson.Object, len(list))
	for i, r := range list {
		if out[i], ok = r.(*pyjson.Object); !ok {
			return nil, fmt.Errorf("%s: a region is not an object", path)
		}
	}
	return out, nil
}

func str(o *pyjson.Object, key string) string {
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

// find is next(r for r in regions if r["id"] == id), with the snippets' message when
// there is none.
func find(regions []*pyjson.Object, id string) (*pyjson.Object, error) {
	for _, r := range regions {
		if str(r, "id") == id {
			return r, nil
		}
	}
	known := make([]string, len(regions))
	for i, r := range regions {
		known[i] = str(r, "id")
	}
	return nil, exitMsg(fmt.Sprintf("Unknown region '%s'. Known: %s", id, strings.Join(known, ", ")))
}

// bbox is `west, south, east, north = r["bbox"]`: the four values, and each as a float.
func bbox(r *pyjson.Object) ([]pyjson.Value, [4]float64, error) {
	var f [4]float64
	v, _ := r.Get("bbox")
	list, ok := v.([]pyjson.Value)
	if !ok || len(list) != 4 {
		return nil, f, fmt.Errorf("region %s: bbox is not four numbers", str(r, "id"))
	}
	for i, x := range list {
		if f[i], ok = pyjson.Number(x); !ok {
			return nil, f, fmt.Errorf("region %s: bbox is not four numbers", str(r, "id"))
		}
	}
	return list, f, nil
}

// pyStr is str() of a decoded JSON value: a string itself, anything else as Python
// prints it (an int's digits, a float's repr, None, True…).
func pyStr(v pyjson.Value) string {
	if s, ok := v.(string); ok {
		return s
	}
	return pytext.StrValue([]byte(encode(v)))
}

func joinStr(vs []pyjson.Value, sep string) string {
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = pyStr(v)
	}
	return strings.Join(parts, sep)
}

func regionVars(out io.Writer, regions []*pyjson.Object, id string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	raw, b, err := bbox(r)
	if err != nil {
		return err
	}
	if !(b[0] < b[2] && b[1] < b[3]) {
		bv, _ := r.Get("bbox")
		return exitMsg(fmt.Sprintf("Region '%s' has an invalid bbox %s (need west<east, south<north). Fix regions.json before building.",
			str(r, "id"), pytext.ReprValue([]byte(encode(bv)))))
	}
	fmt.Fprintf(out, "REGION_NAME=%s\n", pytext.ShellQuote(str(r, "name")))
	// Opt-out, not opt-in: every region gets terrain unless it says otherwise.
	want := "1"
	if v, ok := r.Get("terrain"); ok && v == false {
		want = "0"
	}
	fmt.Fprintf(out, "WANT_TERRAIN=%s\n", want)
	fmt.Fprintf(out, "BBOX=%s\n", pytext.ShellQuote(joinStr(raw, ",")))
	// Empty unless the catalogue caps this region below the defaults.
	for _, kv := range [][2]string{{"REGION_BASEMAP_Z", "basemapMaxzoom"}, {"REGION_TERRAIN_Z", "terrainMaxzoom"}} {
		val := ""
		if v, ok := r.Get(kv[1]); ok {
			val = pyStr(v)
		}
		fmt.Fprintf(out, "%s=%s\n", kv[0], val)
	}
	return nil
}

func encode(v pyjson.Value) string {
	s, _ := pyjson.Encode(v, pyjson.Options{})
	return s
}

func contoursVars(out io.Writer, regions []*pyjson.Object, id string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	raw, _, err := bbox(r)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "REGION_NAME=%s\n", pytext.ShellQuote(str(r, "name")))
	for i, k := range []string{"WEST", "SOUTH", "EAST", "NORTH"} {
		fmt.Fprintf(out, "%s=%s\n", k, pyStr(raw[i]))
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
// the following add or subtract (FMA, which it may do on arm64): Python rounds each
// operation on its own.
func avalancheVars(out io.Writer, regions []*pyjson.Object, id, zminArg string) error {
	r, err := find(regions, id)
	if err != nil {
		return err
	}
	if v, _ := r.Get("avalanche"); !truthy(v) {
		return exitMsg(fmt.Sprintf("Region '%s' does not set \"avalanche\": true in regions.json. "+
			"This artifact is opt-in per region (A8) — add the flag if it is wanted here.", str(r, "id")))
	}
	raw, b, err := bbox(r)
	if err != nil {
		return err
	}
	west, south, east, north := b[0], b[1], b[2], b[3]
	if !(west < east && south < north) {
		bv, _ := r.Get("bbox")
		return exitMsg(fmt.Sprintf("Region '%s' has an invalid bbox %s.", str(r, "id"), pytext.ReprValue([]byte(encode(bv)))))
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
		// math.log raised "math domain error" at the pole (tan 0), where Go returns -Inf
		// and carries on; stop where the Python stopped.
		if !(t > 0) {
			return 0, 0, fmt.Errorf("region %s: latitude %v has no Mercator y (math domain error)", str(r, "id"), latitude)
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

	fmt.Fprintf(out, "REGION_NAME=%s\n", pytext.ShellQuote(str(r, "name")))
	fmt.Fprintf(out, "BBOX=%s\n", pytext.ShellQuote(joinStr(raw, ",")))
	for i, k := range []string{"WEST", "SOUTH", "EAST", "NORTH"} {
		fmt.Fprintf(out, "%s=%s\n", k, pyStr(raw[i]))
	}
	fmt.Fprintf(out, "ZMAX=%d\nZMIN=%d\n", zmax, zmin)
	// Quoted so `eval` assigns all four numbers to TE; the caller then leaves `$TE`
	// unquoted so it word-splits back into gdalwarp's four -te arguments.
	fmt.Fprintf(out, "TE=%s\n", pytext.ShellQuote(strings.Join([]string{
		pyfloat.Repr(ax0), pyfloat.Repr(ay0), pyfloat.Repr(ax1), pyfloat.Repr(ay1)}, " ")))
	fmt.Fprintf(out, "RES=%s\n", pyfloat.Repr(2*half/math.Pow(2, float64(zmax))/512))
	return nil
}

func truthy(v pyjson.Value) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case pyjson.Int:
		return t != "0"
	case float64:
		return t != 0
	case []pyjson.Value:
		return len(t) > 0
	case *pyjson.Object:
		return len(t.Keys) > 0
	}
	return true
}

// ids prints "<id> <wants-terrain>" for each region, optionally only those opting into
// FLAG and whose id matches REGEX (Go's RE2 syntax, where the Python took Python's; the
// patterns RATMAP_REGION_FILTER is documented with mean the same in both).
func ids(out io.Writer, regions []*pyjson.Object, flag, pattern string) error {
	var re *regexp.Regexp
	if pattern != "" {
		var err error
		if re, err = regexp.Compile(pattern); err != nil {
			return fmt.Errorf("RATMAP_REGION_FILTER %q: %w", pattern, err)
		}
	}
	for _, r := range regions {
		if flag != "" {
			if v, _ := r.Get(flag); !truthy(v) {
				continue
			}
		}
		if re != nil && !re.MatchString(str(r, "id")) {
			continue
		}
		terrain := 1
		if v, ok := r.Get("terrain"); ok && v == false {
			terrain = 0
		}
		fmt.Fprintf(out, "%s %d\n", str(r, "id"), terrain)
	}
	return nil
}

// bboxes prints "<id> <w> <s> <e> <n>" for each id given, the numbers as Python's str()
// wrote them — exactly as build-contours.sh and build-avalanche.sh hand them to
// fetch-dem.sh, which is what makes a DEM fetched from here the cache entry those scripts
// look for.
func bboxes(out io.Writer, regions []*pyjson.Object, idList []string) error {
	by := map[string]*pyjson.Object{}
	for _, r := range regions {
		by[str(r, "id")] = r
	}
	for _, id := range idList {
		r, ok := by[id]
		if !ok {
			return fmt.Errorf("no region %q in regions.json", id)
		}
		v, _ := r.Get("bbox")
		list, _ := v.([]pyjson.Value)
		fmt.Fprintln(out, id+" "+joinStr(list, " "))
	}
	return nil
}

// distGB is the GB the regions stage still has to write, from the catalogue's own
// estimates, counting only regions whose basemap is not already built, with 10% headroom.
func distGB(out io.Writer, regions []*pyjson.Object, dist string) error {
	var total float64
	for _, r := range regions {
		id := str(r, "id")
		if _, err := os.Stat(filepath.Join(dist, "regions", id, id+"-basemap.pmtiles")); err == nil {
			continue
		}
		if v, ok := r.Get("estimatedBytes"); ok {
			n, _ := pyjson.Number(v)
			total += n
		}
	}
	fmt.Fprintln(out, int64(total*1.1/1e9))
	return nil
}

// peaksMem is the memory the peaks stage's prominence pass needs, as
// "<GB> <largest region> <its Mpx>" — see build-global.sh's peaks_mem_gb.
func peaksMem(out io.Writer, regions []*pyjson.Object, args []string) error {
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
		order[i] = entry{str(r, "id"), (b[2] - b[0]) * (b[3] - b[1])}
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
