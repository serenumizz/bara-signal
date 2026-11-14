"""
Step 3 - Analysis: what changes, where, how much, is it significant, and why.

1. Trend detection (Mann-Kendall, Hamed-Rao autocorrelation-corrected) + Sen's slope on annual series
2. Change-point detection (Pettitt) on fire-season detections and on climate-adjusted residuals
3. Spatial trend map: per-cell Mann-Kendall + Sen's slope with Benjamini-Hochberg FDR (field significance)
4. "Domino" causal chain fitted on observations (2003-2025):
      ENSO (ONI) + IOD (DMI) -> dry-season rainfall -> root-zone soil wetness -> fire detections -> aerosol (AOD)
   each link = OLS regression, skill checked by leave-one-year-out cross-validation
5. Lagged monthly cross-correlations along the chain (de-seasonalised anomalies)
6. ENSO analog sequences for 2027-2030 (what followed every strong El Nino since 1950)
7. Data needed by the web simulator -> web/data/*.json

Run: python analysis/03_analysis.py
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"
WEB = ROOT / "web" / "data"
WEB.mkdir(parents=True, exist_ok=True)

SEASON = [7, 8, 9, 10]  # Jul-Oct fire season
FIT = range(2003, 2026)  # full Terra+Aqua years
LON0, LAT0, CELL = 95.0, -6.5, 0.25


# ----------------------------------------------------------------------------- statistics helpers
def mann_kendall(x: np.ndarray, hamed_rao: bool = True) -> dict:
    """Mann-Kendall trend test with optional Hamed & Rao (1998) variance correction for autocorrelation."""
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    n = len(x)
    s = 0
    for k in range(n - 1):
        s += np.sign(x[k + 1 :] - x[k]).sum()
    _, counts = np.unique(x, return_counts=True)
    var_s = (n * (n - 1) * (2 * n + 5) - (counts * (counts - 1) * (2 * counts + 5)).sum()) / 18.0
    # Sen's slope
    i, j = np.triu_indices(n, 1)
    slopes = (x[j] - x[i]) / (j - i)
    sen = float(np.median(slopes))
    intercept = float(np.median(x - sen * np.arange(n)))
    if hamed_rao and n > 10:
        detr = x - sen * np.arange(n)
        r = stats.rankdata(detr)
        r = r - r.mean()
        acf = np.array([np.sum(r[: n - L] * r[L:]) / np.sum(r * r) for L in range(1, n)])
        bound = 1.96 / np.sqrt(n)
        corr = 0.0
        for L, rho in enumerate(acf, start=1):
            if abs(rho) > bound:
                corr += (n - L) * (n - L - 1) * (n - L - 2) * rho
        nns = 1 + 2 / (n * (n - 1) * (n - 2)) * corr
        var_s *= max(nns, 1e-6)
    z = 0.0 if s == 0 else (s - np.sign(s)) / np.sqrt(var_s)
    p = 2 * (1 - stats.norm.cdf(abs(z)))
    tau = s / (0.5 * n * (n - 1))
    return {"n": int(n), "S": int(s), "tau": float(tau), "z": float(z), "p": float(p), "sen": sen, "intercept": intercept}


def pettitt(x: np.ndarray) -> tuple[int, float]:
    """Pettitt (1979) change-point test. Returns index of last point before the change and approx p-value."""
    x = np.asarray(x, float)
    n = len(x)
    U = np.array([np.sum(np.sign(x[: t + 1, None] - x[None, t + 1 :])) for t in range(n - 1)])
    k = int(np.argmax(np.abs(U)))
    K = abs(U[k])
    p = 2 * np.exp(-6 * K**2 / (n**3 + n**2))
    return k, float(min(p, 1.0))


def bh_fdr(p: np.ndarray, alpha: float = 0.05) -> np.ndarray:
    p = np.asarray(p)
    order = np.argsort(p)
    m = len(p)
    thresh = alpha * np.arange(1, m + 1) / m
    passed = p[order] <= thresh
    k = np.max(np.where(passed)[0]) + 1 if passed.any() else 0
    sig = np.zeros(m, bool)
    sig[order[:k]] = True
    return sig


def ols(y: np.ndarray, X: np.ndarray, names: list[str]) -> dict:
    """OLS with intercept, coefficient p-values, R2 and leave-one-out cross-validated R2."""
    Xc = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(Xc, y, rcond=None)
    res = y - Xc @ beta
    n, k = Xc.shape
    sigma2 = res @ res / (n - k)
    cov = sigma2 * np.linalg.inv(Xc.T @ Xc)
    se = np.sqrt(np.diag(cov))
    t = beta / se
    p = 2 * (1 - stats.t.cdf(np.abs(t), n - k))
    r2 = 1 - res @ res / np.sum((y - y.mean()) ** 2)
    loo = np.empty(n)
    for i in range(n):
        m = np.arange(n) != i
        b, *_ = np.linalg.lstsq(Xc[m], y[m], rcond=None)
        loo[i] = Xc[i] @ b
    r2cv = 1 - np.sum((y - loo) ** 2) / np.sum((y - y.mean()) ** 2)
    return {
        "coef": {nm: float(b) for nm, b in zip(["intercept"] + names, beta)},
        "p": {nm: float(v) for nm, v in zip(["intercept"] + names, p)},
        "r2": float(r2),
        "r2_loo": float(r2cv),
        "resid_sd": float(np.sqrt(sigma2)),
        "resid": res.tolist(),
        "loo_pred": loo.tolist(),
        "n": int(n),
    }


# ----------------------------------------------------------------------------- load
fires = pd.read_csv(PROC / "fires_monthly.csv")
drv = pd.read_csv(PROC / "drivers_monthly.csv")
ix = pd.read_csv(PROC / "indices_monthly.csv")
grid = pd.read_csv(PROC / "fires_grid_annual.csv")

dom = fires[fires.region != "Other"]
monthly_dom = dom.groupby(["year", "month"]).agg(n=("n", "sum"), n_terra=("n_terra", "sum"), n_aqua=("n_aqua", "sum"))


def seas_mean(df: pd.DataFrame, col: str, months: list[int]) -> pd.Series:
    return df[df.month.isin(months)].groupby("year")[col].mean()


A = pd.DataFrame(index=range(2000, 2027))
A["fires_year"] = dom.groupby("year").n.sum()
A["fires_season"] = dom[dom.month.isin(SEASON)].groupby("year").n.sum()
A["fires_aqua_season"] = dom[dom.month.isin(SEASON)].groupby("year").n_aqua.sum()
A["fires_terra_year"] = dom.groupby("year").n_terra.sum()
A["fires_sumatra"] = fires[(fires.region == "Sumatra") & fires.month.isin(SEASON)].groupby("year").n.sum()
A["fires_borneo"] = fires[(fires.region == "Borneo") & fires.month.isin(SEASON)].groupby("year").n.sum()
A["rain"] = seas_mean(drv, "PRECTOTCORR", SEASON)          # mm/day
A["soil"] = seas_mean(drv, "GWETROOT", SEASON)             # 0-1
A["soil_top"] = seas_mean(drv, "GWETTOP", SEASON)
A["t2m"] = seas_mean(drv, "T2M", SEASON)
A["rh"] = seas_mean(drv, "RH2M", SEASON)
A["wind"] = seas_mean(drv, "SPEED", SEASON)
A["aod"] = seas_mean(drv, "TOTEXTTAU", [8, 9, 10])          # haze peak months
A["oni"] = seas_mean(ix, "oni", [7, 8, 9])                  # JJA, JAS, ASO seasons
A["nino34"] = seas_mean(ix, "nino34_anom", SEASON)
A["dmi"] = seas_mean(ix, "dmi", [8, 9, 10])
A.loc[2000, ["fires_year", "fires_season", "fires_aqua_season"]] = np.nan  # Terra fire record starts Nov 2000
FMETA = json.loads((PROC / "fires_meta.json").read_text())
# 2026: the fire season is only used once its last month is fully covered by 8-day composites
season26_done = pd.Timestamp(FMETA["last_composite_end"]) >= pd.Timestamp(2026, SEASON[-1], 1) + pd.offsets.MonthEnd(0)
fires_season_2026 = float(A.loc[2026, "fires_season"]) if season26_done else None
A.loc[2026, ["fires_year", "fires_season", "fires_aqua_season", "fires_terra_year", "fires_sumatra", "fires_borneo"]] = np.nan
print(A.round(3).to_string())

# ----------------------------------------------------------------------------- 1. trends
trend_vars = {
    "fires_season": ("Fire-season fire pixels (Jul-Oct, Terra+Aqua)", "pixels/yr", FIT),
    "fires_aqua_season": ("Fire-season fire pixels, Aqua only (sensor-consistency check)", "pixels/yr", FIT),
    "fires_terra_year": ("Annual fire pixels, Terra only (2001-2025)", "pixels/yr", range(2001, 2026)),
    "fires_sumatra": ("Fire pixels - Sumatra (Jul-Oct)", "pixels/yr", FIT),
    "fires_borneo": ("Fire pixels - Borneo (Jul-Oct)", "pixels/yr", FIT),
    "rain": ("Dry-season rainfall (Jul-Oct)", "mm/day per yr", range(2001, 2026)),
    "soil": ("Root-zone soil wetness (Jul-Oct)", "fraction per yr", range(2001, 2026)),
    "t2m": ("Air temperature at 2 m (Jul-Oct)", "degC per yr", range(2001, 2026)),
    "rh": ("Relative humidity (Jul-Oct)", "% per yr", range(2001, 2026)),
    "aod": ("Aerosol optical depth (Aug-Oct, MERRA-2)", "AOD per yr", range(2001, 2026)),
    "oni": ("ENSO - ONI (Jul-Sep)", "degC per yr", range(2001, 2026)),
    "dmi": ("Indian Ocean Dipole - DMI (Aug-Oct)", "degC per yr", range(2001, 2026)),
}
trends = []
for key, (label, unit, yrs) in trend_vars.items():
    s = A.loc[list(yrs), key]
    r = mann_kendall(s.values)
    r0 = mann_kendall(s.values, hamed_rao=False)
    mean = float(s.mean())
    trends.append({
        "key": key, "label": label, "unit": unit, "years": [yrs.start, yrs.stop - 1],
        "sen_slope": r["sen"], "pct_per_decade": 100 * 10 * r["sen"] / mean if mean else None,
        "tau": r["tau"], "p": r["p"], "p_classic": r0["p"], "significant": r["p"] < 0.05,
        "direction": "increasing" if r["sen"] > 0 else "decreasing",
    })
print("\nTRENDS (Mann-Kendall, Hamed-Rao corrected)")
for t in trends:
    print(f"  {t['label'][:55]:55s} sen={t['sen_slope']:+.4g} ({t['pct_per_decade']:+.1f}%/dec) p={t['p']:.3f} "
          f"p_classic={t['p_classic']:.3f} {'*' if t['significant'] else ''}")

# ----------------------------------------------------------------------------- 4. chain model
F = A.loc[list(FIT)].copy()
F["ln_fires"] = np.log(F.fires_season)

link_climate = ols(F.rain.values, F[["oni", "dmi"]].values, ["oni", "dmi"])
link_soil = ols(F.soil.values, F[["rain"]].values, ["rain"])

# change point in climate-adjusted fire residual -> governance regime
base = ols(F.ln_fires.values, F[["soil"]].values, ["soil"])
cp_k, cp_p = pettitt(np.array(base["resid"]))
cp_year = list(FIT)[cp_k + 1]  # first year of new regime
cp_raw_k, cp_raw_p = pettitt(F.fires_season.values)
F["regime"] = (F.index >= cp_year).astype(float)
link_fire = ols(F.ln_fires.values, F[["soil", "regime"]].values, ["soil", "regime"])
link_aod = ols(F.aod.values, F[["ln_fires"]].values, ["ln_fires"])

print(f"\nPettitt raw fires: change after {list(FIT)[cp_raw_k]} p={cp_raw_p:.4f}")
print(f"Pettitt climate-adjusted residual: new regime from {cp_year} p={cp_p:.4f}")
for nm, L in [("ENSO+IOD->rain", link_climate), ("rain->soil", link_soil), ("soil->fires(base)", base),
              ("soil+regime->ln fires", link_fire), ("ln fires->AOD", link_aod)]:
    print(f"  {nm:24s} R2={L['r2']:.2f} LOO-R2={L['r2_loo']:.2f} sd={L['resid_sd']:.3f} coef={ {k: round(v,4) for k,v in L['coef'].items()} } p={ {k: round(v,4) for k,v in L['p'].items()} }")
regime_effect = float(np.exp(link_fire["coef"]["regime"]) - 1)
print(f"  regime effect on fires at equal soil wetness: {100*regime_effect:+.0f}%")

# Full chain hindcast (ENSO/IOD only -> fires), to show what climate alone explains
pred_rain = link_climate["coef"]["intercept"] + link_climate["coef"]["oni"] * F.oni + link_climate["coef"]["dmi"] * F.dmi
pred_soil = link_soil["coef"]["intercept"] + link_soil["coef"]["rain"] * pred_rain
pred_ln = link_fire["coef"]["intercept"] + link_fire["coef"]["soil"] * pred_soil + link_fire["coef"]["regime"] * F.regime
chain_r2 = 1 - np.sum((F.ln_fires - pred_ln) ** 2) / np.sum((F.ln_fires - F.ln_fires.mean()) ** 2)
print(f"  full chain (ocean indices only) R2 on ln fires = {chain_r2:.2f}")

# ----------------------------------------------------------------------------- 5. lagged monthly correlations
M = drv.merge(ix, on=["year", "month"], how="left").merge(monthly_dom.reset_index(), on=["year", "month"], how="left")
M = M[(M.year >= 2003) & (M.year <= 2025)].sort_values(["year", "month"]).reset_index(drop=True)
M["ln_n"] = np.log1p(M.n)
for c in ["PRECTOTCORR", "GWETROOT", "TOTEXTTAU", "ln_n", "oni", "dmi"]:
    M[c + "_a"] = M[c] - M.groupby("month")[c].transform("mean")


def lagcorr(a: str, b: str, maxlag: int = 6) -> list[dict]:
    out = []
    for L in range(0, maxlag + 1):
        x, y = M[a + "_a"].shift(L), M[b + "_a"]
        ok = x.notna() & y.notna()
        r, p = stats.pearsonr(x[ok], y[ok])
        out.append({"lag": L, "r": float(r), "p": float(p)})
    return out


lags = {
    "oni->rain": lagcorr("oni", "PRECTOTCORR"),
    "dmi->rain": lagcorr("dmi", "PRECTOTCORR"),
    "rain->soil": lagcorr("PRECTOTCORR", "GWETROOT"),
    "soil->fires": lagcorr("GWETROOT", "ln_n"),
    "fires->aod": lagcorr("ln_n", "TOTEXTTAU"),
}
print("\nLAGGED MONTHLY CORRELATIONS (anomalies)")
for k, v in lags.items():
    best = max(v, key=lambda d: abs(d["r"]))
    print(f"  {k:12s} " + " ".join(f"L{d['lag']}:{d['r']:+.2f}" for d in v) + f"   best lag {best['lag']}")

# ----------------------------------------------------------------------------- 3. spatial trends (0.5 deg aggregation)
g = grid[grid.year.isin(FIT)].copy()
g["I"], g["J"] = g.i // 2, g.j // 2
gc = g.groupby(["I", "J", "year"]).n.sum().unstack(fill_value=0).reindex(columns=list(FIT), fill_value=0)
gc = gc[gc.sum(axis=1) >= 50]
cells = []
for (I, J), row in gc.iterrows():
    r = mann_kendall(row.values, hamed_rao=False)
    pre = row.loc[2003:cp_year - 1].mean()
    post = row.loc[cp_year:2025].mean()
    cells.append({"I": int(I), "J": int(J), "sen": r["sen"], "p": r["p"], "total": int(row.sum()),
                  "pre": float(pre), "post": float(post)})
cells = pd.DataFrame(cells)
cells["sig_fdr"] = bh_fdr(cells.p.values)
cells["lon"] = LON0 + (cells.I + 0.5) * 0.5
cells["lat"] = LAT0 + (cells.J + 0.5) * 0.5
print(f"\nSPATIAL: {len(cells)} active 0.5deg cells; decreasing={int((cells.sen<0).sum())}, increasing={int((cells.sen>0).sum())}; "
      f"FDR-significant: dec={int((cells.sig_fdr&(cells.sen<0)).sum())} inc={int((cells.sig_fdr&(cells.sen>0)).sum())}")

# ----------------------------------------------------------------------------- 6. ENSO analogs
oni_long = ix.groupby("year").apply(lambda d: d[d.month.isin([7, 8, 9])].oni.mean())
dmi_long = ix.groupby("year").apply(lambda d: d[d.month.isin([8, 9, 10])].dmi.mean())
strong = [int(y) for y in oni_long.index if oni_long[y] >= 1.0 and y + 4 <= 2025]
analogs = []
for y in strong:
    analogs.append({
        "start": y, "oni0": float(oni_long[y]),
        "seq": [{"oni": float(oni_long[y + k]), "dmi": float(dmi_long[y + k])} for k in range(1, 5)],
    })
print("\nENSO ANALOGS (El Nino Jul-Sep ONI>=1.0):", [(a["start"], round(a["oni0"], 2)) for a in analogs])
for a in analogs:
    print("   ", a["start"], [round(s["oni"], 2) for s in a["seq"]])
# climatological sample (all years 1950-2025) for unconditional draws
clim = [{"oni": float(oni_long[y]), "dmi": float(dmi_long[y]), "year": int(y)} for y in range(1950, 2026)]

# ----------------------------------------------------------------------------- 2026 observed state
obs26 = {k: (None if pd.isna(A.loc[2026, k]) else float(A.loc[2026, k]))
         for k in ["rain", "soil", "soil_top", "t2m", "rh", "wind", "aod", "oni", "nino34", "dmi"]}
obs26["dmi_latest"] = float(ix[(ix.year == 2026) & ix.dmi.notna()].dmi.iloc[-1])
obs26["dmi_latest_month"] = int(ix[(ix.year == 2026) & ix.dmi.notna()].month.iloc[-1])
obs26["oni_latest"] = float(ix[(ix.year == 2026) & ix.oni.notna()].oni.iloc[-1])
obs26["nino34_monthly"] = ix[(ix.year == 2026)][["month", "nino34_anom"]].dropna().values.tolist()
d26 = drv[drv.year == 2026]
obs26["monthly"] = d26[["month", "PRECTOTCORR", "GWETROOT", "TOTEXTTAU"]].replace({np.nan: None}).values.tolist()
rec = ix[ix.nino34_anom.notna()]
obs26["nino34_record_before_2026"] = float(rec[rec.year < 2026].nino34_anom.max())
obs26["nino34_record_before_2026_when"] = rec[rec.year < 2026].sort_values("nino34_anom").iloc[-1][["year", "month"]].astype(int).tolist()
obs26["nino34_max_2026"] = float(rec[rec.year == 2026].nino34_anom.max())
# nowcast from observed soil wetness
c = link_fire["coef"]
obs26["nowcast_ln"] = c["intercept"] + c["soil"] * obs26["soil"] + c["regime"] * 1
obs26["nowcast_fires"] = float(np.exp(obs26["nowcast_ln"]))
obs26["fires_season_observed"] = fires_season_2026
obs26["fires_last_composite_end"] = FMETA["last_composite_end"]
obs26["nino34_latest"] = float(rec.nino34_anom.iloc[-1])
obs26["nino34_latest_when"] = rec.iloc[-1][["year", "month"]].astype(int).tolist()
obs26["nino34_latest_source"] = str(rec.source.iloc[-1])
print("\n2026 observed:", {k: v for k, v in obs26.items() if k not in ("monthly", "nino34_monthly")})

# soil-wetness rank of 2026 among all years
soil_rank = A.soil.rank().loc[2026]
print(f"2026 Jul-Oct soil wetness rank (1=driest of {A.soil.notna().sum()}): {int(soil_rank)}")

# ----------------------------------------------------------------------------- spatial patterns for simulation
gy = grid.copy()
tot = gy.groupby("year").n.transform("sum")
gy["share"] = gy.n / tot
high_years = [y for y in FIT if A.loc[y, "fires_season"] >= A.loc[list(FIT), "fires_season"].median()]
low_years = [y for y in FIT if y not in high_years]


def pattern(years):
    p = gy[gy.year.isin(years)].groupby(["i", "j"]).share.sum() / len(years)
    p = p / p.sum()
    return [[int(i), int(j), round(float(v), 6)] for (i, j), v in p.items() if v > 2e-5]


patterns = {"high": pattern(high_years), "low": pattern(low_years),
            "post_regime": pattern([y for y in FIT if y >= cp_year])}

# monthly distribution of the fire season in dry vs normal years
mshare = monthly_dom.n.unstack()
mshare = mshare.div(mshare.sum(axis=1), axis=0)
month_profile = {"high": mshare.loc[high_years].mean().round(4).tolist(),
                 "low": mshare.loc[low_years].mean().round(4).tolist()}

# ----------------------------------------------------------------------------- latest 8-day MODIS fire composite (AppEEARS)
live_out = json.loads((PROC / "fires_latest.json").read_text())
print(f"Latest MODIS 8-day composite {live_out['from']}..{live_out['to']}: {live_out['n']} fire pixels")

# ----------------------------------------------------------------------------- export for web
timeline = []
for y in range(2000, 2026):
    gyy = grid[grid.year == y]
    timeline.append({
        "year": y,
        "fires_year": None if pd.isna(A.loc[y, "fires_year"]) else int(A.loc[y, "fires_year"]),
        "fires_season": None if pd.isna(A.loc[y, "fires_season"]) else int(A.loc[y, "fires_season"]),
        "sumatra": None if pd.isna(A.loc[y, "fires_sumatra"]) else int(A.loc[y, "fires_sumatra"]),
        "borneo": None if pd.isna(A.loc[y, "fires_borneo"]) else int(A.loc[y, "fires_borneo"]),
        "monthly": [int(monthly_dom.n.get((y, m), 0)) for m in range(1, 13)],
        **{k: (None if pd.isna(A.loc[y, k]) else round(float(A.loc[y, k]), 4))
           for k in ["rain", "soil", "t2m", "rh", "aod", "oni", "dmi"]},
        "terra_only": y <= 2002,
        "cells": gyy[["i", "j", "n"]].values.tolist(),
    })

hindcast = [{"year": int(y), "obs": float(F.fires_season[y]), "loo": float(np.exp(link_fire["loo_pred"][k])),
             "chain": float(np.exp(pred_ln[y]))} for k, y in enumerate(F.index)]

strip = lambda L: {k: v for k, v in L.items() if k not in ("resid", "loo_pred")}  # noqa: E731
analysis = {
    "generated": pd.Timestamp.now().isoformat(timespec="minutes"),
    "season_months": SEASON,
    "fit_years": [FIT.start, FIT.stop - 1],
    "trends": trends,
    "changepoint": {"raw_after": int(list(FIT)[cp_raw_k]), "raw_p": cp_raw_p, "regime_start": int(cp_year), "regime_p": cp_p},
    "chain": {"climate_to_rain": strip(link_climate), "rain_to_soil": strip(link_soil), "soil_to_fires": strip(link_fire),
              "soil_only_fires": strip(base), "fires_to_aod": strip(link_aod), "chain_r2": float(chain_r2),
              "regime_effect": regime_effect,
              "resid_fire": link_fire["resid"], "resid_rain": link_climate["resid"], "resid_soil": link_soil["resid"]},
    "hindcast": hindcast,
    "lags": lags,
    "spatial": cells[["lon", "lat", "sen", "p", "sig_fdr", "total", "pre", "post"]].round(4).to_dict(orient="records"),
    "analogs": analogs,
    "climatology": clim,
    "obs2026": obs26,
    "patterns": patterns,
    "month_profile": month_profile,
    "high_years": high_years,
    "ranges": {k: [float(A[k].min()), float(A[k].max())] for k in ["rain", "soil", "oni", "dmi", "aod"]},
    "grid": {"lon0": LON0, "lat0": LAT0, "cell": CELL},
    "live": live_out,
}
(WEB / "timeline.json").write_text(json.dumps(timeline, separators=(",", ":")))
(WEB / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":"), default=float))
(WEB / "land.json").write_text((PROC / "land.json").read_text())
A.round(4).to_csv(PROC / "annual_table.csv")
print("\nwrote web/data/timeline.json, analysis.json, land.json")
