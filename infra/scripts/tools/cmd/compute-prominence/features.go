package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"

	"ratmap/infra/tools/internal/jsonedit"
)

// eachLine calls fn with every non-blank line of a line-delimited GeoJSON file, in order,
// with a leading RS (\x1e, RFC 8142's record separator) and surrounding space stripped.
func eachLine(path string, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		raw, err := r.ReadBytes('\n')
		if len(raw) > 0 {
			line := bytes.TrimSpace(bytes.TrimLeft(raw, "\x1e"))
			if len(line) > 0 {
				if ferr := fn(line); ferr != nil {
					return ferr
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// loadCoords reads every feature's point as two float64 slices indexed like the file —
// 16 bytes a peak. NaN for a feature with no coordinates: compute skips those, and NaN
// fails every bounds test.
func loadCoords(path string) ([]float64, []float64, error) {
	var lons, lats []float64
	n := 0
	err := eachLine(path, func(line []byte) error {
		n++
		var f struct {
			Geometry *struct {
				Coordinates []float64 `json:"coordinates"`
			} `json:"geometry"`
		}
		if err := json.Unmarshal(line, &f); err != nil {
			return fmt.Errorf("%s: feature %d: %w", path, n, err)
		}
		if f.Geometry == nil || len(f.Geometry.Coordinates) == 0 {
			lons, lats = append(lons, math.NaN()), append(lats, math.NaN())
			return nil
		}
		if len(f.Geometry.Coordinates) < 2 {
			return fmt.Errorf("%s: feature %d: coordinates has one value", path, n)
		}
		lons = append(lons, f.Geometry.Coordinates[0])
		lats = append(lats, f.Geometry.Coordinates[1])
		return nil
	})
	return lons, lats, err
}

// writeOutput streams the input to the output, adding `prom` where scored.
//
// It splices `"prom": <value>` into each scored line's text and copies every other byte
// through, rather than re-encoding the feature.
func writeOutput(peaksIn, peaksOut string, prom map[int]float64) error {
	out, err := os.Create(peaksOut)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(out, 1<<20)
	i := 0
	err = eachLine(peaksIn, func(line []byte) error {
		defer func() { i++ }()
		if v, ok := prom[i]; ok {
			spliced, err := setProm(line, strconv.FormatFloat(v, 'f', -1, 64))
			if err != nil {
				return fmt.Errorf("%s: feature %d: %w", peaksIn, i+1, err)
			}
			line = spliced
		}
		w.Write(line)
		return w.WriteByte('\n')
	})
	if err != nil {
		out.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// setProm sets properties.prom on the JSON text: an existing "prom" has its value
// replaced in place, a new one is appended as the last property, and a feature with no
// "properties" gets one appended as its last member.
func setProm(line []byte, value string) ([]byte, error) {
	top, err := jsonedit.Parse(line, 0)
	if err != nil {
		return nil, fmt.Errorf("feature: %w", err)
	}
	i, err := top.Find("properties")
	if err != nil {
		return nil, err
	}
	if i < 0 {
		return top.Set(line, "properties", []byte(`{"prom":`+value+`}`))
	}
	if v := top.Value(line, i); v[0] != '{' {
		return nil, fmt.Errorf(`"properties" is %s, not an object`, v)
	}
	props, err := jsonedit.Parse(line, top.Members[i].ValueStart)
	if err != nil {
		return nil, err
	}
	return props.Set(line, "prom", []byte(value))
}
