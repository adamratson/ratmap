// Command build-manifest generates regions/manifest.json — the download catalogue the app
// reads.
//
//	build-manifest.sh [dist_dir]
//	build-manifest.sh [dist_dir] --base-live [--prune] [--only REGEX]
//	build-manifest.sh [dist_dir] --base <manifest.json path or URL> [--prune] [--only REGEX]
//
// A port of scripts/build-manifest.py, which it replaces; scripts/build-manifest.sh builds
// and runs it with the same arguments. Same manifest (json.dump's text, indent 2, via
// internal/pyjson), same hash cache, same messages.
//
// C16: the schema is versioned and open-ended. A region is "a set of named artifacts", not
// a fixed basemap+terrain pair, so contours (and later routing tiles) are an *additive*
// artifact rather than a schema migration. The app must therefore iterate whatever
// artifacts a region declares instead of hardcoding names.
//
// Artifact sizes are recorded here so the app can check `navigator.storage.estimate()`
// against a region *before* starting a multi-hundred-MB download (C1: never let a user
// believe they have offline maps they don't).
//
// Two modes. A full rebuild, strictly from dist_dir/regions/*, is what the Docker global
// build uses — dist_dir there genuinely holds (or is building towards holding) every
// region in regions.json. An incremental update (--base-live, or --base with a path or an
// http(s) URL) recomputes only the region ids present in dist_dir/regions/ and merges them
// into the base by artifact kind; everything else in the base carries over untouched. No
// single machine has ever held every region's archives at once — regions get built a
// handful at a time, often in different sessions on different hosts, against a catalogue
// of 180+ entries. --prune additionally drops base regions whose id is no longer in
// regions.json — an explicit, opt-in unpublish, not an implicit side effect of a partial
// build.
//
// --only scopes dist_dir/regions/ scanning to matching ids, recommended whenever dist_dir
// holds more than this run's own output: a single corrupt archive anywhere in it would
// otherwise abort every region's publish via the fails-closed header check, not just its
// own (hit for real: a stray corrupt austria-contours.pmtiles blocking a
// Scotland/Wales/England run, 2026-09). The pattern is Go's regexp syntax (RE2), where the
// Python took Python's; the patterns this pipeline uses (`^lochaber$`, alternations) mean
// the same in both.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ratmap/infra/tools/internal/cli"
	"ratmap/infra/tools/internal/infra"
	"ratmap/infra/tools/internal/pyjson"
)

const schemaVersion = 1

// artifactKinds maps a filename suffix to an artifact kind, in the order they are tried.
// Adding a kind here is all it takes to publish a new artifact type; the app renders
// whatever it finds.
var artifactKinds = []struct{ suffix, kind string }{
	{"-basemap.pmtiles", "basemap"},
	{"-terrain.pmtiles", "terrain"},
	{"-contours.pmtiles", "contours"},
	{"-paths.pmtiles", "paths"},
	{"-sac.pmtiles", "sac"},
	{"-terrain-features.pmtiles", "terrain-features"},
	// Versioned in the filename, unlike every other kind: `downloadArtifact` skips an
	// artifact whose name is already in OPFS, so a rebuild under an unchanged name never
	// reaches anyone who already holds the region. Stage B's runout channel replaces this
	// line with "-avalanche-2.pmtiles" rather than adding to it — two versions mapping to
	// one kind would race in the merge below.
	{"-avalanche-1.pmtiles", "avalanche"},
	// Versioned for the same reason; bump together with build-region.sh.
	{"-peaks-1.pmtiles", "peaks"},
}

func artifactKind(name string) string {
	for _, k := range artifactKinds {
		if strings.HasSuffix(name, k.suffix) {
			return k.kind
		}
	}
	return ""
}

// failure is a refusal printed as the Python's SystemExit message was, exit status 1.
type failure string

func (f failure) Error() string { return string(f) }

const usage = `usage: build-manifest [-h] [--base MANIFEST_JSON_OR_URL] [--base-live] [--prune] [--only REGEX] [dist_dir]`

func main() {
	a := cli.Parse(os.Args[1:], usage, []cli.Spec{
		{Name: "base", Help: "existing manifest.json to merge into — a local path, or a plain http(s) URL"},
		{Name: "base-live", Bool: true, Help: "merge into $PUBLIC_BASE_URL/regions/manifest.json (environment, then infra/.env)"},
		{Name: "prune", Bool: true, Help: "with --base/--base-live: also drop base regions no longer in regions.json"},
		{Name: "only", Help: "only consider region directories whose id matches this regex (Go RE2 syntax)"},
	})
	usageErr := func(msg string) {
		fmt.Fprintf(os.Stderr, "%s\nbuild-manifest: error: %s\n", usage, msg)
		os.Exit(2)
	}
	if len(a.Positionals) > 1 {
		usageErr("unrecognized arguments: " + strings.Join(a.Positionals[1:], " "))
	}
	if a.Has("base") && a.Has("base-live") {
		usageErr("--base and --base-live are mutually exclusive")
	}
	if a.Has("prune") && !a.Has("base") && !a.Has("base-live") {
		usageErr("--prune only makes sense together with --base or --base-live")
	}
	infraDir, err := infra.Dir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-manifest:", err)
		os.Exit(1)
	}
	distDir := filepath.Join(infraDir, "dist")
	if len(a.Positionals) == 1 {
		distDir = a.Positionals[0]
	}

	var base string
	hasBase := false
	if a.Has("base") {
		base, hasBase = a.String("base", ""), true
	}
	if a.Has("base-live") {
		url := publicBaseURL(infraDir)
		if url == "" {
			usageErr("--base-live needs PUBLIC_BASE_URL — set it in the environment or in " + filepath.Join(infraDir, ".env"))
		}
		base, hasBase = strings.TrimRight(url, "/")+"/regions/manifest.json", true
	}
	var only *regexp.Regexp
	if a.Has("only") {
		if only, err = regexp.Compile(a.String("only", "")); err != nil {
			usageErr("--only is not a valid regex: " + err.Error())
		}
	}
	workers, err := hashWorkers()
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-manifest:", err)
		os.Exit(1)
	}

	err = build(distDir, filepath.Join(infraDir, "regions.json"), filepath.Join(distDir, "regions", "manifest.json"),
		base, hasBase, a.Has("prune"), only, workers, time.Now())
	if err != nil {
		var f failure
		if errors.As(err, &f) {
			fmt.Fprintln(os.Stderr, string(f))
		} else {
			fmt.Fprintln(os.Stderr, "build-manifest:", err)
		}
		os.Exit(1)
	}
}

// hashWorkers is MANIFEST_HASH_WORKERS, default 2. Two, measured 2026-09-11 over 1.1 GB
// with a warm page cache: 2.17 GB/s sequential, 3.53 GB/s at 2 threads, 3.73 GB/s at 8 —
// memory bandwidth caps it almost at once. Two takes nearly all of that, and on a spinning
// disk keeps it to two streams rather than seeking between eight. MANIFEST_HASH_WORKERS=1
// for a disk that dislikes even that.
func hashWorkers() (int, error) {
	v, ok := os.LookupEnv("MANIFEST_HASH_WORKERS")
	if !ok {
		return 2, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, fmt.Errorf("MANIFEST_HASH_WORKERS=%q is not an integer", v)
	}
	return max(1, n), nil
}

// publicBaseURL is PUBLIC_BASE_URL from the environment, falling back to infra/.env — so
// --base-live works the same whether or not the caller went through lib.sh, which exports
// it from .env for every shell script.
func publicBaseURL(infraDir string) string {
	if v := os.Getenv("PUBLIC_BASE_URL"); v != "" {
		return v
	}
	data, err := os.ReadFile(filepath.Join(infraDir, ".env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, val, _ := strings.Cut(line, "=")
		if strings.TrimSpace(key) == "PUBLIC_BASE_URL" {
			return strings.Trim(strings.Trim(strings.TrimSpace(val), `"`), "'")
		}
	}
	return ""
}

// PMTiles v3 fixed header: 127 bytes, little-endian. The only part of an archive this
// reads other than the bytes it hashes.
const headerBytes = 127

var sections = []struct {
	name string
	at   int
}{{"root directory", 8}, {"metadata", 24}, {"leaf directories", 40}, {"tile data", 56}}

// zoomRange reads an archive's real min/max zoom from its PMTiles header.
//
// Recorded in the manifest so the app can tell the user what detail they actually have
// rather than assuming; without it the app claims "limited detail" over a region it has
// fully downloaded — crying wolf, which trains people to ignore the warning that matters.
//
// Read directly rather than through `pmtiles show --header-json`, which checks no more:
// tested 2026-09-11, it rejects a zeroed header and a truncated file, and *accepts* an
// archive whose root directory is garbage. So this validates the header and that every
// section it points at fits inside the file.
//
// A failure is a hard one. An unreadable header is how a corrupt archive presents itself
// — an interrupted `pmtiles extract` leaves a plausibly-sized file whose header is all
// zeros. Publishing it would put a broken download in the catalogue, so refuse to write a
// manifest describing it at all.
func zoomRange(path string) (int, int, error) {
	fail := func(why string) (int, int, error) {
		return 0, 0, failure(fmt.Sprintf("FAIL: %s is not a readable PMTiles archive (%s).\n      Rebuild it; do not publish this manifest.",
			filepath.Base(path), why))
	}
	st, err := os.Stat(path)
	if err != nil {
		return fail(err.Error())
	}
	f, err := os.Open(path)
	if err != nil {
		return fail(err.Error())
	}
	defer f.Close()
	header := make([]byte, headerBytes)
	n, _ := io.ReadFull(f, header)
	if n < headerBytes || string(header[:7]) != "PMTiles" {
		return fail("no PMTiles magic number")
	}
	if header[7] != 3 {
		return fail(fmt.Sprintf("spec version %d; this reads version 3", header[7]))
	}
	size := uint64(st.Size())
	for _, s := range sections {
		off := binary.LittleEndian.Uint64(header[s.at:])
		length := binary.LittleEndian.Uint64(header[s.at+8:])
		// offset + length > size, without the sum overflowing where Python's ints did not.
		if off > size || length > size-off {
			return fail(s.name + " runs past the end of the file")
		}
	}
	return int(header[100]), int(header[101]), nil
}

type artifact struct {
	obj  *pyjson.Object
	path string
	size int64
}

func build(distDir, regionsJSON, dest, base string, hasBase, prune bool, only *regexp.Regexp,
	workers int, now time.Time) error {
	defined, err := loadDefined(regionsJSON)
	if err != nil {
		return err
	}
	fresh, freshOrder, err := buildLocalRegions(distDir, defined, only, workers)
	if err != nil {
		return err
	}

	// regions_by_id, as a Python dict: insertion order, a repeated id keeping its first
	// place.
	byID := map[string]*pyjson.Object{}
	var order []string
	put := func(id string, r *pyjson.Object) {
		if _, ok := byID[id]; !ok {
			order = append(order, id)
		}
		byID[id] = r
	}

	if !hasBase {
		for _, id := range freshOrder {
			put(id, fresh[id])
		}
	} else {
		baseDoc, err := loadBaseManifest(base)
		if err != nil {
			return err
		}
		if v, ok := baseDoc.Get("schemaVersion"); ok {
			if n, ok := pyjson.Number(v); ok && n > schemaVersion {
				return failure(fmt.Sprintf("FAIL: base manifest schemaVersion %s is newer than this script understands (%d). "+
					"Refusing to merge blind — update this script first.", encode(v), schemaVersion))
			}
		}
		if rv, ok := baseDoc.Get("regions"); ok {
			list, _ := rv.([]pyjson.Value)
			for _, r := range list {
				ro, ok := r.(*pyjson.Object)
				if !ok {
					return errors.New("base manifest: a region is not an object")
				}
				id, _ := ro.Get("id")
				s, ok := id.(string)
				if !ok {
					return errors.New("base manifest: a region has no string id")
				}
				put(s, ro)
			}
		}

		// Merge *by artifact kind*, not by whole region — a region already in the base
		// manifest is very often only partly rebuilt (e.g. contours added to a region whose
		// basemap/terrain were already live). Replacing the whole entry with what was
		// rebuilt here would silently drop every artifact kind not present in this run's
		// dist_dir, which is a real regression, not a hypothetical one: the first version
		// of this merge did exactly that to Montenegro's basemap and terrain in testing
		// (2026-09-04) before this fix.
		for _, id := range freshOrder {
			f := fresh[id]
			existing, ok := byID[id]
			if !ok {
				put(id, f)
				continue
			}
			byKind := &pyjson.Object{}
			if av, ok := existing.Get("artifacts"); ok {
				list, _ := av.([]pyjson.Value)
				for _, a := range list {
					if ao, ok := a.(*pyjson.Object); ok {
						k, _ := ao.Get("kind")
						ks, _ := k.(string)
						byKind.Set(ks, ao)
					}
				}
			}
			fa, _ := f.Get("artifacts")
			for _, a := range fa.([]pyjson.Value) {
				k, _ := a.(*pyjson.Object).Get("kind")
				byKind.Set(k.(string), a)
			}
			kinds := append([]string(nil), byKind.Keys...)
			sort.Strings(kinds)
			var arts []pyjson.Value
			var total pyjson.Value = pyjson.FromInt(0)
			for _, k := range kinds {
				a, _ := byKind.Get(k)
				arts = append(arts, a)
				b, _ := a.(*pyjson.Object).Get("bytes")
				total = add(total, b)
			}
			merged := f.Copy() // name/group/bbox from regions.json — current
			merged.Set("artifacts", arts)
			merged.Set("totalBytes", total)
			byID[id] = merged
		}

		if prune {
			var kept []string
			for _, id := range order {
				if _, ok := defined[id]; ok {
					kept = append(kept, id)
				} else {
					delete(byID, id)
				}
			}
			if dropped := len(order) - len(kept); dropped > 0 {
				fmt.Fprintf(os.Stderr, "  pruned %d region(s) no longer in regions.json\n", dropped)
			}
			order = kept
		}
	}

	regions := make([]*pyjson.Object, 0, len(order))
	for _, id := range order {
		regions = append(regions, byID[id])
	}
	// sorted(key=(r.get("group", ""), r["name"])): stable, so ties keep dict order.
	sort.SliceStable(regions, func(i, j int) bool {
		gi, gj := groupOf(regions[i]), groupOf(regions[j])
		if gi != gj {
			return gi < gj
		}
		return nameOf(regions[i]) < nameOf(regions[j])
	})

	manifest := &pyjson.Object{}
	manifest.Set("schemaVersion", pyjson.FromInt(schemaVersion))
	manifest.Set("builtAt", now.UTC().Format("2006-01-02T15:04:05Z"))
	list := make([]pyjson.Value, len(regions))
	for i, r := range regions {
		list[i] = r
	}
	manifest.Set("regions", list)
	text, err := pyjson.Encode(manifest, pyjson.Options{Indent: pyjson.Indent(2), EnsureASCII: true})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(dest, []byte(text+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("manifest: %d region(s) -> %s\n", len(regions), dest)

	// Full rebuild: every region was just computed, so list everything. Merge: only the
	// touched ids are news; the rest is exactly what the base manifest already said, so
	// summarise instead of repeating it.
	var reportIDs []string
	if !hasBase {
		reportIDs = append(reportIDs, order...)
	} else {
		reportIDs = append(reportIDs, freshOrder...)
	}
	sort.Strings(reportIDs)
	for _, id := range reportIDs {
		r, ok := byID[id]
		if !ok {
			continue
		}
		tb, _ := r.Get("totalBytes")
		mb, _ := pyjson.Number(tb)
		av, _ := r.Get("artifacts")
		var kinds []string
		for _, a := range av.([]pyjson.Value) {
			k, _ := a.(*pyjson.Object).Get("kind")
			kinds = append(kinds, fmt.Sprint(k))
		}
		fmt.Printf("  %s: %.1f MB (%s)\n", id, mb/1e6, strings.Join(kinds, ", "))
	}
	if hasBase {
		fmt.Printf("  (%d region(s) unchanged, carried over from base manifest)\n", len(regions)-len(reportIDs))
	}
	return nil
}

func groupOf(r *pyjson.Object) string {
	g, ok := r.Get("group")
	if !ok {
		return ""
	}
	s, _ := g.(string)
	return s
}

func nameOf(r *pyjson.Object) string {
	n, _ := r.Get("name")
	s, _ := n.(string)
	return s
}

// add is Python's + on two JSON numbers: int + int stays an int, anything else a float.
func add(a, b pyjson.Value) pyjson.Value {
	ai, aok := pyjson.IntValue(a)
	bi, bok := pyjson.IntValue(b)
	if aok && bok {
		return pyjson.FromInt(ai + bi)
	}
	af, _ := pyjson.Number(a)
	bf, _ := pyjson.Number(b)
	return af + bf
}

func encode(v pyjson.Value) string {
	s, _ := pyjson.Encode(v, pyjson.Options{})
	return s
}

func loadDefined(path string) (map[string]*pyjson.Object, error) {
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
	list, _ := rv.([]pyjson.Value)
	defined := map[string]*pyjson.Object{}
	for _, r := range list {
		ro, ok := r.(*pyjson.Object)
		if !ok {
			return nil, fmt.Errorf("%s: a region is not an object", path)
		}
		id, _ := ro.Get("id")
		s, ok := id.(string)
		if !ok {
			return nil, fmt.Errorf("%s: a region has no string id", path)
		}
		defined[s] = ro
	}
	return defined, nil
}

// loadBaseManifest reads the base manifest from an http(s) URL or a local path. It may be
// gzipped: upload.sh publishes it with `Content-Encoding: gzip`, which a browser undoes
// and `aws s3 cp` does not, so the magic number decides rather than any header.
func loadBaseManifest(source string) (*pyjson.Object, error) {
	var data []byte
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(source)
		if err == nil && resp.StatusCode/100 != 2 {
			resp.Body.Close()
			err = fmt.Errorf("HTTP Error %d: %s", resp.StatusCode, http.StatusText(resp.StatusCode))
		}
		if err != nil {
			return nil, failure(fmt.Sprintf("FAIL: could not fetch base manifest from %s: %v", source, err))
		}
		defer resp.Body.Close()
		if data, err = io.ReadAll(resp.Body); err != nil {
			return nil, failure(fmt.Sprintf("FAIL: could not fetch base manifest from %s: %v", source, err))
		}
	} else {
		var err error
		if data, err = os.ReadFile(source); err != nil {
			return nil, err
		}
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
	doc, err := pyjson.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("base manifest %s: %w", source, err)
	}
	o, ok := doc.(*pyjson.Object)
	if !ok {
		return nil, fmt.Errorf("base manifest %s: not an object", source)
	}
	return o, nil
}

// buildLocalRegions computes region entries fresh from whatever is actually present under
// distDir, in sorted directory order.
//
// A region directory that exists but yields nothing usable (unknown region id, no
// recognised artifacts) is simply absent from the result — callers merging against a base
// manifest must leave such an id's existing entry untouched rather than treat the
// empty/broken local directory as "delete this from the catalogue". A directory `only`
// does not match is skipped without being touched at all — not even to check whether its
// archives are readable.
func buildLocalRegions(distDir string, defined map[string]*pyjson.Object, only *regexp.Regexp, workers int) (map[string]*pyjson.Object, []string, error) {
	regionsDir := filepath.Join(distDir, "regions")
	byID := map[string]*pyjson.Object{}
	var order []string
	if st, err := os.Stat(regionsDir); err != nil || !st.IsDir() {
		return byID, order, nil
	}
	entries, err := os.ReadDir(regionsDir)
	if err != nil {
		return nil, nil, err
	}
	var pending []artifact
	for _, e := range entries { // ReadDir sorts by name, as sorted(iterdir()) did
		regionDir := filepath.Join(regionsDir, e.Name())
		// is_dir() follows symlinks; DirEntry.IsDir does not.
		if st, err := os.Stat(regionDir); err != nil || !st.IsDir() {
			continue
		}
		id := e.Name()
		if only != nil && !only.MatchString(id) {
			continue
		}
		meta, ok := defined[id]
		if !ok {
			fmt.Fprintf(os.Stderr, "  ! skipping %s: not in regions.json\n", id)
			continue
		}

		// glob("*.pmtiles"), which matches dotfiles too: a leftover
		// ".x-contours.building.pmtiles" is found and skipped as an unrecognised suffix.
		files, _ := filepath.Glob(filepath.Join(regionDir, "*.pmtiles"))
		var arts []pyjson.Value
		var total int64
		for _, path := range files {
			name := filepath.Base(path)
			kind := artifactKind(name)
			if kind == "" {
				fmt.Fprintf(os.Stderr, "  ! skipping %s: unrecognised artifact suffix\n", name)
				continue
			}
			minZ, maxZ, err := zoomRange(path)
			if err != nil {
				return nil, nil, err
			}
			st, err := os.Stat(path)
			if err != nil {
				return nil, nil, err
			}
			a := &pyjson.Object{}
			a.Set("kind", kind)
			// C3: the filename is also the OPFS/TileSourceRegistry key, so it must stay
			// globally unique — hence the region-id prefix.
			a.Set("filename", name)
			a.Set("path", "regions/"+id+"/"+name)
			a.Set("bytes", pyjson.FromInt(st.Size()))
			a.Set("minzoom", pyjson.FromInt(int64(minZ)))
			a.Set("maxzoom", pyjson.FromInt(int64(maxZ)))
			// "sha256" is filled in below, once every archive has passed the header check:
			// lets a resumed or re-downloaded artifact be checked for integrity.
			arts = append(arts, a)
			total += st.Size()
			pending = append(pending, artifact{a, path, st.Size()})
		}
		if len(arts) == 0 {
			fmt.Fprintf(os.Stderr, "  ! skipping %s: no artifacts built\n", id)
			continue
		}

		r := &pyjson.Object{}
		r.Set("id", id)
		name, ok := meta.Get("name")
		if !ok {
			return nil, nil, fmt.Errorf("regions.json: %s has no name", id)
		}
		r.Set("name", name)
		// Absent on hand-written regions; the app treats it as optional.
		if g, ok := meta.Get("group"); ok && truthy(g) {
			r.Set("group", g)
		}
		bbox, _ := meta.Get("bbox")
		r.Set("bbox", bbox)
		r.Set("totalBytes", pyjson.FromInt(total))
		r.Set("artifacts", arts)
		byID[id] = r
		order = append(order, id)
	}

	// Hashed only after every archive's header has been read, so a corrupt file anywhere
	// still fails the run in seconds rather than after hashing everything before it.
	if len(pending) > 0 {
		cache := loadHashCache(distDir)
		if err := fillDigests(pending, cache, workers); err != nil {
			return nil, nil, err
		}
		if err := cache.save(); err != nil {
			return nil, nil, err
		}
	}
	return byID, order, nil
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

// Hashes of archives that have not changed since they were last hashed, kept beside them.
//
// The manifest stage runs with --base-live, which recomputes every artifact under
// dist/regions. On a build host holding the catalogue that is ~213 GB read and hashed on
// every run, usually to publish a handful of new small files. Here a file is rehashed only
// when its size, mtime or inode has changed — and every way this pipeline rewrites an
// archive (build under a temporary name, verify, `mv` into place) gives it a new inode
// and mtime, so a rebuilt archive always misses and an untouched one costs a stat.
//
// Not uploaded: upload.sh publishes *.pmtiles and the manifest, nothing else in dist/.
// Deleting it is always safe; the next run hashes everything. Same file, same format as
// the Python wrote, so an existing cache carries over.
const (
	cacheName    = ".manifest-sha256-cache.json"
	cacheVersion = 1
)

type stamp struct{ size, mtimeNs, ino int64 }

func stampOf(path string) (stamp, error) {
	st, err := os.Stat(path)
	if err != nil {
		return stamp{}, err
	}
	s := stamp{size: st.Size(), mtimeNs: st.ModTime().UnixNano()}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		s.ino = int64(sys.Ino)
	}
	return s, nil
}

type hashCache struct {
	root    string
	path    string
	entries *pyjson.Object
	mu      sync.Mutex
}

func loadHashCache(distDir string) *hashCache {
	c := &hashCache{root: distDir, path: filepath.Join(distDir, cacheName), entries: &pyjson.Object{}}
	// Missing or unreadable reads as empty: everything is hashed, which is the behaviour
	// before this cache existed — never a wrong digest.
	data, err := os.ReadFile(c.path)
	if err != nil {
		return c
	}
	doc, err := pyjson.Decode(data)
	if err != nil {
		return c
	}
	top, ok := doc.(*pyjson.Object)
	if !ok {
		return c
	}
	if v, _ := top.Get("version"); encode(v) != strconv.Itoa(cacheVersion) {
		return c
	}
	if e, ok := top.Get("entries"); ok {
		if eo, ok := e.(*pyjson.Object); ok {
			c.entries = eo
		}
	}
	return c
}

func (c *hashCache) key(path string) string {
	rel, err := filepath.Rel(c.root, path)
	if err != nil {
		return path
	}
	return rel
}

func (c *hashCache) get(path string) string {
	e, ok := c.entries.Get(c.key(path))
	if !ok {
		return ""
	}
	eo, ok := e.(*pyjson.Object)
	if !ok || len(eo.Keys) == 0 {
		return ""
	}
	st, err := stampOf(path)
	if err != nil {
		return ""
	}
	for _, kv := range []struct {
		k string
		v int64
	}{{"size", st.size}, {"mtime_ns", st.mtimeNs}, {"ino", st.ino}} {
		got, _ := eo.Get(kv.k)
		if n, ok := pyjson.IntValue(got); !ok || n != kv.v {
			return ""
		}
	}
	d, _ := eo.Get("sha256")
	s, _ := d.(string)
	return s
}

func (c *hashCache) put(path, digest string, st stamp) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := &pyjson.Object{}
	e.Set("size", pyjson.FromInt(st.size))
	e.Set("mtime_ns", pyjson.FromInt(st.mtimeNs))
	e.Set("ino", pyjson.FromInt(st.ino))
	e.Set("sha256", digest)
	c.entries.Set(c.key(path), e)
}

// save writes the cache, dropping entries whose file is gone — and only those. A run
// scoped with --only never visits most regions; evicting everything it did not visit
// would make the next full run rehash the whole catalogue.
func (c *hashCache) save() error {
	live := &pyjson.Object{}
	for i, k := range c.entries.Keys {
		if _, err := os.Stat(filepath.Join(c.root, k)); err == nil {
			live.Set(k, c.entries.Vals[i])
		}
	}
	doc := &pyjson.Object{}
	doc.Set("version", pyjson.FromInt(cacheVersion))
	doc.Set("entries", live)
	text, err := pyjson.Encode(doc, pyjson.Options{EnsureASCII: true, SortKeys: true})
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

func fillDigests(pending []artifact, cache *hashCache, workers int) error {
	var toHash []artifact
	reused := 0
	for _, a := range pending {
		if d := cache.get(a.path); d != "" {
			a.obj.Set("sha256", d)
			reused++
		} else {
			toHash = append(toHash, a)
		}
	}
	if len(toHash) == 0 {
		fmt.Fprintf(os.Stderr, "  sha256: all %d archive(s) unchanged since last hashed\n", reused)
		return nil
	}
	var total int64
	for _, a := range toHash {
		total += a.size
	}
	fmt.Fprintf(os.Stderr, "  sha256: hashing %d archive(s), %.2f GB (%d unchanged, reused)\n",
		len(toHash), float64(total)/1e9, reused)

	type result struct {
		digest        string
		before, after stamp
		err           error
	}
	results := make([]result, len(toHash))
	next := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				// Stamp *before* hashing, and cache only if the file is still the same
				// afterwards. Stamping after would let a file rewritten mid-hash be
				// remembered under its new mtime with a digest of neither version.
				r := &results[i]
				if r.before, r.err = stampOf(toHash[i].path); r.err != nil {
					continue
				}
				if r.digest, r.err = sha256File(toHash[i].path); r.err != nil {
					continue
				}
				r.after, r.err = stampOf(toHash[i].path)
			}
		}()
	}
	for i := range toHash {
		next <- i
	}
	close(next)
	wg.Wait()
	for i, a := range toHash {
		r := results[i]
		if r.err != nil {
			return r.err
		}
		a.obj.Set("sha256", r.digest)
		if r.before == r.after {
			cache.put(a.path, r.digest, r.before)
		}
	}
	return nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.CopyBuffer(h, f, make([]byte, 1<<20)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
