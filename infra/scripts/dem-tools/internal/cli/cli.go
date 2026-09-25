// Package cli parses command lines the way the Python scripts' argparse did, so every
// existing caller keeps working unchanged: `--flag value` or `--flag=value`, flags and
// positionals in any order, `--` ending the flags. The standard flag package stops at the
// first positional, which the callers do not expect.
package cli

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Spec describes one --flag. Bool flags take no value.
type Spec struct {
	Name string // without the leading dashes
	Bool bool
	Help string
}

// Args is a parsed command line.
type Args struct {
	Values      map[string]string
	Positionals []string
}

// Parse returns the flags and positionals in argv (without the program name).
// -h/--help prints usage and exits 0; a malformed line prints usage and exits 2, as
// argparse does.
func Parse(argv []string, usage string, specs []Spec) Args {
	byName := map[string]Spec{}
	for _, s := range specs {
		byName[s.Name] = s
	}
	fail := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, "%s\nerror: %s\n", usage, fmt.Sprintf(format, a...))
		os.Exit(2)
	}

	out := Args{Values: map[string]string{}}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if a == "--" {
			out.Positionals = append(out.Positionals, argv[i+1:]...)
			break
		}
		if a == "-h" || a == "--help" {
			fmt.Println(usage)
			for _, s := range specs {
				fmt.Printf("  --%-16s %s\n", s.Name, s.Help)
			}
			os.Exit(0)
		}
		if !strings.HasPrefix(a, "--") {
			out.Positionals = append(out.Positionals, a)
			continue
		}
		name, val, hasVal := strings.Cut(a[2:], "=")
		s, ok := byName[name]
		if !ok {
			fail("unrecognized argument: %s", a)
		}
		switch {
		case s.Bool && hasVal:
			fail("argument --%s: ignored explicit argument '%s'", name, val)
		case s.Bool:
			val = "true"
		case !hasVal:
			if i+1 >= len(argv) {
				fail("argument --%s: expected one argument", name)
			}
			i++
			val = argv[i]
		}
		out.Values[name] = val
	}
	return out
}

func (a Args) Has(name string) bool { _, ok := a.Values[name]; return ok }

func (a Args) String(name, def string) string {
	if v, ok := a.Values[name]; ok {
		return v
	}
	return def
}

// Int and Float exit 2 on a malformed value, like argparse's type= conversion.
func (a Args) Int(name string, def int) int {
	v, ok := a.Values[name]
	if !ok {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: argument --%s: invalid int value: '%s'\n", name, v)
		os.Exit(2)
	}
	return n
}

func (a Args) Float(name string, def float64) float64 {
	v, ok := a.Values[name]
	if !ok {
		return def
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: argument --%s: invalid float value: '%s'\n", name, v)
		os.Exit(2)
	}
	return f
}
