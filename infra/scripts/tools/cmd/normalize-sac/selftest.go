package main

import (
	"encoding/json"
	"fmt"
)

// selfTestCases is the Python's --self-test table, value for value: the parser earns a
// test of its own, run on every build by build-sac.sh, because `sac_scale` is a
// documented enum that in practice carries 184 distinct values, and the difference
// between reading "T2-T3" as 3 and discarding it is a graded path silently vanishing
// from the map. 0 means "no grade" (Python's None).
var selfTestCases = []struct {
	value string // JSON
	want  int
}{
	{`"hiking"`, 1},
	{`"mountain_hiking"`, 2},
	{`"demanding_mountain_hiking"`, 3},
	{`"alpine_hiking"`, 4},
	{`"demanding_alpine_hiking"`, 5},
	{`"difficult_alpine_hiking"`, 6},
	{`"T3"`, 3},
	{`"t3"`, 3},
	{`"3"`, 3},
	{`" T2 "`, 2},
	{`"T2+"`, 2},
	// Ranges and lists take the harder end.
	{`"T2-T3"`, 3},
	{`"T1 - T2"`, 2},
	{`"hiking;mountain_hiking"`, 2},
	{`"mountain_hiking - demanding_mountain_hiking"`, 3},
	{`"alpine_hiking (T4)"`, 4},
	// Not a SAC grade, and not T1.
	{`"strolling"`, 0},
	{`"yes"`, 0},
	{`"?"`, 0},
	{`""`, 0},
	{`"T7"`, 0},
	{`"0"`, 0},
	{`null`, 0},
	{`true`, 0},
	{`4`, 4},
}

func selfTest() []string {
	var failures []string
	for _, c := range selfTestCases {
		g, ok, err := parseGrade(json.RawMessage(c.value))
		if !ok {
			g = 0
		}
		if err != nil || g != c.want {
			failures = append(failures, fmt.Sprintf("%s -> %d (%v), expected %d", c.value, g, err, c.want))
		}
	}
	return failures
}
