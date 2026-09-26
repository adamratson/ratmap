// Command normalize-sac normalizes OSM `sac_scale` into an integer grade 1-6 before
// tippecanoe.
//
//	normalize-sac SAC.geojsonl FINAL.geojsonl
//	normalize-sac --self-test
//
// A port of scripts/normalize-sac.py, which it replaces in build-sac.sh: same arguments,
// same grades, same features kept and dropped, same report.
//
// `sac_scale` is a documented enum and is still free text in practice: taginfo lists 184
// distinct values behind the seven official ones (2026-09-06), including "T3", "3",
// "T2-T3", "mountain_hiking;demanding_mountain_hiking", "yes" and "?". Cleaning that here
// rather than in a MapLibre style expression means the tiles carry a plain number, the
// renderer and the route sampler both read one property, and an unparseable value can
// never surface on the map as a grade that does not exist.
//
// Two rules decide the ambiguous cases, and both round the same way — *never* report
// ground as easier than it was tagged:
//
//   - A range ("T2-T3", "hiking;mountain_hiking") takes the **harder** end.
//   - A modifier ("T2+") takes its base grade, because the modifier is not part of the
//     scale and inventing T2.5 would be a number the SAC never defined.
//
// `strolling` is dropped rather than mapped to T1: it is not a SAC grade — the scale
// starts at T1 — and a path tagged as a stroll is better shown as ungraded than as the
// easiest graded thing on the hill.
//
// Features with no usable grade are dropped entirely: this artifact exists only to say
// what the grade is. The three reasons a feature is dropped are counted separately,
// because they mean very different things. "Not a line" is expected — `osmium tags-filter
// w/sac_scale` carries the ways' own tagged nodes along with them (gates, cairns), and in
// Montenegro that is 250 of 1 212 exported features. "No sac_scale" likewise. An
// *unreadable value*, though, is a way someone graded and we failed to read, so those are
// the ones printed with their values.
//
// The output is not the Python's bytes: it copies osmium's geometry text through rather
// than re-serializing it, and writes the new properties compactly. Its readers —
// build-sac.sh's grade check and tippecanoe — parse it, and both see the same features.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/pytext"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		if failures := selfTest(); len(failures) > 0 {
			fmt.Fprintf(os.Stderr, "normalize-sac self-test FAILED:\n  %s\n", strings.Join(failures, "\n  "))
			os.Exit(1)
		}
		fmt.Printf("  normalize-sac self-test OK (%d values)\n", len(selfTestCases))
		return
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: normalize-sac SAC.geojsonl FINAL.geojsonl | --self-test")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "normalize-sac:", err)
		os.Exit(1)
	}
}

type counts struct {
	kept, notALine, untagged, duplicated int
	// Unreadable values by str(value), in first-seen order: the report lists the most
	// common, and Python's stable sort left ties in the order they were first met.
	unparsed      map[string]int
	unparsedOrder []string
}

func run(srcPath, destPath string, out io.Writer) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()
	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(dest, 1<<20)
	r := bufio.NewReaderSize(src, 1<<20)

	c := counts{unparsed: map[string]int{}}
	// OSM way ids already written. The input is the concatenation of one export per
	// continent extract, and Geofabrik's continents share the ways that cross their
	// seams — pinned a day apart, the same way can arrive twice with two different
	// versions. Keeping the first is right: they differ by an edit made between two
	// snapshots, not by being different paths. ~921 k graded ways worldwide, so this set
	// costs tens of MB; build-paths.sh works at 85 M and cannot do the same.
	seen := map[string]struct{}{}

	for n := 1; ; n++ {
		raw, rerr := r.ReadBytes('\n')
		// RFC8142 puts an RS (0x1e) before each record; our callers turn it off, but
		// stripping it anyway means this also works on a plain geojsonseq export.
		if line := bytes.TrimFunc(bytes.TrimLeft(raw, "\x1e"), pytext.IsSpace); len(line) > 0 {
			if err := feature(line, w, seen, &c); err != nil {
				dest.Close()
				return fmt.Errorf("%s: line %d: %w", srcPath, n, err)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dest.Close()
			return rerr
		}
	}
	if err := w.Flush(); err != nil {
		dest.Close()
		return err
	}
	if err := dest.Close(); err != nil {
		return err
	}

	unreadable := 0
	for _, k := range c.unparsedOrder {
		unreadable += c.unparsed[k]
	}
	fmt.Fprintf(out, "  graded %d ways; skipped %d non-line features, %d untagged, %d unreadable, "+
		"%d already seen (continent seams)\n", c.kept, c.notALine, c.untagged, unreadable, c.duplicated)
	if len(c.unparsedOrder) > 0 {
		// Printed, not silent: a value climbing this list is how we find out the tag's
		// usage has drifted, rather than noticing a thinning map two years later.
		top := append([]string(nil), c.unparsedOrder...)
		sort.SliceStable(top, func(a, b int) bool { return c.unparsed[top[a]] > c.unparsed[top[b]] })
		if len(top) > 8 {
			top = top[:8]
		}
		var items []string
		for _, v := range top {
			items = append(items, fmt.Sprintf("%s x%d", pytext.ReprString(v), c.unparsed[v]))
		}
		fmt.Fprintf(out, "  unreadable values: %s\n", strings.Join(items, ", "))
	}
	return nil
}

// feature handles one line. It errs where the Python raised — a geometry or properties
// that is present but not an object, an @id that is a list or dict, an infinite number —
// so the stage fails where it failed.
func feature(line []byte, w *bufio.Writer, seen map[string]struct{}, c *counts) error {
	var f map[string]json.RawMessage
	if err := json.Unmarshal(line, &f); err != nil {
		return err
	}

	// The scale describes a stretch of path. A node tagged with it is either a tagging
	// error or, far more often, just a gate that happened to be on a graded way and came
	// through the filter with it.
	geometry := f["geometry"]
	geomType, err := member(geometry, "geometry", "type")
	if err != nil {
		return err
	}
	if t, _ := pytext.Str(geomType); t != "LineString" && t != "MultiLineString" {
		c.notALine++
		return nil
	}

	// Only now, as in the Python: properties that are not an object only raised once
	// something was read from them, which a non-line never reached.
	var props map[string]json.RawMessage
	if p, ok := f["properties"]; ok {
		if len(bytes.TrimSpace(p)) == 0 || bytes.TrimSpace(p)[0] != '{' {
			return fmt.Errorf("properties is %s, not an object", p)
		}
		if err := json.Unmarshal(p, &props); err != nil {
			return err
		}
	}

	raw, ok := props["sac_scale"]
	if !ok || isNull(raw) {
		c.untagged++
		return nil
	}

	// `@id`, not `id`: that is the key `osmium export -a id` writes (verified against a
	// real export, 2026-09-08 — reading `id` silently deduplicated nothing at all).
	// Absent when the caller did not pass the flag, in which case deduplication is
	// skipped rather than half-applied.
	if id, ok := props["@id"]; ok && !isNull(id) {
		k, err := hashKey(id)
		if err != nil {
			return err
		}
		if _, dup := seen[k]; dup {
			c.duplicated++
			return nil
		}
		seen[k] = struct{}{}
	}

	grade, ok, err := parseGrade(raw)
	if err != nil {
		return err
	}
	if !ok {
		s := pytext.StrValue(raw)
		if _, known := c.unparsed[s]; !known {
			c.unparsedOrder = append(c.unparsedOrder, s)
		}
		c.unparsed[s]++
		return nil
	}

	// `t` and `name` only. Every byte of this artifact is downloaded onto a phone over
	// whatever signal a glen has, and nothing else here is read by the app.
	w.WriteString(`{"type":"Feature","geometry":`)
	w.Write(geometry)
	w.WriteString(`,"properties":{"t":` + strconv.Itoa(grade))
	if name, ok := pytext.Str(props["name"]); ok {
		w.WriteString(`,"name":`)
		w.Write(jsonString(name))
	}
	w.WriteString("}}\n")
	c.kept++
	return nil
}

// member is Python's `obj.get(key)` on a value that defaulted to {} when absent: nil if
// either is missing, an error if the value is present but not an object.
func member(obj json.RawMessage, name, key string) (json.RawMessage, error) {
	if obj == nil {
		return nil, nil
	}
	o := bytes.TrimSpace(obj)
	if len(o) == 0 || o[0] != '{' {
		return nil, fmt.Errorf("%s is %s, not an object", name, obj)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(o, &m); err != nil {
		return nil, err
	}
	return m[key], nil
}

func isNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// jsonString encodes s as JSON without Go's HTML escaping of <, > and &.
func jsonString(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return bytes.TrimRight(b.Bytes(), "\n")
}

// hashKey identifies an @id the way a Python set does: by equality and hash, under which
// 5, 5.0 and True == 1 are the same key and "5" is not. Lists and dicts are unhashable,
// and raised.
func hashKey(raw json.RawMessage) (string, error) {
	raw = bytes.TrimSpace(raw)
	switch {
	case len(raw) == 0:
		return "", errors.New("empty @id")
	case raw[0] == '"':
		s, _ := pytext.Str(raw)
		return "s" + s, nil
	case raw[0] == '[' || raw[0] == '{':
		return "", fmt.Errorf("@id is %s: unhashable in Python", raw)
	case string(raw) == "true":
		return "n1", nil
	case string(raw) == "false":
		return "n0", nil
	}
	if !bytes.ContainsAny(raw, ".eE") {
		if i, err := strconv.ParseInt(string(raw), 10, 64); err == nil {
			return "n" + strconv.FormatInt(i, 10), nil
		}
		return "n" + strings.TrimPrefix(string(raw), "+"), nil // past int64: exact digits
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return "", fmt.Errorf("@id %s: %w", raw, err)
	}
	if f == math.Trunc(f) && math.Abs(f) < 1<<63 {
		return "n" + strconv.FormatInt(int64(f), 10), nil // 5.0 is 5
	}
	return "f" + strconv.FormatFloat(f, 'g', -1, 64), nil
}
