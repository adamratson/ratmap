import json, os, sys
listing, dist, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
text = open(listing).read().strip()
# An empty bucket lists as no output at all, not as an empty Contents array.
try:
    remote = {o["Key"]: o["Size"] for o in (json.loads(text).get("Contents") or [])} if text else {}
except (ValueError, AttributeError, KeyError, TypeError) as err:
    # One line, not a traceback: the caller prints it as the reason and falls back.
    sys.exit(f"listing was not readable JSON: {err}")
for key in keys:
    if remote.get(key) != os.path.getsize(os.path.join(dist, key)):
        print(key)