#!/usr/bin/env python3
"""Writes the small PMTiles v3 archives the goldens run on (run from testdata/): one
with leaf directories under an uncompressed root, one the same with gzip, and one
whose tiles are all in the root directory. Tile data is a few bytes a tile; nothing here
reads it."""
import gzip, struct

def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F; v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v: return bytes(out)

def directory(entries):  # entries: (tile_id, run, offset, length)
    b = varint(len(entries))
    last = 0
    for e in entries: b += varint(e[0] - last); last = e[0]
    for e in entries: b += varint(e[1])
    for e in entries: b += varint(e[3])
    for i, e in enumerate(entries):
        prev = entries[i - 1] if i else None
        b += varint(0 if prev and e[2] == prev[2] + prev[3] else e[2] + 1)
    return b

def first_id(z): return sum(4 ** i for i in range(z))

def write(path, groups, compression, minzoom, maxzoom):
    """groups: a list of directories' entry lists (tile_id, run); more than one means leaves."""
    comp = (lambda b: b) if compression == 1 else (lambda b: gzip.compress(b, mtime=0))
    data = bytearray(); dirs = []
    for g in groups:
        es = []
        for tile_id, run in g:
            es.append((tile_id, run, len(data), 4)); data += b"tile"
        dirs.append(es)
    if len(dirs) == 1:
        root, leaves = comp(directory(dirs[0])), b""
    else:
        leaves = bytearray(); root_es = []
        for es in dirs:
            blob = comp(directory(es))
            root_es.append((es[0][0], 0, len(leaves), len(blob))); leaves += blob
        root = comp(directory(root_es))
    meta = comp(b"{}")
    root_off = 127; meta_off = root_off + len(root)
    leaf_off = meta_off + len(meta); data_off = leaf_off + len(leaves)
    tiles = sum(r for g in groups for _, r in g)
    h = b"PMTiles" + bytes([3]) + struct.pack(
        "<QQQQQQQQQQQ", root_off, len(root), meta_off, len(meta), leaf_off, len(leaves),
        data_off, len(data), tiles, sum(len(g) for g in groups), sum(len(g) for g in groups))
    h += bytes([0, compression, 1, 1, minzoom, maxzoom])  # clustered, internal, tile comp, type
    h += struct.pack("<iiiiB", -10_000_000, -10_000_000, 10_000_000, 10_000_000, minzoom)
    h += struct.pack("<ii", 0, 0)
    assert len(h) == 127, len(h)
    with open(path, "wb") as f:
        f.write(h + root + meta + leaves + data)

leafy = [[(first_id(3) + 5, 3), (first_id(4), 1)],
         [(first_id(5) + 100, 1), (first_id(6) + 7, 2)],
         [(first_id(7) - 2, 3)]]  # a run that crosses from z6 into z7
write("leafy.pmtiles", leafy, 1, 2, 9)
write("leafy-gzip.pmtiles", leafy, 2, 3, 7)
# The second run ends on the last tile of z1: nothing here is at z2.
write("root-only.pmtiles", [[(0, 1), (1, 4)]], 2, 0, 14)
with open("empty.pmtiles", "wb"): pass
with open("short.pmtiles", "wb") as f: f.write(b"PMTiles\x03")
with open("not-pmtiles.pmtiles", "wb") as f: f.write(b"<html>not found</html>" * 10)
