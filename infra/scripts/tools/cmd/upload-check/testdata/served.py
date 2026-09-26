import gzip, json, sys
headers, body, local = sys.argv[1:4]
with open(headers) as f:
    encodings = [line.split(":", 1)[1].strip().lower() for line in f if line.lower().startswith("content-encoding:")]
if encodings[-1:] != ["gzip"]:
    sys.exit(f"served without Content-Encoding: gzip (got {encodings or 'none'})")
with open(body, "rb") as f:
    served = json.loads(gzip.decompress(f.read()))
with open(local) as f:
    expected = json.load(f)
if served != expected:
    sys.exit("served manifest does not match the one just uploaded")
print(f"Verified: served gzipped, {len(served['regions'])} regions")