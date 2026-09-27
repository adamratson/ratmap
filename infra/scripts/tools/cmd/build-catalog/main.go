// Command build-catalog generates regions.json — a globe-covering download catalogue —
// from Geofabrik's index.
//
//	./scripts/build-catalog.sh                 # full run: measures every candidate (slow, cached)
//	./scripts/build-catalog.sh --no-estimate   # rough pass off bbox area, for a quick look
//	./scripts/build-catalog.sh --print         # summarise without writing regions.json
//
// scripts/build-catalog.sh builds and runs it with the same arguments. regions.json is a
// checked-in file, so a regeneration writes it the same way every time: a diff shows what
// changed, not a reformatting.
//
// Why this exists: the catalogue *is* regions.json. Nothing in the pipeline discovers
// regions — `ratmap global regions` loops over whatever ids this file defines — so "cover
// the whole globe" means "write ~700 region definitions", which is not a hand job.
//
// Source: https://download.geofabrik.de/index-v1.json, the same hierarchy the extracts
// themselves come from (555 regions, each with a polygon and a .osm.pbf URL). Taking the
// catalogue from there rather than inventing a grid means every region has a name a human
// recognises and an OSM source that already exists.
//
// Three things this does that a naive dump of that file does not:
//
//  1. Sizes every candidate for real (`pmtiles extract --dry-run` against the upstream
//     archives) rather than guessing from bbox area. Area is a poor proxy — measured, a
//     square degree of Switzerland is 108 MB of basemap and a square degree of Montenegro
//     is 31 MB. A region over the cap is subdivided into its Geofabrik children; one with
//     no children left to split is cut into cells, and failing that gets a lower zoom
//     ceiling. Estimates are cached, so a re-run costs nothing and an interrupted run
//     resumes.
//
//  2. Splits regions whose bbox is nonsense. Deriving a bbox from a country polygon gives
//     [-180, …, 180, …] for the US, Russia, New Zealand, Fiji, Kiribati and Alaska — they
//     cross the antimeridian, and `pmtiles extract --bbox` would cut a planet-width strip.
//     Far-flung parts are split into separate regions (Hawaii is not a corner of Alaska's
//     bounding box) and a genuine antimeridian crossing is emitted as two regions.
//
//  3. Keeps hand-written regions. Lochaber and the Cairngorms are curated areas Geofabrik
//     has no equivalent for, and they are already published — dropping them from
//     regions.json would delist them (upload.sh refuses, for good reason). Anything
//     already in regions.json that this did not generate is preserved verbatim.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"ratmap/infra/tools/internal/cli"
	"ratmap/infra/tools/internal/infra"
	"ratmap/infra/tools/internal/num"
)

const indexURL = "https://download.geofabrik.de/index-v1.json"

// Same upstream archives, and the same pinning, as build-region.sh — the estimate has to
// be of the thing that will actually be extracted.
const (
	basemapSource = "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"
	terrainSource = "https://download.mapterhorn.com/planet.pmtiles"
)

// Zoom ceilings, best first. build-region.sh's defaults are the first of each; a region
// too big to split drops down this list rather than shipping a 40 GB download.
//
// Dropping a basemap level costs roughly 4x the detail and is not free: paths carry
// min_zoom 14 in the Protomaps schema, so z13 is where a walking map stops being one.
// That is why subdivision is tried first and this is the fallback.
var (
	basemapZooms = []int{15, 14, 13}
	terrainZooms = []int{11, 10, 9}
)

// Per-artifact cap. Both artifacts download together, so the real ceiling a user sees is
// about twice this. 900 MB is already a long download on hill signal; it exists to stop a
// region being impossible, not to make it comfortable.
const defaultMaxBytes = 900_000_000

// Below this, a longitude span is not a region — it is a framing artefact.
const degenerateDegrees = 0.01

// Two polygon parts further apart than this become separate regions. Hawaii sits 4000 km
// off the US mainland: one bbox around both is 20,000 square degrees of empty Pacific.
const partGapDegrees = 5.0

var units = map[string]float64{"B": 1, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}

// retiredIDs were published and then withdrawn. Never reuse one: the filename is the OPFS
// key (C3), nothing on the client verifies the sha256 the manifest records, and
// `regionStatus` is "is a file with this name present". So a new region reusing a retired
// id is served from whatever the old archive was, forever, on every device that had it —
// the wrong-tiles failure C3 exists to prevent, arriving through time instead of through a
// name collision. A generated region wanting one of these gets the `-region` suffix.
var retiredIDs = set("lochaber", "cairngorms", "scotland", "montenegro")

// excludedIDs are regions deliberately left out of the catalogue, with everything beneath
// them. Not a technical exclusion — the pipeline handles them — but a decision about what
// is worth building and hosting. They are also the three most expensive things in the
// catalogue: Russia's ten federal districts alone measured 176 cells and 115.6 GB once
// split to full detail. summarise prints what this omitted, so a hole in world coverage
// is a line in the output rather than something you notice on a hill.
var excludedIDs = set(
	"russia",        // 10 federal districts -> 176 cells
	"us",            // 53 state extracts
	"south-america", // 12 countries
	"england",       // 47 counties -> hand-grouped into 9 official regions instead
	// (england-north-east, ..., england-south-west in regions.json); Geofabrik has no
	// tier between the whole country and county level.
	"scotland", // childless leaf, but already a manual (no-geofabrikId) entry in
	// regions.json — excluded so a regen doesn't generate a second, `-region`-suffixed
	// copy of the same ground. See the montenegro incident this same rename mechanism
	// produced (2026-09).
	"wales", // same reasoning as scotland, also a manual entry
)

// aggregateIDs are Geofabrik convenience extracts that are unions of regions it also
// publishes separately. Listing both would offer the same ground twice — a user
// downloading `alps` and then `switzerland` pays for Switzerland twice and gets two
// archives fighting over the same map. Each of these is fully covered by its
// constituents, which stay in.
//
// Deliberately explicit rather than inferred: bbox containment cannot tell an aggregate
// from a neighbour, and India's bbox contains Nepal, Bhutan, Bangladesh and Sri Lanka
// without being an aggregate of any of them. summarise prints an overlap report so a new
// aggregate in a future index shows up for review rather than passing silently.
var aggregateIDs = set(
	"alps",                                                            // = at + ch + de-south + fr-east + it-north + li + si
	"britain-and-ireland",                                             // = great-britain + ireland-and-northern-ireland
	"dach",                                                            // = germany + austria + switzerland
	"great-britain",                                                   // = great-britain + the NI part of ireland-and-northern-ireland
	"south-africa-and-lesotho",                                        // = south-africa + lesotho
	"sea",                                                             // South-East Asia: = indonesia + malaysia-... + thailand + ...
	"us-midwest", "us-northeast", "us-pacific", "us-south", "us-west", // = us/<state> sets
)

func set(xs ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func sortedKeys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// failure is a refusal: the message printed on its own, exit status 1.
type failure string

func (f failure) Error() string { return string(f) }

// paths are where the catalogue's files live: regions.json in infra/, the caches in
// RATMAP_CACHE (set by the Docker image to the /work volume — a containerised run would
// otherwise write its measurement cache to the container's own layer and throw away
// hours of dry runs the moment the container exits) or infra/.cache.
type paths struct {
	infra, cache, indexCache, estimateCache, regionsJSON string
}

func pathsFor(infraDir string) paths {
	cache := os.Getenv("RATMAP_CACHE")
	if cache == "" {
		cache = filepath.Join(infraDir, ".cache")
	}
	return paths{infraDir, cache, filepath.Join(cache, "geofabrik-index.json"),
		filepath.Join(cache, "catalog-estimates.json"), filepath.Join(infraDir, "regions.json")}
}

const usage = `usage: build-catalog [flags]`

func main() {
	fs := flag.NewFlagSet("build-catalog", flag.ExitOnError)
	maxBytes := fs.Float64("max-bytes", defaultMaxBytes, "per-artifact cap in bytes; a region over it is subdivided")
	noEstimate := fs.Bool("no-estimate", false, "guess sizes from bbox area instead of measuring — fast, and wrong by 3x")
	maxDepth := fs.Int("max-depth", 3, "how many times a region with no children may be quartered to fit the cap (3: up to 64 cells)")
	workers := fs.Int("workers", 4, "parallel dry runs")
	refreshIndex := fs.Bool("refresh-index", false, "re-download Geofabrik's index")
	only := fs.String("only", "", "one continent id, for a quick look (implies --print)")
	printOnly := fs.Bool("print", false, "summarise without writing regions.json")
	if args := cli.Parse(fs, usage, os.Args[1:]); len(args) > 0 {
		cli.Fail(fs, "unexpected arguments: %s", strings.Join(args, " "))
	}
	infraDir, err := infra.Dir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-catalog:", err)
		os.Exit(1)
	}
	o := options{
		maxBytes:     int64(*maxBytes),
		estimate:     !*noEstimate,
		maxDepth:     *maxDepth,
		workers:      *workers,
		refreshIndex: *refreshIndex,
		printOnly:    *printOnly,
	}
	if cli.Given(fs)["only"] {
		o.only = only
	}
	if err := run(pathsFor(infraDir), o, os.Stdout, os.Stderr); err != nil {
		var f failure
		if errors.As(err, &f) {
			fmt.Fprintln(os.Stderr, string(f))
		} else {
			fmt.Fprintln(os.Stderr, "build-catalog:", err)
		}
		os.Exit(1)
	}
}

type options struct {
	maxBytes          int64
	estimate          bool
	maxDepth, workers int
	refreshIndex      bool
	only              *string
	printOnly         bool
}

func run(p paths, o options, out, errOut io.Writer) error {
	idx, err := loadIndex(p, o.refreshIndex, errOut)
	if err != nil {
		return err
	}
	est, err := newEstimator(p, o.workers, o.estimate, errOut)
	if err != nil {
		return err
	}
	ov, err := overrides(p)
	if err != nil {
		return err
	}
	var generated []*genRegion
	err = func() error {
		caps := map[string]int64{}
		for _, id := range ov.order {
			if v, ok := ov.byID[id]["maxBytes"]; ok {
				n, err := strconv.ParseInt(string(bytes.TrimSpace(v)), 10, 64)
				if err != nil {
					return fmt.Errorf("regions.json: %s: maxBytes %s is not a whole number", id, v)
				}
				caps[id] = n
			}
		}
		accepted, err := walk(idx, est, o.maxBytes, o.only, caps)
		if err != nil {
			return err
		}
		generated, err = buildRegions(idx, accepted, est, o.maxBytes, caps, o.maxDepth, ov)
		return err
	}()
	// Saved whatever happened: an interrupted run keeps the measurements it made.
	if serr := est.save(false); err == nil {
		err = serr
	}
	if err != nil {
		return err
	}

	records, manual, err := mergeWithManual(p, generated, ov)
	if err != nil {
		return err
	}
	if err := summarise(out, records, manual, est); err != nil {
		return err
	}

	if o.printOnly || o.only != nil {
		fmt.Fprintln(out, "\n(--print: regions.json not written)")
		return nil
	}
	text, err := dumps(records)
	if err != nil {
		return err
	}
	// Written in place, deliberately. compose.yml bind-mounts this single file into the
	// container, and a write-to-temp-then-rename would replace the inode the mount is
	// pinned to — the container would see its own new file and the host's copy would
	// never change, which is the whole point of running the generator there.
	if err := os.WriteFile(p.regionsJSON, []byte(text), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "\nwrote %s\n", p.regionsJSON)
	return nil
}

// ---------------------------------------------------------------------------- index

type index struct {
	features map[string]*feature
	order    []string // feature ids in file order
	// children by parent id; "" is the top level (no parent). Values in index order.
	children map[string][]string
}

// feature is one region of Geofabrik's index.
type feature struct {
	Properties featureProps `json:"properties"`
	Geometry   struct {
		Type        string `json:"type"`
		Coordinates any    `json:"coordinates"` // nested lists of [lon, lat]
	} `json:"geometry"`
}

type featureProps struct {
	ID     string `json:"id"`
	Parent string `json:"parent"`
	Name   string `json:"name"`
	URLs   struct {
		PBF string `json:"pbf"`
	} `json:"urls"`
}

func loadIndex(p paths, refresh bool, errOut io.Writer) (*index, error) {
	if _, err := os.Stat(p.indexCache); refresh || err != nil {
		if err := os.MkdirAll(p.cache, 0o755); err != nil {
			return nil, err
		}
		fmt.Fprintf(errOut, "fetching %s\n", indexURL)
		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Get(indexURL)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("%s: HTTP %d", indexURL, resp.StatusCode)
		}
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(p.indexCache, data, 0o644); err != nil {
			return nil, err
		}
	}
	data, err := os.ReadFile(p.indexCache)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Features []*feature `json:"features"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", p.indexCache, err)
	}
	idx := &index{features: map[string]*feature{}, children: map[string][]string{}}
	for _, f := range doc.Features {
		id := f.Properties.ID
		if _, seen := idx.features[id]; !seen {
			idx.order = append(idx.order, id)
		}
		idx.features[id] = f
	}
	for _, f := range doc.Features {
		id := f.Properties.ID
		if aggregateIDs[id] || excludedIDs[id] {
			continue
		}
		parent := effectiveParent(id, &f.Properties, idx.features)
		idx.children[parent] = append(idx.children[parent], id)
	}
	if err := checkAggregates(idx.children); err != nil {
		return nil, err
	}
	return idx, nil
}

// checkAggregates refuses an aggregate that has children: dropping it drops the subtree.
//
// `united-kingdom` sat in the aggregates on the reasoning that `great-britain` covers the
// same ground. It does — but great-britain is the childless union, and united-kingdom is
// where England, Scotland and Wales hang. Listing the parent deleted all three from the
// catalogue and left a single 1.1 GB Great Britain capped at basemap z13, which is the
// zoom that generalises away nearly every path. Ben Nevis lost its paths to a one-line
// mistake in a set literal, and nothing said a word.
func checkAggregates(children map[string][]string) error {
	var detail []string
	for _, a := range sortedKeys(aggregateIDs) {
		if kids := children[a]; len(kids) > 0 {
			k := append([]string(nil), kids...)
			sort.Strings(k)
			detail = append(detail, fmt.Sprintf("      %s -> %s", a, strings.Join(k, ", ")))
		}
	}
	if len(detail) == 0 {
		return nil
	}
	return failure("FAIL: these AGGREGATE_IDS have children, so dropping them drops the children too:\n" +
		strings.Join(detail, "\n") + "\n" +
		"      List the childless union instead, or move it to EXCLUDED_IDS if the omission is deliberate.")
}

// effectiveParent is the containing region, which Geofabrik's `parent` field is not
// always. The 53 US state extracts are ids of the form `us/alabama` but carry
// `parent: north-america` — as siblings of `us`, not children of it. Taken at face value
// the catalogue would list the whole United States *and* every state, publishing the same
// ground twice at two zoom levels. The id path is the real hierarchy wherever it exists.
func effectiveParent(id string, p *featureProps, features map[string]*feature) string {
	if i := strings.LastIndex(id, "/"); i >= 0 {
		if _, ok := features[id[:i]]; ok {
			return id[:i]
		}
	}
	return p.Parent
}

type box [4]float64 // west, south, east, north

func polygonParts(f *feature) []any {
	c := f.Geometry.Coordinates
	if list, ok := c.([]any); ok && f.Geometry.Type == "MultiPolygon" {
		return list
	}
	return []any{c}
}

func partBBox(part any) box {
	b := box{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	var walk func(any)
	walk = func(node any) {
		list, _ := node.([]any)
		if len(list) == 0 {
			return
		}
		if x, ok := list[0].(float64); ok {
			y, _ := list[1].(float64)
			b[0], b[1], b[2], b[3] = math.Min(b[0], x), math.Min(b[1], y), math.Max(b[2], x), math.Max(b[3], y)
			return
		}
		for _, child := range list {
			walk(child)
		}
	}
	walk(part)
	return b
}

func union(boxes []box) box {
	u := boxes[0]
	for _, b := range boxes[1:] {
		u = box{math.Min(u[0], b[0]), math.Min(u[1], b[1]), math.Max(u[2], b[2]), math.Max(u[3], b[3])}
	}
	return u
}

func area(b box) float64 { return (b[2] - b[0]) * (b[3] - b[1]) }

// ------------------------------------------------------------------- bbox splitting

type interval struct {
	lo, hi float64
	b      box
}

// cluster groups intervals, starting a new group on a gap wider than `gap`.
func cluster(values []interval, gap float64) [][]interval {
	sorted := append([]interval(nil), values...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].lo < sorted[j].lo })
	var groups [][]interval
	for _, it := range sorted {
		if len(groups) > 0 {
			last := groups[len(groups)-1]
			hi := math.Inf(-1)
			for _, g := range last {
				hi = math.Max(hi, g.hi)
			}
			if it.lo-hi <= gap {
				groups[len(groups)-1] = append(last, it)
				continue
			}
		}
		groups = append(groups, []interval{it})
	}
	return groups
}

// regionBoxes is the bounding boxes to extract for one Geofabrik region, largest first.
//
// Usually one. More when the region has parts an ocean apart, or crosses the
// antimeridian — `pmtiles extract` takes west < east and cannot wrap, so a crossing has to
// become two extracts rather than one box spanning the entire planet the wrong way round.
func regionBoxes(f *feature) ([]box, error) {
	var boxes []box
	for _, p := range polygonParts(f) {
		boxes = append(boxes, partBBox(p))
	}

	// Re-express longitudes as 0..360 and keep whichever framing is narrower. A country
	// sitting either side of the antimeridian is compact in the shifted frame and
	// planet-wide in the normal one; everything else is the reverse.
	shift := func(v float64) float64 {
		if v < 0 {
			return v + 360
		}
		return v
	}
	shifted := make([]box, len(boxes))
	inverted := false
	for i, b := range boxes {
		shifted[i] = box{shift(b[0]), b[1], shift(b[2]), b[3]}
		// A part that itself straddles the prime meridian comes out inverted when
		// shifted; such a part can't be crossing the antimeridian, so leave the frame.
		if shifted[i][0] > shifted[i][2] {
			inverted = true
		}
	}
	su, bu := union(shifted), union(boxes)
	shiftedWidth := su[2] - su[0]
	// A ring that goes all the way round the globe — Antarctica — has longitudes spanning
	// exactly -180..180, which the shifted frame collapses to zero width. That reads as the
	// narrowest possible framing and wins, producing `180,-90,180,-60`: a box with no width
	// at all, which extracts a handful of tiles into an archive that fails verification
	// an hour into a build. A circumpolar region covers every longitude and must keep the
	// full-width frame.
	useShifted := !inverted && shiftedWidth > degenerateDegrees && shiftedWidth < bu[2]-bu[0]
	frame := boxes
	if useShifted {
		frame = shifted
	}

	var split []box
	var lonItems []interval
	for _, b := range frame {
		lonItems = append(lonItems, interval{b[0], b[2], b})
	}
	for _, lonGroup := range cluster(lonItems, partGapDegrees) {
		var latItems []interval
		for _, it := range lonGroup {
			latItems = append(latItems, interval{it.b[1], it.b[3], it.b})
		}
		for _, latGroup := range cluster(latItems, partGapDegrees) {
			var members []box
			for _, it := range latGroup {
				members = append(members, it.b)
			}
			split = append(split, union(members))
		}
	}

	var out []box
	for _, b := range split {
		west, south, east, north := b[0], b[1], b[2], b[3]
		unshift := func(v float64) float64 {
			if v > 180 {
				return v - 360
			}
			return v
		}
		switch {
		case useShifted && west < 180 && 180 < east:
			// Genuinely crosses the antimeridian: two extracts, meeting at the line.
			out = append(out, box{unshift(west), south, 180.0, north}, box{-180.0, south, east - 360, north})
		case useShifted:
			out = append(out, box{unshift(west), south, unshift(east), north})
		default:
			out = append(out, b)
		}
	}
	for i := range out {
		for j := range out[i] {
			out[i][j] = num.Round(out[i][j], 4)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return area(out[i]) > area(out[j]) })

	// Checked here rather than trusted downstream. An invalid box costs a download and an
	// `ls`-plausible archive before `pmtiles verify` rejects it — and that is the good
	// case, hours into a run. The generator is where it is cheap to notice.
	for _, b := range out {
		west, south, east, north := b[0], b[1], b[2], b[3]
		if !(west < east && south < north && -180 <= west && east <= 180 && -90 <= south && north <= 90) {
			return nil, failure(fmt.Sprintf("FAIL: %s produced an invalid bbox %s.\n      west<east, south<north, and within [-180,180]/[-90,90].",
				f.Properties.ID, bboxText(b)))
		}
	}
	return out, nil
}

// bboxText is a box for a message, as regions.json would write it.
func bboxText(b box) string {
	parts := make([]string, 4)
	for i, v := range b {
		parts[i] = strconv.FormatFloat(v, 'f', -1, 64)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

var compass = []struct {
	sx, sy int
	name   string
}{
	{0, 1, "north"}, {0, -1, "south"}, {1, 0, "east"}, {-1, 0, "west"},
	{1, 1, "north-east"}, {-1, 1, "north-west"},
	{1, -1, "south-east"}, {-1, -1, "south-west"},
}

// compassLabel is where b sits relative to the region's main body, as a name and an id
// suffix.
func compassLabel(b, primary box) (string, string) {
	dx := (b[0]+b[2])/2 - (primary[0]+primary[2])/2
	dy := (b[1]+b[3])/2 - (primary[1]+primary[3])/2
	span := math.Max(math.Abs(dx), math.Abs(dy))
	if span == 0 {
		span = 1
	}
	sign := func(d float64) int {
		switch {
		case math.Abs(d) < span/2:
			return 0
		case d > 0:
			return 1
		}
		return -1
	}
	sx, sy := sign(dx), sign(dy)
	name := "outlying"
	for _, c := range compass {
		if c.sx == sx && c.sy == sy {
			name = c.name
			break
		}
	}
	var suffix strings.Builder
	for _, w := range strings.Split(name, "-") {
		suffix.WriteByte(w[0])
	}
	return name, suffix.String()
}

// ---------------------------------------------------------------------- estimating

var sizeRE = regexp.MustCompile(`archive size of ([\d.]+)\s*(TB|GB|MB|kB|B)\b`)

// parseSize reads bytes from `pmtiles extract --dry-run`'s closing line, ok=false if it
// said nothing.
func parseSize(text string) (int64, bool) {
	m := sizeRE.FindStringSubmatch(text)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	return int64(f * units[m[2]]), true
}

// estimator holds measured extract sizes, cached on disk.
//
// A dry run is two to twenty seconds of range requests against a 135 GB archive, and the
// walk asks for hundreds of them. Caching by (source, bbox, zoom) makes a re-run free and
// lets an interrupted one resume — which matters, because the first full pass takes an
// hour or two.
type estimator struct {
	p       paths
	enabled bool
	workers int
	errOut  io.Writer
	mu      sync.Mutex
	cache   map[string]int64
	misses  int
}

func newEstimator(p paths, workers int, enabled bool, errOut io.Writer) (*estimator, error) {
	e := &estimator{p: p, enabled: enabled, workers: workers, errOut: errOut, cache: map[string]int64{}}
	data, err := os.ReadFile(p.estimateCache)
	if err == nil {
		if err := json.Unmarshal(data, &e.cache); err != nil {
			return nil, fmt.Errorf("%s: %w", p.estimateCache, err)
		}
	}
	return e, nil
}

type request struct {
	source string
	b      box
	zoom   int
}

// key is the cache key: the kind, the bbox to six significant digits (%g), and the zoom.
// Changing how it is spelled would take every cached measurement again.
func key(r request) string {
	kind := "terrain"
	if r.source == basemapSource {
		kind = "basemap"
	}
	return fmt.Sprintf("%s|%s|z%d", kind, bboxArg(r.b), r.zoom)
}

func bboxArg(b box) string {
	parts := make([]string, 4)
	for i, v := range b {
		parts[i] = strconv.FormatFloat(v, 'g', 6, 64)
	}
	return strings.Join(parts, ",")
}

func (e *estimator) cached(k string) (int64, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	n, ok := e.cache[k]
	return n, ok
}

// measure is guessed from bbox area when estimation is off, measured otherwise.
func (e *estimator) measure(r request) (int64, error) {
	if !e.enabled {
		perSqDegree, zooms := 12e6, terrainZooms
		if r.source == basemapSource {
			perSqDegree, zooms = 40e6, basemapZooms
		}
		shrink := math.Pow(4, float64(zooms[0]-r.zoom))
		return int64(area(r.b) * perSqDegree / shrink), nil
	}
	k := key(r)
	if n, ok := e.cached(k); ok {
		return n, nil
	}

	// Retried, because a single failure must not end a run of thousands of measurements.
	// Four concurrent extracts over a 135 GB archive occasionally have one die with no
	// output at all — rerun by hand and it succeeds — and losing an hour of measurement to
	// that would be absurd.
	var size int64
	got := false
	var lastOut, lastErr string
	for attempt := 0; attempt < 3; attempt++ {
		cmd := exec.Command("pmtiles", "extract", r.source, "/dev/null",
			"--bbox="+bboxArg(r.b), fmt.Sprintf("--maxzoom=%d", r.zoom), "--dry-run")
		var stdout, stderr strings.Builder
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		runErr := cmd.Run()
		lastOut, lastErr = stdout.String(), stderr.String()
		if n, ok := parseSize(lastOut + lastErr); ok {
			size, got = n, true
			break
		}
		if runErr == nil {
			// An all-ocean bbox has nothing to extract and says so.
			size, got = 0, true
			break
		}
		time.Sleep(time.Duration(2*(attempt+1)) * time.Second)
	}
	if !got {
		msg := strings.TrimSpace(lastErr)
		if lastErr == "" {
			msg = strings.TrimSpace(lastOut)
		}
		if msg == "" {
			msg = "(no output)"
		}
		return 0, failure(fmt.Sprintf("FAIL: pmtiles extract could not size %s in 3 attempts:\n%s", k, msg))
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cache[k] = size
	e.misses++
	// Checkpoint as we go. The first full pass is an hour of range requests against two
	// archives; losing it to a Ctrl-C or a dropped connection would mean starting from
	// nothing.
	if e.misses%25 == 0 {
		if err := e.save(true); err != nil {
			return 0, err
		}
	}
	return size, nil
}

// warm measures a batch in parallel, so the walk's per-level work isn't serialised.
func (e *estimator) warm(reqs []request) error {
	var pending []request
	for _, r := range reqs {
		if _, ok := e.cached(key(r)); !ok {
			pending = append(pending, r)
		}
	}
	if len(pending) == 0 || !e.enabled {
		return nil
	}
	fmt.Fprintf(e.errOut, "  measuring %d candidate(s)...\n", len(pending))
	errs := make([]error, len(pending))
	next := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < max(1, e.workers); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				_, errs[i] = e.measure(pending[i])
			}
		}()
	}
	for i := range pending {
		next <- i
	}
	close(next)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return e.save(false)
}

// save writes the cache, one key a line in sorted order so that it diffs. locked: the
// caller already holds the lock.
func (e *estimator) save(locked bool) error {
	if !e.enabled {
		return nil
	}
	if err := os.MkdirAll(e.p.cache, 0o755); err != nil {
		return err
	}
	if !locked {
		e.mu.Lock()
		defer e.mu.Unlock()
	}
	text, err := json.MarshalIndent(e.cache, "", "")
	if err != nil {
		return err
	}
	return os.WriteFile(e.p.estimateCache, text, 0o644)
}

// ------------------------------------------------------------------------- walking

// topLevel is the continent-level ancestor — the group a region is listed under, and the
// OSM extract its peaks and search come from. Geofabrik has *nine* of these, not eight:
// Russia is its own top-level file, not part of europe or asia.
func topLevel(idx *index, id string) (*featureProps, error) {
	p := &idx.features[id].Properties
	for p.Parent != "" {
		f, ok := idx.features[p.Parent]
		if !ok {
			return nil, fmt.Errorf("index: %s's parent %q is not in the index", p.ID, p.Parent)
		}
		p = &f.Properties
	}
	return p, nil
}

func largestBasemap(est *estimator, boxes []box) (int64, error) {
	var largest int64 = math.MinInt64
	for _, b := range boxes {
		n, err := est.measure(request{basemapSource, b, basemapZooms[0]})
		if err != nil {
			return 0, err
		}
		largest = max(largest, n)
	}
	return largest, nil
}

// walk descends the hierarchy, subdividing anything too big to be one download.
// Breadth-first by level, so every candidate at a level can be measured in parallel;
// depth-first would serialise the slowest part of the run behind itself.
func walk(idx *index, est *estimator, maxBytes int64, only *string, caps map[string]int64) ([]string, error) {
	var frontier []string
	for _, t := range idx.children[""] {
		if only != nil && t != *only {
			continue
		}
		// Antarctica has no children, so it stands as its own candidate.
		if kids, ok := idx.children[t]; ok {
			frontier = append(frontier, kids...)
		} else {
			frontier = append(frontier, t)
		}
	}
	var accepted []string
	for level := 1; len(frontier) > 0; level++ {
		boxes := map[string][]box{}
		var reqs []request
		for _, id := range frontier {
			b, err := regionBoxes(idx.features[id])
			if err != nil {
				return nil, err
			}
			boxes[id] = b
		}
		fmt.Fprintf(est.errOut, "level %d: %d candidate(s)\n", level, len(frontier))
		for _, id := range frontier {
			for _, b := range boxes[id] {
				reqs = append(reqs, request{basemapSource, b, basemapZooms[0]})
			}
		}
		if err := est.warm(reqs); err != nil {
			return nil, err
		}
		var next []string
		for _, id := range frontier {
			largest, err := largestBasemap(est, boxes[id])
			if err != nil {
				return nil, err
			}
			limit, ok := caps[safeID(id)]
			if !ok {
				limit = maxBytes
			}
			if kids := idx.children[id]; largest > limit && len(kids) > 0 {
				next = append(next, kids...)
			} else {
				accepted = append(accepted, id)
			}
		}
		frontier = next
	}
	return accepted, nil
}

// chooseZoom is the highest zoom that keeps this artifact under the cap.
//
// Only reached for a region with nothing left to subdivide into — Antarctica, or a state
// that is simply large. Shipping it at a lower zoom is better than shipping a download
// nobody can complete, and the manifest records the real zoom range, so the app already
// tells the user what detail they actually have.
func chooseZoom(est *estimator, source string, zooms []int, b box, maxBytes int64) (int, int64, error) {
	var size int64
	for _, z := range zooms {
		n, err := est.measure(request{source, b, z})
		if err != nil {
			return 0, 0, err
		}
		size = n
		if size <= maxBytes {
			return z, size, nil
		}
	}
	return zooms[len(zooms)-1], size, nil
}

// cleanName tidies a Geofabrik name, which carries markup and sometimes just repeats the
// id. Written out rather than with regexp, whose \s is only ASCII space: a name can hold a
// no-break space.
func cleanName(p *featureProps) string {
	name := collapseSpaces(strings.TrimSpace(replaceBr(p.Name)))
	if name == p.ID || strings.Contains(name, "/") {
		last := name[strings.LastIndex(name, "/")+1:]
		name = capitalizeWords(strings.ReplaceAll(last, "-", " "))
	}
	return name
}

// capitalizeWords upper-cases the first letter of each space-separated word and
// lower-cases the rest: "new york" is "New York".
func capitalizeWords(s string) string {
	var b strings.Builder
	start := true
	for _, r := range s {
		switch {
		case r == ' ':
			start = true
		case start:
			r, start = unicode.ToUpper(r), false
		default:
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// replaceBr replaces each <br>, <br/> and <br /> with a space.
func replaceBr(s string) string {
	var b strings.Builder
	r := []rune(s)
	for i := 0; i < len(r); {
		if i+3 <= len(r) && string(r[i:i+3]) == "<br" {
			j := i + 3
			for j < len(r) && unicode.IsSpace(r[j]) {
				j++
			}
			if j < len(r) && r[j] == '/' {
				j++
			}
			if j < len(r) && r[j] == '>' {
				b.WriteByte(' ')
				i = j + 1
				continue
			}
		}
		b.WriteRune(r[i])
		i++
	}
	return b.String()
}

// collapseSpaces replaces each run of spaces with one.
func collapseSpaces(s string) string {
	var b strings.Builder
	inSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// safeID is the id as a filename, an OPFS key and a TileSourceRegistry key (C3): lower
// case, each run of anything but a-z, 0-9 and - as one -, and no - at either end.
func safeID(id string) string {
	var b strings.Builder
	inRun := false
	for _, r := range strings.ToLower(id) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
			inRun = false
			continue
		}
		if !inRun {
			b.WriteByte('-')
		}
		inRun = true
	}
	return strings.Trim(b.String(), "-")
}

// ---------------------------------------------------------------------- assembling

func quadrants(b box) []box {
	west, south, east, north := b[0], b[1], b[2], b[3]
	midX, midY := (west+east)/2, (south+north)/2
	return []box{
		{west, midY, midX, north},
		{midX, midY, east, north},
		{west, south, midX, midY},
		{midX, south, east, midY},
	}
}

// cellLabel is a cell's name and id suffix, from where its centre is.
//
// Coordinates rather than a sequence number, because these are filenames (C3): numbering
// cells means a region that gains one cell renumbers all the ones after it, and every
// already-downloaded archive after that point silently becomes the wrong region.
func cellLabel(b box) (string, string) {
	lng, lat := (b[0]+b[2])/2, (b[1]+b[3])/2
	ns, ew := "N", "E"
	if lat < 0 {
		ns = "S"
	}
	if lng < 0 {
		ew = "W"
	}
	return fmt.Sprintf("%.0f°%s %.0f°%s", math.Abs(lat), ns, math.Abs(lng), ew),
		fmt.Sprintf("%s%02.0f%s%03.0f", strings.ToLower(ns), math.Abs(lat), strings.ToLower(ew), math.Abs(lng))
}

type source struct {
	url   string
	zooms []int
}

// splitToFit cuts boxes down to cells that fit the cap at full detail.
//
// The hierarchy runs out long before the size problem does: Geofabrik has nothing below
// the Siberian Federal District, Greenland or Nunavut's Qikiqtaaluk region, and each of
// those is several GB even after the zoom ladder has taken a level of detail away twice.
// A grid split is the only tool left, and it is the better one — it keeps full zoom and
// hands someone the part of Siberia they are actually walking in.
//
// Cells with nothing in them are dropped, which is most of what a quadtree over Greenland
// or the Arctic archipelago produces. That is also why this splits on measurements rather
// than on area: an empty quadrant costs nothing and disappears, so the cells that survive
// are the inhabited ones.
//
// split is false when the boxes were already fine, so a region that never needed cutting
// keeps its plain name and id.
func splitToFit(boxes []box, est *estimator, limit int64, maxDepth int, withTerrain bool) ([]box, bool, error) {
	level := append([]box(nil), boxes...)
	var done []box
	split := false
	sources := []source{{basemapSource, basemapZooms}}
	if withTerrain {
		sources = append(sources, source{terrainSource, terrainZooms})
	}
	for depth := 0; depth <= maxDepth; depth++ {
		var reqs []request
		for _, b := range level {
			for _, s := range sources {
				reqs = append(reqs, request{s.url, b, s.zooms[0]})
			}
		}
		if err := est.warm(reqs); err != nil {
			return nil, false, err
		}
		var next []box
		for _, b := range level {
			var size int64 = math.MinInt64
			for _, s := range sources {
				n, err := est.measure(request{s.url, b, s.zooms[0]})
				if err != nil {
					return nil, false, err
				}
				size = max(size, n)
			}
			if depth > 0 && size == 0 {
				continue // an empty quadrant: ocean, ice, or off the edge of the data
			}
			if size > limit && depth < maxDepth {
				next = append(next, quadrants(b)...)
				split = true
			} else {
				done = append(done, b)
			}
		}
		level = next
		if len(level) == 0 {
			break
		}
	}
	// Anything still over the cap at max depth stays, and takes the zoom ladder instead.
	out := append(done, level...)
	sort.SliceStable(out, func(i, j int) bool { return area(out[i]) > area(out[j]) })
	return out, split, nil
}

// overrideSet is the per-region decisions in regions.json that a regeneration must not
// overwrite, by id in file order.
//
// All of these are human calls the generator has no way to make. `contours` says a region
// is worth the most expensive artifact in the pipeline; `avalanche` says its terrain is
// the kind people are killed by in winter — a claim about snow climate and use, not about
// topography, so nothing in Geofabrik's index can imply it; `terrain: false` says the
// opposite about hillshade (Antarctica's is 101 GB at z11, spanning every longitude);
// `maxBytes` says a region is worth more than the default cap — Switzerland's basemap is
// 980 MB at z15, and dropping it to z14 to stay under 900 MB trades away detail over the
// Alps to save 20% of a download people take on wifi before a trip.
type overrideSet struct {
	byID  map[string]map[string]json.RawMessage
	order []string
}

var overrideKeys = []string{"contours", "avalanche", "maxBytes", "terrain"}

func overrides(p paths) (overrideSet, error) {
	o := overrideSet{byID: map[string]map[string]json.RawMessage{}}
	regions, err := existingRegions(p)
	if err != nil || regions == nil {
		return o, err
	}
	for _, r := range regions {
		kept := map[string]json.RawMessage{}
		for _, k := range overrideKeys {
			if v, ok := r.fields[k]; ok {
				kept[k] = v
			}
		}
		if _, seen := o.byID[r.ID]; !seen {
			o.order = append(o.order, r.ID)
		}
		o.byID[r.ID] = kept
	}
	return o, nil
}

// skipsTerrain is the ids whose override says `terrain: false` — exactly false.
func (o overrideSet) skipsTerrain() map[string]bool {
	s := map[string]bool{}
	for id, over := range o.byID {
		if string(bytes.TrimSpace(over["terrain"])) == "false" {
			s[id] = true
		}
	}
	return s
}

// existing is a region already in regions.json: its text as written, and its fields.
type existing struct {
	raw    json.RawMessage
	fields map[string]json.RawMessage
	ID     string
}

// existingRegions is regions.json's regions, or nil if there is no regions.json.
func existingRegions(p paths) ([]existing, error) {
	data, err := os.ReadFile(p.regionsJSON)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		Regions []json.RawMessage `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", p.regionsJSON, err)
	}
	out := []existing{}
	for _, raw := range doc.Regions {
		e := existing{raw: raw}
		if err := json.Unmarshal(raw, &e.fields); err != nil {
			return nil, fmt.Errorf("%s: %w", p.regionsJSON, err)
		}
		json.Unmarshal(e.fields["id"], &e.ID)
		out = append(out, e)
	}
	return out, nil
}

// genRegion is a region this generates, its fields in the order regions.json has always
// had them. The overrides are whatever regions.json said, carried over as written.
type genRegion struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	BBox        box    `json:"bbox"`
	OSMExtract  string `json:"osmExtract"`
	Group       string `json:"group"`
	GeofabrikID string `json:"geofabrikId"`
	// Advisory: what `pmtiles extract --dry-run` says this will weigh. The manifest
	// carries the real byte counts once built; this is for deciding what to build and in
	// what order.
	EstimatedBytes int64           `json:"estimatedBytes"`
	BasemapMaxzoom int             `json:"basemapMaxzoom,omitempty"`
	TerrainMaxzoom int             `json:"terrainMaxzoom,omitempty"`
	Contours       json.RawMessage `json:"contours,omitempty"`
	Avalanche      json.RawMessage `json:"avalanche,omitempty"`
	MaxBytes       json.RawMessage `json:"maxBytes,omitempty"`
	Terrain        json.RawMessage `json:"terrain,omitempty"`
}

func buildRegions(idx *index, accepted []string, est *estimator, maxBytes int64, caps map[string]int64,
	maxDepth int, ov overrideSet) ([]*genRegion, error) {
	boxesBy := map[string][]box{}
	for _, gid := range accepted {
		b, err := regionBoxes(idx.features[gid])
		if err != nil {
			return nil, err
		}
		boxesBy[gid] = b
	}
	skips := ov.skipsTerrain()

	// Terrain has not been measured for anything yet — the walk only needed basemap
	// sizes. Warmed as one parallel batch, because the passes below would otherwise ask
	// for several hundred dry runs one at a time.
	var reqs []request
	for _, gid := range accepted {
		if skips[safeID(gid)] {
			continue
		}
		for _, b := range boxesBy[gid] {
			reqs = append(reqs, request{terrainSource, b, terrainZooms[0]})
		}
	}
	if err := est.warm(reqs); err != nil {
		return nil, err
	}

	// Then cut anything still too big into cells. This is where the regions Geofabrik has
	// no children for stop being 5 GB downloads.
	type cells struct {
		boxes []box
		split bool
	}
	cellsBy := map[string]cells{}
	var every []box
	for _, gid := range accepted {
		limit, ok := caps[safeID(gid)]
		if !ok {
			limit = maxBytes
		}
		c, split, err := splitToFit(boxesBy[gid], est, limit, maxDepth, !skips[safeID(gid)])
		if err != nil {
			return nil, err
		}
		cellsBy[gid] = cells{c, split}
	}
	for _, gid := range accepted {
		every = append(every, cellsBy[gid].boxes...)
	}

	// Finally the fallback ladder, one rung at a time, measuring only the boxes still over
	// the cap at the rung above — the cells that a grid split could not rescue, either
	// because they hit the depth limit or because the data really is that dense. Measured
	// against the smallest cap in play, so a region with its own lower cap still has the
	// rungs below it available. A raised cap simply stops using them.
	smallest := maxBytes
	for _, c := range caps {
		smallest = min(smallest, c)
	}
	for _, s := range []source{{basemapSource, basemapZooms}, {terrainSource, terrainZooms}} {
		over := every
		for i := 0; i+1 < len(s.zooms); i++ {
			var still []box
			for _, b := range over {
				n, err := est.measure(request{s.url, b, s.zooms[i]})
				if err != nil {
					return nil, err
				}
				if n > smallest {
					still = append(still, b)
				}
			}
			over = still
			if len(over) == 0 {
				break
			}
			var rung []request
			for _, b := range over {
				rung = append(rung, request{s.url, b, s.zooms[i+1]})
			}
			if err := est.warm(rung); err != nil {
				return nil, err
			}
		}
	}

	var records []*genRegion
	for _, gid := range accepted {
		p := &idx.features[gid].Properties
		continent, err := topLevel(idx, gid)
		if err != nil {
			return nil, err
		}
		c := cellsBy[gid]
		primary := boxesBy[gid][0]
		baseID := safeID(gid)
		name := cleanName(p)

		var used []string
		for _, b := range c.boxes {
			var label, suffix string
			hasSuffix := false
			switch {
			case c.split:
				// Cells are named for where they are. A region that was cut up has no
				// "main" part to be north-west of.
				label, suffix = cellLabel(b)
				hasSuffix = true
			case b != primary:
				label, suffix = compassLabel(b, primary)
				hasSuffix = true
			}
			regionID, regionName := baseID, name
			if hasSuffix {
				// Two cells can round to the same centre, and two outlying parts can land
				// in the same direction (American Oceania has three clusters, two of them
				// east). Keep ids unique without renumbering the ones already published.
				if contains(used, suffix) {
					n := 0
					for _, u := range used {
						if strings.HasPrefix(u, suffix) {
							n++
						}
					}
					suffix = fmt.Sprintf("%s-%d", suffix, n+1)
					label = label + " " + suffix[len(suffix)-1:]
				}
				used = append(used, suffix)
				regionID, regionName = baseID+"-"+suffix, name+" ("+label+")"
			}

			limit, ok := caps[regionID]
			if !ok {
				if limit, ok = caps[baseID]; !ok {
					limit = maxBytes
				}
			}
			bz, bb, err := chooseZoom(est, basemapSource, basemapZooms, b, limit)
			if err != nil {
				return nil, err
			}
			tz, tb := terrainZooms[0], int64(0)
			if !skips[baseID] {
				if tz, tb, err = chooseZoom(est, terrainSource, terrainZooms, b, limit); err != nil {
					return nil, err
				}
			}

			r := &genRegion{
				ID: regionID, Name: regionName, BBox: b,
				// The *continent* extract, not this region's own. peaks and places are
				// single global artifacts built from the union of these
				// (region-osm-sources); pointing 700 regions at 700 country extracts would
				// make that union a 700-file download instead of a nine-file one, for
				// exactly the same coverage.
				OSMExtract: continent.URLs.PBF, Group: cleanName(continent), GeofabrikID: gid,
				EstimatedBytes: bb + tb,
			}
			if bz != basemapZooms[0] {
				r.BasemapMaxzoom = bz
			}
			if tz != terrainZooms[0] {
				r.TerrainMaxzoom = tz
			}
			records = append(records, r)
		}
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Group != records[j].Group {
			return records[i].Group < records[j].Group
		}
		return records[i].Name < records[j].Name
	})
	return records, nil
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// mergeWithManual keeps every hand-written region, and never reuses one of their ids — or
// a retired one.
//
// Lochaber and the Cairngorms are curated areas with no Geofabrik equivalent, and they are
// published — a regions.json without them would delist them on the next upload. Generated
// regions are identified by `geofabrikId`; anything without one is manual and survives a
// regeneration untouched.
func mergeWithManual(p paths, generated []*genRegion, ov overrideSet) ([]record, []record, error) {
	existing, err := existingRegions(p)
	if err != nil {
		return nil, nil, err
	}
	var manual []record
	for _, r := range existing {
		if _, generated := r.fields["geofabrikId"]; !generated {
			rec, err := recordOf(r.raw)
			if err != nil {
				return nil, nil, err
			}
			manual = append(manual, rec)
		}
	}
	// Human decisions survive a regeneration rather than being silently reset on the next
	// run — see overrides.
	taken := map[string]bool{}
	for _, r := range manual {
		taken[r.ID] = true
	}
	for id := range retiredIDs {
		taken[id] = true
	}
	for _, r := range generated {
		if over, ok := ov.byID[r.ID]; ok {
			r.Contours, r.Avalanche, r.MaxBytes, r.Terrain = over["contours"], over["avalanche"], over["maxBytes"], over["terrain"]
		}
	}
	records := append([]record(nil), manual...)
	for _, r := range generated {
		if taken[r.ID] {
			r.ID += "-region"
		}
		taken[r.ID] = true
		raw, err := json.Marshal(r)
		if err != nil {
			return nil, nil, err
		}
		rec, err := recordOf(raw)
		if err != nil {
			return nil, nil, err
		}
		records = append(records, rec)
	}
	return records, manual, nil
}

// record is a region as written to regions.json — hand-written ones verbatim — and what
// the summary reads of it.
type record struct {
	raw            json.RawMessage
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	BBox           []float64 `json:"bbox"`
	GeofabrikID    *string   `json:"geofabrikId"`
	EstimatedBytes int64     `json:"estimatedBytes"`
	BasemapMaxzoom *int64    `json:"basemapMaxzoom"`
	TerrainMaxzoom *int64    `json:"terrainMaxzoom"`
}

func recordOf(raw json.RawMessage) (record, error) {
	r := record{raw: raw}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("regions.json: %s: %w", raw, err)
	}
	return r, nil
}

// overlaps is the fraction of a covered by b, for flagging a generated duplicate of a
// manual region.
func overlaps(a, b box) float64 {
	w := math.Max(0, math.Min(a[2], b[2])-math.Max(a[0], b[0]))
	h := math.Max(0, math.Min(a[3], b[3])-math.Max(a[1], b[1]))
	if area(a) == 0 {
		return 0
	}
	return (w * h) / area(a)
}

func bboxOf(r record) box {
	var b box
	copy(b[:], r.BBox)
	return b
}

func human(size float64) string {
	for _, unit := range []string{"B", "kB", "MB", "GB", "TB"} {
		if math.Abs(size) < 1000 || unit == "TB" {
			if unit == "B" {
				return fmt.Sprintf("%.0f %s", size, unit)
			}
			return fmt.Sprintf("%.1f %s", size, unit)
		}
		size /= 1000
	}
	return ""
}

const catalogueComment = "Region definitions for the offline download catalogue. bbox is [west, south, east, " +
	"north]. Ids are URL-safe, stable, and become part of artifact filenames, which are " +
	"also TileSourceRegistry keys (C3) — never rename a published one. Entries carrying " +
	"`geofabrikId` are generated by scripts/build-catalog.sh from Geofabrik's index and " +
	"may be regenerated; entries without one are hand-written and are preserved across " +
	"regenerations. `osmExtract` is the continent extract feeding the global peaks and " +
	"places builds (region-osm-sources). `basemapMaxzoom`/`terrainMaxzoom` appear only " +
	"where a region is too large to ship at the default ceiling; `estimatedBytes` is " +
	"advisory, measured by pmtiles extract --dry-run at generation time. `maxBytes` raises " +
	"(or lowers) the per-artifact cap for one region, so a region worth full detail keeps " +
	"it — Switzerland's basemap is 980 MB at z15 and would otherwise drop to z14. " +
	"`contours: true` " +
	"opts a region into the contour build, which is otherwise skipped — it costs roughly " +
	"300 MB of intermediate GeoJSON per square degree and does not scale to a global " +
	"catalogue. `avalanche: true` likewise opts a region into the avalanche terrain " +
	"build (Phase 4.6); it is set for ranges with an avalanche warning service or " +
	"documented avalanche activity, which is a judgement about winter use rather than " +
	"about the shape of the ground."

var (
	cellNameRE  = regexp.MustCompile(`\(\d+\x{00b0}[NS] \d+\x{00b0}[EW]`)
	splitNameRE = regexp.MustCompile(`\((north|south|east|west|outlying)`)
)

func summarise(w io.Writer, records, manual []record, est *estimator) error {
	var generated []record
	for _, r := range records {
		if r.GeofabrikID != nil {
			generated = append(generated, r)
		}
	}
	var total int64
	for _, r := range generated {
		total += r.EstimatedBytes
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "catalogue: %d regions (%d hand-written, %d generated)\n", len(records), len(manual), len(generated))
	fmt.Fprintf(w, "  projected bucket size: %s (basemap + terrain, contours excluded)\n", human(float64(total)))
	if len(generated) > 0 {
		sizes := make([]int64, len(generated))
		for i, r := range generated {
			sizes[i] = r.EstimatedBytes
		}
		sort.Slice(sizes, func(i, j int) bool { return sizes[i] < sizes[j] })
		fmt.Fprintf(w, "  median region: %s\n", human(float64(sizes[len(sizes)/2])))
	}
	if len(excludedIDs) > 0 {
		// Said out loud every run. These are holes in world coverage, and a catalogue that
		// quietly stops at a border is worse than one that never claimed the ground.
		fmt.Fprintf(w, "  excluded by decision: %s (and everything under them)\n", strings.Join(sortedKeys(excludedIDs), ", "))
	}

	type group struct {
		gid     string
		records []record
	}
	var cells []*group
	byGID := map[string]*group{}
	for _, r := range generated {
		if cellNameRE.MatchString(r.Name) {
			gid := *r.GeofabrikID
			g, ok := byGID[gid]
			if !ok {
				g = &group{gid: gid}
				byGID[gid] = g
				cells = append(cells, g)
			}
			g.records = append(g.records, r)
		}
	}
	if len(cells) > 0 {
		n := 0
		for _, g := range cells {
			n += len(g.records)
		}
		fmt.Fprintf(w, "\n  %d region(s) too big for their smallest Geofabrik subdivision, cut into %d cells at full zoom:\n", len(cells), n)
		sorted := append([]*group(nil), cells...)
		sort.SliceStable(sorted, func(i, j int) bool { return len(sorted[i].records) > len(sorted[j].records) })
		for _, g := range sorted[:min(10, len(sorted))] {
			var t, largest int64
			for _, r := range g.records {
				t += r.EstimatedBytes
				largest = max(largest, r.EstimatedBytes)
			}
			fmt.Fprintf(w, "    %-32s %3d cells, %9s total, largest %s\n", g.gid, len(g.records), human(float64(t)), human(float64(largest)))
		}
	}

	var degraded []record
	for _, r := range generated {
		if r.BasemapMaxzoom != nil || r.TerrainMaxzoom != nil {
			degraded = append(degraded, r)
		}
	}
	if len(degraded) > 0 {
		fmt.Fprintf(w, "\n  %d region(s) capped below the default zoom (too large to split further):\n", len(degraded))
		sorted := append([]record(nil), degraded...)
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].EstimatedBytes > sorted[j].EstimatedBytes })
		for _, r := range sorted[:min(10, len(sorted))] {
			bz, tz := int64(basemapZooms[0]), int64(terrainZooms[0])
			if r.BasemapMaxzoom != nil {
				bz = *r.BasemapMaxzoom
			}
			if r.TerrainMaxzoom != nil {
				tz = *r.TerrainMaxzoom
			}
			fmt.Fprintf(w, "    %-32s %9s  (basemap z%d, terrain z%d)\n", r.ID, human(float64(r.EstimatedBytes)), bz, tz)
		}
	}

	var split []record
	for _, r := range generated {
		if splitNameRE.MatchString(r.Name) {
			split = append(split, r)
		}
	}
	if len(split) > 0 {
		fmt.Fprintf(w, "\n  %d region(s) split off a distant or antimeridian-crossing part:\n", len(split))
		for _, r := range split[:min(12, len(split))] {
			fmt.Fprintf(w, "    %-32s %s\n", r.ID, r.Name)
		}
	}

	for _, m := range manual {
		for _, g := range generated {
			if overlaps(bboxOf(m), bboxOf(g)) > 0.95 && overlaps(bboxOf(g), bboxOf(m)) > 0.95 {
				fmt.Fprintf(w, "\n  ! %s and %s cover the same ground — consider dropping one\n", m.ID, g.ID)
			}
		}
	}

	type swallow struct {
		outer  string
		inside []string
	}
	var swallowed []swallow
	for i, outer := range generated {
		var inside []string
		for j, inner := range generated {
			if i != j && overlaps(bboxOf(inner), bboxOf(outer)) > 0.9 {
				inside = append(inside, inner.ID)
			}
		}
		if len(inside) >= 3 {
			swallowed = append(swallowed, swallow{outer.ID, inside})
		}
	}
	if len(swallowed) > 0 {
		// Advisory, not automatic. This is the signature of a Geofabrik convenience extract
		// that the aggregates do not yet know about — but it is also the signature of a
		// large country with small neighbours, so it is a prompt to look, not a rule.
		// India's bbox swallows Nepal, Bhutan, Bangladesh and Sri Lanka.
		fmt.Fprintf(w, "\n  %d region(s) whose box contains 3+ others — check for a new aggregate:\n", len(swallowed))
		sort.SliceStable(swallowed, func(i, j int) bool { return len(swallowed[i].inside) > len(swallowed[j].inside) })
		for _, s := range swallowed[:min(8, len(swallowed))] {
			more := ""
			if len(s.inside) > 5 {
				more = " ..."
			}
			fmt.Fprintf(w, "    %-32s contains %d: %s%s\n", s.outer, len(s.inside), strings.Join(s.inside[:min(5, len(s.inside))], ", "), more)
		}
	}

	fmt.Fprintf(w, "\n  largest 10:\n")
	largest := append([]record(nil), generated...)
	sort.SliceStable(largest, func(i, j int) bool { return largest[i].EstimatedBytes > largest[j].EstimatedBytes })
	for _, r := range largest[:min(10, len(largest))] {
		fmt.Fprintf(w, "    %-32s %9s  %s\n", r.ID, human(float64(r.EstimatedBytes)), r.Name)
	}
	if est.enabled {
		fmt.Fprintf(w, "\n  %d new measurement(s); cache: %s\n", est.misses, est.p.estimateCache)
	} else {
		fmt.Fprintln(w, "\n  ! sizes are guessed from bbox area, not measured — re-run without --no-estimate")
	}
	return nil
}

var bboxLineRE = regexp.MustCompile(`\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]`)

// dumps is indented JSON, but with each bbox on one line. Four hundred regions is a file
// people still have to read and diff; a bbox split across four lines turns every one of
// them into a five-line block for no gain.
func dumps(records []record) (string, error) {
	doc := struct {
		Comment string            `json:"comment"`
		Regions []json.RawMessage `json:"regions"`
	}{Comment: catalogueComment}
	for _, r := range records {
		doc.Regions = append(doc.Regions, r.raw)
	}
	var text bytes.Buffer
	enc := json.NewEncoder(&text)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return "", err
	}
	return bboxLineRE.ReplaceAllString(text.String(), "[$1, $2, $3, $4]"), nil
}
