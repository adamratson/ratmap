import math, sys
west, south, east, north = (float(v) for v in sys.argv[1:5])
base = "https://copernicus-dem-30m.s3.amazonaws.com"
for lat in range(math.floor(south), math.ceil(north)):
    for lon in range(math.floor(west), math.ceil(east)):
        ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
        ew = f"{'W' if lon < 0 else 'E'}{abs(lon):03d}"
        name = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
        print(f"{base}/{name}/{name}.tif")