import gzip, struct, sys

def varints(buf):
    pos = 0
    while pos < len(buf):
        value = shift = 0
        while True:
            byte = buf[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        yield value

def entries(raw):
    it = varints(raw)
    n = next(it)
    ids, tile_id = [], 0
    for _ in range(n):
        tile_id += next(it)
        ids.append(tile_id)
    runs = [next(it) for _ in range(n)]
    lengths = [next(it) for _ in range(n)]
    offsets = []
    for i in range(n):
        v = next(it)
        offsets.append(offsets[i - 1] + lengths[i - 1] if v == 0 and i > 0 else v - 1)
    return zip(ids, runs, offsets, lengths)

def zoom_of(tile_id):
    z, first = 0, 0
    while tile_id >= first + 4 ** z:
        first += 4 ** z
        z += 1
    return z

with open(sys.argv[1], "rb") as f:
    header = f.read(127)
    if header[:7] != b"PMTiles" or header[7] != 3:
        sys.exit("not a PMTiles v3 archive")
    root_off, root_len, _, _, leaf_off = struct.unpack_from("<5Q", header, 8)
    compression, header_min, header_max = header[97], header[100], header[101]
    if compression not in (1, 2):  # none or gzip — all this pipeline's sources use
        sys.exit(f"unsupported internal compression {compression}")

    def read_dir(offset, length):
        f.seek(offset)
        raw = f.read(length)
        return entries(gzip.decompress(raw) if compression == 2 else raw)

    lo = hi = None
    pending = [(root_off, root_len)]
    while pending:
        for tile_id, run, offset, length in read_dir(*pending.pop()):
            if run == 0:  # a leaf directory, not a tile
                pending.append((leaf_off + offset, length))
                continue
            first, last = zoom_of(tile_id), zoom_of(tile_id + run - 1)
            lo = first if lo is None else min(lo, first)
            hi = last if hi is None else max(hi, last)

if lo is None:
    sys.exit("no tiles")
print(lo, hi, header_min, header_max)