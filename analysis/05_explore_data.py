"""
Step 5 - Real-data build of the "Jejak Api - Explore the Islands" 3D map (web/explore/).

Replaces every placeholder of the prototype with measured data, on its 0.5 deg cell grid
(Sumatra + Kalimantan), monthly 2003-01 .. 2026-10:

  fire   NASA FIRMS MODIS C6.1 vegetation-fire detections per cell & month (2003-2025; 2026 not yet archived)
  rain   A  NASA POWER PRECTOTCORR (MERRA-2 bias-corrected precipitation), mm/day
  soil   B  NASA POWER GWETROOT root-zone soil wetness (MERRA-2), 0-1   [replaces placeholder peat water table]
  loss   C  Hansen/UMD tree-cover loss (>30% canopy) via Global Forest Watch regency statistics, cumulative % since 2001
  aod    E  NASA POWER AOD_55 (MERRA-2 aerosol optical depth)        [replaces the synthetic smoke-plume model]
  oni/dmi D NOAA CPC ONI and NOAA PSL DMI
  peat      PEATMAP (Xu et al. 2018, Univ. Leeds) peat fraction per cell
  terrain   AWS Terrain Tiles (SRTM/GMTED-derived) elevation
  model     logistic regressions fitted on 2003-2025 cell data (July "clue check" and monthly risk),
            evaluated with leave-one-year-out cross-validation

Run: python analysis/05_explore_data.py   (after 01-04)
"""
from __future__ import annotations

import base64
import difflib
import glob
import io
import json
import math
import re
import time
import warnings
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
import requests
import shapefile
import shapely
from PIL import Image, ImageDraw
from shapely.geometry import box, shape
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
RAW, PROC = ROOT / "data" / "raw", ROOT / "data" / "processed"
OUT = ROOT / "web" / "explore"
OUT.mkdir(parents=True, exist_ok=True)

MONTHS = [f"{y}-{m:02d}" for y in range(2003, 2027) for m in range(1, 13)]
MONTHS = MONTHS[: MONTHS.index("2026-10") + 1]
T = len(MONTHS)
FIRE_LAST = MONTHS.index("2025-12")  # FIRMS archive ends here
SUMATRA = ["Aceh", "North Sumatra", "West Sumatra", "Riau", "Riau Islands", "Jambi", "South Sumatra", "Bengkulu", "Lampung", "Bangka-Belitung Islands"]
KALIMANTAN = ["West Kalimantan", "Central Kalimantan", "South Kalimantan", "East Kalimantan", "North Kalimantan"]


def gj(level):
    g = json.loads((RAW / "admin" / f"IDN_{level}.geojson").read_text(encoding="utf8"))
    return [f["properties"]["shapeName"] for f in g["features"]], [shape(f["geometry"]).buffer(0) for f in g["features"]]


# ----------------------------------------------------------------------------- cells
n1, g1 = gj("ADM1")
n2, g2 = gj("ADM2")
study = {n: g for n, g in zip(n1, g1) if n in SUMATRA + KALIMANTAN}
tree1 = shapely.STRtree(list(study.values()))
names1 = list(study.keys())
tree2 = shapely.STRtree(g2)
cells = []
for i in range(0, 49):
    for j in range(0, 26):
        lon, lat = 95.25 + 0.5 * i, -5.75 + 0.5 * j
        b = box(lon - 0.25, lat - 0.25, lon + 0.25, lat + 0.25)
        best, ba = None, 0
        for k in tree1.query(b):
            a = study[names1[k]].intersection(b).area
            if a > ba:
                best, ba = names1[k], a
        if ba < 0.1 * b.area:
            continue
        kb, ka = -1, 0
        for k in tree2.query(b):
            a = g2[k].intersection(b).area
            if a > ka:
                kb, ka = int(k), a
        cells.append({"lon": lon, "lat": lat, "i": i, "j": j, "region": best,
                      "island": "Sumatra" if best in SUMATRA else "Kalimantan", "kab": kb})
print(f"cells: {len(cells)}")
C = len(cells)
cidx = {(c["i"], c["j"]): n for n, c in enumerate(cells)}

# ----------------------------------------------------------------------------- fire
fire = np.full((C, T), -1, dtype=np.int32)
fire[:, : FIRE_LAST + 1] = 0
for f in sorted(glob.glob(str(RAW / "firms" / "modis_*_Indonesia.csv"))):
    y = int(re.search(r"modis_(\d{4})", f).group(1))
    if y < 2003:
        continue
    d = pd.read_csv(f, usecols=["latitude", "longitude", "acq_date", "confidence", "type"])
    d = d[(d["type"] == 0) & (d["confidence"] >= 30)]
    ii = np.floor((d.longitude.values - 95.0) / 0.5).astype(int)
    jj = np.floor((d.latitude.values + 6.0) / 0.5).astype(int)
    tt = np.array([MONTHS.index(s[:7]) for s in d.acq_date.values])
    for a, b, t in zip(ii, jj, tt):
        n = cidx.get((a, b))
        if n is not None:
            fire[n, t] += 1
print("fire detections in cells 2003-2025:", int(fire[fire > 0].sum()))

# ----------------------------------------------------------------------------- NASA POWER regional (0.5 deg)
pdir = RAW / "power_regional"
pdir.mkdir(exist_ok=True)
BOXES = [(94.5, 104.5, -9, 1), (94.5, 104.5, 1, 8), (104.5, 114.5, -9, 1), (104.5, 114.5, 1, 8), (114.5, 120.5, -9, 1), (114.5, 120.5, 1, 8)]


def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 1000:
        return json.loads(dest.read_text())
    for a in range(5):
        try:
            r = requests.get(url, timeout=300)
            r.raise_for_status()
            dest.write_text(r.text)
            return r.json()
        except Exception as e:  # noqa: BLE001
            print("   retry", dest.name, e)
            time.sleep(10 * (a + 1))
    raise RuntimeError(url)


grid = {}  # (param) -> dict[(lon,lat)] -> {month: value}
for par in ["PRECTOTCORR", "GWETROOT", "AOD_55"]:
    pts = {}
    for k, (x0, x1, y0, y1) in enumerate(BOXES):
        base = f"parameters={par}&community=AG&latitude-min={y0}&latitude-max={y1}&longitude-min={x0}&longitude-max={x1}&format=JSON"
        m = fetch(f"https://power.larc.nasa.gov/api/temporal/monthly/regional?{base}&start=2003&end=2025", pdir / f"m_{par}_{k}.json")
        dly = fetch(f"https://power.larc.nasa.gov/api/temporal/daily/regional?{base}&start=20260101&end=20261031", pdir / f"d26_{par}_{k}.json")
        for feat in m["features"]:
            lon, lat = round(feat["geometry"]["coordinates"][0], 2), round(feat["geometry"]["coordinates"][1], 2)
            ser = feat["properties"]["parameter"][par]
            dct = pts.setdefault((lon, lat), {})
            for key, v in ser.items():
                if key[4:] != "13" and v != -999:
                    dct[f"{key[:4]}-{key[4:]}"] = v
        for feat in dly["features"]:
            lon, lat = round(feat["geometry"]["coordinates"][0], 2), round(feat["geometry"]["coordinates"][1], 2)
            ser = pd.Series(feat["properties"]["parameter"][par]).replace(-999.0, np.nan)
            ser.index = pd.to_datetime(ser.index, format="%Y%m%d")
            g = ser.groupby(ser.index.month)
            mean, cnt = g.mean(), g.count()
            dct = pts.setdefault((lon, lat), {})
            for mo in mean.index:
                if cnt[mo] >= 20:
                    dct[f"2026-{mo:02d}"] = float(mean[mo])
    grid[par] = pts
    print(f"POWER {par}: {len(pts)} grid points")


from scipy.spatial import cKDTree  # noqa: E402

# POWER grids are native: MERRA-2 0.5 x 0.625 deg (rain, soil) and 1 deg (AOD) -> inverse-distance weighting
# of the 4 nearest grid points with data onto each 0.5 deg cell centre.
_trees = {par: (list(pts.keys()), cKDTree(np.array(list(pts.keys())))) for par, pts in grid.items()}


def cell_series(par, lon, lat):
    keys, tree = _trees[par]
    d, k = tree.query([lon, lat], k=4)
    w = 1 / np.maximum(d, 0.05)
    out = np.full(T, np.nan)
    for t, mth in enumerate(MONTHS):
        vals = [(grid[par][keys[q]].get(mth), wq) for q, wq in zip(k, w)]
        vals = [(v, wq) for v, wq in vals if v is not None]
        if vals:
            out[t] = sum(v * wq for v, wq in vals) / sum(wq for _, wq in vals)
    return out


rain = np.array([cell_series("PRECTOTCORR", c["lon"], c["lat"]) for c in cells])
soil = np.array([cell_series("GWETROOT", c["lon"], c["lat"]) for c in cells])
aod = np.array([cell_series("AOD_55", c["lon"], c["lat"]) for c in cells])
print("missing share rain/soil/aod:", np.isnan(rain).mean().round(3), np.isnan(soil).mean().round(3), np.isnan(aod).mean().round(3))

# ----------------------------------------------------------------------------- peat fraction (PEATMAP, cylindrical equal-area)
R = 6378137.0
PX = 0.01
W_, H_ = int(25 / PX), int(13 / PX)  # lon 95..120, lat -6.5..6.5
img = Image.new("L", (W_, H_), 0)
dr = ImageDraw.Draw(img)
sf = shapefile.Reader(str(RAW / "peat" / "Asia" / "SEA_Peatland.shp"))
shp = sf.shape(0)
parts = list(shp.parts) + [len(shp.points)]
P = np.array(shp.points)
lonp = np.degrees(P[:, 0] / R)
latp = np.degrees(np.arcsin(np.clip(P[:, 1] / R, -1, 1)))
holes = []
for a, b in zip(parts[:-1], parts[1:]):
    xs, ys = lonp[a:b], latp[a:b]
    if xs.max() < 95 or xs.min() > 120 or ys.max() < -6.5 or ys.min() > 6.5:
        continue
    area2 = np.sum(xs[:-1] * ys[1:] - xs[1:] * ys[:-1])  # >0 counter-clockwise
    poly = list(zip(((xs - 95) / PX).tolist(), ((6.5 - ys) / PX).tolist()))
    if len(poly) < 3:
        continue
    (holes.append(poly) if area2 > 0 else dr.polygon(poly, fill=255))
for poly in holes:
    dr.polygon(poly, fill=0)
pm = np.asarray(img) / 255.0
for c in cells:
    x0, y0 = int((c["lon"] - 0.25 - 95) / PX), int((6.5 - c["lat"] - 0.25) / PX)
    blk = pm[max(0, y0): y0 + 50, max(0, x0): x0 + 50]
    c["peatFrac"] = round(float(blk.mean()) if blk.size else 0.0, 3)
    c["peat"] = 1 if c["peatFrac"] >= 0.2 else 0
print(f"peat cells (>=20% peat): {sum(c['peat'] for c in cells)} of {C}")

# ----------------------------------------------------------------------------- forest loss (GFW regency stats, threshold 30%)
ws = openpyxl.load_workbook(RAW / "gfw" / "IDN.xlsx", read_only=True)["Subnational 2 tree cover loss"]
rows = list(ws.iter_rows(values_only=True))
hdr = rows[0]
yrs = [int(h[-4:]) for h in hdr if str(h).startswith("tc_loss_ha_")]
gfw = {}
for r in rows[1:]:
    if r[3] != 30:
        continue
    loss = np.array([r[hdr.index(f"tc_loss_ha_{y}")] or 0 for y in yrs], float)
    ext = r[hdr.index("extent_2000_ha")] or 0
    gfw[(r[1], r[2])] = (np.cumsum(loss) / ext * 100) if ext > 0 else np.zeros(len(yrs))
PROV_ID = {"Aceh": "Aceh", "North Sumatra": "Sumatera Utara", "West Sumatra": "Sumatera Barat", "Riau": "Riau", "Riau Islands": "Kepulauan Riau",
           "Jambi": "Jambi", "South Sumatra": "Sumatera Selatan", "Bengkulu": "Bengkulu", "Lampung": "Lampung", "Bangka-Belitung Islands": "Bangka Belitung",
           "West Kalimantan": "Kalimantan Barat", "Central Kalimantan": "Kalimantan Tengah", "South Kalimantan": "Kalimantan Selatan",
           "East Kalimantan": "Kalimantan Timur", "North Kalimantan": "Kalimantan Timur"}
norm = lambda s: re.sub(r"^(kota|kabupaten|kab\.?)\s+", "", s.lower()).replace("-", " ").strip()  # noqa: E731
regions = json.loads((PROC / "atlas" / "regions.json").read_text(encoding="utf8"))
kab_loss, unmatched = {}, []
for c in cells:
    k = c["kab"]
    if k < 0 or k in kab_loss:
        continue
    prov = PROV_ID.get(regions[k]["prov"])
    cands = {norm(b): key for key, _ in gfw.items() for (a, b) in [key] if a == prov} if prov else {}
    # regencies created after the GFW boundary vintage -> use their parent regency's statistics
    ALIAS = {"Mempawah": "Pontianak", "Pesisir Barat": "Lampung Barat", "Penukal Abab Lematang Ilir": "Muara Enim", "Mahakam Hulu": "Kutai Barat"}
    m = difflib.get_close_matches(norm(ALIAS.get(regions[k]["name"], regions[k]["name"])), list(cands), n=1, cutoff=0.75)
    if m:
        kab_loss[k] = gfw[cands[m[0]]]
    else:
        unmatched.append(regions[k]["name"])
print(f"GFW loss matched for {len(kab_loss)} regencies; unmatched: {unmatched}")
loss = np.full((C, T), np.nan)
for n, c in enumerate(cells):
    L = kab_loss.get(c["kab"])
    if L is None:
        continue
    for t, mth in enumerate(MONTHS):
        y = min(int(mth[:4]), yrs[-1])
        loss[n, t] = L[yrs.index(y)]
LOSS_LAST = yrs[-1]

# ----------------------------------------------------------------------------- ocean indices
ix = pd.read_csv(PROC / "indices_monthly.csv")
ixm = {f"{int(r.year)}-{int(r.month):02d}": r for r in ix.itertuples()}
oni = [None if pd.isna(ixm[m].oni) else round(float(ixm[m].oni), 2) for m in MONTHS]
dmi = [None if pd.isna(ixm[m].dmi) else round(float(ixm[m].dmi), 2) for m in MONTHS]

# ----------------------------------------------------------------------------- data-driven thresholds & models
fit_t = np.arange(0, FIRE_LAST + 1)
FIRE_EVENT = 10
# B danger line: root-zone soil wetness that best separates fire months (>=10 detections) from others in peat cells (Youden J)
pe = np.array([c["peat"] for c in cells], bool)
sv, fv = soil[pe][:, fit_t].ravel(), fire[pe][:, fit_t].ravel()
ok = ~np.isnan(sv)
best_thr, best_j = None, -1
for thr in np.arange(0.55, 0.95, 0.005):
    tp = np.mean(sv[ok][fv[ok] >= FIRE_EVENT] < thr)
    fp = np.mean(sv[ok][fv[ok] < FIRE_EVENT] < thr)
    if tp - fp > best_j:
        best_j, best_thr = tp - fp, float(thr)
print(f"B threshold (Youden): soil wetness < {best_thr:.3f}  J={best_j:.2f}")

# monthly risk model
hist = np.zeros_like(fire, dtype=float)
for n in range(C):
    seen = 0
    for t in range(T):
        hist[n, t] = seen
        if t <= FIRE_LAST and fire[n, t] >= FIRE_EVENT:
            seen = 1
X, Y, G = [], [], []
for n, c in enumerate(cells):
    for t in fit_t:
        if np.isnan(rain[n, t]) or np.isnan(soil[n, t]) or oni[t] is None:
            continue
        X.append([rain[n, t], soil[n, t], oni[t], c["peatFrac"], 0 if np.isnan(loss[n, t]) else loss[n, t] / 100, hist[n, t]])
        Y.append(int(fire[n, t] >= FIRE_EVENT))
        G.append(int(MONTHS[t][:4]))
X, Y, G = np.array(X), np.array(Y), np.array(G)
mu, sd = X.mean(0), X.std(0)
Xs = (X - mu) / sd
pred = np.zeros(len(Y))
for y in np.unique(G):
    m = G == y
    lr = LogisticRegression(max_iter=1000).fit(Xs[~m], Y[~m])
    pred[m] = lr.predict_proba(Xs[m])[:, 1]
risk_auc = roc_auc_score(Y, pred)
lr = LogisticRegression(max_iter=1000).fit(Xs, Y)
risk_model = {"features": ["rain", "soil", "oni", "peatFrac", "lossFrac", "burnedBefore"], "mu": mu.round(5).tolist(), "sd": sd.round(5).tolist(),
              "coef": lr.coef_[0].round(4).tolist(), "b": round(float(lr.intercept_[0]), 4), "auc_loyo": round(float(risk_auc), 3),
              "event": FIRE_EVENT, "base_rate": round(float(Y.mean()), 4), "n": int(len(Y))}
print("monthly risk model:", risk_model)

# July clue check model (clues lit in Jun-Jul -> big fire Aug-Nov)
rows_ = []
for n, c in enumerate(cells):
    jj = [MONTHS.index(f"{y}-07") for y in range(2003, 2026)]
    rn = np.nanmean([(rain[n, t - 1] + rain[n, t]) / 2 for t in jj])
    s_jj = np.array([(soil[n, t - 1] + soil[n, t]) / 2 for t in jj])
    s_q = np.nanpercentile(s_jj, 25)
    cmax = max(fire[n, : FIRE_LAST + 1].max(), 1)
    for y, t in zip(range(2003, 2026), jj):
        D = int((oni[t] or 0) >= 0.5 or (oni[t - 1] or 0) >= 0.5 or (dmi[t] or -9) >= 0.4 or (dmi[t - 1] or -9) >= 0.4)
        A = int((rain[n, t - 1] + rain[n, t]) / 2 < 0.75 * rn)
        B = int((soil[n, t - 1] + soil[n, t]) / 2 <= s_q)
        Cc = int(not np.isnan(loss[n, t]) and loss[n, t] >= 35)
        H = int(c["peat"] or (fire[n, :t - 1] >= FIRE_EVENT).any())
        peak = fire[n, t + 1: t + 5].max()
        big = int(peak >= max(FIRE_EVENT, 0.25 * cmax))
        # continuous July inputs (what the chance model actually uses)
        oj = np.mean([oni[t - 1] or 0, oni[t] or 0])
        rr = ((rain[n, t - 1] + rain[n, t]) / 2) / rn
        sz = (((soil[n, t - 1] + soil[n, t]) / 2) - np.nanmean(s_jj)) / (np.nanstd(s_jj) + 1e-6)
        lf = 0 if np.isnan(loss[n, t]) else loss[n, t] / 100
        rows_.append([D, A, B, Cc, H, big, y, oj, rr, sz, c["peatFrac"], lf, H])
R_ = np.array(rows_, float)
R_ = R_[~np.isnan(R_).any(axis=1)]
Yj, Gj = R_[:, 5].astype(int), R_[:, 6].astype(int)
Xb = R_[:, :5]                      # binary clues (shown as lights)
Xc = R_[:, 7:]                      # continuous inputs (used for the chance)
cmu, csd = Xc.mean(0), Xc.std(0)
Xcs = (Xc - cmu) / csd


def loyo(Xm):
    p = np.zeros(len(Yj))
    for y in np.unique(Gj):
        m = Gj == y
        p[m] = LogisticRegression(max_iter=1000).fit(Xm[~m], Yj[~m]).predict_proba(Xm[m])[:, 1]
    return p


pb, pc = loyo(Xb), loyo(Xcs)
lj = LogisticRegression(max_iter=1000).fit(Xcs, Yj)
july_model = {"features": ["oniJJ", "rainRatioJJ", "soilZJJ", "peatFrac", "lossFrac", "burnedBefore"],
              "mu": cmu.round(5).tolist(), "sd": csd.round(5).tolist(), "coef": lj.coef_[0].round(4).tolist(), "b": round(float(lj.intercept_[0]), 4),
              "auc_loyo": round(float(roc_auc_score(Yj, pc)), 3), "auc_binary_clues": round(float(roc_auc_score(Yj, pb)), 3),
              "base_rate": round(float(Yj.mean()), 3), "n": int(len(Yj))}
# decision threshold for "fire likely": maximise Youden J on the held-out predictions
ths = np.linspace(0.05, 0.9, 86)
jj_ = [((pc >= h) & (Yj == 1)).sum() / max(1, (Yj == 1).sum()) - ((pc >= h) & (Yj == 0)).sum() / max(1, (Yj == 0).sum()) for h in ths]
july_model["cut"] = round(float(ths[int(np.argmax(jj_))]), 3)
july_model["acc_loyo"] = round(float(((pc >= july_model["cut"]) == Yj).mean()), 3)
july_model["hit_rate"] = round(float(((pc >= july_model["cut"]) & (Yj == 1)).sum() / (Yj == 1).sum()), 3)
july_model["false_alarm"] = round(float(((pc >= july_model["cut"]) & (Yj == 0)).sum() / (Yj == 0).sum()), 3)
print("July clue model:", july_model)

# ----------------------------------------------------------------------------- terrain on the explorer grid
LON0, LON1, LAT0, LAT1, RES = 94.4, 119.8, -8.4, 7.4, 0.06
NX, NY = round((LON1 - LON0) / RES) + 1, round((LAT1 - LAT0) / RES) + 1
Z = 6
tx = lambda lon: (lon + 180) / 360 * 2**Z  # noqa: E731
ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**Z  # noqa: E731
X0, X1, Y0, Y1 = int(tx(LON0)), int(tx(LON1)), int(ty(LAT1)), int(ty(LAT0))
tdir = RAW / "terrain"
mosaic = np.zeros(((Y1 - Y0 + 1) * 256, (X1 - X0 + 1) * 256), np.float32)
for a in range(X0, X1 + 1):
    for b in range(Y0, Y1 + 1):
        f = tdir / f"{Z}_{a}_{b}.png"
        if not f.exists():
            f.write_bytes(requests.get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{a}/{b}.png", timeout=60).content)
        im = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB")).astype(np.float32)
        mosaic[(b - Y0) * 256:(b - Y0 + 1) * 256, (a - X0) * 256:(a - X0 + 1) * 256] = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
lons = LON0 + np.arange(NX) * RES
lats = LAT1 - np.arange(NY) * RES
LL, AA = np.meshgrid(lons, lats)
px = np.clip(((LL + 180) / 360 * 2**Z - X0) * 256, 0, mosaic.shape[1] - 1).astype(int)
py = np.clip(((1 - np.arcsinh(np.tan(np.radians(AA))) / np.pi) / 2 * 2**Z - Y0) * 256, 0, mosaic.shape[0] - 1).astype(int)
dem = np.clip(np.round(mosaic[py, px]), -8000, 6000).astype("<i2")

# ----------------------------------------------------------------------------- land polygons
land = json.loads((RAW / "geo" / "ne_10m_land.geojson").read_text())
bb = box(LON0 - 0.5, LAT0 - 0.5, LON1 + 0.5, LAT1 + 0.5)
feats = []
for f in land["features"]:
    g = shape(f["geometry"])
    if not g.intersects(bb):
        continue
    g = g.intersection(bb).simplify(0.01, preserve_topology=True)
    for p in getattr(g, "geoms", [g]):
        if p.geom_type == "Polygon" and p.area > 0.0005:
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[round(x, 3), round(y, 3)] for x, y in p.exterior.coords]]}})

# ----------------------------------------------------------------------------- export
def iarr(a, scale):
    return [None if np.isnan(v) else int(round(v * scale)) for v in a]


kabinfo = {}
out_cells = []
for n, c in enumerate(cells):
    k = c["kab"]
    if k >= 0 and k not in kabinfo:
        r = regions[k]
        kabinfo[k] = {"name": r["name"], "prov": r["prov"], "rank": r["rank"], "tot": r["tot"], "pct_dec": r["pct_dec"], "sig": r["sig"], "sen": r["sen"], "p": r["p"]}
    out_cells.append({
        "lon": c["lon"], "lat": c["lat"], "region": c["region"], "island": c["island"], "kab": k, "peat": c["peat"], "peatFrac": c["peatFrac"],
        "s": {"fire": fire[n].tolist(), "rain": iarr(rain[n], 10), "soil": iarr(soil[n], 1000), "aod": iarr(aod[n], 1000), "loss": iarr(loss[n], 10)},
    })
data = {
    "real": True,
    "months": MONTHS, "fireLast": FIRE_LAST, "lossLast": LOSS_LAST,
    "oni": oni, "dmi": dmi,
    "cells": out_cells, "kabs": {str(k): v for k, v in kabinfo.items()},
    "thrB": round(best_thr, 3), "riskModel": risk_model, "julyModel": july_model,
    "dem": {"lon0": LON0, "lat1": LAT1, "res": RES, "nx": NX, "ny": NY, "b64": base64.b64encode(dem.tobytes()).decode()},
    "land": {"type": "FeatureCollection", "features": feats},
    "nino34Oct2026": float(ix[(ix.year == 2026) & (ix.month == 10)].nino34_anom.iloc[0]),
}
(OUT / "data.json").write_text(json.dumps(data, separators=(",", ":")))
# shared terrain for the other 3D scenes of the site (hero, timeline, simulators)
(ROOT / "web" / "data" / "terrain.json").write_text(json.dumps({"dem": data["dem"], "land": data["land"]}, separators=(",", ":")))
print(f"wrote web/explore/data.json  {(OUT / 'data.json').stat().st_size / 1e6:.2f} MB  (T={T}, cells={C}, DEM {NX}x{NY})")
