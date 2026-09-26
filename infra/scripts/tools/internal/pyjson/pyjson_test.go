package pyjson

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/python-dumps.tsv is CPython's json.dumps(json.loads(text)) on 2,500-odd texts
// under the four option sets the pipeline's writers use: key
// order and repeated keys, ints (including ones past int64) against floats, -0 and -0.0,
// float repr, non-ASCII and control characters escaped or not, empty containers, and
// indent 2 against indent 0.
func TestMatchesCPython(t *testing.T) {
	f, err := os.Open("testdata/python-dumps.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	opts := []Options{
		{EnsureASCII: true},
		{Indent: Indent(2), EnsureASCII: true},
		{Indent: Indent(2)},
		{Indent: Indent(0), EnsureASCII: true, SortKeys: true},
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	n := 0
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "\t")
		var in string
		json.Unmarshal([]byte(cols[0]), &in)
		v, err := Decode([]byte(in))
		if err != nil {
			t.Fatalf("Decode(%q): %v", in, err)
		}
		for i, o := range opts {
			var want string
			json.Unmarshal([]byte(cols[i+1]), &want)
			got, err := Encode(v, o)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Errorf("option set %d on %q:\n got  %q\n want %q", i, in, got, want)
			}
		}
		n++
	}
	if n < 2500 {
		t.Fatalf("only %d vectors", n)
	}
}
