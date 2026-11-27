package main

// The checks behind prune-bucket.sh, and the manifest history upload.sh keeps for them.
//
// A file the live manifest does not list may still be wanted: a phone that read the
// manifest before it was replaced can be part-way through downloading a file the new one
// dropped, and an upload in progress puts its archives up before the manifest that lists
// them. So a file goes only once nothing has wanted it for DAYS: it was uploaded more than
// DAYS ago, and no manifest live in the last DAYS lists it.
//
// The manifests live in the last DAYS are the live one and those it replaced within
// DAYS. upload.sh keeps each manifest it replaces, as regions/manifest-history/<STAMP>.json,
// STAMP being when that manifest went up (its LastModified, so the bucket's clock) and
// the history file's own LastModified when it was replaced: the file is written just
// before the manifest replacing it. Every time here is the bucket's.
//
// The history says nothing of a manifest replaced without being kept: by an upload.sh
// from before it kept them, or by anything else that writes regions/manifest.json. So it
// is read as a chain, back from the live manifest: each manifest's history file must have
// been written within chainSlack of the next one going up. Where the chain breaks is as far
// back as the history can be trusted, and nothing is deleted until that is DAYS ago.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	liveKey       = "regions/manifest.json"
	historyPrefix = "regions/manifest-history/"
	stampLayout   = "20060102T150405Z"
	// upload.sh writes the history file, then the new manifest: seconds apart, or minutes
	// when the plain manifest has to be put back after the gzipped one failed to verify.
	chainSlack = time.Hour
)

type object struct {
	Key          string
	Size         int64
	LastModified time.Time
	ETag         string
}

// readObjects reads a `list-objects-v2 --output json` listing. Strictly, unlike changed's
// reading of it: a file whose age is unknown cannot be judged old enough to delete.
func readObjects(path string) ([]object, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Contents []struct {
			Key          *string
			Size         *int64
			LastModified *string
			ETag         *string
		}
	}
	if text := strings.TrimSpace(string(data)); text != "" {
		if err := json.Unmarshal([]byte(text), &doc); err != nil {
			return nil, failure("listing was not readable JSON: " + err.Error())
		}
	}
	objs := make([]object, 0, len(doc.Contents))
	for _, o := range doc.Contents {
		if o.Key == nil || o.Size == nil || o.LastModified == nil {
			return nil, failure("listing was not readable JSON: an entry has no Key, Size and LastModified")
		}
		t, err := time.Parse(time.RFC3339, *o.LastModified)
		if err != nil {
			return nil, failure(fmt.Sprintf("listing: %s: LastModified %q is not a time", *o.Key, *o.LastModified))
		}
		obj := object{Key: *o.Key, Size: *o.Size, LastModified: t.UTC()}
		if o.ETag != nil {
			obj.ETag = *o.ETag
		}
		objs = append(objs, obj)
	}
	return objs, nil
}

type window struct {
	now, cutoff time.Time
	days        time.Duration
}

func parseWindow(nowArg, daysArg string) (window, error) {
	secs, err := strconv.ParseInt(nowArg, 10, 64)
	if err != nil {
		return window{}, failure("NOW must be seconds since the epoch, not " + strconv.Quote(nowArg))
	}
	days, err := strconv.Atoi(daysArg)
	if err != nil || days < 1 {
		return window{}, failure("DAYS must be a whole number, at least 1, not " + strconv.Quote(daysArg))
	}
	now := time.Unix(secs, 0).UTC()
	d := time.Duration(days) * 24 * time.Hour
	return window{now: now, cutoff: now.Add(-d), days: d}, nil
}

// kept is a history file: the manifest that went up at liveSince, replaced at the file's
// own LastModified.
type kept struct {
	object
	liveSince time.Time
}

func history(objs []object) ([]kept, error) {
	var hist []kept
	for _, o := range objs {
		name, ok := strings.CutPrefix(o.Key, historyPrefix)
		if !ok {
			continue
		}
		stamp, ok := strings.CutSuffix(name, ".json")
		t, err := time.Parse(stampLayout, stamp)
		if !ok || err != nil {
			// Not skipped: a manifest kept under some other name could list anything.
			return nil, failure(fmt.Sprintf("%s: not a history file upload.sh writes (YYYYMMDDTHHMMSSZ.json)", o.Key))
		}
		hist = append(hist, kept{object: o, liveSince: t})
	}
	return hist, nil
}

// chainStart walks the history back from a manifest that went up at live, and returns
// how far back it reaches unbroken, and through how many kept manifests.
func chainStart(live time.Time, hist []kept) (time.Time, int) {
	cur, n := live, 0
	for {
		var next *kept
		for i := range hist {
			h := &hist[i]
			replaced := h.LastModified
			if replaced.After(cur) || cur.Sub(replaced) > chainSlack {
				continue
			}
			if next == nil || replaced.After(next.LastModified) {
				next = h
			}
		}
		// A manifest kept as having gone up after it was replaced is not a link anyone
		// wrote: stop there rather than walk into it.
		if next == nil || !next.liveSince.Before(next.LastModified) {
			return cur, n
		}
		cur, n = next.liveSince, n+1
	}
}

// needed is the history files of manifests replaced within the window: those that were
// live inside it.
func needed(hist []kept, w window) []kept {
	var out []kept
	for _, h := range hist {
		if !h.LastModified.Before(w.cutoff) {
			out = append(out, h)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// historyNeeded prints the history files prune will want, so that prune-bucket.sh fetches
// only those.
func historyNeeded(nowArg, daysArg, listing string, out io.Writer) error {
	w, err := parseWindow(nowArg, daysArg)
	if err != nil {
		return err
	}
	objs, err := readObjects(listing)
	if err != nil {
		return err
	}
	hist, err := history(objs)
	if err != nil {
		return err
	}
	for _, h := range needed(hist, w) {
		fmt.Fprintln(out, h.Key)
	}
	return nil
}

// artifactPaths is every bucket key a manifest lists.
func artifactPaths(path string) (map[string]bool, error) {
	data, err := readManifest(path)
	if err != nil {
		return nil, err
	}
	var m struct {
		Regions []struct {
			Artifacts []struct {
				Path *string `json:"path"`
			} `json:"artifacts"`
		} `json:"regions"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(m.Regions) == 0 {
		// Read as "lists nothing", every region's files would go.
		return nil, failure(path + ": lists no regions")
	}
	paths := map[string]bool{}
	for _, r := range m.Regions {
		for _, a := range r.Artifacts {
			if a.Path == nil || *a.Path == "" {
				return nil, failure(path + ": an artifact has no path")
			}
			paths[*a.Path] = true
		}
	}
	return paths, nil
}

type tally struct {
	n     int
	bytes int64
}

func (t *tally) add(size int64) { t.n++; t.bytes += size }

func (t tally) String() string {
	if t.n == 1 {
		return "1 file, " + human(t.bytes)
	}
	return fmt.Sprintf("%d files, %s", t.n, human(t.bytes))
}

// human is prune-caches.sh's, GB and MB of 1024, with kB for the manifests.
func human(b int64) string {
	const kb, mb, gb = 1 << 10, 1 << 20, 1 << 30
	switch {
	case b >= gb:
		return fmt.Sprintf("%.1f GB", float64(b)/gb)
	case b >= mb:
		return fmt.Sprintf("%.0f MB", float64(b)/mb)
	case b >= kb:
		return fmt.Sprintf("%.0f kB", float64(b)/kb)
	}
	return fmt.Sprintf("%d bytes", b)
}

func when(t time.Time) string { return t.Format("2006-01-02 15:04 UTC") }

// Why a file the live manifest does not list has to wait, by whichever wait is longest.
const (
	waitNew      = "uploaded recently"
	waitListed   = "listed by a recent manifest"
	waitCoverage = "before the manifest history"
)

// prune decides, for each file under regions/ that the live manifest does not list,
// whether it may be deleted now, and writes the plan to PLAN, a line a file, by key:
//
//	delete	KEY	BYTES
//	wait	KEY	BYTES	UNTIL	WHY
//	missing	KEY
//
// missing is a file the live manifest lists that the bucket does not have. Everything
// outside regions/ is left alone: the global files are named by the app's own build, and
// an older build of it can still be running on a phone. So is regions/manifest.json and
// its history.
//
// LIVE is the live manifest as fetched, and LIVE_META what get-object said of it then: if
// it is not the one the listing saw, the history read from the listing is not the history
// of this manifest, and nothing is decided.
func prune(nowArg, daysArg, listing, live, liveMeta, histDir, plan string, out io.Writer) error {
	w, err := parseWindow(nowArg, daysArg)
	if err != nil {
		return err
	}
	objs, err := readObjects(listing)
	if err != nil {
		return err
	}
	var liveObj *object
	for i := range objs {
		if objs[i].Key == liveKey {
			liveObj = &objs[i]
		}
	}
	if liveObj == nil {
		return failure("the listing has no " + liveKey + ": nothing to judge the rest by")
	}
	metaData, err := os.ReadFile(liveMeta)
	if err != nil {
		return err
	}
	var meta struct {
		LastModified string
		ETag         string
	}
	if err := json.Unmarshal(metaData, &meta); err != nil {
		return fmt.Errorf("%s: %w", liveMeta, err)
	}
	// A listing gives LastModified to the millisecond and get-object, from the HTTP header,
	// to the second; and some gateways quote the ETag in one and not the other (rclone's
	// serve s3 does both). Krystal gives the same in each, but nothing promises it.
	fetched, err := time.Parse(time.RFC3339, meta.LastModified)
	if err != nil || !fetched.Truncate(time.Second).Equal(liveObj.LastModified.Truncate(time.Second)) ||
		strings.Trim(meta.ETag, `"`) != strings.Trim(liveObj.ETag, `"`) {
		return failure(liveKey + " changed between the listing and fetching it (an upload?): run this again")
	}

	liveRefs, err := artifactPaths(live)
	if err != nil {
		return err
	}
	hist, err := history(objs)
	if err != nil {
		return err
	}
	// The last moment a manifest live in the window listed each key.
	listedUntil := map[string]time.Time{}
	recent := needed(hist, w)
	for _, h := range recent {
		refs, err := artifactPaths(filepath.Join(histDir, filepath.Base(h.Key)))
		if err != nil {
			return err
		}
		for k := range refs {
			if h.LastModified.After(listedUntil[k]) {
				listedUntil[k] = h.LastModified
			}
		}
	}
	from, links := chainStart(liveObj.LastModified, hist)
	trusted := from.Add(w.days)

	var all, listed, outside, bookkeeping, deletable, waiting tally
	waitWhy := map[string]*tally{}
	var first, last time.Time
	var lines []string
	present := map[string]bool{}
	for _, o := range objs {
		all.add(o.Size)
		present[o.Key] = true
		switch {
		case !strings.HasPrefix(o.Key, "regions/"):
			outside.add(o.Size)
			continue
		case o.Key == liveKey || strings.HasPrefix(o.Key, historyPrefix):
			bookkeeping.add(o.Size)
			continue
		case liveRefs[o.Key]:
			listed.add(o.Size)
			continue
		}
		until, why := o.LastModified.Add(w.days), waitNew
		if t := listedUntil[o.Key]; !t.IsZero() && t.Add(w.days).After(until) {
			until, why = t.Add(w.days), waitListed
		}
		if trusted.After(until) {
			until, why = trusted, waitCoverage
		}
		if !until.After(w.now) {
			deletable.add(o.Size)
			lines = append(lines, fmt.Sprintf("delete\t%s\t%d", o.Key, o.Size))
			continue
		}
		waiting.add(o.Size)
		if waitWhy[why] == nil {
			waitWhy[why] = &tally{}
		}
		waitWhy[why].add(o.Size)
		if first.IsZero() || until.Before(first) {
			first = until
		}
		if until.After(last) {
			last = until
		}
		lines = append(lines, fmt.Sprintf("wait\t%s\t%d\t%s\t%s", o.Key, o.Size, until.Format(time.RFC3339), why))
	}
	var missing []string
	for k := range liveRefs {
		if !present[k] {
			missing = append(missing, k)
			lines = append(lines, "missing\t"+k)
		}
	}
	sort.Strings(missing)
	sort.Slice(lines, func(i, j int) bool { return planKey(lines[i]) < planKey(lines[j]) })
	body := strings.Join(lines, "\n")
	if body != "" {
		body += "\n"
	}
	if err := os.WriteFile(plan, []byte(body), 0o644); err != nil {
		return err
	}

	fmt.Fprintf(out, "Bucket: %s\n", all)
	fmt.Fprintf(out, "  listed by the live manifest  %s\n", listed)
	fmt.Fprintf(out, "  not listed, under regions/   %s\n", deletable.plus(waiting))
	fmt.Fprintf(out, "  outside regions/             %s (never pruned: the app names these itself)\n", outside)
	fmt.Fprintf(out, "  manifest and its history     %s\n", bookkeeping)
	fmt.Fprintf(out, "Live manifest up since %s; the history reaches back to %s", when(liveObj.LastModified), when(from))
	switch links {
	case 0:
		fmt.Fprintln(out, " (no earlier manifest kept)")
	case 1:
		fmt.Fprintln(out, " (1 earlier manifest kept)")
	default:
		fmt.Fprintf(out, " (%d earlier manifests kept)\n", links)
	}
	if len(missing) > 0 {
		fmt.Fprintf(out, "MISSING: %d file(s) the live manifest lists are not in the bucket, and fail to download:\n", len(missing))
		for i, k := range missing {
			if i == 10 {
				fmt.Fprintf(out, "  ... and %d more\n", len(missing)-i)
				break
			}
			fmt.Fprintf(out, "  %s\n", k)
		}
	}
	if deletable.n == 0 && waiting.n == 0 {
		fmt.Fprintln(out, "Nothing to prune.")
		return nil
	}
	fmt.Fprintf(out, "Deletable now: %s\n", deletable)
	if waiting.n > 0 {
		fmt.Fprintf(out, "Waiting:       %s, until %s", waiting, when(first))
		if last.After(first) {
			fmt.Fprintf(out, " to %s", when(last))
		}
		fmt.Fprintln(out)
		for _, why := range []string{waitNew, waitListed, waitCoverage} {
			if t := waitWhy[why]; t != nil {
				fmt.Fprintf(out, "  %-29s%s\n", why, t)
			}
		}
	}
	return nil
}

func (t tally) plus(u tally) tally { return tally{n: t.n + u.n, bytes: t.bytes + u.bytes} }

func planKey(line string) string {
	_, rest, _ := strings.Cut(line, "\t")
	key, _, _ := strings.Cut(rest, "\t")
	return key
}

// archive prints the history key to keep PUBLISHED under before LOCAL replaces it, from
// PUBLISHED's LastModified as head-object or get-object gives it — or nothing, when LOCAL
// is the same manifest and upload.sh need not upload it at all. A published manifest that
// is not JSON is kept all the same: whatever it was, phones may have read it.
func archive(published, local, lastModified string, out io.Writer) error {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(lastModified))
	if err != nil {
		return failure(fmt.Sprintf("LastModified %q is not a time", lastModified))
	}
	pub, err := readManifest(published)
	if err != nil {
		return err
	}
	loc, err := readManifest(local)
	if err != nil {
		return err
	}
	var pubDoc, locDoc any
	if err := json.Unmarshal(loc, &locDoc); err != nil {
		return fmt.Errorf("%s: %w", local, err)
	}
	if json.Unmarshal(pub, &pubDoc) == nil && reflect.DeepEqual(pubDoc, locDoc) {
		return nil
	}
	fmt.Fprintln(out, historyPrefix+t.UTC().Format(stampLayout)+".json")
	return nil
}
