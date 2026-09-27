// Command upload-check holds upload.sh's three checks.
//
//	upload-check changed LISTING DIST_DIR KEY...      # which archives differ from the bucket
//	upload-check unpublished PUBLISHED LOCAL          # regions a new manifest would drop
//	upload-check served HEADERS BODY LOCAL            # the live manifest is served right
//
// See upload.sh beside each call for why each check exists.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

type failure string

func (f failure) Error() string { return string(f) }

const usage = `usage: upload-check changed LISTING DIST_DIR KEY...
       upload-check unpublished PUBLISHED_MANIFEST LOCAL_MANIFEST
       upload-check served HEADERS BODY LOCAL_MANIFEST`

func main() {
	err := run(os.Args[1:], os.Stdout)
	var f failure
	switch {
	case err == nil:
	case errors.Is(err, errUsage):
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	case errors.As(err, &f):
		fmt.Fprintln(os.Stderr, string(f))
		os.Exit(1)
	default:
		fmt.Fprintln(os.Stderr, "upload-check:", err)
		os.Exit(1)
	}
}

var errUsage = errors.New("usage")

func run(args []string, out io.Writer) error {
	switch {
	case len(args) >= 3 && args[0] == "changed":
		return changed(args[1], args[2], args[3:], out)
	case len(args) == 3 && args[0] == "unpublished":
		return unpublished(args[1], args[2], out)
	case len(args) == 4 && args[0] == "served":
		return served(args[1], args[2], args[3], out)
	}
	return errUsage
}

// changed prints each key whose size in dist/ differs from the bucket listing's, or which
// the listing lacks. Every way the listing can be wrong errs towards uploading: a key it
// omits reads as absent, a size it misreports reads as changed. A listing that cannot be
// read at all fails, and upload.sh falls back to checking one archive at a time.
func changed(listing, dist string, keys []string, out io.Writer) error {
	data, err := os.ReadFile(listing)
	if err != nil {
		return err
	}
	remote := map[string]float64{}
	// An empty bucket lists as no output at all, not as an empty Contents array.
	if text := bytes.TrimSpace(data); len(text) > 0 {
		var doc struct {
			Contents []struct {
				Key  *string
				Size *float64
			}
		}
		if err := json.Unmarshal(text, &doc); err != nil {
			return failure("listing was not readable JSON: " + err.Error())
		}
		for _, o := range doc.Contents {
			if o.Key == nil || o.Size == nil {
				return failure("listing was not readable JSON: an entry has no Key and Size")
			}
			remote[*o.Key] = *o.Size
		}
	}
	for _, key := range keys {
		st, err := os.Stat(filepath.Join(dist, key))
		if err != nil {
			return err
		}
		if size, present := remote[key]; !present || size != float64(st.Size()) {
			fmt.Fprintln(out, key)
		}
	}
	return nil
}

// readManifest reads a manifest, plain or gzipped: the published copy is stored gzipped,
// and `aws s3 cp` returns it as stored.
func readManifest(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if data, err = io.ReadAll(zr); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	return data, nil
}

type manifestRegions struct {
	Regions []struct {
		ID *string `json:"id"`
	} `json:"regions"`
}

func regionIDs(path string) (map[string]bool, error) {
	data, err := readManifest(path)
	if err != nil {
		return nil, err
	}
	var m manifestRegions
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	ids := map[string]bool{}
	for _, r := range m.Regions {
		if r.ID == nil {
			return nil, fmt.Errorf("%s: a region has no id", path)
		}
		ids[*r.ID] = true
	}
	return ids, nil
}

// unpublished prints the region ids in the published manifest that the local one drops,
// sorted and space-separated — empty when it drops none.
func unpublished(published, local string, out io.Writer) error {
	pids, err := regionIDs(published)
	if err != nil {
		return err
	}
	lids, err := regionIDs(local)
	if err != nil {
		return err
	}
	var gone []string
	for id := range pids {
		if !lids[id] {
			gone = append(gone, id)
		}
	}
	sort.Strings(gone)
	fmt.Fprintln(out, strings.Join(gone, " "))
	return nil
}

// served checks the live manifest is served with Content-Encoding: gzip and decodes to
// exactly the manifest just uploaded.
func served(headersPath, bodyPath, localPath string, out io.Writer) error {
	f, err := os.Open(headersPath)
	if err != nil {
		return err
	}
	var encodings []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(strings.ToLower(line), "content-encoding:") {
			_, v, _ := strings.Cut(line, ":")
			encodings = append(encodings, strings.ToLower(strings.TrimSpace(v)))
		}
	}
	f.Close()
	if len(encodings) == 0 || encodings[len(encodings)-1] != "gzip" {
		got := "none"
		if len(encodings) > 0 {
			q := make([]string, len(encodings))
			for i, e := range encodings {
				q[i] = "'" + e + "'"
			}
			got = "[" + strings.Join(q, ", ") + "]"
		}
		return failure(fmt.Sprintf("served without Content-Encoding: gzip (got %s)", got))
	}
	body, err := os.ReadFile(bodyPath)
	if err != nil {
		return err
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("served body is not gzip: %w", err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		return fmt.Errorf("served body is not gzip: %w", err)
	}
	var servedDoc, localDoc any
	if err := json.Unmarshal(plain, &servedDoc); err != nil {
		return fmt.Errorf("served body: %w", err)
	}
	localData, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(localData, &localDoc); err != nil {
		return fmt.Errorf("%s: %w", localPath, err)
	}
	// The same values, whatever the key order or spacing: numbers decode to float64, so
	// 1 and 1.0 match, and nothing else of a different type does.
	if !reflect.DeepEqual(servedDoc, localDoc) {
		return failure("served manifest does not match the one just uploaded")
	}
	var m manifestRegions
	json.Unmarshal(plain, &m)
	fmt.Fprintf(out, "Verified: served gzipped, %d regions\n", len(m.Regions))
	return nil
}
