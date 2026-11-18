// Command normalize-routes turns OSM walking route relations into route-tagged ways before
// tippecanoe.
//
//	normalize-routes RELATIONS.opl WAYS.geojsonl OUT.geojsonl
//	normalize-routes --self-test
//
// Named walking routes — the West Highland Way, the GR routes, the Swiss Wanderland routes,
// a village's waymarked loop — are OSM route relations, and neither the Protomaps basemap
// (its `network` is a road shield's, measured on scotland-basemap.pmtiles, 2026-11-18) nor
// `osmium export` turns them into lines: export writes a relation only when it is an area.
// So the member ways come in exported (WAYS, `osmium export -a type,id`) and the relations
// come in as OPL (`osmium cat -f opl,add_metadata=false`), and this joins them. Each way is
// drawn as the most important route it is on, and a route's ways are then joined end to
// end into lines (mergeLines) so its name has room. Each line carries:
//
//   - `network`: iwn, nwn, rwn or lwn — international, national, regional, local, OSM's own
//     levels. A route tagged with any other network (13 Scottish hiking routes say `lcn`) or
//     none (81 in Scotland, 209 in Switzerland — mostly village and town walks) counts as
//     local. The level is OSM's, not a ranking that means the same in every country:
//     Montenegro tags its numbered trails national, Norway most of its routes regional.
//   - `name`: what to label it — the route's name, or its ref where it has none. Italy's CAI
//     trails are numbered rather than named (88% have a ref, 39% a name, Overpass
//     2026-11-18), so a ref is often all there is.
//
// The long trails are stages under a parent: the West Highland Way is a `type=superroute`
// of nine stage relations, and the way should say "West Highland Way", not "Drymen to
// Rowardennan". A parent's name replaces a stage's when the parent is a superroute (or a
// route of routes) with the same `network` tag. Not a `type=network` parent: those are
// collections, and "Jakobswege in Deutschland" would otherwise name Swiss paths. Nor one
// at another level, or a national route that is also part of an E-path would be drawn at
// national level under the E-path's name.
//
// Kept: `type=route` relations with `route=hiking` or `route=foot`, unless
// `state=proposed` (planned, not yet on the ground). A way on several routes takes the
// highest level, then a named route over an unnamed one, then the lowest relation id, so
// the output does not depend on input order. Relations and ways are deduplicated by id
// across concatenated continent extracts, the seam problem normalize-sac documents.
//
// Each feature carries a tippecanoe minzoom: z8 for international, national and regional
// routes, z12 for local ones. Switzerland's 24,494 local relations are its whole
// signposted network cut signpost to signpost; drawn from z8 they would bury the map.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/osmpoint"
	"ratmap/infra/tools/internal/rawjson"
)

// networks, most important first: a way's rank is its index here.
var networks = []string{"iwn", "nwn", "rwn", "lwn"}

// minZoom is the tippecanoe minzoom for each network.
var minZoom = map[string]int{"iwn": 8, "nwn": 8, "rwn": 8, "lwn": 12}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if err := selfTest(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: normalize-routes RELATIONS.opl WAYS.geojsonl OUT.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-routes:", err)
		os.Exit(1)
	}
}

type member struct {
	kind byte // 'n', 'w' or 'r'
	id   int64
}

type relation struct {
	id      int64
	tags    map[string]string
	members []member
}

// parseOPL reads one relation line of `osmium cat -f opl,add_metadata=false`:
//
//	r123 Tname=West%20%Highland%20%Way,type=route Mw1@,w2@forward,r3@
//
// ok=false for a line that is not a relation (osmium cat -t relation writes none).
func parseOPL(line string) (rel relation, ok bool, err error) {
	fields := strings.Fields(line)
	if len(fields) == 0 || fields[0][0] != 'r' {
		return rel, false, nil
	}
	if rel.id, err = strconv.ParseInt(fields[0][1:], 10, 64); err != nil {
		return rel, false, fmt.Errorf("relation id %q: %w", fields[0], err)
	}
	rel.tags = map[string]string{}
	for _, f := range fields[1:] {
		switch f[0] {
		case 'T':
			if len(f) == 1 {
				continue
			}
			for _, kv := range strings.Split(f[1:], ",") {
				k, v, found := strings.Cut(kv, "=")
				if !found {
					return rel, false, fmt.Errorf("r%d: tag %q has no '='", rel.id, kv)
				}
				if k, err = unescape(k); err != nil {
					return rel, false, fmt.Errorf("r%d: %w", rel.id, err)
				}
				if v, err = unescape(v); err != nil {
					return rel, false, fmt.Errorf("r%d: %w", rel.id, err)
				}
				rel.tags[k] = v
			}
		case 'M':
			if len(f) == 1 {
				continue
			}
			for _, m := range strings.Split(f[1:], ",") {
				ref, _, _ := strings.Cut(m, "@")
				if len(ref) < 2 || !strings.ContainsRune("nwr", rune(ref[0])) {
					return rel, false, fmt.Errorf("r%d: member %q", rel.id, m)
				}
				id, err := strconv.ParseInt(ref[1:], 10, 64)
				if err != nil {
					return rel, false, fmt.Errorf("r%d: member %q: %w", rel.id, m, err)
				}
				rel.members = append(rel.members, member{ref[0], id})
			}
		}
	}
	return rel, true, nil
}

// unescape undoes OPL's escaping: any character outside its safe set is written as its
// Unicode code point in hex between percent signs, "%20%" for a space.
func unescape(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '%')
		if i < 0 {
			b.WriteString(s)
			return b.String(), nil
		}
		j := strings.IndexByte(s[i+1:], '%')
		if j < 0 {
			return "", fmt.Errorf("unterminated escape in %q", s)
		}
		cp, err := strconv.ParseUint(s[i+1:i+1+j], 16, 32)
		if err != nil {
			return "", fmt.Errorf("bad escape in %q", s)
		}
		b.WriteString(s[:i])
		b.WriteRune(rune(cp))
		s = s[i+2+j:]
	}
}

// walking is whether a relation is a walking route this keeps, and why not if it is not.
func walking(r relation) (bool, string) {
	if r.tags["type"] != "route" {
		return false, "not a route"
	}
	if route := r.tags["route"]; route != "hiking" && route != "foot" {
		return false, "not a route"
	}
	if r.tags["state"] == "proposed" {
		return false, "proposed"
	}
	return true, ""
}

// level is a route's network, any value other than the four (or none) counting as local.
func level(r relation) string {
	for _, n := range networks {
		if r.tags["network"] == n {
			return n
		}
	}
	return "lwn"
}

func rank(network string) int {
	for i, n := range networks {
		if n == network {
			return i
		}
	}
	return len(networks)
}

// parentable is whether a relation's name can stand for its member routes': a superroute,
// or a route made of routes. Never a `type=network` collection.
func parentable(r relation) bool {
	switch r.tags["type"] {
	case "superroute":
		return true
	case "route":
		for _, m := range r.members {
			if m.kind == 'r' {
				return true
			}
		}
	}
	return false
}

// labeller works out each route's label: its topmost same-level named parent's name, else
// its own name, else its ref.
type labeller struct {
	rels    map[int64]relation
	parents map[int64][]int64 // child -> parentable parents, lowest id first
}

func newLabeller(rels map[int64]relation) *labeller {
	l := &labeller{rels: rels, parents: map[int64][]int64{}}
	for _, r := range rels {
		if !parentable(r) {
			continue
		}
		for _, m := range r.members {
			if m.kind == 'r' && m.id != r.id {
				l.parents[m.id] = append(l.parents[m.id], r.id)
			}
		}
	}
	for _, ps := range l.parents {
		sort.Slice(ps, func(i, j int) bool { return ps[i] < ps[j] })
	}
	return l
}

// label gives a route's label and whether it came from a parent.
func (l *labeller) label(r relation) (string, bool) {
	name, fromParent := "", false
	seen := map[int64]bool{r.id: true}
	for cur := r; ; {
		var up *relation
		for _, pid := range l.parents[cur.id] {
			p, ok := l.rels[pid]
			// The same network tag, not merely the same level: a parent tagged `lcn` is a
			// cycle network's, whatever level() makes of it.
			if ok && !seen[pid] && p.tags["network"] == r.tags["network"] {
				up = &p
				break
			}
		}
		if up == nil {
			break
		}
		seen[up.id] = true
		if n := strings.TrimSpace(up.tags["name"]); n != "" {
			name, fromParent = n, true
		}
		cur = *up
	}
	if name != "" {
		return name, fromParent
	}
	if n := strings.TrimSpace(r.tags["name"]); n != "" {
		return n, false
	}
	return strings.TrimSpace(r.tags["ref"]), false
}

// choice is the route a way is drawn as. Lower is better: level, then named, then id.
type choice struct {
	rank    int
	unnamed int
	id      int64
	network string
	label   string
}

func (c choice) better(o choice) bool {
	if c.rank != o.rank {
		return c.rank < o.rank
	}
	if c.unnamed != o.unnamed {
		return c.unnamed < o.unnamed
	}
	return c.id < o.id
}

func run(relsPath, waysPath, destPath string, out io.Writer) error {
	rels := map[int64]relation{}
	relDupes := 0
	if err := eachLine(relsPath, func(n int, line []byte) error {
		r, ok, err := parseOPL(string(line))
		if err != nil {
			return fmt.Errorf("%s: line %d: %w", relsPath, n, err)
		}
		if !ok {
			return nil
		}
		if _, seen := rels[r.id]; seen {
			relDupes++
			return nil
		}
		rels[r.id] = r
		return nil
	}); err != nil {
		return err
	}

	labels := newLabeller(rels)
	best := map[int64]choice{}
	routes, fromParent := 0, 0
	skipped := map[string]int{}
	ids := make([]int64, 0, len(rels))
	for id := range rels {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		r := rels[id]
		if ok, why := walking(r); !ok {
			skipped[why]++
			continue
		}
		routes++
		label, parent := labels.label(r)
		if parent {
			fromParent++
		}
		net := level(r)
		c := choice{rank: rank(net), id: r.id, network: net, label: label}
		if label == "" {
			c.unnamed = 1
		}
		for _, m := range r.members {
			if m.kind != 'w' {
				continue
			}
			if cur, ok := best[m.id]; !ok || c.better(cur) {
				best[m.id] = c
			}
		}
	}

	var ways []way
	seen := map[int64]bool{}
	notOnRoute, wayDupes, notLines := 0, 0, 0
	err := eachLine(waysPath, func(n int, line []byte) error {
		var f struct {
			Geometry   json.RawMessage            `json:"geometry"`
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(line, &f); err != nil {
			return fmt.Errorf("%s: line %d: %w", waysPath, n, err)
		}
		if t, _ := rawjson.String(f.Properties["@type"]); t != "way" {
			notLines++
			return nil
		}
		var g struct {
			Type        string
			Coordinates []point
		}
		if json.Unmarshal(f.Geometry, &g) != nil || g.Type != "LineString" || len(g.Coordinates) < 2 {
			notLines++
			return nil
		}
		id, err := strconv.ParseInt(rawjson.Text(f.Properties["@id"]), 10, 64)
		if err != nil {
			return fmt.Errorf("%s: line %d: @id %s", waysPath, n, f.Properties["@id"])
		}
		c, ok := best[id]
		if !ok {
			notOnRoute++
			return nil
		}
		if seen[id] {
			wayDupes++
			return nil
		}
		seen[id] = true
		ways = append(ways, way{id: id, coords: g.Coordinates, network: c.network, label: c.label})
		return nil
	})
	if err != nil {
		return err
	}

	kept := map[string]int{}
	named := 0
	for _, wy := range ways {
		kept[wy.network]++
		if wy.label != "" {
			named++
		}
	}
	lines := mergeLines(ways)

	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(dest, 1<<20)
	for _, l := range lines {
		fmt.Fprintf(w, `{"type":"Feature","tippecanoe":{"minzoom":%d},"geometry":{"type":"LineString","coordinates":[`, minZoom[l.network])
		for i, p := range l.coords {
			if i > 0 {
				w.WriteByte(',')
			}
			w.WriteByte('[')
			w.WriteString(strconv.FormatFloat(p[0], 'f', -1, 64))
			w.WriteByte(',')
			w.WriteString(strconv.FormatFloat(p[1], 'f', -1, 64))
			w.WriteByte(']')
		}
		w.WriteString(`]},"properties":{"network":"`)
		w.WriteString(l.network)
		w.WriteString(`"`)
		if l.label != "" {
			w.WriteString(`,"name":`)
			w.Write(osmpoint.JSONString(l.label))
		}
		w.WriteString("}}\n")
	}
	if err := w.Flush(); err != nil {
		dest.Close()
		return err
	}
	if err := dest.Close(); err != nil {
		return err
	}

	parts := make([]string, len(networks))
	total := 0
	for i, n := range networks {
		parts[i] = fmt.Sprintf("%s x%d", n, kept[n])
		total += kept[n]
	}
	fmt.Fprintf(out, "  kept %d ways (%s; %d named) from %d walking routes, %d named after their parent route, joined into %d lines; skipped %d relations that are not walking routes, %d proposed, %d relations and %d ways already seen (continent seams), %d ways on no kept route, %d non-line features\n",
		total, strings.Join(parts, ", "), named, routes, fromParent, len(lines),
		skipped["not a route"], skipped["proposed"], relDupes, wayDupes, notOnRoute, notLines)
	return nil
}

// point is a coordinate as osmium writes it. Ways that share an OSM node share its
// coordinates exactly, so a point is compared as written, without a tolerance.
type point [2]float64

// way is a member way with the route it is drawn as.
type way struct {
	id      int64
	coords  []point
	network string
	label   string
}

// line is one output feature: ways of one route, joined end to end.
type line struct {
	coords  []point
	network string
	label   string
}

// mergeLines joins ways drawn as the same route (network and label) end to end, so a label
// has a line long enough to sit on. A way is a few hundred metres, and "West Highland
// Way" is about 110 px: unjoined, the names showed from z13 at best, the trail's own
// z11 floor never (seen in the browser over Kinlochleven, 2026-11-18). tippecanoe's
// --coalesce does not do this — it combines features into one, not lines into a line.
//
// Ways are joined only through a node exactly two of the route's ways end at: where a
// third meets (a fork, an alternative, a spur), each branch stays its own line rather than
// one being picked to run on. Ways are taken in id order and the result does not depend on
// input order.
func mergeLines(ways []way) []line {
	sort.Slice(ways, func(i, j int) bool { return ways[i].id < ways[j].id })
	type key struct {
		network, label string
	}
	type end struct {
		k key
		p point
	}
	ends := map[end][]int{}
	for i, wy := range ways {
		k := key{wy.network, wy.label}
		ends[end{k, wy.coords[0]}] = append(ends[end{k, wy.coords[0]}], i)
		last := wy.coords[len(wy.coords)-1]
		ends[end{k, last}] = append(ends[end{k, last}], i)
	}
	used := make([]bool, len(ways))
	// next is the one other unused way ending at p, if exactly two of the route's ways
	// end there.
	next := func(k key, p point, from int) (int, bool) {
		at := ends[end{k, p}]
		if len(at) != 2 {
			return 0, false
		}
		other := at[0]
		if other == from {
			other = at[1]
		}
		if other == from || used[other] {
			return 0, false
		}
		return other, true
	}
	var lines []line
	for i, wy := range ways {
		if used[i] {
			continue
		}
		used[i] = true
		k := key{wy.network, wy.label}
		coords := append([]point(nil), wy.coords...)
		for tail := i; ; {
			j, ok := next(k, coords[len(coords)-1], tail)
			if !ok {
				break
			}
			used[j] = true
			c := ways[j].coords
			if c[0] != coords[len(coords)-1] {
				c = reversed(c)
			}
			coords = append(coords, c[1:]...)
			tail = j
		}
		for head := i; ; {
			j, ok := next(k, coords[0], head)
			if !ok {
				break
			}
			used[j] = true
			c := ways[j].coords
			if c[len(c)-1] != coords[0] {
				c = reversed(c)
			}
			coords = append(append([]point(nil), c[:len(c)-1]...), coords...)
			head = j
		}
		lines = append(lines, line{coords: coords, network: wy.network, label: wy.label})
	}
	return lines
}

func reversed(c []point) []point {
	r := make([]point, len(c))
	for i, p := range c {
		r[len(c)-1-i] = p
	}
	return r
}

// eachLine calls fn with each non-blank line of path, record separators stripped.
func eachLine(path string, fn func(n int, line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		if line := bytes.TrimSpace(bytes.TrimLeft(raw, "\x1e")); len(line) > 0 {
			if err := fn(n, line); err != nil {
				return err
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// selfTest is --self-test: a trail of two stages under a superroute, joined into one line, a collection that must
// not name its members, a way on two routes, a ref-only route, a route with no network, a
// proposed route and a cycle route, and a seam duplicate. It runs the real normalizer, so
// its report line is printed too.
func selfTest(out io.Writer) error {
	rels := strings.Join([]string{
		"r10 Tname=Long%20%Trail,network=nwn,route=hiking,type=superroute Mr11@,r12@",
		"r11 Tname=Stage%20%1,network=nwn,route=hiking,type=route Mw1@,w2@",
		"r12 Tname=Stage%20%2,network=nwn,route=hiking,type=route Mw3@",
		"r20 Tname=Pilgrim%20%Ways,network=iwn,route=hiking,type=network Mr21@",
		"r21 Tname=Valley%20%Way,network=iwn,route=hiking,type=route Mw4@",
		"r30 Tname=Village%20%Loop,network=lwn,route=foot,type=route Mw2@,w5@",
		"r40 Tnetwork=rwn,ref=102,route=hiking,type=route Mw6@",
		"r50 Tname=Town%20%Walk,route=hiking,type=route Mw7@",
		"r60 Tname=Planned,network=rwn,route=hiking,state=proposed,type=route Mw8@",
		"r70 Tname=Cycleway,network=lcn,route=bicycle,type=route Mw9@",
		"r11 Tname=Stage%20%1,network=nwn,route=hiking,type=route Mw1@,w2@",
	}, "\n")
	// Way n runs from (n, 0) to (n+1, 0), so consecutive ids meet end to end.
	line := `{"type":"Feature","geometry":{"type":"LineString","coordinates":[[%d,0],[%d,0]]},"properties":{"@type":"way","@id":%d}}`
	var ways []string
	for _, id := range []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 1} {
		ways = append(ways, fmt.Sprintf(line, id, id+1, id))
	}
	// Ways 1-3, the trail's two stages, join into one line; 4-7 meet their neighbours
	// but belong to other routes, so stay apart.
	want := []map[string]any{
		{"network": "nwn", "name": "Long Trail", "minzoom": 8, "points": 4},
		{"network": "iwn", "name": "Valley Way", "minzoom": 8, "points": 2},
		{"network": "lwn", "name": "Village Loop", "minzoom": 12, "points": 2},
		{"network": "rwn", "name": "102", "minzoom": 8, "points": 2},
		{"network": "lwn", "name": "Town Walk", "minzoom": 12, "points": 2},
	}

	dir, err := os.MkdirTemp("", "normalize-routes-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	relsPath, waysPath, dest := filepath.Join(dir, "r.opl"), filepath.Join(dir, "w.geojsonl"), filepath.Join(dir, "out.geojsonl")
	if err := os.WriteFile(relsPath, []byte(rels+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(waysPath, []byte(strings.Join(ways, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	if err := run(relsPath, waysPath, dest, out); err != nil {
		return err
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		return err
	}
	var got []map[string]any
	for _, l := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var f struct {
			Tippecanoe struct{ Minzoom int }
			Geometry   struct{ Coordinates [][2]float64 }
			Properties map[string]any
		}
		if err := json.Unmarshal([]byte(l), &f); err != nil {
			return err
		}
		f.Properties["points"] = len(f.Geometry.Coordinates)
		f.Properties["minzoom"] = f.Tippecanoe.Minzoom
		got = append(got, f.Properties)
	}
	norm := func(v any) any { b, _ := json.Marshal(v); var x any; json.Unmarshal(b, &x); return x }
	if !reflect.DeepEqual(norm(got), norm(want)) {
		return fmt.Errorf("FAIL: normalize-routes self-test\n  expected %v\n  got %v", want, got)
	}
	fmt.Fprintf(out, "  normalize-routes self-test OK (%d relations, %d ways)\n", len(strings.Split(rels, "\n")), len(ways))
	return nil
}
