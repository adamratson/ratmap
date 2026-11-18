package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ratmap/infra/tools/internal/golden"
)

// testdata/selftest.want.stdout is what --self-test prints.
func TestSelfTest(t *testing.T) {
	var out bytes.Buffer
	if err := selfTest(&out); err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/selftest.want.stdout")
	if out.String() != string(want) {
		t.Errorf("self-test output differs:\n got:\n%s\n want:\n%s", out.String(), want)
	}
}

// testdata/edge.want.* are the output and report for testdata/edge.opl and
// testdata/edge.geojsonl: a superroute of stages, a superroute of superroutes, a stage
// whose parent has another network (keeps its own name), a collection that must not name
// its members, a route of routes, a parent cycle, a way on routes of every level and on two
// named routes of one level (the lower id wins), an unnamed route whose ref labels it, one
// with neither, a route with no network and one with a cycle network (both local), proposed
// and disused routes, a cycle route, OPL escapes in names (a comma, an equals sign, a
// percent sign and non-ASCII letters), a polygon and a node in the way input, seam
// duplicates of both a relation and a way, and the joining of ways into lines: a route's
// ways end to end with one mapped backwards (one line), a fork where three meet (three
// lines) and two ways closing a loop (one line). Compared parsed, not as bytes. -update
// rewrites them.
func TestEdgeCases(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out.geojsonl")
	var report bytes.Buffer
	if err := run("testdata/edge.opl", "testdata/edge.geojsonl", out, &report); err != nil {
		t.Fatal(err)
	}
	golden.Check(t, "report", report.Bytes(), "testdata/edge.want.stdout")
	if *golden.Update {
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		golden.Check(t, "features", data, "testdata/edge.want.geojsonl")
		return
	}
	got, want := features(t, out), features(t, "testdata/edge.want.geojsonl")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("features differ:\n got  %v\n want %v", got, want)
	}
}

func TestUnescape(t *testing.T) {
	for in, want := range map[string]string{
		"plain":                 "plain",
		"West%20%Highland":      "West Highland",
		"%2c%%3d%%25%":          ",=%",
		"Pe%161%ka%20%ku%107%e": "Peška kuće",
		"%1f600%":               "😀",
	} {
		got, err := unescape(in)
		if err != nil || got != want {
			t.Errorf("unescape(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"open%20", "%zz%"} {
		if _, err := unescape(bad); err == nil {
			t.Errorf("unescape(%q) succeeded, want an error", bad)
		}
	}
}

func TestParseOPL(t *testing.T) {
	r, ok, err := parseOPL("r7 Tname=A%2c%%20%B,type=route Mw1@,w2@forward,r3@,n4@guidepost")
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if r.id != 7 || r.tags["name"] != "A, B" || r.tags["type"] != "route" {
		t.Errorf("parsed %+v", r)
	}
	want := []member{{'w', 1}, {'w', 2}, {'r', 3}, {'n', 4}}
	if !reflect.DeepEqual(r.members, want) {
		t.Errorf("members %v, want %v", r.members, want)
	}
	if r, ok, err := parseOPL("r8 T M"); err != nil || !ok || len(r.tags) != 0 || len(r.members) != 0 {
		t.Errorf("empty relation: %+v %v %v", r, ok, err)
	}
	if _, ok, _ := parseOPL("w9 Thighway=path Nn1,n2"); ok {
		t.Error("a way line parsed as a relation")
	}
	for _, bad := range []string{"rX T", "r1 Tnoequals", "r1 Mx1@", "r1 Mw@"} {
		if _, _, err := parseOPL(bad); err == nil {
			t.Errorf("parseOPL(%q) succeeded, want an error", bad)
		}
	}
}

func features(t *testing.T, path string) []any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fs []any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		fs = append(fs, v)
	}
	return fs
}
