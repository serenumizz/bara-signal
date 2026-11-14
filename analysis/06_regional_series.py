"""Regional monthly climate series for the Trend Lab (web/explore/regional.json).

NASA POWER (MERRA-2) daily maximum air temperature, relative humidity and wind speed, averaged over the
peat-dome hotspot points used by the analysis, aligned to the 286 months of web/explore/data.json (2003-01 ...).
These are NOT per-province series: the Trend Lab labels them "whole study area".
"""
import csv, json, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
months = json.load(open(root / "web/explore/data.json"))["months"]
rows = {}
for r in csv.DictReader(open(root / "data/processed/drivers_monthly.csv")):
    rows[f"{int(r['year'])}-{int(r['month']):02d}"] = r
def col(name, nd):
    out = []
    for m in months:
        v = rows.get(m, {}).get(name, "")
        out.append(round(float(v), nd) if v not in ("", None) else None)
    return out
out = {"months": months, "tmax": col("T2M_MAX", 2), "rh": col("RH2M", 1), "wind": col("WS2M", 2),
       "note": "NASA POWER (MERRA-2) averaged over the peat-dome hotspot points; not per province"}
(root / "web/explore/regional.json").write_text(json.dumps(out, separators=(",", ":")))
print({k: (sum(v is not None for v in out[k]), len(out[k])) for k in ("tmax", "rh", "wind")}, (root / "web/explore/regional.json").stat().st_size, "bytes")
