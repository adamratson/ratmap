// Package golden checks what a command writes against files kept beside its tests:
// stdout, stderr and exit status, case by case, as the build scripts see them.
//
// A command's testdata/cases.tsv holds one case a line, tab-separated:
//
//	NAME	ARG...
//
// The ARGs are what main is given. An ARG of {{out}} is a scratch file whose contents the
// command writes; they are compared too. An ARG of <FILE is not passed: FILE is the case's
// stdin. The goldens are NAME.want.stdout — stdout, then "exit N" — NAME.want.stderr,
// absent when stderr is empty, and NAME.want.out for {{out}}. A NAME written ~NAME has its
// stderr left uncompared.
//
// The first goldens were written by the Python each command replaced (git history has
// it). `go test ./... -update` rewrites them from the Go instead, for a change that is
// meant to alter output: the diff is then the review.
package golden

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Update is -update: rewrite the goldens instead of comparing against them.
var Update = flag.Bool("update", false, "rewrite the golden files from what the code writes now")

const argsEnv = "RATMAP_GOLDEN_ARGS"

// Main is called from a command's TestMain: when the test binary is re-run as the command
// (by Run), it runs main with the case's arguments instead of the tests.
func Main(m *testing.M, main func()) {
	if a := os.Getenv(argsEnv); a != "" {
		var args []string
		if err := json.Unmarshal([]byte(a), &args); err != nil {
			fmt.Fprintln(os.Stderr, "golden:", err)
			os.Exit(2)
		}
		os.Args = append([]string{filepath.Base(os.Args[0])}, args...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// Run runs every case in testdata/cases.tsv.
func Run(t *testing.T) {
	t.Helper()
	data, err := os.ReadFile("testdata/cases.tsv")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		cols := strings.Split(line, "\t")
		name, args := cols[0], cols[1:]
		stderr := !strings.HasPrefix(name, "~")
		name = strings.TrimPrefix(name, "~")
		n++
		t.Run(name, func(t *testing.T) { runCase(t, name, args, stderr) })
	}
	if n == 0 {
		t.Fatal("cases.tsv has no cases")
	}
}

func runCase(t *testing.T, name string, args []string, checkStderr bool) {
	out := filepath.Join(t.TempDir(), "out")
	usesOut := false
	var passed []string
	stdin := ""
	for _, a := range args {
		switch {
		case a == "{{out}}":
			passed, usesOut = append(passed, out), true
		case strings.HasPrefix(a, "<"):
			stdin = a[1:]
		default:
			passed = append(passed, a)
		}
	}
	encoded, _ := json.Marshal(passed)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), argsEnv+"="+string(encoded))
	if stdin != "" {
		in, err := os.Open(stdin)
		if err != nil {
			t.Fatal(err)
		}
		defer in.Close()
		cmd.Stdin = in
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	status := 0
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatal(err)
		}
		status = exit.ExitCode()
	}
	fmt.Fprintf(&stdout, "exit %d\n", status)

	Check(t, "stdout", stdout.Bytes(), filepath.Join("testdata", name+".want.stdout"))
	if checkStderr {
		CheckOptional(t, "stderr", stderr.Bytes(), filepath.Join("testdata", name+".want.stderr"))
	}
	if usesOut {
		got, _ := os.ReadFile(out) // absent reads as empty
		Check(t, "output file", got, filepath.Join("testdata", name+".want.out"))
	}
}

// Check compares got with the golden file at path, or with -update writes it there.
func Check(t *testing.T, what string, got []byte, path string) {
	t.Helper()
	if *Update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from %s:\n got:\n%s\n want:\n%s", what, path, got, want)
	}
}

// CheckOptional is Check for a golden that is absent when it would be empty.
func CheckOptional(t *testing.T, what string, got []byte, path string) {
	t.Helper()
	if *Update {
		if len(got) == 0 {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				t.Fatal(err)
			}
			return
		}
		Check(t, what, got, path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from %s:\n got:\n%s\n want:\n%s", what, path, got, want)
	}
}
