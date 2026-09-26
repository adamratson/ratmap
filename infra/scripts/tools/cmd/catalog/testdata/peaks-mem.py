
import json, math, sys
res, workers, per_fetch, per_px = (float(sys.argv[2]), int(sys.argv[3]),
                                   float(sys.argv[4]), float(sys.argv[5]))
def area(r): w, s, e, n = r["bbox"]; return (e - w) * (n - s)
with open(sys.argv[1]) as f:
    order = sorted(json.load(f)["regions"], key=area)
px = [area(r) / (res * res) for r in order]
n = len(order)
need = max(px[k] * per_px / 2**30 + per_fetch * min(workers, n - 1 - k) for k in range(n))
print(math.ceil(need), order[-1]["id"], round(px[-1] / 1e6))