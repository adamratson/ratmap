import json, math, shlex, sys

with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
if not match.get("avalanche"):
    sys.exit(
        f"Region '{match['id']}' does not set \"avalanche\": true in regions.json. "
        "This artifact is opt-in per region (A8) — add the flag if it is wanted here."
    )

west, south, east, north = match["bbox"]
if not (west < east and south < north):
    sys.exit(f"Region '{match['id']}' has an invalid bbox {match['bbox']}.")

DEM_METRES = 30.0
EQUATOR = 40075016.685578488
lat = math.radians((south + north) / 2)

# Round *up*, not down. Under-resolving a slope raster smooths gradients and reports
# terrain as gentler than it is — the same direction of error as A1, and the one that
# matters. Mild oversampling of a 30 m DEM costs bytes and loses nothing; the app draws
# the layer with nearest resampling above this anyway, so the cell grid stays visible and
# nobody mistakes it for finer data than it is.
zmax = math.ceil(math.log2(EQUATOR * math.cos(lat) / (512 * DEM_METRES)))
zmax = max(9, min(12, zmax))

# Never build below the zoom the app will actually draw at. region-layers.ts suppresses a
# region's own layers below ceil(log2(360/span)) — a `pmtiles extract` keeps whole upstream
# tiles, so low-zoom tiles span far more than the region and would paint a hard-edged
# rectangle across the map. Building levels nobody renders is pure waste: for Liechtenstein
# that floor is z11, so z8-z10 would have been three levels of nothing.
span = max(east - west, north - south)
zmin = max(int(sys.argv[3]), math.ceil(math.log2(360 / span)))
zmin = min(zmin, zmax)

# Snap the extent to the tile grid at the *finest* level. Snapping at the coarsest instead
# is what the first version did, and a z8 tile is 156 km across — Liechtenstein's 18x25 km
# box inflated to a 313x313 km raster, 268 megapixels of mostly nothing, and a class
# histogram diluted to 1% steep ground. Aligning at zmax keeps the raster tight; the
# origin is then a multiple of 512 px there and stays pixel-aligned through every halving.
HALF = EQUATOR / 2
def to_merc(lon, latitude):
    x = lon * HALF / 180.0
    y = math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)) * HALF / math.pi
    return x, y

x0, y0 = to_merc(west, south)
x1, y1 = to_merc(east, north)
tile = 2 * HALF / (2 ** zmax)
ax0 = math.floor((x0 + HALF) / tile) * tile - HALF
ay0 = math.floor((y0 + HALF) / tile) * tile - HALF
ax1 = math.ceil((x1 + HALF) / tile) * tile - HALF
ay1 = math.ceil((y1 + HALF) / tile) * tile - HALF

print(f"REGION_NAME={shlex.quote(match['name'])}")
print(f"BBOX={shlex.quote(','.join(str(c) for c in match['bbox']))}")
print(f"WEST={west}"); print(f"SOUTH={south}"); print(f"EAST={east}"); print(f"NORTH={north}")
print(f"ZMAX={zmax}"); print(f"ZMIN={zmin}")
# Quoted so `eval` assigns all four numbers to TE; the caller then leaves `$TE` unquoted
# so it word-splits back into gdalwarp's four -te arguments.
print(f"TE={shlex.quote(f'{ax0} {ay0} {ax1} {ay1}')}")
print(f"RES={2 * HALF / (2 ** zmax) / 512}")