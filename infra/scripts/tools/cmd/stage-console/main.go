// Command stage-console is what build-global.sh pipes each stage through: everything
// the stage writes goes to its log, and the console gets an info-level view of it — one
// live progress line per stage, plus the lines worth reading as they happen.
//
//	stage_x 2>&1 | stage-console --stage NAME --log FILE [--sources N] [--level info|debug]
//
// A planet stage writes tens of thousands of lines nobody reads as they scroll past: each
// archive's full `pmtiles show`, tool builds, self-tests, per-region prominence detail,
// tippecanoe's and pmtiles' own progress redrawn in place. All of it still goes to the
// log, byte for byte (`--level debug` puts it on the console too, as before). What the
// console shows is read from conventions the build scripts already follow:
//
//	[HH:MM:SS] text       the driver's own log lines           printed
//	==> text              a script's next step                 the live line's status;
//	                                                           "(i/n)" at its end is progress
//	Source: URL           the next OSM extract (--sources N)  progress over the N
//	Built PATH ...        the stage's result                   printed, with its size
//	NN.N%  z/x/y          tippecanoe's progress                progress, "tiling"
//	fetching chunks NN%   pmtiles extract's progress           progress, "downloading"
//	#### NN.N%            curl --progress-bar                  progress, "downloading"
//	FAIL / ERROR / ! ...  something going wrong                printed
//	@@progress D N UNIT   explicit progress (the driver)      progress; UNIT "bytes" shows
//	                                                           as "4.1/310 GB"
//	@@fetch D N UNIT      what is fetched ahead of the work    "· fetched D/N UNIT"
//	                      (the driver: contours' DEMs)         beside the progress
//
// and anything else is debug: the log only. On a terminal the live line redraws in place
// once a second; anywhere else (docker logs, a file) it is printed as a line when the
// step changes, and at most once a minute otherwise.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"golang.org/x/sys/unix"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "stage-console:", err)
		os.Exit(2)
	}
}

func run(args []string, in io.Reader, out *os.File) error {
	fs := flag.NewFlagSet("stage-console", flag.ContinueOnError)
	stage := fs.String("stage", "", "stage name, shown on the live line")
	logPath := fs.String("log", "", "file every byte of the stage's output is appended to")
	sources := fs.Int("sources", 0, "how many OSM extracts the stage reads, for its Source: lines")
	level := fs.String("level", "info", "info, or debug for everything")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *stage == "" || *logPath == "" {
		return errors.New("--stage and --log are required")
	}
	if *level != "info" && *level != "debug" {
		return fmt.Errorf("--level %q: want info or debug", *level)
	}
	lf, err := os.OpenFile(*logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer lf.Close()

	c := newConsole(*stage, *sources, out, isTerminal(out), time.Now)
	c.debug = *level == "debug"
	c.width = func() int { return terminalWidth(out) }

	// The reader only splits; every decision and every write happens on this goroutine,
	// so the ticker's redraw and a line arriving never interleave.
	segs := make(chan segment, 256)
	go split(in, segs)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case s, ok := <-segs:
			if !ok {
				c.finish()
				return nil
			}
			lf.Write(c.logBytes(s))
			c.feed(s)
		case <-tick.C:
			c.tick()
		}
	}
}

// A segment is one piece of the stream up to and including its terminator: '\n' for a
// line, '\r' for one frame of a progress bar redrawn in place, or nothing at EOF.
type segment struct {
	text string
	end  byte
}

func split(in io.Reader, out chan<- segment) {
	defer close(out)
	r := bufio.NewReaderSize(in, 64<<10)
	var buf []byte
	for {
		b, err := r.ReadByte()
		if err != nil {
			if len(buf) > 0 {
				out <- segment{string(buf), 0}
			}
			return
		}
		if b == '\n' || b == '\r' {
			out <- segment{string(buf), b}
			buf = buf[:0]
			continue
		}
		buf = append(buf, b)
	}
}

var (
	reDriver    = regexp.MustCompile(`^\[\d\d:\d\d:\d\d\] `)
	reStep      = regexp.MustCompile(`^==> (.*?)\s*$`)
	reStepCount = regexp.MustCompile(`\((\d+)/(\d+)\)$`)
	reSource    = regexp.MustCompile(`^Source: (\S+)`)
	reBuilt     = regexp.MustCompile(`^Built (\S+)`)
	reTippe     = regexp.MustCompile(`^\s*(\d+(?:\.\d+)?)%\s+\d+/\d+/\d+\s*$`)
	rePmtiles   = regexp.MustCompile(`^fetching (?:chunks|tiles)\s+(\d+)%`)
	reCurl      = regexp.MustCompile(`^#*\s*(\d+(?:\.\d+)?)%\s*$`)
	reProgress  = regexp.MustCompile(`^@@(progress|fetch) (\d+) (\d+)(?: (.*))?$`)
	// A line that starts with a failure, however it is cased, or says FAILED anywhere;
	// "0 failed to parse" in a count is not one.
	reTrouble = regexp.MustCompile(`^\s*(?i:fail|failed|error|fatal|panic)\b|\bFAILED\b|^\s*! |^curl: \(\d+\)`)
)

type console struct {
	stage   string
	sources int
	out     io.Writer
	tty     bool
	debug   bool
	now     func() time.Time
	width   func() int

	start    time.Time
	status   string  // the current step
	done     float64 // progress: done of total, in unit; total 0 = none known
	total    float64
	unit     string
	sourceN  int
	fetched  string // "fetched 5/62 DEMs", from @@fetch
	frame    int
	cells    int       // the bar's width
	drawn    bool      // a live line is on screen (terminal only)
	lastLine string    // the last status printed as a line (not a terminal)
	lastAt   time.Time // when it was printed
}

func newConsole(stage string, sources int, out io.Writer, tty bool, now func() time.Time) *console {
	return &console{stage: stage, sources: sources, out: out, tty: tty, now: now,
		start: now(), width: func() int { return 100 }, cells: 20}
}

// logBytes is what the log gets for a segment: exactly what the stage wrote, except the
// driver's @@progress lines, which mean nothing to someone reading the log afterwards.
func (c *console) logBytes(s segment) []byte {
	if reProgress.MatchString(s.text) {
		return nil
	}
	b := []byte(s.text)
	if s.end != 0 {
		b = append(b, s.end)
	}
	return b
}

func (c *console) feed(s segment) {
	if c.debug {
		if !reProgress.MatchString(s.text) {
			c.out.Write(c.logBytes(s))
		}
		return
	}
	t := strings.TrimRight(s.text, " \t")
	if t == "" {
		return
	}
	switch {
	case reProgress.MatchString(t):
		m := reProgress.FindStringSubmatch(t)
		if m[1] == "fetch" {
			c.fetched = fmt.Sprintf("fetched %s/%s %s", m[2], m[3], m[4])
			c.fetched = strings.TrimSpace(c.fetched)
			c.setProgress(c.done, c.total, c.unit)
			break
		}
		c.setProgress(atof(m[2]), atof(m[3]), m[4])
	case reDriver.MatchString(t):
		c.print(t)
	case reStep.MatchString(t):
		c.status = reStep.FindStringSubmatch(t)[1]
		if m := reStepCount.FindStringSubmatch(c.status); m != nil {
			c.status = strings.TrimSpace(strings.TrimSuffix(c.status, m[0]))
			c.setProgress(atof(m[1])-1, atof(m[2]), "")
		}
		c.statusChanged()
	case reSource.MatchString(t):
		src := filepath.Base(reSource.FindStringSubmatch(t)[1])
		src = strings.TrimSuffix(src, ".osm.pbf")
		c.sourceN++
		c.status = "reading " + src
		if c.sources > 0 {
			c.setProgress(float64(c.sourceN-1), float64(c.sources), "extracts")
		}
		c.statusChanged()
	case reBuilt.MatchString(t):
		c.print(c.stamp() + "built " + c.describe(reBuilt.FindStringSubmatch(t)[1]))
	case reTippe.MatchString(t):
		c.percent("tiling", reTippe.FindStringSubmatch(t)[1])
	case rePmtiles.MatchString(t):
		c.percent("downloading", rePmtiles.FindStringSubmatch(t)[1])
	case reCurl.MatchString(t):
		c.percent("downloading", reCurl.FindStringSubmatch(t)[1])
	case reTrouble.MatchString(t):
		c.print(c.stamp() + strings.TrimLeft(t, " "))
	}
}

func (c *console) percent(what, pct string) {
	c.setProgress(atof(pct), 100, "%")
	if c.status != what {
		c.status = what
		c.statusChanged()
	}
}

func (c *console) setProgress(done, total float64, unit string) {
	c.done, c.total, c.unit = done, total, strings.TrimSpace(unit)
	if c.tty {
		c.redraw()
	}
}

// statusChanged: a new step is worth a line where there is no live line to show it.
func (c *console) statusChanged() {
	if c.tty {
		c.redraw()
		return
	}
	c.printStatus(true)
}

func (c *console) tick() {
	c.frame++
	if c.tty {
		c.redraw()
		return
	}
	c.printStatus(false)
}

// printStatus, off a terminal: the status as a line, on a new step (but not more than
// one every 5 s, for a run of fast ones) or once a minute while anything moved.
func (c *console) printStatus(stepChanged bool) {
	line := c.statusLine(false)
	if line == c.lastLine {
		return
	}
	since := c.now().Sub(c.lastAt)
	if (stepChanged && since >= 5*time.Second) || since >= time.Minute {
		fmt.Fprintln(c.out, c.stamp()+strings.TrimLeft(line, " "))
		c.lastLine, c.lastAt = line, c.now()
	}
}

func (c *console) print(line string) {
	if c.tty && c.drawn {
		fmt.Fprint(c.out, "\r\x1b[2K")
		c.drawn = false
	}
	fmt.Fprintln(c.out, line)
	if c.tty {
		c.redraw()
	}
}

func (c *console) redraw() {
	fmt.Fprint(c.out, "\r\x1b[2K"+c.fit(c.width()-1))
	c.drawn = true
}

// fit: the live line in w columns — the step text shortened first, then the bar, so the
// count and the clock are the last things a narrow terminal loses.
func (c *console) fit(w int) string {
	line := c.statusLine(true)
	over := len([]rune(line)) - w
	if over <= 0 {
		return line
	}
	keep := c.status
	if n := len([]rune(keep)); n > 0 {
		c.status = string([]rune(keep)[:max(n-over-1, 0)]) + "…"
		if c.status == "…" {
			c.status = ""
		}
	}
	line = c.statusLine(true)
	c.status = keep
	if over = len([]rune(line)) - w; over > 0 {
		cells := c.cells
		c.cells = max(cells-over, 0)
		line = c.statusLine(true)
		c.cells = cells
	}
	if r := []rune(line); len(r) > w {
		line = string(r[:max(w, 0)])
	}
	return line
}

func (c *console) finish() {
	if c.tty && c.drawn {
		fmt.Fprint(c.out, "\r\x1b[2K")
		c.drawn = false
	}
}

var spinner = []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")

// statusLine: "  ⠹ paths  [██████░░░░░░░░░░░░░░] 3/8 extracts  reading europe  12:04".
func (c *console) statusLine(live bool) string {
	var b strings.Builder
	b.WriteString("  ")
	if live {
		b.WriteRune(spinner[c.frame%len(spinner)])
		b.WriteString(" ")
	}
	b.WriteString(c.stage)
	if c.total > 0 {
		frac := min(max(c.done/c.total, 0), 1)
		if c.cells >= 4 {
			full := int(frac*float64(c.cells) + 0.5)
			b.WriteString("  [" + strings.Repeat("█", full) + strings.Repeat("░", c.cells-full) + "]")
		}
		b.WriteString(" ")
		switch c.unit {
		case "%":
			b.WriteString(fmt.Sprintf("%3d%%", int(frac*100))) // down, so 100% means done
		case "bytes":
			b.WriteString(sizes(c.done, c.total))
		default:
			b.WriteString(fmt.Sprintf("%s/%s", trim(c.done), trim(c.total)))
			if c.unit != "" {
				b.WriteString(" " + c.unit)
			}
		}
	}
	if c.fetched != "" {
		b.WriteString(" · " + c.fetched)
	}
	if c.status != "" {
		b.WriteString("  " + c.status)
	}
	if live {
		b.WriteString("  " + duration(c.now().Sub(c.start)))
	}
	return b.String()
}

func (c *console) stamp() string { return c.now().UTC().Format("[15:04:05] ") }

// describe: "dist/peaks-global.pmtiles (412 MB)", the path as the driver's other lines
// spell it and the size it came out at.
func (c *console) describe(path string) string {
	name := strings.TrimPrefix(path, "/opt/ratmap/infra/")
	st, err := os.Stat(path)
	if err != nil {
		return name
	}
	return fmt.Sprintf("%s (%s)", name, size(st.Size()))
}

func size(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// sizes: "4.1/310 GB", both in the unit the total reads best in.
func sizes(done, total float64) string {
	div, unit := 1.0, "B"
	switch {
	case total >= 1<<30:
		div, unit = 1<<30, "GB"
	case total >= 1<<20:
		div, unit = 1<<20, "MB"
	case total >= 1<<10:
		div, unit = 1<<10, "KB"
	}
	f := func(v float64) string {
		v /= div
		if v < 10 && unit != "B" {
			return strconv.FormatFloat(v, 'f', 1, 64)
		}
		return strconv.FormatFloat(v, 'f', 0, 64)
	}
	return f(done) + "/" + f(total) + " " + unit
}

func duration(d time.Duration) string {
	s := int(d.Seconds())
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func trim(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func isTerminal(f *os.File) bool { return isatty.IsTerminal(f.Fd()) }

func terminalWidth(f *os.File) int {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil || ws.Col == 0 {
		return 100
	}
	return int(ws.Col)
}
