// Package golden runs a command's main against the Python it replaced: stdout, stderr and
// exit status, case by case, as the build scripts saw them.
//
// A command's testdata/cases.tsv holds one case a line, tab-separated:
//
//	NAME	ARG...
//
// The goldens were written by the Python before it was removed (git history has it); the
// ARGs are what main is given, as the Python was. An ARG of {{out}} is a scratch file whose contents the command writes; they are compared too.
// An ARG of <FILE is not passed: FILE is the case's stdin.
// The goldens are NAME.want.stdout — stdout, then "exit N" — NAME.want.stderr, absent
// when stderr was empty, and NAME.want.out for {{out}}. A NAME written ~NAME has its
// stderr left uncompared: the Python's message there quoted its own exception text, which
// the port does not reproduce, and the scripts only pass it on.
package golden

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

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

	compare(t, "stdout", stdout.Bytes(), filepath.Join("testdata", name+".want.stdout"))
	if checkStderr {
		want, err := os.ReadFile(filepath.Join("testdata", name+".want.stderr"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if !bytes.Equal(stderr.Bytes(), want) {
			t.Errorf("stderr differs from the Python's:\n got:\n%s\n want:\n%s", stderr.Bytes(), want)
		}
	}
	if usesOut {
		got, _ := os.ReadFile(out) // absent reads as empty, as the goldens record it
		compare(t, "output file", got, filepath.Join("testdata", name+".want.out"))
	}
}

func compare(t *testing.T, what string, got []byte, wantPath string) {
	t.Helper()
	want, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the Python's:\n got:\n%s\n want:\n%s", what, got, want)
	}
}
