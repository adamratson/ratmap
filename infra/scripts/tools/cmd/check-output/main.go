// Command check-output runs the build scripts' regression checks on what they built: a
// parsing or schema change that silently breaks a property should fail the build here,
// not be discovered on a mountain.
//
//	check-output peaks FILE              # build-peaks.sh: known summit elevations
//	check-output munros FILE             # build-peaks.sh: the Munro count
//	check-output sac FILE                # build-sac.sh: known paths' hardest grades
//	check-output terrain-features FILE   # build-terrain-features.sh: every kind present
//
// Each prints a line per assertion and exits 1 with a FAIL line when one fails. The
// expected values and why each was chosen are documented beside the calls in the scripts.
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

	"ratmap/infra/tools/internal/rawjson"
)

// failure is a failed assertion: the message on stderr, status 1.
type failure string

func (f failure) Error() string { return string(f) }

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: check-output peaks|munros|sac|terrain-features FILE")
		os.Exit(2)
	}
	checks := map[string]func(string, io.Writer) error{
		"peaks": peaks, "munros": munros, "sac": sac, "terrain-features": terrainFeatures,
	}
	check, ok := checks[os.Args[1]]
	if !ok {
		fmt.Fprintln(os.Stderr, "usage: check-output peaks|munros|sac|terrain-features FILE")
		os.Exit(2)
	}
	if err := check(os.Args[2], os.Stdout); err != nil {
		var f failure
		if errors.As(err, &f) {
			fmt.Fprintln(os.Stderr, string(f))
		} else {
			fmt.Fprintln(os.Stderr, "check-output:", err)
		}
		os.Exit(1)
	}
}

// eachProps calls fn with every feature's properties, a feature with none getting an
// empty set. Blank lines are skipped and a GeoJSONSeq record separator is stripped.
func eachProps(path string, fn func(map[string]json.RawMessage) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		line, rerr := r.ReadBytes('\n')
		if text := bytes.TrimSpace(bytes.TrimLeft(line, "\x1e")); len(text) > 0 {
			var feature struct {
				Properties map[string]json.RawMessage `json:"properties"`
			}
			if err := json.Unmarshal(text, &feature); err != nil {
				return fmt.Errorf("%s: line %d: %w", path, n, err)
			}
			if err := fn(feature.Properties); err != nil {
				return fmt.Errorf("%s: line %d: %w", path, n, err)
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

// number is a JSON number's value and its text as written; ok=false for anything else,
// a numeric string included (which json.Number alone would accept).
func number(raw json.RawMessage) (float64, string, bool) {
	raw = bytes.TrimSpace(raw)
	var n json.Number
	if len(raw) == 0 || raw[0] == '"' || json.Unmarshal(raw, &n) != nil {
		return 0, "", false
	}
	f, err := n.Float64()
	return f, n.String(), err == nil
}

// peaks checks known summit elevations, matched on name prefix (OSM often carries a
// multilingual name — Zla Kolata is tagged "Zla Kolata / Kollate e Keqe").
func peaks(path string, out io.Writer) error {
	expected := []struct {
		name string
		ele  float64
	}{{"Ben Nevis", 1345}, {"Mont Blanc", 4808}, {"Bobotov Kuk", 2523}, {"Zla Kolata", 2535}}
	const tolerance = 2

	type ele struct {
		v    float64
		text string
	}
	byName := map[string]ele{}
	err := eachProps(path, func(p map[string]json.RawMessage) error {
		name, ok := rawjson.String(p["name"])
		v, text, isNum := number(p["ele"])
		if !ok || !isNum {
			return nil
		}
		for _, e := range expected {
			if _, seen := byName[e.name]; !seen && strings.HasPrefix(name, e.name) {
				byName[e.name] = ele{v, text}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	checked := 0
	for _, e := range expected {
		actual, ok := byName[e.name]
		if !ok {
			fmt.Fprintf(out, "  (skip %s: not in this extract)\n", e.name)
			continue
		}
		if math.Abs(actual.v-e.ele) > tolerance {
			return failure(fmt.Sprintf("FAIL: %s ele=%s, expected ~%d", e.name, actual.text, int(e.ele)))
		}
		fmt.Fprintf(out, "  OK %s: %s m\n", e.name, actual.text)
		checked++
	}
	if checked == 0 {
		fmt.Fprintln(out, "  (no known summits in this extract — elevation assertions skipped)")
	}
	return nil
}

// munros checks the Munro count: 282, the SMC's current published count.
func munros(path string, out io.Writer) error {
	const want = 282
	count := 0
	err := eachProps(path, func(p map[string]json.RawMessage) error {
		lists := ""
		if v, ok := p["lists"]; ok {
			s, isStr := rawjson.String(v)
			if !isStr {
				return fmt.Errorf("lists is %s, not a string", v)
			}
			lists = s
		}
		for _, l := range strings.Split(lists, ";") {
			if l == "munro" {
				count++
				break
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	switch {
	case count == 0:
		fmt.Fprintln(out, "  (no munro=yes nodes in this extract — count assertion skipped)")
	case count != want:
		return failure(fmt.Sprintf("FAIL: %d munros, expected %d", count, want))
	default:
		fmt.Fprintf(out, "  OK %d munros\n", count)
	}
	return nil
}

// sac checks the hardest grade on known named paths, and that more than one grade
// survived — a build whose output is a single grade means the parser has collapsed the
// scale.
func sac(path string, out io.Writer) error {
	expected := []struct {
		name  string
		grade int64
	}{{"Ben Nevis Mountain Path", 2}, {"West Highland Way", 1}, {"Aonach Eagach", 5}}
	hardest := map[string]int64{}
	histogram := map[int64]int{}
	err := eachProps(path, func(p map[string]json.RawMessage) error {
		grade, err := strconv.ParseInt(string(bytes.TrimSpace(p["t"])), 10, 64)
		if err != nil {
			return fmt.Errorf("t is %s, not a grade", p["t"])
		}
		histogram[grade]++
		if name, ok := rawjson.String(p["name"]); ok {
			for _, e := range expected {
				if e.name == name {
					hardest[name] = max(hardest[name], grade)
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	checked := 0
	for _, e := range expected {
		actual, ok := hardest[e.name]
		if !ok {
			fmt.Fprintf(out, "  (skip %s: not in this extract)\n", e.name)
			continue
		}
		if actual != e.grade {
			return failure(fmt.Sprintf("FAIL: %s hardest grade %d, expected %d", e.name, actual, e.grade))
		}
		fmt.Fprintf(out, "  OK %s: T%d\n", e.name, e.grade)
		checked++
	}
	var present []int64
	for g := range histogram {
		present = append(present, g)
	}
	sort.Slice(present, func(i, j int) bool { return present[i] < present[j] })
	parts := make([]string, len(present))
	for i, g := range present {
		parts[i] = "T" + strconv.FormatInt(g, 10) + " x" + strconv.Itoa(histogram[g])
	}
	fmt.Fprintf(out, "  grades present: %s\n", strings.Join(parts, ", "))
	if len(present) < 2 {
		return failure("FAIL: fewer than two distinct grades in the whole build")
	}
	if checked == 0 {
		fmt.Fprintln(out, "  (no known paths in this extract — grade assertions skipped)")
	}
	return nil
}

// terrainFeatures checks that all four kinds are present in meaningful numbers, or the
// filter/normalize step has silently collapsed.
func terrainFeatures(path string, out io.Writer) error {
	minimum := []struct {
		kind string
		n    int
	}{{"scree", 20}, {"shingle", 5}, {"rock", 5}, {"stone", 5}}
	histogram := map[string]int{}
	err := eachProps(path, func(p map[string]json.RawMessage) error {
		kv, ok := p["kind"]
		if !ok {
			return errors.New(`no "kind"`)
		}
		histogram[rawjson.Text(kv)]++
		return nil
	})
	if err != nil {
		return err
	}
	sorted := []string{"rock", "scree", "shingle", "stone"}
	parts := make([]string, len(sorted))
	for i, k := range sorted {
		parts[i] = fmt.Sprintf("%s x%d", k, histogram[k])
	}
	fmt.Fprintf(out, "  by kind: %s\n", strings.Join(parts, ", "))
	var missing []string
	for _, m := range minimum {
		if histogram[m.kind] < m.n {
			missing = append(missing, fmt.Sprintf("%s (%d < %d)", m.kind, histogram[m.kind], m.n))
		}
	}
	if len(missing) > 0 {
		return failure("FAIL: implausibly few features for " + strings.Join(missing, ", ") +
			" — filter or normalize step likely broken")
	}
	if len(histogram) < 2 {
		return failure("FAIL: fewer than two distinct kinds in the whole build")
	}
	return nil
}
