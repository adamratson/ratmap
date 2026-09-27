// Command build-manifest generates regions/manifest.json — the download catalogue the app
// reads.
//
//	build-manifest.sh [dist_dir]
//	build-manifest.sh [dist_dir] --base-live [--prune] [--only REGEX]
//	build-manifest.sh [dist_dir] --base <manifest.json path or URL> [--prune] [--only REGEX]
//
// scripts/build-manifest.sh builds and runs it with the same arguments.
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
// Scotland/Wales/England run, 2026-09). The pattern is RE2 syntax.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
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

// failure is a refusal: the message printed on its own, exit status 1.
type failure string

func (f failure) Error() string { return string(f) }

const usage = `usage: build-manifest [--base MANIFEST_JSON_OR_URL | --base-live] [--prune] [--only REGEX] [DIST_DIR]`

func main() {
	fs := flag.NewFlagSet("build-manifest", flag.ExitOnError)
	baseFlag := fs.String("base", "", "existing manifest.json to merge into — a local path, or a plain http(s) URL")
	baseLive := fs.Bool("base-live", false, "merge into $PUBLIC_BASE_URL/regions/manifest.json (environment, then infra/.env)")
	prune := fs.Bool("prune", false, "with --base/--base-live: also drop base regions no longer in regions.json")
	onlyFlag := fs.String("only", "", "only consider region directories whose id matches this regex (RE2 syntax)")
	args := cli.Parse(fs, usage, os.Args[1:])
	usageErr := func(msg string) { cli.Fail(fs, "%s", msg) }
	given := cli.Given(fs)
	if len(args) > 1 {
		usageErr("unexpected arguments: " + strings.Join(args[1:], " "))
	}
	if given["base"] && *baseLive {
		usageErr("--base and --base-live are mutually exclusive")
	}
	if *prune && !given["base"] && !*baseLive {
		usageErr("--prune only makes sense together with --base or --base-live")
	}
	infraDir, err := infra.Dir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-manifest:", err)
		os.Exit(1)
	}
	distDir := filepath.Join(infraDir, "dist")
	if len(args) == 1 {
		distDir = args[0]
	}

	var base string
	hasBase := false
	if given["base"] {
		base, hasBase = *baseFlag, true
	}
	if *baseLive {
		url := publicBaseURL(infraDir)
		if url == "" {
			usageErr("--base-live needs PUBLIC_BASE_URL — set it in the environment or in " + filepath.Join(infraDir, ".env"))
		}
		base, hasBase = strings.TrimRight(url, "/")+"/regions/manifest.json", true
	}
	var only *regexp.Regexp
	if given["only"] {
		if only, err = regexp.Compile(*onlyFlag); err != nil {
			usageErr("--only is not a valid regex: " + err.Error())
		}
	}
	workers, err := hashWorkers()
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-manifest:", err)
		os.Exit(1)
	}

	err = build(distDir, filepath.Join(infraDir, "regions.json"), filepath.Join(distDir, "regions", "manifest.json"),
		base, hasBase, *prune, only, workers, time.Now())
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
		// offset + length > size, without the sum overflowing.
		if off > size || length > size-off {
			return fail(s.name + " runs past the end of the file")
		}
	}
	return int(header[100]), int(header[101]), nil
}

// artifact is one archive's manifest entry, its fields in the order the app has always
// seen them.
type artifact struct {
	Kind string `json:"kind"`
	// C3: the filename is also the OPFS/TileSourceRegistry key, so it must stay globally
	// unique — hence the region-id prefix.
	Filename string `json:"filename"`
	Path     string `json:"path"`
	Bytes    int64  `json:"bytes"`
	MinZoom  int    `json:"minzoom"`
	MaxZoom  int    `json:"maxzoom"`
	// Filled in once every archive has passed the header check: lets a resumed or
	// re-downloaded artifact be checked for integrity.
	SHA256 string `json:"sha256,omitempty"`

	file string // where it is on disk
}

// region is a manifest entry built in this run.
type region struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group,omitempty"` // absent on hand-written regions; optional to the app
	// As regions.json writes it.
	BBox       json.RawMessage   `json:"bbox"`
	TotalBytes int64             `json:"totalBytes"`
	Artifacts  []json.RawMessage `json:"artifacts"`
}

// entry is one region of the manifest being written: built here, or carried over from the
// base manifest exactly as it was, fields this tool does not know about included (C16).
type entry struct {
	raw         json.RawMessage
	group, name string
	built       *region // nil when carried over
	kinds       []string
}

// definition is what the manifest takes from a regions.json entry.
type definition struct {
	Name  *string         `json:"name"`
	Group string          `json:"group"`
	BBox  json.RawMessage `json:"bbox"`
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

	// Regions by id, in first-seen order; a repeated id keeps its first place.
	byID := map[string]*entry{}
	var order []string
	put := func(id string, e *entry) {
		if _, ok := byID[id]; !ok {
			order = append(order, id)
		}
		byID[id] = e
	}

	if !hasBase {
		for _, id := range freshOrder {
			e, err := builtEntry(fresh[id])
			if err != nil {
				return err
			}
			put(id, e)
		}
	} else {
		baseDoc, err := loadBaseManifest(base)
		if err != nil {
			return err
		}
		if baseDoc.SchemaVersion != "" {
			if n, err := baseDoc.SchemaVersion.Float64(); err == nil && n > schemaVersion {
				return failure(fmt.Sprintf("FAIL: base manifest schemaVersion %s is newer than this script understands (%d). "+
					"Refusing to merge blind — update this script first.", baseDoc.SchemaVersion, schemaVersion))
			}
		}
		for _, raw := range baseDoc.Regions {
			var head struct {
				ID    *string `json:"id"`
				Name  string  `json:"name"`
				Group string  `json:"group"`
			}
			if err := json.Unmarshal(raw, &head); err != nil || head.ID == nil {
				return errors.New("base manifest: a region has no string id")
			}
			put(*head.ID, &entry{raw: raw, group: head.Group, name: head.Name})
		}

		// Merge *by artifact kind*, not by whole region — a region already in the base
		// manifest is very often only partly rebuilt (e.g. contours added to a region whose
		// basemap/terrain were already live). Replacing the whole entry with what was
		// rebuilt here would silently drop every artifact kind not present in this run's
		// dist_dir, which is a real regression, not a hypothetical one: the first version
		// of this merge did exactly that to Montenegro's basemap and terrain in testing
		// (2026-09-04) before this fix. Name, group and bbox come from regions.json —
		// current.
		for _, id := range freshOrder {
			f := fresh[id]
			if existing, ok := byID[id]; ok {
				if err := mergeArtifacts(f, existing.raw); err != nil {
					return fmt.Errorf("base manifest: region %s: %w", id, err)
				}
			}
			e, err := builtEntry(f)
			if err != nil {
				return err
			}
			put(id, e)
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

	entries := make([]*entry, 0, len(order))
	for _, id := range order {
		entries = append(entries, byID[id])
	}
	// By group, then name; stable, so ties keep first-seen order.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].group != entries[j].group {
			return entries[i].group < entries[j].group
		}
		return entries[i].name < entries[j].name
	})
	manifest := struct {
		SchemaVersion int               `json:"schemaVersion"`
		BuiltAt       string            `json:"builtAt"`
		Regions       []json.RawMessage `json:"regions"`
	}{schemaVersion, now.UTC().Format("2006-01-02T15:04:05Z"), make([]json.RawMessage, len(entries))}
	for i, e := range entries {
		manifest.Regions[i] = e.raw
	}
	var text bytes.Buffer
	enc := json.NewEncoder(&text)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(manifest); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(dest, text.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Printf("manifest: %d region(s) -> %s\n", len(entries), dest)

	// Full rebuild: every region was just computed, so list everything. Merge: only the
	// touched ids are news; the rest is exactly what the base manifest already said, so
	// summarise instead of repeating it.
	reportIDs := append([]string(nil), freshOrder...)
	sort.Strings(reportIDs)
	for _, id := range reportIDs {
		e := byID[id]
		fmt.Printf("  %s: %.1f MB (%s)\n", id, float64(e.built.TotalBytes)/1e6, strings.Join(e.kinds, ", "))
	}
	if hasBase {
		fmt.Printf("  (%d region(s) unchanged, carried over from base manifest)\n", len(entries)-len(reportIDs))
	}
	return nil
}

// mergeArtifacts adds to f every artifact of the base entry whose kind f did not rebuild,
// kept exactly as the base had it, then sorts them by kind and totals their bytes.
func mergeArtifacts(f *region, baseRaw json.RawMessage) error {
	var base struct {
		Artifacts []json.RawMessage `json:"artifacts"`
	}
	if err := json.Unmarshal(baseRaw, &base); err != nil {
		return err
	}
	byKind := map[string]json.RawMessage{}
	sizes := map[string]int64{}
	for _, list := range [][]json.RawMessage{base.Artifacts, f.Artifacts} { // this run's win
		for _, a := range list {
			var kb struct {
				Kind  string `json:"kind"`
				Bytes int64  `json:"bytes"`
			}
			if err := json.Unmarshal(a, &kb); err != nil {
				return fmt.Errorf("an artifact: %w", err)
			}
			byKind[kb.Kind], sizes[kb.Kind] = a, kb.Bytes
		}
	}
	kinds := make([]string, 0, len(byKind))
	for k := range byKind {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	f.Artifacts, f.TotalBytes = nil, 0
	for _, k := range kinds {
		f.Artifacts = append(f.Artifacts, byKind[k])
		f.TotalBytes += sizes[k]
	}
	return nil
}

// builtEntry is a region built (or merged) in this run, ready to write.
func builtEntry(r *region) (*entry, error) {
	raw, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	e := &entry{raw: raw, group: r.Group, name: r.Name, built: r}
	for _, a := range r.Artifacts {
		var k struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(a, &k); err != nil {
			return nil, err
		}
		e.kinds = append(e.kinds, k.Kind)
	}
	return e, nil
}

func loadDefined(path string) (map[string]definition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Regions []struct {
			ID *string `json:"id"`
			definition
		} `json:"regions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	defined := map[string]definition{}
	for _, r := range doc.Regions {
		if r.ID == nil {
			return nil, fmt.Errorf("%s: a region has no string id", path)
		}
		defined[*r.ID] = r.definition
	}
	return defined, nil
}

// baseManifest is what a merge needs of the base manifest; each region stays raw.
type baseManifest struct {
	SchemaVersion json.Number       `json:"schemaVersion"`
	Regions       []json.RawMessage `json:"regions"`
}

// loadBaseManifest reads the base manifest from an http(s) URL or a local path. It may be
// gzipped: upload.sh publishes it with `Content-Encoding: gzip`, which a browser undoes
// and `aws s3 cp` does not, so the magic number decides rather than any header.
func loadBaseManifest(source string) (*baseManifest, error) {
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
	var doc baseManifest
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("base manifest %s: %w", source, err)
	}
	return &doc, nil
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
func buildLocalRegions(distDir string, defined map[string]definition, only *regexp.Regexp, workers int) (map[string]*region, []string, error) {
	regionsDir := filepath.Join(distDir, "regions")
	byID := map[string]*region{}
	var order []string
	if st, err := os.Stat(regionsDir); err != nil || !st.IsDir() {
		return byID, order, nil
	}
	dirs, err := os.ReadDir(regionsDir)
	if err != nil {
		return nil, nil, err
	}
	var pending []*artifact
	arts := map[string][]*artifact{}
	for _, d := range dirs { // ReadDir sorts by name
		regionDir := filepath.Join(regionsDir, d.Name())
		// Following symlinks, which DirEntry.IsDir does not.
		if st, err := os.Stat(regionDir); err != nil || !st.IsDir() {
			continue
		}
		id := d.Name()
		if only != nil && !only.MatchString(id) {
			continue
		}
		meta, ok := defined[id]
		if !ok {
			fmt.Fprintf(os.Stderr, "  ! skipping %s: not in regions.json\n", id)
			continue
		}

		// Glob matches dotfiles too: a leftover ".x-contours.building.pmtiles" is found
		// and skipped as an unrecognised suffix.
		files, _ := filepath.Glob(filepath.Join(regionDir, "*.pmtiles"))
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
			a := &artifact{Kind: kind, Filename: name, Path: "regions/" + id + "/" + name,
				Bytes: st.Size(), MinZoom: minZ, MaxZoom: maxZ, file: path}
			arts[id] = append(arts[id], a)
			total += st.Size()
			pending = append(pending, a)
		}
		if len(arts[id]) == 0 {
			fmt.Fprintf(os.Stderr, "  ! skipping %s: no artifacts built\n", id)
			continue
		}
		if meta.Name == nil {
			return nil, nil, fmt.Errorf("regions.json: %s has no name", id)
		}
		byID[id] = &region{ID: id, Name: *meta.Name, Group: meta.Group, BBox: meta.BBox, TotalBytes: total}
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
	for _, id := range order {
		for _, a := range arts[id] {
			raw, err := json.Marshal(a)
			if err != nil {
				return nil, nil, err
			}
			byID[id].Artifacts = append(byID[id].Artifacts, raw)
		}
	}
	return byID, order, nil
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
// Deleting it is always safe; the next run hashes everything.
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

type cacheEntry struct {
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtime_ns"`
	Ino     int64  `json:"ino"`
	SHA256  string `json:"sha256"`
}

type cacheFile struct {
	Version int                   `json:"version"`
	Entries map[string]cacheEntry `json:"entries"`
}

type hashCache struct {
	root    string
	path    string
	entries map[string]cacheEntry
	mu      sync.Mutex
}

func loadHashCache(distDir string) *hashCache {
	c := &hashCache{root: distDir, path: filepath.Join(distDir, cacheName), entries: map[string]cacheEntry{}}
	// Missing or unreadable reads as empty: everything is hashed, which is the behaviour
	// before this cache existed — never a wrong digest.
	data, err := os.ReadFile(c.path)
	if err != nil {
		return c
	}
	var f cacheFile
	if json.Unmarshal(data, &f) != nil || f.Version != cacheVersion || f.Entries == nil {
		return c
	}
	c.entries = f.Entries
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
	e, ok := c.entries[c.key(path)]
	if !ok {
		return ""
	}
	st, err := stampOf(path)
	if err != nil || e.Size != st.size || e.MtimeNs != st.mtimeNs || e.Ino != st.ino {
		return ""
	}
	return e.SHA256
}

func (c *hashCache) put(path, digest string, st stamp) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[c.key(path)] = cacheEntry{st.size, st.mtimeNs, st.ino, digest}
}

// save writes the cache, dropping entries whose file is gone — and only those. A run
// scoped with --only never visits most regions; evicting everything it did not visit
// would make the next full run rehash the whole catalogue.
func (c *hashCache) save() error {
	live := map[string]cacheEntry{}
	for k, e := range c.entries {
		if _, err := os.Stat(filepath.Join(c.root, k)); err == nil {
			live[k] = e
		}
	}
	text, err := json.Marshal(cacheFile{cacheVersion, live})
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, text, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

func fillDigests(pending []*artifact, cache *hashCache, workers int) error {
	var toHash []*artifact
	reused := 0
	for _, a := range pending {
		if d := cache.get(a.file); d != "" {
			a.SHA256 = d
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
		total += a.Bytes
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
				if r.before, r.err = stampOf(toHash[i].file); r.err != nil {
					continue
				}
				if r.digest, r.err = sha256File(toHash[i].file); r.err != nil {
					continue
				}
				r.after, r.err = stampOf(toHash[i].file)
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
		a.SHA256 = r.digest
		if r.before == r.after {
			cache.put(a.file, r.digest, r.before)
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
