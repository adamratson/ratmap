import struct, sys
with open(sys.argv[1], "rb") as f:
    header = f.read(127)
print(struct.unpack_from("<Q", header, 72)[0] if header[:7] == b"PMTiles" else "invalid")