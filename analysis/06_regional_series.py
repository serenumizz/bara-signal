"""Regional monthly climate series for the Trend Lab (web/explore/regional.json).

MERRA-2 (NASA Giovanni / GES DISC): T2M air temperature, RH2M relative humidity and SPEED surface wind speed,
averaged over the study area by 01_fetch_data.py / 02_process.py (data/processed/drivers_monthly.csv), aligned to
the months of web/explore/data.json. These are NOT per-province series: the Trend Lab labels them "whole study area".
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
out = {"months": months, "t2m": col("T2M", 2), "rh": col("RH2M", 1), "wind": col("SPEED", 2),
       "note": "MERRA-2 via NASA Giovanni (T2M, RH2M, SPEED), whole study area; not per province"}
(root / "web/explore/regional.json").write_text(json.dumps(out, separators=(",", ":")))
print({k: (sum(v is not None for v in out[k]), len(out[k])) for k in ("t2m", "rh", "wind")}, (root / "web/explore/regional.json").stat().st_size, "bytes")
