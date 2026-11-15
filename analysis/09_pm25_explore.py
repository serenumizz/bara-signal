"""
Step 9 - Add MERRA-2 surface PM2.5 to the explore map data (web/explore/data.json, cells[].s.pm).

Each 0.5 deg explore cell gets the PM2.5 of its nearest MERRA-2 grid point (same matching as 08_questions.py),
stored as ug/m3 x 10 (integer), null where the month is not covered. Idempotent: re-running overwrites s.pm.
Input: data/processed/pm25_grid.npz (07_pm25.py).
"""
import json, pathlib
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "web/explore/data.json"
ex = json.load(open(P))
g = np.load(ROOT / "data/processed/pm25_grid.npz", allow_pickle=True)
gm = {str(m): i for i, m in enumerate(g["months"])}
lat, lon, PM = g["lat"], g["lon"], g["PM25"]
for c in ex["cells"]:
    i, j = int(np.abs(lat - c["lat"]).argmin()), int(np.abs(lon - c["lon"]).argmin())
    out = []
    for m in ex["months"]:
        k = gm.get(m.replace("-", ""))
        v = None if k is None else PM[k][i][j]
        out.append(None if v is None or not np.isfinite(v) else int(round(float(v) * 10)))
    c["s"]["pm"] = out
json.dump(ex, open(P, "w"), separators=(",", ":"))
vals = [v for c in ex["cells"] for v in c["s"]["pm"] if v is not None]
print("cells", len(ex["cells"]), "values", len(vals), "range ug/m3", min(vals) / 10, max(vals) / 10)
