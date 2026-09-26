#!/usr/bin/env python3
"""Writes subset-keys.tsv (run from testdata/): subset-key.py's key for a file of SIZE
bytes whose mtime is MTIME_NS nanoseconds, with filter union UNION (JSON-quoted). The
times include ones just short of a whole second, which st_mtime's double rounds up."""
import json, os, subprocess, sys, tempfile
cases = [(0, 1_758_900_000_000_000_000, "n/natural=peak w/sac_scale"),
         (1234, 1_758_900_000_999_999_999, "  n/natural=peak   w/sac_scale "),
         (7, 1_758_900_000_999_999_900, "a\tb\nc\x1fd"),
         (7, 1_758_900_000_999_999_800, ""),
         (99, 1_000_000_000_500_000_000, "nwr/natural=scree,shingle,rock,stone"),
         (1, 1_999_999_999_999_999_999, "x　y z")]
with tempfile.TemporaryDirectory() as d, open("subset-keys.tsv", "w") as out:
    for size, ns, union in cases:
        path = os.path.join(d, "src.osm.pbf")
        with open(path, "wb") as f: f.write(b"\0" * size)
        os.utime(path, ns=(ns, ns))
        key = subprocess.run([sys.executable, "subset-key.py", path, union],
                             check=True, capture_output=True, text=True).stdout.strip()
        out.write(f"{size}\t{ns}\t{json.dumps(union)}\t{key}\n")
