package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock                   { return &clock{time.Date(2026, 11, 22, 17, 0, 0, 0, time.UTC)} }
func feedAll(c *console, segs ...segment) {
	for _, s := range segs {
		c.feed(s)
	}
}
func line(s string) segment  { return segment{s, '\n'} }
func frame(s string) segment { return segment{s, '\r'} }

// Off a terminal, what a stage of a real run (build-sac.sh's output, abridged) comes to:
// the driver's lines and the result printed, each step once, the debug lines gone.
func TestInfoOffTerminal(t *testing.T) {
	dir := t.TempDir()
	built := filepath.Join(dir, "sac-global.pmtiles")
	os.WriteFile(built, make([]byte, 3<<20), 0o644)

	clk := newClock()
	var out strings.Builder
	c := newConsole("sac", 2, &out, false, clk.now)
	feedAll(c,
		line("==> building normalize-sac"),
		line("  normalize-sac self-test OK (25 values)"),
		line("go: downloading golang.org/x/image v0.20.0"))
	clk.advance(6 * time.Second)
	feedAll(c,
		line("Source: https://download.geofabrik.de/africa-261121.osm.pbf"),
		line("  cached africa-261121.osm.pbf (7.9G)"),
		line("  graded 868 ways; skipped 257 non-line features"))
	clk.advance(2 * time.Second) // too soon after the last for a line of its own
	feedAll(c, line("Source: https://download.geofabrik.de/asia-261121.osm.pbf"))
	clk.advance(10 * time.Second)
	feedAll(c,
		frame("  12.5%  6/35/23  "),
		frame("  37.5%  6/35/23  "),
		line("pmtiles spec version: 3"),
		line("tile type: mvt"),
		line("Built "+built),
		line("Next:"),
		line("  ./scripts/upload.sh"))

	want := strings.Join([]string{
		"[17:00:00] sac  building normalize-sac",
		"[17:00:06] sac  [░░░░░░░░░░░░░░░░░░░░] 0/2 extracts  reading africa-261121",
		"[17:00:18] sac  [███░░░░░░░░░░░░░░░░░]  12%  tiling",
		"[17:00:18] built " + built + " (3 MB)",
		"",
	}, "\n")
	if got := out.String(); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

// Off a terminal, progress alone prints at most once a minute, and only if it moved.
func TestHeartbeatOffTerminal(t *testing.T) {
	clk := newClock()
	var out strings.Builder
	c := newConsole("regions", 0, &out, false, clk.now)
	c.feed(line("@@progress 0 184 regions"))
	c.tick()
	for i := 1; i <= 90; i++ {
		clk.advance(time.Second)
		c.feed(line("@@progress " + itoa(i/30) + " 184 regions"))
		c.tick()
	}
	if got := strings.Count(out.String(), "\n"); got != 2 {
		t.Errorf("%d lines in 90 s, want 2 (the first, and one a minute on):\n%s", got, out.String())
	}
}

// Trouble is printed whatever made it; the log gets every byte bar the @@ lines.
func TestTroubleAndLog(t *testing.T) {
	clk := newClock()
	var out strings.Builder
	c := newConsole("detail", 8, &out, false, clk.now)
	for _, s := range []string{
		"FAIL: implausibly few features for stile (3 < 10)",
		"ERROR 1: TIFFReadEncodedTile() failed.",
		"  ! no DEM for montenegro-region — its peaks keep no prominence",
		"curl: (22) The requested URL returned error: 404",
		"  graded 0 ways; 0 failed to parse", // "failed" mid-line: not trouble
		"[17:20:38] regions/x FAILED — see /work/logs/x.log",
	} {
		c.feed(line(s))
	}
	got := out.String()
	for _, want := range []string{"FAIL: implausibly", "ERROR 1:", "! no DEM", "curl: (22)", "regions/x FAILED"} {
		if !strings.Contains(got, want) {
			t.Errorf("console is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "graded 0 ways") {
		t.Errorf("a count with \"failed\" in it was printed as trouble:\n%s", got)
	}
	if b := c.logBytes(line("@@progress 3 8 regions")); b != nil {
		t.Errorf("@@progress reached the log: %q", b)
	}
	if b := string(c.logBytes(frame("  37.5%  6/35/23  "))); b != "  37.5%  6/35/23  \r" {
		t.Errorf("a progress frame was not logged as written: %q", b)
	}
}

// A step ending "(i/n)" is progress: compute-prominence's per-region header.
func TestStepCount(t *testing.T) {
	clk := newClock()
	var out strings.Builder
	c := newConsole("peaks", 0, &out, false, clk.now)
	c.feed(line("==> prominence: scotland (112/184)"))
	if want := "[17:00:00] peaks  [████████████░░░░░░░░] 111/184  prominence: scotland\n"; out.String() != want {
		t.Errorf("got %q, want %q", out.String(), want)
	}
}

// regions: progress in bytes, the count as its status, and contours' fetch-ahead beside.
func TestBytesAndFetch(t *testing.T) {
	clk := newClock()
	var out strings.Builder
	c := newConsole("contours", 0, &out, false, clk.now)
	clk.advance(time.Minute)
	feedAll(c,
		line("@@fetch 5 62 DEMs"),
		line("@@progress 4402341888 332859965440 bytes"),
		line("==> 3/62 regions"))
	want := "[17:01:00] contours  [░░░░░░░░░░░░░░░░░░░░] 4.1/310 GB · fetched 5/62 DEMs  3/62 regions\n"
	if out.String() != want {
		t.Errorf("got  %q\nwant %q", out.String(), want)
	}
	if b := c.logBytes(line("@@fetch 5 62 DEMs")); b != nil {
		t.Errorf("@@fetch reached the log: %q", b)
	}
}

// On a terminal: one live line, redrawn in place, cleared before a printed line and at
// the end, and never wider than the terminal.
func TestTerminal(t *testing.T) {
	clk := newClock()
	var out strings.Builder
	c := newConsole("contours", 0, &out, true, clk.now)
	c.width = func() int { return 40 }
	c.feed(line("@@progress 3 62 regions"))
	clk.advance(75 * time.Second)
	c.tick()
	c.feed(line("[17:01:15] contours/alps FAILED — see the log"))
	c.finish()

	got := out.String()
	for _, f := range strings.Split(got, "\r\x1b[2K") {
		if strings.HasSuffix(f, "\n") {
			continue // a printed line, which wraps like any other
		}
		if n := len([]rune(f)); n > 39 {
			t.Errorf("live line of %d columns on a 40-column terminal: %q", n, f)
		}
	}
	if !strings.Contains(got, "\r\x1b[2K[17:01:15] contours/alps FAILED — see the log\n") {
		t.Errorf("printed line did not clear the live line first:\n%q", got)
	}
	if !strings.HasSuffix(got, "\r\x1b[2K") {
		t.Errorf("live line not cleared at the end:\n%q", got)
	}
	if !strings.Contains(got, "3/62") {
		t.Errorf("no progress on the live line:\n%q", got)
	}
}

// --level debug is the old tee: everything to the console as written, @@ lines aside.
func TestDebug(t *testing.T) {
	var out strings.Builder
	c := newConsole("sac", 0, &out, false, newClock().now)
	c.debug = true
	feedAll(c, line("pmtiles spec version: 3"), frame("  37.5%  6/35/23  "), line("@@progress 1 2 x"))
	if want := "pmtiles spec version: 3\n  37.5%  6/35/23  \r"; out.String() != want {
		t.Errorf("got %q, want %q", out.String(), want)
	}
}

func TestDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		0: "0:00", 75 * time.Second: "1:15", 3*time.Hour + 4*time.Minute + 5*time.Second: "3:04:05",
	} {
		if got := duration(d); got != want {
			t.Errorf("duration(%v) = %q, want %q", d, got, want)
		}
	}
}

func itoa(i int) string { return trim(float64(i)) }
