"""
Step 4 - Regional fire atlas (province + regency / kabupaten level) and real terrain.

  * Joins every NASA FIRMS MODIS vegetation-fire detection 2000-2025 (and the last-7-day NRT feed)
    to geoBoundaries ADM2 (519 kabupaten/kota) and ADM1 (34 provinces), Indonesia.
  * Per regency: yearly & monthly detections, FRP, Mann-Kendall/Sen trend 2003-2025 with
    Benjamini-Hochberg FDR across regencies, pre/post-2016 means, peak years.
  * Fire points aggregated to a 0.05 deg grid per year (count + FRP) for the 3D map.
  * Real elevation: AWS Terrain Tiles (Terrarium encoding; SRTM/GMTED-derived) -> 0.05 deg int16 grid.
  * NASA POWER Jul-Oct rainfall & root-zone soil wetness at the centroid of the 80 most fire-prone
    regencies, plus a per-regency soil-wetness -> fire correlation.

Run: python analysis/04_regions.py      (after 01-03)
"""
from __future__ import annotations

import glob
import io
import json
import math
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import shapely
from PIL import Image
from shapely.geometry import mapping, shape

warnings.filterwarnings("ignore")


ROOT = Path(__file__).resolve().parents[1]
RAW, PROC = ROOT / "data" / "raw", ROOT / "data" / "processed"
WEB = ROOT / "data" / "processed"  # atlas tables (regions.json feeds step 5)
(WEB / "atlas").mkdir(parents=True, exist_ok=True)

# reuse the statistics helpers of step 3 without re-running the whole analysis
src = (ROOT / "analysis" / "03_analysis.py").read_text(encoding="utf8")
helpers = src.split("# ----------------------------------------------------------------------------- load")[0]
ns: dict = {"__file__": str(ROOT / "analysis" / "03_analysis.py")}
exec(compile(helpers, "helpers", "exec"), ns)  # noqa: S102  (our own file)
mann_kendall, bh_fdr = ns["mann_kendall"], ns["bh_fdr"]

LON0, LON1, LAT0, LAT1 = 94.5, 141.5, -11.5, 6.5  # all of Indonesia
PT = 0.05  # display grid for fire points
FIT = list(range(2003, 2026))


# ----------------------------------------------------------------------------- boundaries
def load(level):
    g = json.loads((RAW / "admin" / f"IDN_{level}.geojson").read_text(encoding="utf8"))
    names = [f["properties"]["shapeName"] for f in g["features"]]
    geoms = [shape(f["geometry"]).buffer(0) for f in g["features"]]
    return names, geoms


n1, g1 = load("ADM1")
n2, g2 = load("ADM2")
prov_of = []
for g in g2:
    p = g.representative_point()
    hit = [k for k, pg in enumerate(g1) if pg.contains(p)]
    if not hit:
        d = [pg.distance(p) for pg in g1]
        hit = [int(np.argmin(d))]
    prov_of.append(hit[0])
for g in g1 + g2:
    shapely.prepare(g)


def assign(lon: np.ndarray, lat: np.ndarray, geoms) -> np.ndarray:
    """Vectorised point-in-polygon: bbox prefilter + shapely.contains_xy per polygon."""
    out = np.full(len(lon), -1, dtype=np.int32)
    for k, g in enumerate(geoms):
        x0, y0, x1, y1 = g.bounds
        m = np.where((out < 0) & (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1))[0]
        if len(m):
            inside = shapely.contains_xy(g, lon[m], lat[m])
            out[m[inside]] = k
    return out


# ----------------------------------------------------------------------------- join all years
rows, pts = [], []
for f in sorted(glob.glob(str(RAW / "firms" / "modis_*_Indonesia.csv"))):
    d = pd.read_csv(f, usecols=["latitude", "longitude", "acq_date", "confidence", "type", "frp"])
    d = d[(d["type"] == 0) & (d["confidence"] >= 30)]
    lon, lat = d.longitude.values, d.latitude.values
    k2 = assign(lon, lat, g2)
    t = pd.to_datetime(d.acq_date)
    df = pd.DataFrame({"year": t.dt.year.values, "month": t.dt.month.values, "kab": k2, "frp": d.frp.values,
                       "lon": lon, "lat": lat})
    rows.append(df.groupby(["kab", "year", "month"]).agg(n=("frp", "size"), frp=("frp", "sum")).reset_index())
    df["gi"] = np.floor((df.lon - LON0) / PT).astype(int)
    df["gj"] = np.floor((df.lat - LAT0) / PT).astype(int)
    pts.append(df.groupby(["year", "gi", "gj"]).agg(n=("frp", "size"), frp=("frp", "sum"), kab=("kab", lambda s: s.mode().iat[0])).reset_index())
    print(f"  {Path(f).name}: {len(d):>7} pts, unassigned (offshore) {int((k2 < 0).sum())}")

J = pd.concat(rows)
J.to_csv(PROC / "fires_regency_monthly.csv", index=False)
P = pd.concat(pts)

# ----------------------------------------------------------------------------- per-regency stats
years = list(range(2001, 2026))
Y = J[J.kab >= 0].groupby(["kab", "year"]).n.sum().unstack(fill_value=0).reindex(columns=years, fill_value=0)
Y = Y.reindex(range(len(g2)), fill_value=0)
M = J[(J.kab >= 0) & J.year.isin(FIT)].groupby(["kab", "month"]).n.sum().unstack(fill_value=0).reindex(columns=range(1, 13), fill_value=0)
M = M.reindex(range(len(g2)), fill_value=0)
FRP = J[J.kab >= 0].groupby(["kab", "year"]).frp.sum().unstack(fill_value=0).reindex(columns=years, fill_value=0).reindex(range(len(g2)), fill_value=0)

stats = []
for k in range(len(g2)):
    s = Y.loc[k, FIT].values.astype(float)
    tot = int(Y.loc[k].sum())
    if tot >= 30:
        r = mann_kendall(s, hamed_rao=True)
        sen, p = r["sen"], r["p"]
    else:
        sen, p = 0.0, 1.0
    stats.append({"sen": sen, "p": p, "tot": tot})
pvals = np.array([s["p"] for s in stats])
tested = np.array([s["tot"] >= 30 for s in stats])
sig = np.zeros(len(stats), bool)
sig[tested] = bh_fdr(pvals[tested])

nat = Y.sum(axis=0)
regions = []
for k, g in enumerate(g2):
    c = g.representative_point()
    yr = Y.loc[k].values.astype(int)
    s = Y.loc[k, FIT].values.astype(float)
    pre, post = float(Y.loc[k, 2003:2015].mean()), float(Y.loc[k, 2016:2025].mean())
    mean = s.mean() if s.mean() > 0 else np.nan
    regions.append({
        "id": k, "name": n2[k], "prov": n1[prov_of[k]],
        "c": [round(c.x, 3), round(c.y, 3)],
        "area_km2": round(g.area * 111.32**2 * math.cos(math.radians(c.y))),
        "y": yr.tolist(), "frp": [round(v) for v in FRP.loc[k].values],
        "m": M.loc[k].values.astype(int).tolist(),
        "tot": int(yr.sum()),
        "sen": round(stats[k]["sen"], 3), "p": round(stats[k]["p"], 4), "sig": bool(sig[k]),
        "pct_dec": None if not np.isfinite(mean) else round(100 * 10 * stats[k]["sen"] / mean, 1),
        "pre": round(pre, 1), "post": round(post, 1),
        "share2015": round(float(Y.loc[k, 2015] / nat[2015]), 4) if nat[2015] else 0,
    })
order = sorted(range(len(regions)), key=lambda k: -regions[k]["tot"])
for rank, k in enumerate(order, 1):
    regions[k]["rank"] = rank
print(f"\nregencies with fire: {sum(r['tot'] > 0 for r in regions)}; FDR-significant trends: "
      f"falling {sum(r['sig'] and r['sen'] < 0 for r in regions)}, rising {sum(r['sig'] and r['sen'] > 0 for r in regions)}")
print("rising & significant:", [(r["name"], r["prov"], r["sen"]) for r in regions if r["sig"] and r["sen"] > 0])

# ----------------------------------------------------------------------------- climate clues (NASA POWER) for top regencies
TOPN = 80
clim_dir = RAW / "power_regency"
clim_dir.mkdir(exist_ok=True)
season = [7, 8, 9, 10]
for k in order[:TOPN]:
    r = regions[k]
    dest = clim_dir / f"{k}.json"
    if not dest.exists():
        url = ("https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=PRECTOTCORR,GWETROOT"
               f"&community=AG&longitude={r['c'][0]}&latitude={r['c'][1]}&start=2001&end=2025&format=JSON")
        for attempt in range(4):
            try:
                resp = requests.get(url, timeout=120)
                resp.raise_for_status()
                dest.write_text(resp.text)
                break
            except Exception as e:  # noqa: BLE001
                print("   retry", r["name"], e)
                time.sleep(5 * (attempt + 1))
    par = json.loads(dest.read_text())["properties"]["parameter"]
    rain = [np.mean([par["PRECTOTCORR"][f"{y}{m:02d}"] for m in season]) for y in years]
    soil = [np.mean([par["GWETROOT"][f"{y}{m:02d}"] for m in season]) for y in years]
    r["rain"] = [round(v, 2) for v in rain]
    r["soil"] = [round(v, 3) for v in soil]
    ss = np.array(soil[2:]); ff = np.log1p(np.array(r["y"][2:]))  # 2003-2025
    r["r_soil_fire"] = round(float(np.corrcoef(ss, ff)[0, 1]), 2)
print(f"climate clues attached to {TOPN} regencies")

# ----------------------------------------------------------------------------- simplified boundaries
feats = []
for k, g in enumerate(g2):
    s = g.simplify(0.015, preserve_topology=True)
    polys = getattr(s, "geoms", [s])
    rings = []
    for p in polys:
        if p.geom_type != "Polygon" or p.area < 0.0004:
            continue
        rings.append([[round(x, 3), round(y, 3)] for x, y in p.exterior.coords])
    feats.append(rings)
provs = []
for k, g in enumerate(g1):
    s = g.simplify(0.02, preserve_topology=True)
    rings = [[[round(x, 3), round(y, 3)] for x, y in p.exterior.coords] for p in getattr(s, "geoms", [s])
             if p.geom_type == "Polygon" and p.area > 0.002]
    provs.append({"name": n1[k], "rings": rings})

# ----------------------------------------------------------------------------- fire points per year
for y in range(2000, 2026):
    py = P[P.year == y]
    arr = [[round(LON0 + (i + 0.5) * PT, 3), round(LAT0 + (j + 0.5) * PT, 3), int(n), round(float(f), 1), int(kb)]
           for i, j, n, f, kb in py[["gi", "gj", "n", "frp", "kab"]].values]
    (WEB / "atlas" / f"pts_{y}.json").write_text(json.dumps(arr, separators=(",", ":")))
live = pd.read_csv(RAW / "current" / "firms_modis_SEA_7d.csv")
live = live[(live.confidence >= 30) & live.longitude.between(LON0, LON1) & live.latitude.between(LAT0, LAT1)]
lk = assign(live.longitude.values, live.latitude.values, g2)
live = live[lk >= 0].assign(kab=lk[lk >= 0])
(WEB / "atlas" / "pts_live.json").write_text(json.dumps(
    [[round(a, 3), round(b, 3), 1, round(c, 1), int(k)] for a, b, c, k in live[["longitude", "latitude", "frp", "kab"]].values],
    separators=(",", ":")))
print(f"live NRT points inside Indonesia: {len(live)} ({live.acq_date.min()} .. {live.acq_date.max()})")

# ----------------------------------------------------------------------------- terrain (AWS Terrain Tiles, terrarium)
Z = 6
def tile_xy(lon, lat):
    n = 2**Z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y
x0, y0 = tile_xy(LON0, LAT1); x1, y1 = tile_xy(LON1, LAT0)
tx, ty = range(int(x0), int(x1) + 1), range(int(y0), int(y1) + 1)
tiles_dir = RAW / "terrain"; tiles_dir.mkdir(exist_ok=True)
mosaic = np.zeros((len(ty) * 256, len(tx) * 256), np.float32)
for a, X in enumerate(tx):
    for b, Yt in enumerate(ty):
        f = tiles_dir / f"{Z}_{X}_{Yt}.png"
        if not f.exists():
            f.write_bytes(requests.get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{X}/{Yt}.png", timeout=60).content)
        im = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB")).astype(np.float32)
        mosaic[b * 256:(b + 1) * 256, a * 256:(a + 1) * 256] = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
DEM = 0.05
lons = np.arange(LON0 + DEM / 2, LON1, DEM)
lats = np.arange(LAT1 - DEM / 2, LAT0, -DEM)
LL, AA = np.meshgrid(lons, lats)
px = ((LL + 180) / 360 * 2**Z - tx.start) * 256
py_ = ((1 - np.arcsinh(np.tan(np.radians(AA))) / np.pi) / 2 * 2**Z - ty.start) * 256
elev = mosaic[np.clip(py_.astype(int), 0, mosaic.shape[0] - 1), np.clip(px.astype(int), 0, mosaic.shape[1] - 1)]
elev = np.clip(np.round(elev), -8000, 5000).astype(np.int16)
(WEB / "atlas" / "dem.bin").write_bytes(elev.tobytes())
print(f"DEM grid {elev.shape} max {elev.max()} m (tiles z{Z}: {len(tx)}x{len(ty)})")

meta = {
    "bbox": [LON0, LON1, LAT0, LAT1], "dem": {"cell": DEM, "w": int(elev.shape[1]), "h": int(elev.shape[0])},
    "pt_cell": PT, "years": years, "fit": [FIT[0], FIT[-1]],
    "national": nat.astype(int).tolist(),
    "provinces": provs,
    "live": {"from": str(live.acq_date.min()), "to": str(live.acq_date.max())},
}
(WEB / "atlas" / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
(WEB / "atlas" / "regions.json").write_text(json.dumps(regions, separators=(",", ":")))
(WEB / "atlas" / "bounds.json").write_text(json.dumps(feats, separators=(",", ":")))
for f in sorted((WEB / "atlas").glob("*")):
    if f.stat().st_size > 400_000:
        print(f"  {f.name}: {f.stat().st_size/1e6:.2f} MB")
