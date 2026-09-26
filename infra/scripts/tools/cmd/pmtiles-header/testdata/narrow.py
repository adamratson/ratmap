import json, sys
h = json.load(sys.stdin)
lo, hi = int(sys.argv[1]), int(sys.argv[2])
h["minzoom"], h["maxzoom"] = lo, hi
h["center"][2] = min(max(h["center"][2], lo), hi)
json.dump(h, open(sys.argv[3], "w"))