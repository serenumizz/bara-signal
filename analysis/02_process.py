"""
Step 2 - Turn raw downloads into tidy analysis tables.

Outputs (data/processed/):
  fires_monthly.csv   year, month, region, n (Terra+Aqua), n_terra, frp_sum_MW
  fires_grid_annual.csv  year, i, j, n  (0.25 deg grid over Sumatra+Kalimantan study domain)
  drivers_monthly.csv year, month, PRECTOTCORR, GWETROOT, GWETTOP, T2M_MAX, RH2M, WS2M, AOD_55 (mean of hotspot points)
                      2000-2025 from POWER monthly, 2026 from POWER daily (near real time)
  indices_monthly.csv year, month, nino34_anom (CPC sstoi), oni (CPC), dmi (PSL HadISST)
  land.json           simplified coastline polygons for the study domain (Natural Earth 10m)
"""
from __future__ import annotations

import glob
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)

# Study domain (Sumatra + Kalimantan, Indonesia only because the FIRMS file is the Indonesia country subset)
LON0, LON1, LAT0, LAT1 = 95.0, 119.0, -6.5, 6.0
CELL = 0.25
REGIONS = {
    "Sumatra": (95.0, 106.6, -6.5, 6.0),      # incl. Bangka-Belitung
    "Kalimantan": (108.0, 119.0, -4.5, 4.5),  # Indonesian Borneo (Sulawesi starts east of ~119)
}


def region_of(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    r = np.full(lon.shape, "Other", dtype=object)
    for name, (a, b, c, d) in REGIONS.items():
        r[(lon >= a) & (lon < b) & (lat >= c) & (lat < d)] = name
    return r


def process_firms() -> None:
    monthly, grid = [], []
    for f in sorted(glob.glob(str(RAW / "firms" / "modis_*_Indonesia.csv"))):
        d = pd.read_csv(f)
        # keep presumed vegetation fires (type 0) with nominal/high confidence (>=30), standard FIRMS practice
        d = d[(d["type"] == 0) & (d["confidence"] >= 30)].copy()
        t = pd.to_datetime(d["acq_date"])
        d["year"], d["month"] = t.dt.year, t.dt.month
        d["region"] = region_of(d["longitude"].values, d["latitude"].values)
        d["terra"] = (d["satellite"] == "Terra").astype(int)
        g = d.groupby(["year", "month", "region"]).agg(
            n=("frp", "size"), n_terra=("terra", "sum"), frp_sum_MW=("frp", "sum")
        )
        monthly.append(g.reset_index())

        dom = d[(d.longitude >= LON0) & (d.longitude < LON1) & (d.latitude >= LAT0) & (d.latitude < LAT1)]
        i = ((dom.longitude - LON0) / CELL).astype(int)
        j = ((dom.latitude - LAT0) / CELL).astype(int)
        gg = pd.DataFrame({"year": dom.year, "i": i, "j": j}).groupby(["year", "i", "j"]).size()
        grid.append(gg.rename("n").reset_index())
        print(f"  {Path(f).name}: {len(d):>7} vegetation fire detections")

    m = pd.concat(monthly)
    # make the table complete (months with zero fires)
    idx = pd.MultiIndex.from_product(
        [range(2000, 2026), range(1, 13), ["Sumatra", "Kalimantan", "Other"]], names=["year", "month", "region"]
    )
    m = m.set_index(["year", "month", "region"]).reindex(idx, fill_value=0).reset_index()
    m = m[~((m.year == 2000) & (m.month < 11))]  # Terra fire record starts Nov 2000
    m.to_csv(OUT / "fires_monthly.csv", index=False)
    pd.concat(grid).to_csv(OUT / "fires_grid_annual.csv", index=False)


def read_power_monthly(path: Path) -> pd.DataFrame:
    p = json.loads(path.read_text())["properties"]["parameter"]
    rows = {}
    for par, series in p.items():
        for k, v in series.items():
            y, mo = int(k[:4]), int(k[4:])
            if mo == 13:  # annual value
                continue
            rows.setdefault((y, mo), {})[par] = np.nan if v == -999 else v
    df = pd.DataFrame.from_dict(rows, orient="index")
    df.index = pd.MultiIndex.from_tuples(df.index, names=["year", "month"])
    return df


def read_power_daily_as_monthly(path: Path) -> pd.DataFrame:
    p = json.loads(path.read_text())["properties"]["parameter"]
    df = pd.DataFrame(p)
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    df = df.replace(-999.0, np.nan)
    g = df.groupby([df.index.year, df.index.month])
    mean = g.mean()
    # only keep monthly means backed by >= 20 valid days
    mean = mean.where(g.count() >= 20)
    mean.index.names = ["year", "month"]
    return mean


def process_power() -> None:
    pts = json.loads((RAW / "power" / "_points.json").read_text())
    frames = []
    for lon, lat, name in pts:
        a = read_power_monthly(RAW / "power" / f"{name}.json")
        b = read_power_daily_as_monthly(RAW / "current" / f"power_daily_2026_{name}.json")
        df = pd.concat([a, b])
        df["point"] = name
        df["island"] = "Sumatra" if lon < 107 else "Kalimantan"
        frames.append(df.reset_index())
    allp = pd.concat(frames)
    allp.to_csv(OUT / "drivers_monthly_points.csv", index=False)
    params = ["PRECTOTCORR", "GWETROOT", "GWETTOP", "T2M_MAX", "RH2M", "WS2M", "AOD_55"]
    allp.groupby(["year", "month"])[params].mean().reset_index().to_csv(OUT / "drivers_monthly.csv", index=False)


def process_indices() -> None:
    # CPC sstoi: YR MON NINO1+2 ANOM NINO3 ANOM NINO4 ANOM NINO3.4 ANOM
    s = pd.read_csv(RAW / "climate" / "sstoi.indices", sep=r"\s+")
    s = s.rename(columns={"YR": "year", "MON": "month"})
    s["nino34_anom"] = s.iloc[:, -1]
    s = s[["year", "month", "nino34_anom"]]

    # CPC ONI: SEAS YR TOTAL ANOM ; map 3-month season to its centre month
    o = pd.read_csv(RAW / "climate" / "oni.ascii.txt", sep=r"\s+")
    seas = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
    o["month"] = o["SEAS"].map({k: i + 1 for i, k in enumerate(seas)})
    o = o.rename(columns={"YR": "year", "ANOM": "oni"})[["year", "month", "oni"]]

    # PSL DMI (HadISST): first line = year range, then year + 12 values, footer text
    rows = []
    for line in (RAW / "climate" / "dmi.had.long.data").read_text().splitlines()[1:]:
        parts = line.split()
        if len(parts) == 13 and parts[0].isdigit():
            for mo, v in enumerate(parts[1:], start=1):
                v = float(v)
                rows.append((int(parts[0]), mo, np.nan if v < -99 else v))
    dmi = pd.DataFrame(rows, columns=["year", "month", "dmi"])

    ix = o.merge(s, on=["year", "month"], how="outer").merge(dmi, on=["year", "month"], how="outer")
    ix = ix[ix.year >= 1950].sort_values(["year", "month"])
    ix.to_csv(OUT / "indices_monthly.csv", index=False)


def process_land() -> None:
    from shapely.geometry import box, mapping, shape

    dom = box(LON0 - 1, LAT0 - 1, LON1 + 1, LAT1 + 1)
    gj = json.loads((RAW / "geo" / "ne_10m_land.geojson").read_text())
    polys = []
    for f in gj["features"]:
        g = shape(f["geometry"])
        if not g.intersects(dom):
            continue
        g = g.intersection(dom).simplify(0.02, preserve_topology=True)
        geoms = getattr(g, "geoms", [g])
        for p in geoms:
            if p.geom_type != "Polygon" or p.area < 0.01:
                continue
            ring = [[round(x, 3), round(y, 3)] for x, y in p.exterior.coords]
            polys.append(ring)
    (OUT / "land.json").write_text(json.dumps(polys, separators=(",", ":")))
    print(f"  land polygons: {len(polys)}")


if __name__ == "__main__":
    print("FIRMS"); process_firms()
    print("POWER"); process_power()
    print("Indices"); process_indices()
    print("Land"); process_land()
