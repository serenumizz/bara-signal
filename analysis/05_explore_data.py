"""
Step 5 - Real-data build of the "Jejak Api - Explore the Islands" 3D map (web/explore/data.json)
and the shared terrain of the other 3D scenes (web/data/terrain.json).

Every layer comes from a source on the Space Apps 2026 challenge Resources tab, on a 0.5 deg cell grid
covering Sumatra and Borneo (cells with >= 10% land of those islands, from the MODIS MOD44W land mask):

  fire   MODIS MOD14A2 + MYD14A2 fire pixels per cell & month (AppEEARS)
  rain   A  MERRA-2 PRECTOTCORR, mm/day          (Giovanni / GES DISC)
  soil   B  MERRA-2 GWETROOT root-zone wetness   (Giovanni / GES DISC)
  loss   C  decline of MODIS MOD44B % tree cover since 2001, in % of the 2001 cover (AppEEARS)
  aod    E  MERRA-2 TOTEXTTAU aerosol optical depth at 550 nm (Giovanni / GES DISC)
  oni/dmi D Nino3.4 (ONI = 3-month mean) and DMI from NOAA ERSSTv5 (KNMI Climate Explorer)
  terrain   SRTM elevation (AppEEARS SRTMGL3), coastlines from MOD44W
  model     logistic regressions fitted on 2003-2025 cell data (July "clue check" and monthly risk),
            evaluated with leave-one-year-out cross-validation

Run: python analysis/05_explore_data.py   (after 01-03)
"""
from __future__ import annotations

import base64
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
OUT = ROOT / "web" / "explore"
OUT.mkdir(parents=True, exist_ok=True)

# ----------------------------------------------------------------------------- time axis
M2 = np.load(PROC / "merra2_grid.npz")
fmeta = json.loads((PROC / "fires_meta.json").read_text())
fire_end = pd.Timestamp(fmeta["last_composite_end"])
last_fire_month = (fire_end + pd.Timedelta(days=1)).to_period("M") - 1   # last month fully covered
last_merra = pd.Period(f"{str(M2['months'][-1])[:4]}-{str(M2['months'][-1])[4:]}", "M")
END = max(last_fire_month, last_merra)
MONTHS = [str(p) for p in pd.period_range("2003-01", END, freq="M")]
T = len(MONTHS)
FIRE_LAST = MONTHS.index(str(last_fire_month))
tix = {m: k for k, m in enumerate(MONTHS)}

# ----------------------------------------------------------------------------- cells (land of Sumatra / Borneo)
isl = np.load(PROC / "islands.npz")
reg, lon0m, lat1m, resm = isl["region"], float(isl["lon0"]), float(isl["lat1"]), float(isl["res"])
cells = []
for i in range(0, 49):
    for j in range(0, 26):
        lon, lat = 95.25 + 0.5 * i, -5.75 + 0.5 * j
        x0, y0 = int(round((lon - 0.25 - lon0m) / resm)), int(round((lat1m - (lat + 0.25)) / resm))
        blk = reg[max(0, y0): y0 + 50, max(0, x0): x0 + 50]
        if blk.size == 0:
            continue
        s, b = (blk == 1).mean(), (blk == 2).mean()
        if max(s, b) < 0.1:
            continue
        cells.append({"lon": lon, "lat": lat, "i": i, "j": j, "island": "Sumatra" if s >= b else "Borneo",
                      "landFrac": round(float(s + b), 3)})
C = len(cells)
cidx = {(c["i"], c["j"]): n for n, c in enumerate(cells)}
print(f"cells: {C}")

# ----------------------------------------------------------------------------- fire (0.25 deg grid -> 0.5 deg cells)
fire = np.full((C, T), -1, dtype=np.int32)
fire[:, : FIRE_LAST + 1] = 0
g = pd.read_csv(PROC / "fires_grid_monthly.csv")
g = g[g.year >= 2003]
g["ci"], g["cj"] = g.i // 2, g.j // 2 - 1          # 0.25 grid origin (95, -6.5) -> 0.5 grid origin (95, -6)
g["n"] = g.n_terra + g.n_aqua
for r in g.groupby(["ci", "cj", "year", "month"]).n.sum().reset_index().itertuples():
    n = cidx.get((r.ci, r.cj))
    t = tix.get(f"{r.year}-{r.month:02d}")
    if n is not None and t is not None and t <= FIRE_LAST:
        fire[n, t] += r.n
print("fire pixels in cells 2003-", MONTHS[FIRE_LAST], ":", int(fire[fire > 0].sum()))

# ----------------------------------------------------------------------------- MERRA-2 onto cells (IDW of 4 nearest grid points)
mlat, mlon = M2["lat"], M2["lon"]
LO, LA = np.meshgrid(mlon, mlat)
tree = cKDTree(np.column_stack([LO.ravel(), LA.ravel()]))
mt = {f"{str(m)[:4]}-{str(m)[4:]}": k for k, m in enumerate(M2["months"])}


def cell_series(var: str, lon: float, lat: float) -> np.ndarray:
    d, k = tree.query([lon, lat], k=4)
    w = 1 / np.maximum(d, 0.05)
    a = M2[var].reshape(len(M2["months"]), -1)[:, k]
    out = np.full(T, np.nan)
    for t, m in enumerate(MONTHS):
        if m in mt:
            v = a[mt[m]]
            ok = ~np.isnan(v)
            if ok.any():
                out[t] = (v[ok] * w[ok]).sum() / w[ok].sum()
    return out


rain = np.array([cell_series("PRECTOTCORR", c["lon"], c["lat"]) for c in cells])
soil = np.array([cell_series("GWETROOT", c["lon"], c["lat"]) for c in cells])
aod = np.array([cell_series("TOTEXTTAU", c["lon"], c["lat"]) for c in cells])
print("missing share rain/soil/aod:", np.isnan(rain).mean().round(3), np.isnan(soil).mean().round(3), np.isnan(aod).mean().round(3))

# ----------------------------------------------------------------------------- tree cover decline (MOD44B)
tc = pd.read_csv(PROC / "treecover_cells.csv")
tcy = sorted(tc.year.unique())
LOSS_LAST = int(tcy[-1])
loss = np.full((C, T), np.nan)
for (i, j), d in tc.groupby(["i", "j"]):
    n = cidx.get((i, j))
    if n is None:
        continue
    ser = d.set_index("year").tree_cover
    base = ser.get(2001, np.nan)
    if not base or np.isnan(base) or base < 5:
        continue
    for t, m in enumerate(MONTHS):
        y = min(int(m[:4]), LOSS_LAST)
        if y in ser.index:
            loss[n, t] = max(0.0, (base - ser[y]) / base * 100)

# ----------------------------------------------------------------------------- ocean indices
ix = pd.read_csv(PROC / "indices_monthly.csv")
ixm = {f"{int(r.year)}-{int(r.month):02d}": r for r in ix.itertuples()}
oni = [None if (m not in ixm or pd.isna(ixm[m].oni)) else round(float(ixm[m].oni), 2) for m in MONTHS]
dmi = [None if (m not in ixm or pd.isna(ixm[m].dmi)) else round(float(ixm[m].dmi), 2) for m in MONTHS]
n34 = ix.dropna(subset=["nino34_anom"]).iloc[-1]
n34_prev_max = float(ix.dropna(subset=["nino34_anom"]).iloc[:-1].nino34_anom.max())   # record check vs 1950 onwards

# ----------------------------------------------------------------------------- data-driven thresholds & models
fit_t = np.array([t for t in range(FIRE_LAST + 1) if MONTHS[t] <= "2025-12"])
FIRE_EVENT = 10


def youden(values, events, grid, below=True):
    ok = ~np.isnan(values)
    v, e = values[ok], events[ok]
    best, bj = None, -1
    for thr in grid:
        hit = v < thr if below else v >= thr
        j_ = hit[e].mean() - hit[~e].mean()
        if j_ > bj:
            best, bj = float(thr), j_
    return best, bj


ev = (fire[:, fit_t] >= FIRE_EVENT).ravel()
best_thr, jb = youden(soil[:, fit_t].ravel(), ev, np.arange(0.55, 0.95, 0.005))
print(f"B threshold (Youden, all cells): soil wetness < {best_thr:.3f}  J={jb:.2f}")
thr_c, jc = youden(loss[:, fit_t].ravel(), ev, np.arange(2, 60, 1.0), below=False)
print(f"C threshold (Youden, all cells): tree-cover decline >= {thr_c:.0f}%  J={jc:.2f}")

hist = np.zeros_like(fire, dtype=float)
for n in range(C):
    seen = 0
    for t in range(T):
        hist[n, t] = seen
        if t <= FIRE_LAST and fire[n, t] >= FIRE_EVENT:
            seen = 1
X, Y, G = [], [], []
for n in range(C):
    for t in fit_t:
        if np.isnan(rain[n, t]) or np.isnan(soil[n, t]) or oni[t] is None:
            continue
        X.append([rain[n, t], soil[n, t], oni[t], 0 if np.isnan(loss[n, t]) else loss[n, t] / 100, hist[n, t]])
        Y.append(int(fire[n, t] >= FIRE_EVENT))
        G.append(int(MONTHS[t][:4]))
X, Y, G = np.array(X), np.array(Y), np.array(G)
mu, sd = X.mean(0), X.std(0)
Xs = (X - mu) / sd
pred = np.zeros(len(Y))
for y in np.unique(G):
    m = G == y
    pred[m] = LogisticRegression(max_iter=1000).fit(Xs[~m], Y[~m]).predict_proba(Xs[m])[:, 1]
lr = LogisticRegression(max_iter=1000).fit(Xs, Y)
risk_model = {"features": ["rain", "soil", "oni", "lossFrac", "burnedBefore"], "mu": mu.round(5).tolist(), "sd": sd.round(5).tolist(),
              "coef": lr.coef_[0].round(4).tolist(), "b": round(float(lr.intercept_[0]), 4), "auc_loyo": round(float(roc_auc_score(Y, pred)), 3),
              "event": FIRE_EVENT, "base_rate": round(float(Y.mean()), 4), "n": int(len(Y))}
print("monthly risk model:", risk_model)

# July clue check (clues lit in Jun-Jul -> big fire Aug-Nov), 2003-2025
rows_ = []
for n in range(C):
    jj = [tix[f"{y}-07"] for y in range(2003, 2026)]
    rn = np.nanmean([(rain[n, t - 1] + rain[n, t]) / 2 for t in jj])
    s_jj = np.array([(soil[n, t - 1] + soil[n, t]) / 2 for t in jj])
    s_q = np.nanpercentile(s_jj, 25)
    cmax = max(fire[n, : FIRE_LAST + 1].max(), 1)
    for y, t in zip(range(2003, 2026), jj):
        D = int((oni[t] or 0) >= 0.5 or (oni[t - 1] or 0) >= 0.5 or (dmi[t] or -9) >= 0.4 or (dmi[t - 1] or -9) >= 0.4)
        A = int((rain[n, t - 1] + rain[n, t]) / 2 < 0.75 * rn)
        B = int((soil[n, t - 1] + soil[n, t]) / 2 <= s_q)
        Cc = int(not np.isnan(loss[n, t]) and loss[n, t] >= thr_c)
        H = int((fire[n, : t - 1] >= FIRE_EVENT).any())
        big = int(fire[n, t + 1: t + 5].max() >= max(FIRE_EVENT, 0.25 * cmax))
        oj = np.mean([oni[t - 1] or 0, oni[t] or 0])
        rr = ((rain[n, t - 1] + rain[n, t]) / 2) / rn
        sz = (((soil[n, t - 1] + soil[n, t]) / 2) - np.nanmean(s_jj)) / (np.nanstd(s_jj) + 1e-6)
        lf = 0 if np.isnan(loss[n, t]) else loss[n, t] / 100
        rows_.append([D, A, B, Cc, H, big, y, oj, rr, sz, lf, H])
R_ = np.array(rows_, float)
R_ = R_[~np.isnan(R_).any(axis=1)]
Yj, Gj = R_[:, 5].astype(int), R_[:, 6].astype(int)
Xb, Xc = R_[:, :5], R_[:, 7:]
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
july_model = {"features": ["oniJJ", "rainRatioJJ", "soilZJJ", "lossFrac", "burnedBefore"],
              "mu": cmu.round(5).tolist(), "sd": csd.round(5).tolist(), "coef": lj.coef_[0].round(4).tolist(), "b": round(float(lj.intercept_[0]), 4),
              "auc_loyo": round(float(roc_auc_score(Yj, pc)), 3), "auc_binary_clues": round(float(roc_auc_score(Yj, pb)), 3),
              "base_rate": round(float(Yj.mean()), 3), "n": int(len(Yj))}
ths = np.linspace(0.05, 0.9, 86)
jj_ = [((pc >= h) & (Yj == 1)).sum() / max(1, (Yj == 1).sum()) - ((pc >= h) & (Yj == 0)).sum() / max(1, (Yj == 0).sum()) for h in ths]
july_model["cut"] = round(float(ths[int(np.argmax(jj_))]), 3)
july_model["acc_loyo"] = round(float(((pc >= july_model["cut"]) == Yj).mean()), 3)
july_model["hit_rate"] = round(float(((pc >= july_model["cut"]) & (Yj == 1)).sum() / (Yj == 1).sum()), 3)
july_model["false_alarm"] = round(float(((pc >= july_model["cut"]) & (Yj == 0)).sum() / (Yj == 0).sum()), 3)
print("July clue model:", july_model)

# ----------------------------------------------------------------------------- terrain + coastlines
LON0, LAT1, RES = 94.4, 7.4, 0.06
dem = np.load(PROC / "dem_006.npy")
NY, NX = dem.shape
land = json.loads((PROC / "land.json").read_text())
feats = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}} for ring in land]


# ----------------------------------------------------------------------------- export
def iarr(a, scale):
    return [None if np.isnan(v) else int(round(v * scale)) for v in a]


out_cells = [{"lon": c["lon"], "lat": c["lat"], "region": c["island"], "island": c["island"], "landFrac": c["landFrac"],
              "s": {"fire": fire[n].tolist(), "rain": iarr(rain[n], 10), "soil": iarr(soil[n], 1000), "aod": iarr(aod[n], 1000),
                    "loss": iarr(loss[n], 10)}} for n, c in enumerate(cells)]
data = {
    "real": True,
    "months": MONTHS, "fireLast": FIRE_LAST, "lossLast": LOSS_LAST,
    "oni": oni, "dmi": dmi,
    "cells": out_cells,
    "thrB": round(best_thr, 3), "thrC": round(thr_c, 1), "riskModel": risk_model, "julyModel": july_model,
    "dem": {"lon0": LON0, "lat1": LAT1, "res": RES, "nx": int(NX), "ny": int(NY), "b64": base64.b64encode(dem.astype("<i2").tobytes()).decode()},
    "land": {"type": "FeatureCollection", "features": feats},
    "nino34Latest": round(float(n34.nino34_anom), 2), "nino34LatestMonth": f"{int(n34.year)}-{int(n34.month):02d}",
    "nino34LatestSource": str(n34.source),
    "nino34IsRecord": bool(float(n34.nino34_anom) > n34_prev_max), "nino34RecordSince": int(ix.year.min()),
}
(OUT / "data.json").write_text(json.dumps(data, separators=(",", ":")))
(ROOT / "web" / "data" / "terrain.json").write_text(json.dumps({"dem": data["dem"], "land": data["land"]}, separators=(",", ":")))
print(f"wrote web/explore/data.json  {(OUT / 'data.json').stat().st_size / 1e6:.2f} MB  (T={T}, cells={C}, DEM {NX}x{NY})")
