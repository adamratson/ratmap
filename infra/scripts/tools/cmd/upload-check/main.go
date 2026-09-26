// Command upload-check holds upload.sh's three checks.
//
//	upload-check changed LISTING DIST_DIR KEY...      # which archives differ from the bucket
//	upload-check unpublished PUBLISHED LOCAL          # regions a new manifest would drop
//	upload-check served HEADERS BODY LOCAL            # the live manifest is served right
//
// Ports of the Python snippets upload.sh carried inline: same output, same exit status
// where they refused. See upload.sh beside each call for why each check exists.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"ratmap/infra/tools/internal/pyjson"
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
	remote := map[string]pyjson.Value{}
	// An empty bucket lists as no output at all, not as an empty Contents array.
	if text := bytes.TrimSpace(data); len(text) > 0 {
		doc, err := pyjson.Decode(text)
		if err != nil {
			return failure("listing was not readable JSON: " + err.Error())
		}
		top, ok := doc.(*pyjson.Object)
		if !ok {
			return failure("listing was not readable JSON: not an object")
		}
		if c, ok := top.Get("Contents"); ok && c != nil {
			list, ok := c.([]pyjson.Value)
			if !ok {
				return failure("listing was not readable JSON: Contents is not a list")
			}
			for _, o := range list {
				obj, ok := o.(*pyjson.Object)
				k, hasK := obj.Get("Key")
				s, hasS := obj.Get("Size")
				ks, isStr := k.(string)
				if !ok || !hasK || !hasS || !isStr {
					return failure("listing was not readable JSON: an entry has no Key and Size")
				}
				remote[ks] = s
			}
		}
	}
	for _, key := range keys {
		st, err := os.Stat(filepath.Join(dist, key))
		if err != nil {
			return err
		}
		size, ok := pyjson.Number(remote[key])
		if _, present := remote[key]; !present || !ok || size != float64(st.Size()) {
			fmt.Fprintln(out, key)
		}
	}
	return nil
}

func readManifest(path string) (*pyjson.Object, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// The published copy is stored gzipped; `aws s3 cp` returns it as stored.
	if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		if data, err = io.ReadAll(zr); err != nil {
			return nil, err
		}
	}
	v, err := pyjson.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	o, ok := v.(*pyjson.Object)
	if !ok {
		return nil, fmt.Errorf("%s: not an object", path)
	}
	return o, nil
}

func regionIDs(m *pyjson.Object) (map[string]bool, error) {
	ids := map[string]bool{}
	rv, _ := m.Get("regions")
	list, _ := rv.([]pyjson.Value)
	for _, r := range list {
		ro, ok := r.(*pyjson.Object)
		if !ok {
			return nil, errors.New("a region is not an object")
		}
		id, _ := ro.Get("id")
		s, ok := id.(string)
		if !ok {
			return nil, errors.New("a region has no string id")
		}
		ids[s] = true
	}
	return ids, nil
}

// unpublished prints the region ids in the published manifest that the local one drops,
// sorted and space-separated — empty when it drops none.
func unpublished(published, local string, out io.Writer) error {
	p, err := readManifest(published)
	if err != nil {
		return err
	}
	l, err := readManifest(local)
	if err != nil {
		return err
	}
	pids, err := regionIDs(p)
	if err != nil {
		return err
	}
	lids, err := regionIDs(l)
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
	servedDoc, err := pyjson.Decode(plain)
	if err != nil {
		return fmt.Errorf("served body: %w", err)
	}
	localData, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	localDoc, err := pyjson.Decode(localData)
	if err != nil {
		return fmt.Errorf("%s: %w", localPath, err)
	}
	if !equal(servedDoc, localDoc) {
		return failure("served manifest does not match the one just uploaded")
	}
	so, _ := servedDoc.(*pyjson.Object)
	var regions []pyjson.Value
	if so != nil {
		rv, _ := so.Get("regions")
		regions, _ = rv.([]pyjson.Value)
	}
	fmt.Fprintf(out, "Verified: served gzipped, %d regions\n", len(regions))
	return nil
}

// equal is Python's == on decoded JSON: objects by key regardless of order, lists in
// order, and numbers by value — 1 == 1.0 == True.
func equal(a, b pyjson.Value) bool {
	if an, ok := pyjson.Number(a); ok {
		bn, ok := pyjson.Number(b)
		if !ok {
			return false
		}
		ai, aInt := pyjson.IntValue(a)
		bi, bInt := pyjson.IntValue(b)
		if aInt && bInt {
			return ai == bi
		}
		return an == bn
	}
	switch at := a.(type) {
	case nil:
		return b == nil
	case string:
		bs, ok := b.(string)
		return ok && at == bs
	case []pyjson.Value:
		bl, ok := b.([]pyjson.Value)
		if !ok || len(at) != len(bl) {
			return false
		}
		for i := range at {
			if !equal(at[i], bl[i]) {
				return false
			}
		}
		return true
	case *pyjson.Object:
		bo, ok := b.(*pyjson.Object)
		if !ok || len(at.Keys) != len(bo.Keys) {
			return false
		}
		for i, k := range at.Keys {
			bv, ok := bo.Get(k)
			if !ok || !equal(at.Vals[i], bv) {
				return false
			}
		}
		return true
	}
	return false
}
