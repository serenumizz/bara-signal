"""
Step 8 - The two questions of the judging one-pager, answered per island (web/data/questions.json).

  Q1  How have fire hotspots, AOD at 550 nm and surface PM2.5 changed across Sumatra and Kalimantan, 2003-2025,
      and are the trends statistically significant?
  Q2  Do seasons with more fire hotspots coincide with higher AOD and surface PM2.5?

Inputs
  fire     NASA FIRMS MODIS detections per 0.5 deg cell and month   web/explore/data.json (cells[].s.fire)
  AOD      MERRA-2 TOTEXTTAU (aerosol optical depth, 550 nm)         data/processed/merra2_grid.npz   (NASA Giovanni)
  PM2.5    MERRA-2 aerosol components, see 07_pm25.py               data/processed/pm25_grid.npz     (NASA Giovanni)
Each explore cell is matched to the nearest MERRA-2 grid point (0.5 x 0.625 deg); an island's AOD / PM2.5 is the mean over
its land cells, its fire count the sum over its cells. One value per year: the Jul-Oct fire season (consistent definition,
23 complete seasons, no missing months).

Statistics
  trend         Sen's slope; Mann-Kendall test with the Hamed-Rao autocorrelation correction (pymannkendall)
  Q2            seasons ranked by fire count: the 8 highest vs the 8 lowest (Mann-Whitney U), Spearman rank correlation
                of fire with AOD and with PM2.5 over all 23 seasons
"""
import json, pathlib
import numpy as np
import scipy.stats as st
import pymannkendall as mk

ROOT = pathlib.Path(__file__).resolve().parents[1]
YEARS = list(range(2003, 2026))
SEASON = (7, 8, 9, 10)

ex = json.load(open(ROOT / "web/explore/data.json"))
months = ex["months"]                                  # '2003-01' ...
cells = ex["cells"]
aod_g = np.load(ROOT / "data/processed/merra2_grid.npz", allow_pickle=True)
pm_g = np.load(ROOT / "data/processed/pm25_grid.npz", allow_pickle=True)
gm = [str(m) for m in aod_g["months"]]
assert gm == [str(m) for m in pm_g["months"]]
lat, lon = aod_g["lat"], aod_g["lon"]
TOT, PM = aod_g["TOTEXTTAU"], pm_g["PM25"]

def nearest(c):
    return int(np.abs(lat - c["lat"]).argmin()), int(np.abs(lon - c["lon"]).argmin())
idx = [nearest(c) for c in cells]

def mon_idx(y, mo): return months.index(f"{y}-{mo:02d}")
def gmon_idx(y, mo): return gm.index(f"{y}{mo:02d}")

def island_series(sel):
    """season values per year for the cells in sel: (fire sum, aod mean, pm25 mean)"""
    fire, aod, pm = [], [], []
    for y in YEARS:
        fi = [mon_idx(y, m) for m in SEASON]; gi = [gmon_idx(y, m) for m in SEASON]
        fire.append(float(sum(cells[k]["s"]["fire"][i] for k in sel for i in fi)))
        a = np.nanmean([[TOT[g][idx[k]] for k in sel] for g in gi]); p = np.nanmean([[PM[g][idx[k]] for k in sel] for g in gi])
        aod.append(float(a)); pm.append(float(p))
    return {"fire": fire, "aod": aod, "pm25": pm}

def monthly_series(sel):
    """all 276 months 2003-2025 (fire sum, AOD mean, PM2.5 mean) for the seasonal Mann-Kendall robustness check"""
    mi = [months.index(f"{y}-{m:02d}") for y in YEARS for m in range(1, 13)]
    gi = [gm.index(f"{y}{m:02d}") for y in YEARS for m in range(1, 13)]
    return {"fire": [float(sum(cells[k]["s"]["fire"][i] for k in sel)) for i in mi],
            "aod": [float(np.nanmean([TOT[g][idx[k]] for k in sel])) for g in gi],
            "pm25": [float(np.nanmean([PM[g][idx[k]] for k in sel])) for g in gi]}

def trend(v):
    v = np.asarray(v, float); x = np.arange(len(v))
    h = mk.hamed_rao_modification_test(v); plain = mk.original_test(v)
    mean = float(v.mean())
    return {"sen_per_year": float(h.slope), "pct_per_decade": float(h.slope * 10 / mean * 100) if mean else None, "mean": mean,
            "p_adjusted": float(h.p), "z_adjusted": float(h.z), "p_plain": float(plain.p), "tau": float(h.Tau),
            "direction": "up" if h.slope > 0 else "down" if h.slope < 0 else "flat",
            "significant": bool(h.p < 0.05)}

def compare(s):
    fire = np.asarray(s["fire"]); order = np.argsort(fire); k = 8
    low, high = [int(i) for i in order[:k]], [int(i) for i in order[-k:]]
    out = {"k": k, "high_years": sorted(YEARS[i] for i in high), "low_years": sorted(YEARS[i] for i in low)}
    for v in ("aod", "pm25"):
        a = np.asarray(s[v]); hi, lo = a[high], a[low]
        u = st.mannwhitneyu(hi, lo, alternative="two-sided")
        rho = st.spearmanr(fire, a)
        out[v] = {"high_mean": float(hi.mean()), "low_mean": float(lo.mean()), "ratio": float(hi.mean() / lo.mean()),
                  "mannwhitney_p": float(u.pvalue), "spearman_rho": float(rho.statistic), "spearman_p": float(rho.pvalue)}
    return out

areas = {"Sumatra": [i for i, c in enumerate(cells) if c["island"] == "Sumatra"],
         "Kalimantan": [i for i, c in enumerate(cells) if c["island"] == "Kalimantan"],
         "Both islands": list(range(len(cells)))}
out = {"years": YEARS, "season": "Jul-Oct", "areas": {}, "method": {
    "trend": "Sen's slope; Mann-Kendall with the Hamed-Rao autocorrelation correction (pymannkendall 1.4.3), one Jul-Oct value per year",
    "compare": "8 highest vs 8 lowest fire seasons, Mann-Whitney U; Spearman rank correlation over all seasons",
    "pm25": "DUSMASS25 + SSSMASS25 + BCSMASS + 1.4 OCSMASS + 1.375 SO4SMASS, MERRA-2 (ug/m3)",
    "sources": {"fire": "NASA FIRMS MODIS C6.1 (Terra + Aqua)", "aod": "MERRA-2 TOTEXTTAU, NASA Giovanni / GES DISC", "pm25": "MERRA-2 aerosol components, NASA Giovanni / GES DISC"}}}
for name, sel in areas.items():
    s = island_series(sel); ms = monthly_series(sel)
    tr = {v: trend(s[v]) for v in s}
    for v in s:   # robustness: seasonal Mann-Kendall (Hirsch-Slack, Hamed-Rao-adjusted not available) on all 276 monthly values
        r = mk.seasonal_test(np.asarray(ms[v]), period=12); tr[v]["p_seasonal_monthly"] = float(r.p); tr[v]["seasonal_monthly_trend"] = r.trend
    out["areas"][name] = {"n_cells": len(sel), "series": s, "trend": tr, "compare": compare(s)}
# data quality / coverage / missing observations
ok = [idx[k] for k in range(len(cells))]
dist = [float(max(abs(lat[i] - cells[k]["lat"]), abs(lon[j] - cells[k]["lon"]))) for k, (i, j) in enumerate(idx)]
gsel = [gmon_idx(y, m) for y in YEARS for m in range(1, 13)]
fire_all = np.array([[cells[k]["s"]["fire"][months.index(f"{y}-{m:02d}")] for y in YEARS for m in range(1, 13)] for k in range(len(cells))], float)
out["quality"] = {"months": len(gsel), "years": [YEARS[0], YEARS[-1]], "cells": len(cells),
    "fire_missing": int(np.isnan(fire_all).sum()), "aod_missing": int(np.isnan(TOT[gsel]).sum()), "pm25_missing": int(np.isnan(PM[gsel]).sum()),
    "grid_points": int(len(set(idx))), "max_offset_deg": round(max(dist), 2), "zero_fire_cell_months_pct": round(float((fire_all == 0).mean() * 100), 1),
    "seasons": len(YEARS)}
print("\nquality:", out["quality"])
(ROOT / "web/data/questions.json").write_text(json.dumps(out, separators=(",", ":")))
for name, a in out["areas"].items():
    print(f"\n== {name} ({a['n_cells']} cells)")
    for v, t in a["trend"].items():
        print(f"  {v:5s} {t['pct_per_decade']:+7.1f}%/decade  Sen {t['sen_per_year']:+.4g}/yr  p(HR) = {t['p_adjusted']:.3f}  p(plain) = {t['p_plain']:.3f}  {'significant' if t['significant'] else 'not significant'}")
    c = a["compare"]; print("  high-fire years:", c["high_years"]); print("  low-fire years: ", c["low_years"])
    for v in ("aod", "pm25"):
        x = c[v]; print(f"  {v:5s} high {x['high_mean']:.3g} vs low {x['low_mean']:.3g} (x{x['ratio']:.2f}, MWU p = {x['mannwhitney_p']:.4f}); Spearman rho = {x['spearman_rho']:.2f}, p = {x['spearman_p']:.4f}")
