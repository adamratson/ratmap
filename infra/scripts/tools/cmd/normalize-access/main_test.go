package main

import (
	"bytes"
	"os"
	"testing"
)

// testdata/selftest.want.stdout is what --self-test prints: the report line, then OK.
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
