// Package cli is the standard flag package with flags and positionals in any order:
// `tool DEM OUT --zmax 11` as well as `tool --zmax 11 DEM OUT`, which the build scripts
// rely on. flag.Parse alone stops at the first positional.
package cli

import (
	"flag"
	"fmt"
	"os"
)

// Parse parses args with fs, returning the positionals in order. Everything after "--"
// is positional. fs should be flag.ExitOnError: a bad flag prints usage and exits 2, -h
// prints it and exits 0.
func Parse(fs *flag.FlagSet, usage string, args []string) []string {
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), usage)
		fs.PrintDefaults()
	}
	var positionals []string
	for {
		fs.Parse(args)
		rest := fs.Args()
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" {
			return append(positionals, rest...)
		}
		if len(rest) == 0 {
			return positionals
		}
		positionals, args = append(positionals, rest[0]), rest[1:]
	}
}

// Given is the set of flags that appeared on the command line.
func Given(fs *flag.FlagSet) map[string]bool {
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	return set
}

// Fail reports a usage error — flags that parsed but do not make sense together — with
// the usage, and exits 2.
func Fail(fs *flag.FlagSet, format string, a ...any) {
	fmt.Fprintf(fs.Output(), "%s: %s\n", fs.Name(), fmt.Sprintf(format, a...))
	fs.Usage()
	os.Exit(2)
}
