// Command check-output runs the build scripts' regression checks on what they built: a
// parsing or schema change that silently breaks a property should fail the build here,
// not be discovered on a mountain.
//
//	check-output peaks FILE              # build-peaks.sh: known summit elevations
//	check-output munros FILE             # build-peaks.sh: the Munro count
//	check-output sac FILE                # build-sac.sh: known paths' hardest grades
//	check-output terrain-features FILE   # build-terrain-features.sh: every kind present
//
// Ports of the Python checks those scripts carried inline: same assertions, same lines
// in the log, exit status 1 with the same message where they failed. The expected values
// and why each was chosen are documented beside the calls in the scripts.
package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"

	"ratmap/infra/tools/internal/pyjson"
	"ratmap/infra/tools/internal/pytext"
)

// failure is sys.exit("..."): the message on stderr, status 1.
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

// eachProps calls fn with every feature's properties. strip: skip blank lines and strip
// an RS prefix, as the peaks checks did; without it every line must be a feature, as the
// sac and terrain checks assumed.
func eachProps(path string, strip bool, fn func(*pyjson.Object) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		line, rerr := r.ReadBytes('\n')
		if len(line) > 0 || rerr == nil {
			text := line
			if strip {
				text = bytes.TrimFunc(bytes.TrimLeft(line, "\x1e"), pytext.IsSpace)
			}
			if !strip || len(text) > 0 {
				v, err := pyjson.Decode(text)
				if err != nil {
					return fmt.Errorf("%s: line %d: %w", path, n, err)
				}
				feature, ok := v.(*pyjson.Object)
				if !ok {
					return fmt.Errorf("%s: line %d is not a JSON object", path, n)
				}
				pv, has := feature.Get("properties")
				props, ok := pv.(*pyjson.Object)
				if !has && strip {
					props, ok = &pyjson.Object{}, true // .get("properties", {})
				}
				if !ok {
					return fmt.Errorf("%s: line %d has no properties object", path, n)
				}
				if err := fn(props); err != nil {
					return err
				}
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

func pyStr(v pyjson.Value) string {
	if s, ok := v.(string); ok {
		return s
	}
	s, _ := pyjson.Encode(v, pyjson.Options{})
	return pytext.StrValue([]byte(s))
}

// peaks checks known summit elevations, matched on name prefix (OSM often carries a
// multilingual name — Zla Kolata is tagged "Zla Kolata / Kollate e Keqe").
func peaks(path string, out io.Writer) error {
	expected := []struct {
		name string
		ele  float64
	}{{"Ben Nevis", 1345}, {"Mont Blanc", 4808}, {"Bobotov Kuk", 2523}, {"Zla Kolata", 2535}}
	const tolerance = 2

	byName := map[string]pyjson.Value{}
	err := eachProps(path, true, func(p *pyjson.Object) error {
		nv, _ := p.Get("name")
		name, ok := nv.(string)
		ev, _ := p.Get("ele")
		if _, isNum := pyjson.Number(ev); !ok || !isNum {
			return nil
		}
		for _, e := range expected {
			if _, seen := byName[e.name]; !seen && strings.HasPrefix(name, e.name) {
				byName[e.name] = ev
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
		a, _ := pyjson.Number(actual)
		if math.Abs(a-e.ele) > tolerance {
			return failure(fmt.Sprintf("FAIL: %s ele=%s, expected ~%d", e.name, pyStr(actual), int(e.ele)))
		}
		fmt.Fprintf(out, "  OK %s: %s m\n", e.name, pyStr(actual))
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
	err := eachProps(path, true, func(p *pyjson.Object) error {
		lists := ""
		if v, ok := p.Get("lists"); ok {
			s, isStr := v.(string)
			if !isStr {
				return fmt.Errorf("lists is %s, not a string", pyStr(v))
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
	err := eachProps(path, false, func(p *pyjson.Object) error {
		tv, ok := p.Get("t")
		grade, isInt := pyjson.IntValue(tv)
		if !ok || !isInt {
			return fmt.Errorf("a feature's t is %s, not a grade", pyStr(tv))
		}
		histogram[grade]++
		nv, _ := p.Get("name")
		if name, ok := nv.(string); ok {
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
	err := eachProps(path, false, func(p *pyjson.Object) error {
		kv, ok := p.Get("kind")
		if !ok {
			return errors.New(`a feature has no "kind"`)
		}
		histogram[pyStr(kv)]++
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
