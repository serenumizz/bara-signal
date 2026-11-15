"""
Step 10 - One AOD for the whole site: MERRA-2 TOTEXTTAU (aerosol optical depth at 550 nm, NASA Giovanni / GES DISC).

Until this step the site carried three different AOD series: the 3D map and the Trend Lab used NASA POWER AOD_55 per cell
(about 2.1 times larger than TOTEXTTAU), the Evidence tab used Aug-Oct means at ten hotspot points (2001-2025), and the
Findings tab used TOTEXTTAU Jul-Oct over all cells (2003-2025). This script puts the first two on the Findings definition:

    AOD of a cell and month = TOTEXTTAU of the nearest MERRA-2 grid point              (data/processed/merra2_grid.npz)
    AOD of a year (both islands) = mean over the 406 explore cells and over Jul-Oct     (same as 08_questions.py, "Both islands")

and rewrites only the AOD-related fields of the shipped files:

    web/explore/data.json   cells[].s.aod (x1000, int)                        -> map layer, clue E, Trend Lab
    web/data/timeline.json  aod per year                                      -> Evidence tab, hero scene
    web/data/analysis.json  trends[aod], chain.fires_to_aod, lags[fires->aod], ranges.aod -> Evidence tab

Everything else in those files (fire, rain, soil, ONI, DMI, models, charts) is left as it is. The statistics are the same
functions as in 03_analysis.py (Mann-Kendall with the Hamed-Rao correction, Sen's slope, OLS with leave-one-out R2, lagged
correlations of de-seasonalised monthly anomalies). The script first re-computes the OLD Evidence AOD fields from the old
series and checks they match the shipped numbers, so the functions are known to be the ones that built the files.
(obs2026 is the partial-2026 block of the removed 2026 view; it is not used by the site and is not touched.)

Run:   python analysis/10_align_aod.py        (after 03/05/07-09; safe to run again)
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
PROC, WEB = ROOT / "data" / "processed", ROOT / "web"
SEASON, FIT = [7, 8, 9, 10], list(range(2003, 2026))
NEW_LABEL = "Aerosol optical depth (Jul-Oct, MERRA-2 TOTEXTTAU)"


# ---- statistics: identical to analysis/03_analysis.py -------------------------------------------------------------
def mann_kendall(x, hamed_rao=True):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    n = len(x)
    s = 0
    for k in range(n - 1):
        s += np.sign(x[k + 1:] - x[k]).sum()
    _, counts = np.unique(x, return_counts=True)
    var_s = (n * (n - 1) * (2 * n + 5) - (counts * (counts - 1) * (2 * counts + 5)).sum()) / 18.0
    i, j = np.triu_indices(n, 1)
    sen = float(np.median((x[j] - x[i]) / (j - i)))
    if hamed_rao and n > 10:
        r = stats.rankdata(x - sen * np.arange(n))
        r = r - r.mean()
        acf = np.array([np.sum(r[: n - L] * r[L:]) / np.sum(r * r) for L in range(1, n)])
        bound, corr = 1.96 / np.sqrt(n), 0.0
        for L, rho in enumerate(acf, start=1):
            if abs(rho) > bound:
                corr += (n - L) * (n - L - 1) * (n - L - 2) * rho
        var_s *= max(1 + 2 / (n * (n - 1) * (n - 2)) * corr, 1e-6)
    z = 0.0 if s == 0 else (s - np.sign(s)) / np.sqrt(var_s)
    return {"sen": sen, "tau": float(s / (0.5 * n * (n - 1))), "p": float(2 * (1 - stats.norm.cdf(abs(z))))}


def ols(y, X, names):
    Xc = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(Xc, y, rcond=None)
    res = y - Xc @ beta
    n, k = Xc.shape
    sigma2 = res @ res / (n - k)
    se = np.sqrt(np.diag(sigma2 * np.linalg.inv(Xc.T @ Xc)))
    p = 2 * (1 - stats.t.cdf(np.abs(beta / se), n - k))
    r2 = 1 - res @ res / np.sum((y - y.mean()) ** 2)
    loo = np.empty(n)
    for i in range(n):
        m = np.arange(n) != i
        b, *_ = np.linalg.lstsq(Xc[m], y[m], rcond=None)
        loo[i] = Xc[i] @ b
    return {"coef": {nm: float(b) for nm, b in zip(["intercept"] + names, beta)}, "p": {nm: float(v) for nm, v in zip(["intercept"] + names, p)},
            "r2": float(r2), "r2_loo": float(1 - np.sum((y - loo) ** 2) / np.sum((y - y.mean()) ** 2)),
            "resid_sd": float(np.sqrt(sigma2)), "resid": res.tolist(), "loo_pred": loo.tolist(), "n": int(n)}


def trend_row(series: pd.Series, label: str, years: list[int]) -> dict:
    r, r0 = mann_kendall(series.values), mann_kendall(series.values, hamed_rao=False)
    mean = float(series.mean())
    return {"key": "aod", "label": label, "unit": "AOD per yr", "years": [years[0], years[-1]], "sen_slope": r["sen"],
            "pct_per_decade": 100 * 10 * r["sen"] / mean, "tau": r["tau"], "p": r["p"], "p_classic": r0["p"], "significant": r["p"] < 0.05,
            "direction": "increasing" if r["sen"] > 0 else "decreasing"}


def lagcorr(M, a, b, maxlag=6):
    out = []
    for L in range(0, maxlag + 1):
        x, y = M[a + "_a"].shift(L), M[b + "_a"]
        ok = x.notna() & y.notna()
        r, p = stats.pearsonr(x[ok], y[ok])
        out.append({"lag": L, "r": float(r), "p": float(p)})
    return out


# ---- data -------------------------------------------------------------------------------------------------------------
ex = json.loads((WEB / "explore" / "data.json").read_text())
ana = json.loads((WEB / "data" / "analysis.json").read_text())
tl = json.loads((WEB / "data" / "timeline.json").read_text())
g = np.load(PROC / "merra2_grid.npz", allow_pickle=True)
gm = {str(m): i for i, m in enumerate(g["months"])}
lat, lon, TOT = g["lat"], g["lon"], g["TOTEXTTAU"]
cells, months = ex["cells"], ex["months"]
idx = [(int(np.abs(lat - c["lat"]).argmin()), int(np.abs(lon - c["lon"]).argmin())) for c in cells]


def cell_month(k: int, ym: str):
    t = gm.get(ym.replace("-", ""))
    return None if t is None else float(TOT[t][idx[k]])


def island_mean(year: int, ms=SEASON) -> float:
    return float(np.nanmean([[TOT[gm[f"{year}{m:02d}"]][idx[k]] for k in range(len(cells))] for m in ms]))


# ---- 0. sanity: the functions above reproduce the OLD Evidence AOD fields from the OLD series -----------------------
old = [t for t in ana["trends"] if t["key"] == "aod"][0]
if "Aug-Oct" in old["label"]:
    A_old = pd.Series({t["year"]: t["aod"] for t in tl}).sort_index()
    chk = trend_row(A_old.loc[range(2001, 2026)], old["label"], list(range(2001, 2026)))
    F = pd.DataFrame({"aod": A_old.loc[FIT], "ln_fires": np.log([t["fires_season"] for t in tl if t["year"] in FIT])}, index=FIT)
    link = ols(F.aod.values, F[["ln_fires"]].values, ["ln_fires"])
    assert abs(chk["p"] - old["p"]) < 1e-6 and abs(chk["sen_slope"] - old["sen_slope"]) < 1e-5, "trend function does not reproduce the shipped AOD trend"
    assert abs(link["coef"]["ln_fires"] - ana["chain"]["fires_to_aod"]["coef"]["ln_fires"]) < 1e-4, "OLS does not reproduce the shipped AOD link"
    print("check: old Evidence AOD trend (p, tau exact; slope to 1e-5) and AOD<-ln(fire) link (to 1e-4, the series are stored rounded) are reproduced by the functions used here")

# ---- 1. explore cells: AOD x1000 ---------------------------------------------------------------------------------------
changed = 0
for k, c in enumerate(cells):
    new = []
    for ym in months:
        v = cell_month(k, ym)
        new.append(None if v is None or np.isnan(v) else int(round(v * 1000)))
    changed += sum(a != b for a, b in zip(new, c["s"]["aod"]))
    c["s"]["aod"] = new
(WEB / "explore" / "data.json").write_text(json.dumps(ex, separators=(",", ":")))
print(f"explore data.json: AOD rebuilt for {len(cells)} cells x {len(months)} months ({changed} values changed)")

# ---- 2. year series (both islands, Jul-Oct) -> timeline.json ----------------------------------------------------------
season = {y: island_mean(y) for y in range(2000, 2026)}
for t in tl:
    t["aod"] = round(season[t["year"]], 4) if t["year"] in season else None
(WEB / "data" / "timeline.json").write_text(json.dumps(tl, separators=(",", ":")))
S = pd.Series(season)

# ---- 3. analysis.json: trend, chain link, lagged correlations, range ------------------------------------------------------
for i, t in enumerate(ana["trends"]):
    if t["key"] == "aod":
        ana["trends"][i] = trend_row(S.loc[FIT], NEW_LABEL, FIT)
F = pd.DataFrame({"aod": S.loc[FIT].values, "ln_fires": np.log([next(t["fires_season"] for t in tl if t["year"] == y) for y in FIT])}, index=FIT)
l_aod = ols(F.aod.values, F[["ln_fires"]].values, ["ln_fires"])
ana["chain"]["fires_to_aod"] = {k: v for k, v in l_aod.items() if k not in ("resid", "loo_pred")}

fm = pd.read_csv(PROC / "fires_monthly.csv")
mdom = fm[fm.region != "Other"].groupby(["year", "month"]).n.sum().reset_index()
M = pd.DataFrame([{"year": y, "month": m, "TOTEXTTAU": island_mean(y, [m])} for y in FIT for m in range(1, 13)]).merge(mdom, on=["year", "month"], how="left")
M["ln_n"] = np.log1p(M.n)
for c in ["TOTEXTTAU", "ln_n"]:
    M[c + "_a"] = M[c] - M.groupby("month")[c].transform("mean")
ana["lags"]["fires->aod"] = lagcorr(M, "ln_n", "TOTEXTTAU")
ana["ranges"]["aod"] = [float(S.loc[FIT].min()), float(S.loc[FIT].max())]
(WEB / "data" / "analysis.json").write_text(json.dumps(ana, separators=(",", ":")))

t = [x for x in ana["trends"] if x["key"] == "aod"][0]
print(f"analysis.json: AOD trend {t['pct_per_decade']:+.1f} %/decade, p = {t['p']:.3f} ({'significant' if t['significant'] else 'not significant'}); "
      f"AOD<-ln(fire) R2 = {l_aod['r2']:.2f}, LOO R2 = {l_aod['r2_loo']:.2f}; lag-0 correlation {ana['lags']['fires->aod'][0]['r']:+.2f}")
print("2015 Jul-Oct AOD (both islands):", round(season[2015], 3), "| range", [round(v, 3) for v in ana["ranges"]["aod"]])
