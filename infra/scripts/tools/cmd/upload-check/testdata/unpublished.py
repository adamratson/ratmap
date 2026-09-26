import gzip, json, sys
def ids(path):
    # The published copy is stored gzipped (see below); `aws s3 cp` returns it as stored.
    with open(path, "rb") as f:
        data = f.read()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return {r["id"] for r in json.loads(data).get("regions", [])}
print(" ".join(sorted(ids(sys.argv[1]) - ids(sys.argv[2]))))