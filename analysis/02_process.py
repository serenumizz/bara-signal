"""
Step 2 - Turn the raw downloads (step 1, Resources-tab sources only) into tidy analysis tables.

Outputs (data/processed/):
  islands.npz          0.01 deg land mask + island labels (Sumatra / Borneo) from MODIS MOD44W (AppEEARS)
  land.json            simplified coastline polygons, traced from the same MOD44W mask
  fires_monthly.csv    year, month, region (Sumatra / Borneo / Other), n (Terra+Aqua), n_terra, n_aqua
                       n = MODIS fire pixels (MOD14A2/MYD14A2 FireMask nominal+high confidence) per 8-day composite,
                       summed over the composites that start in that month
  fires_grid_monthly.csv  year, month, i, j, n_terra, n_aqua on a 0.25 deg grid (lon0 95, lat0 -6.5)
  fires_grid_annual.csv   year, i, j, n   (same grid, Terra+Aqua)
  fires_latest.json    fire pixels of the most recent 8-day composite (replaces the old 7-day FIRMS feed)
  drivers_monthly_points.csv / drivers_monthly.csv
                       MERRA-2 (Giovanni / GES DISC) at 10 peat-fire hotspot points:
                       PRECTOTCORR mm/day, GWETROOT, GWETTOP (0-1), T2M degC, RH2M % (from QV2M, T2M, PS),
                       SPEED m/s, TOTEXTTAU (aerosol optical depth at 550 nm)
  merra2_grid.npz      the same MERRA-2 variables on their native 0.5 x 0.625 deg grid, monthly (for step 5)
  indices_monthly.csv  year, month, nino34_anom, oni, dmi  (KNMI Climate Explorer, NOAA ERSSTv5;
                       Nino3.4 after the last ERSSTv5 month from KNMI's daily NOAA OISST series)
  treecover_cells.csv  year, i, j, tree_cover (% , MODIS MOD44B, mean over land) on the 0.5 deg explorer grid
  dem_006.npy          SRTM elevation (AppEEARS SRTMGL3) averaged to the 0.06 deg grid of the 3D scenes
"""
from __future__ import annotations

import glob
import json
import re
import warnings
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
import xarray as xr
from scipy import ndimage

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)

LON0, LAT0, CELL = 95.0, -6.5, 0.25          # fire grid (same origin as before)
MAP = (94.4, 119.8, -8.4, 7.5)                # land mask / terrain extent
MASK_RES = 0.01

# Hotspot sampling points (lon, lat, label) on the large peat domes of Riau, Jambi, South Sumatra,
# West/Central/South Kalimantan - unchanged from the original study design.
POINTS = [
    (101.5, 1.3, "Riau-Bengkalis"), (102.6, 0.3, "Riau-Pelalawan"), (103.8, -1.3, "Jambi-MuaroJambi"),
    (105.3, -3.0, "SumSel-OKI"), (104.6, -2.6, "SumSel-Banyuasin"), (109.6, -0.6, "KalBar-KubuRaya"),
    (113.9, -2.3, "KalTeng-Palangkaraya"), (114.4, -3.0, "KalTeng-Pulangpisau"), (112.6, -2.9, "KalTeng-Katingan"),
    (115.0, -3.0, "KalSel-Barito"),
]


# ----------------------------------------------------------------------------- AppEEARS netCDF helpers
def nc_files(task: str) -> list[str]:
    return sorted(glob.glob(str(RAW / "appeears" / task / "*.nc")))


def nc_layer(path: str, layer: str):
    """Open an AppEEARS netCDF-4 file lazily: returns (h5 dataset, lat, lon, dates)."""
    h = h5py.File(path, "r")
    name = next(k for k in h.keys() if k == layer or k.endswith(layer))
    lat, lon = h["lat"][:], h["lon"][:]
    dates = None
    if "time" in h:
        units = h["time"].attrs.get("units", b"days since 2000-01-01")
        units = units.decode() if isinstance(units, bytes) else units
        base = pd.Timestamp(re.search(r"since (\S+)", units).group(1)[:10])
        dates = base + pd.to_timedelta(h["time"][:], unit="D")
    return h, h[name], lat, lon, dates


# ----------------------------------------------------------------------------- land mask & islands (MOD44W)
def process_land() -> None:
    f = nc_files("water")[0]
    h, ds, lat, lon, _ = nc_layer(f, "water_mask")
    w = ds[0] if ds.ndim == 3 else ds[:]
    w = np.asarray(w).astype(np.float32)
    w[(w != 0) & (w != 1)] = np.nan          # 0 = land, 1 = water, others = fill
    land_fine = 1 - w
    # aggregate to 0.01 deg land fraction
    nx = int(round((MAP[1] - MAP[0]) / MASK_RES))
    ny = int(round((MAP[3] - MAP[2]) / MASK_RES))
    ix = np.clip(((lon - MAP[0]) / MASK_RES).astype(int), 0, nx - 1)
    iy = np.clip(((MAP[3] - lat) / MASK_RES).astype(int), 0, ny - 1)   # row 0 = north
    s = np.zeros((ny, nx)); c = np.zeros((ny, nx))
    for r in range(land_fine.shape[0]):
        row = land_fine[r]
        ok = ~np.isnan(row)
        np.add.at(s[iy[r]], ix[ok], row[ok])
        np.add.at(c[iy[r]], ix[ok], 1)
    frac = np.where(c > 0, s / np.maximum(c, 1), 0.0)
    h.close()
    land = frac >= 0.5

    lab, n = ndimage.label(land, structure=np.ones((3, 3)))
    sizes = ndimage.sum(land, lab, index=np.arange(1, n + 1))

    def comp_at(lo, la):
        return lab[int((MAP[3] - la) / MASK_RES), int((lo - MAP[0]) / MASK_RES)]

    big = {"Sumatra": comp_at(101.5, 0.5), "Borneo": comp_at(114.0, 0.0), "Malay Peninsula": comp_at(102.0, 4.0),
           "Java": comp_at(110.0, -7.3)}
    assert all(v > 0 for v in big.values()), big
    big_map = np.zeros_like(lab)
    for k, v in enumerate(big.values(), start=1):
        big_map[lab == v] = k
    # land cut by the east edge of the map is Sulawesi (5): never part of the study islands
    east = set(np.unique(lab[:, -1])) - {0, big["Borneo"]}
    big_map[np.isin(lab, list(east))] = 5
    # every other land component goes to the nearest big land mass (Bangka, Belitung, Riau islands -> Sumatra ...)
    _, (ri, ci) = ndimage.distance_transform_edt(big_map == 0, return_indices=True)
    region = np.where(land, big_map[ri, ci], 0).astype(np.int8)   # 1 Sumatra, 2 Borneo, 3 Peninsula, 4 Java, 5 Sulawesi
    np.savez_compressed(OUT / "islands.npz", frac=frac.astype(np.float32), region=region,
                        lon0=MAP[0], lat1=MAP[3], res=MASK_RES, names=np.array(["", *big.keys()]))
    print(f"  islands: Sumatra {int((region == 1).sum())} px, Borneo {int((region == 2).sum())} px (0.01 deg)")

    # coastlines: trace the 0.5 land-fraction contour, keep outer rings of land
    from shapely.geometry import Polygon
    from skimage import measure
    sm = ndimage.zoom(frac, 0.5, order=1)  # 0.02 deg
    res2 = MASK_RES * frac.shape[1] / sm.shape[1]
    polys = []
    for cont in measure.find_contours(np.pad(sm, 1), 0.5):
        y, x = cont[:, 0] - 1, cont[:, 1] - 1
        lons, lats = MAP[0] + (x + 0.5) * res2, MAP[3] - (y + 0.5) * res2
        if len(lons) < 4:
            continue
        p = Polygon(zip(lons, lats))
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty or p.area < 0.0005:
            continue
        rp = p.representative_point()
        if frac[min(int((MAP[3] - rp.y) / MASK_RES), frac.shape[0] - 1), min(int((rp.x - MAP[0]) / MASK_RES), frac.shape[1] - 1)] < 0.5:
            continue  # a lake, not land
        p = p.simplify(0.01, preserve_topology=True)
        for g in getattr(p, "geoms", [p]):
            if g.geom_type == "Polygon" and g.area > 0.0005:
                polys.append([[round(a, 3), round(b, 3)] for a, b in g.exterior.coords])
    (OUT / "land.json").write_text(json.dumps(polys, separators=(",", ":")))
    print(f"  land polygons: {len(polys)}")


def island_lookup():
    z = np.load(OUT / "islands.npz")
    reg, lon0, lat1, res = z["region"], float(z["lon0"]), float(z["lat1"]), float(z["res"])

    def f(lon, lat):
        i = np.clip(((lon - lon0) / res).astype(int), 0, reg.shape[1] - 1)
        j = np.clip(((lat1 - lat) / res).astype(int), 0, reg.shape[0] - 1)
        return reg[j, i]
    return f


# ----------------------------------------------------------------------------- fire (MOD14A2 / MYD14A2)
FIRE_MIN_CLASS = 8   # FireMask 8 = fire (nominal confidence), 9 = fire (high confidence)


def process_fires() -> None:
    reg_of = island_lookup()
    names = {1: "Sumatra", 2: "Borneo"}
    rows, grid_rows, latest = [], [], None
    for sensor, prefix in [("terra", "fire_terra"), ("aqua", "fire_aqua")]:
        for task_dir in sorted(glob.glob(str(RAW / "appeears" / f"{prefix}_*"))):
            for f in nc_files(Path(task_dir).name):
                h, ds, lat, lon, dates = nc_layer(f, "FireMask")
                LO, LA = np.meshgrid(lon, lat)
                region = reg_of(LO, LA)
                gi = np.floor((LO - LON0) / CELL).astype(int)
                gj = np.floor((LA - LAT0) / CELL).astype(int)
                for t, d in enumerate(dates):
                    fm = ds[t]
                    hit = fm >= FIRE_MIN_CLASS
                    hit &= fm <= 9
                    if not hit.any():
                        rows.append((d, sensor, "Sumatra", 0)); continue
                    r = region[hit]
                    for code, nm in names.items():
                        rows.append((d, sensor, nm, int((r == code).sum())))
                    rows.append((d, sensor, "Other", int(np.isin(r, [1, 2], invert=True).sum())))
                    keep = np.isin(r, [1, 2])
                    g = pd.DataFrame({"i": gi[hit][keep], "j": gj[hit][keep]}).value_counts().rename("n").reset_index()
                    g["date"], g["sensor"] = d, sensor
                    grid_rows.append(g)
                    if latest is None or d > latest[0]:
                        latest = (d, sensor, LO[hit][keep], LA[hit][keep])
                h.close()
                print(f"  {Path(f).name}: {len(dates)} composites {dates.min().date()} .. {dates.max().date()}")

    R = pd.DataFrame(rows, columns=["date", "sensor", "region", "n"])
    R["year"], R["month"] = R.date.dt.year, R.date.dt.month
    m = R.pivot_table(index=["year", "month", "region"], columns="sensor", values="n", aggfunc="sum", fill_value=0)
    idx = pd.MultiIndex.from_product([sorted(R.year.unique()), range(1, 13), ["Sumatra", "Borneo", "Other"]],
                                     names=["year", "month", "region"])
    m = m.reindex(idx, fill_value=0).reset_index()
    for c_ in ["terra", "aqua"]:
        if c_ not in m:
            m[c_] = 0
    m = m.rename(columns={"terra": "n_terra", "aqua": "n_aqua"})
    m["n"] = m.n_terra + m.n_aqua
    first = R.date.min()
    last = R.date.max()
    m = m[(pd.to_datetime(dict(year=m.year, month=m.month, day=1)) >= first.replace(day=1))
          & (pd.to_datetime(dict(year=m.year, month=m.month, day=1)) <= last)]
    m[["year", "month", "region", "n", "n_terra", "n_aqua"]].to_csv(OUT / "fires_monthly.csv", index=False)

    G = pd.concat(grid_rows)
    G["year"], G["month"] = G.date.dt.year, G.date.dt.month
    gm = G.pivot_table(index=["year", "month", "i", "j"], columns="sensor", values="n", aggfunc="sum", fill_value=0).reset_index()
    for c_ in ["terra", "aqua"]:
        if c_ not in gm:
            gm[c_] = 0
    gm = gm.rename(columns={"terra": "n_terra", "aqua": "n_aqua"})
    gm.to_csv(OUT / "fires_grid_monthly.csv", index=False)
    ga = gm.assign(n=gm.n_terra + gm.n_aqua).groupby(["year", "i", "j"]).n.sum().reset_index()
    ga.to_csv(OUT / "fires_grid_annual.csv", index=False)

    comp = R.groupby(["date", "sensor"]).size().reset_index()
    (OUT / "fires_meta.json").write_text(json.dumps({
        "first": str(first.date()), "last_composite_start": str(last.date()),
        "last_composite_end": str((last + pd.Timedelta(days=7)).date()),
        "n_composites": {s: int((comp.sensor == s).sum()) for s in ["terra", "aqua"]},
        "fire_classes": "MOD14A2/MYD14A2 FireMask 8 (nominal) and 9 (high confidence)",
    }, indent=1))
    d, s_, lo, la = latest
    (OUT / "fires_latest.json").write_text(json.dumps({
        "from": str(d.date()), "to": str((d + pd.Timedelta(days=7)).date()), "sensor": s_, "n": int(len(lo)),
        "points": [[round(float(a), 3), round(float(b), 3)] for a, b in zip(lo, la)]}, separators=(",", ":")))
    print(f"  fire pixels 2001-{last.year}: {int(m.n.sum())}; latest composite {d.date()} ({s_}): {len(lo)} pixels")


# ----------------------------------------------------------------------------- MERRA-2 (Giovanni / GES DISC)
def load_merra2():
    var_files = {"flx": ["PRECTOTCORR", "SPEED"], "lnd": ["GWETROOT", "GWETTOP"], "aer": ["TOTEXTTAU"], "slv": ["T2M", "QV2M", "PS"]}
    months = sorted({Path(p).stem for p in glob.glob(str(RAW / "merra2" / "flx" / "*.nc4"))})
    lat = lon = None
    data = {}
    for coll, vs in var_files.items():
        for v in vs:
            data[v] = np.full((len(months), 35, 43), np.nan, np.float32)
        for t, ym in enumerate(months):
            p = RAW / "merra2" / coll / f"{ym}.nc4"
            if not p.exists():
                continue
            with xr.open_dataset(p, engine="h5netcdf") as ds:
                if lat is None:
                    lat, lon = ds.lat.values, ds.lon.values
                for v in vs:
                    a = ds[v].values[0].astype(np.float32)
                    a[np.abs(a) > 1e14] = np.nan
                    data[v][t] = a
    data["PRECTOTCORR"] *= 86400.0            # kg m-2 s-1 -> mm/day
    tc = data["T2M"] - 273.15
    e = data["QV2M"] * data["PS"] / (0.622 + 0.378 * data["QV2M"]) / 100.0   # hPa
    es = 6.112 * np.exp(17.67 * tc / (tc + 243.5))
    data["RH2M"] = np.clip(100 * e / es, 0, 100)
    data["T2M"] = tc
    del data["QV2M"], data["PS"]
    return months, lat, lon, data


def process_merra2() -> None:
    months, lat, lon, data = load_merra2()
    np.savez_compressed(OUT / "merra2_grid.npz", months=np.array(months), lat=lat, lon=lon, **data)
    frames = []
    for lo, la, name in POINTS:
        i, j = int(np.argmin(np.abs(lon - lo))), int(np.argmin(np.abs(lat - la)))
        df = pd.DataFrame({k: v[:, j, i] for k, v in data.items()})
        df["year"] = [int(m[:4]) for m in months]
        df["month"] = [int(m[4:]) for m in months]
        df["point"], df["island"] = name, ("Sumatra" if lo < 107 else "Borneo")
        frames.append(df)
    allp = pd.concat(frames)
    allp.to_csv(OUT / "drivers_monthly_points.csv", index=False)
    params = ["PRECTOTCORR", "GWETROOT", "GWETTOP", "T2M", "RH2M", "SPEED", "TOTEXTTAU"]
    allp.groupby(["year", "month"])[params].mean().reset_index().to_csv(OUT / "drivers_monthly.csv", index=False)
    print(f"  MERRA-2 months: {months[0]} .. {months[-1]} ({len(months)})")


# ----------------------------------------------------------------------------- ocean indices (KNMI)
def _knmi_monthly(path: Path) -> pd.DataFrame:
    rows = []
    for line in path.read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split()
        if len(parts) == 2:                    # "1854.0833  -0.70"  (decimal year, value)
            x, v = float(parts[0]), float(parts[1])
            y = int(np.floor(x + 1e-6)); mo = int(round((x - y) * 12)) + 1
            rows.append((y, mo, v))
        elif len(parts) == 13:                 # "2025  v1 .. v12"
            y = int(parts[0])
            rows += [(y, mo, float(v)) for mo, v in enumerate(parts[1:], start=1)]
    df = pd.DataFrame(rows, columns=["year", "month", "v"])
    df.loc[df.v < -900, "v"] = np.nan
    return df


def process_indices() -> None:
    K = RAW / "knmi"
    n34 = _knmi_monthly(K / "iersst_nino3.4a.dat").rename(columns={"v": "nino34_anom"})
    dmi = _knmi_monthly(K / "idmi_ersst.dat").rename(columns={"v": "dmi"})
    # anomalies relative to 1991-2020 (the current WMO normal)
    clim = n34[(n34.year >= 1991) & (n34.year <= 2020)].groupby("month").nino34_anom.mean()
    n34["nino34_anom"] = n34.nino34_anom - n34.month.map(clim)
    n34["source"] = "ERSSTv5"
    # extend with KNMI daily NOAA OISST Nino3.4 (monthly means of >= 20 days), re-based to match ERSSTv5 over 1991-2020
    d = []
    for line in (K / "inino34_daily.dat").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        a, b = line.split()[:2]
        d.append((int(a[:4]), int(a[4:6]), float(b)))
    d = pd.DataFrame(d, columns=["year", "month", "v"])
    g = d.groupby(["year", "month"]).v
    oi = g.mean()[g.count() >= 20].rename("oi").reset_index()
    both = oi.merge(n34, on=["year", "month"])
    both = both[(both.year >= 1991) & (both.year <= 2020)]
    off = (both.oi - both.nino34_anom).groupby(both.month).mean()
    oi["oi"] = oi.oi - oi.month.map(off)
    last = n34.dropna(subset=["nino34_anom"]).iloc[-1]
    ext = oi[(oi.year * 12 + oi.month) > (last.year * 12 + last.month)].rename(columns={"oi": "nino34_anom"})
    ext["source"] = "OISST"
    n34 = pd.concat([n34.dropna(subset=["nino34_anom"]), ext]).sort_values(["year", "month"]).reset_index(drop=True)
    # ONI: 3-month running mean of Nino3.4, assigned to the centre month (CPC definition)
    n34["oni"] = n34.nino34_anom.rolling(3, center=True).mean()
    ix = n34.merge(dmi, on=["year", "month"], how="left")
    ix = ix[ix.year >= 1950][["year", "month", "nino34_anom", "oni", "dmi", "source"]]
    ix.to_csv(OUT / "indices_monthly.csv", index=False)
    lastrow = ix.iloc[-1]
    print(f"  indices 1950-01 .. {int(lastrow.year)}-{int(lastrow.month):02d}; Nino3.4 latest {lastrow.nino34_anom:+.2f} ({lastrow.source})")


# ----------------------------------------------------------------------------- tree cover (MOD44B) on the 0.5 deg explorer cells
def process_treecover() -> None:
    reg_of = island_lookup()
    rows = []
    for f in nc_files("treecover"):
        h, ds, lat, lon, dates = nc_layer(f, "Percent_Tree_Cover")
        LO, LA = np.meshgrid(lon, lat)
        study = np.isin(reg_of(LO, LA), [1, 2])
        ci = np.floor((LO - 95.0) / 0.5).astype(int)
        cj = np.floor((LA + 6.0) / 0.5).astype(int)
        key = (ci * 100 + cj)[study]
        for t, d in enumerate(dates):
            v = ds[t].astype(np.float32)[study]
            ok = v <= 100                     # 200 = water, 253 = fill
            s = pd.Series(v[ok]).groupby(key[ok]).mean()
            for k, val in s.items():
                rows.append((d.year, int(k // 100), int(k % 100), round(float(val), 2)))
            print(f"  tree cover {d.year}: {len(s)} cells")
        h.close()
    pd.DataFrame(rows, columns=["year", "i", "j", "tree_cover"]).to_csv(OUT / "treecover_cells.csv", index=False)


# ----------------------------------------------------------------------------- terrain (SRTMGL3)
def process_dem() -> None:
    LON0_, LON1_, LAT0_, LAT1_, RES = 94.4, 119.8, -8.4, 7.4, 0.06
    NX, NY = round((LON1_ - LON0_) / RES) + 1, round((LAT1_ - LAT0_) / RES) + 1
    s = np.zeros((NY, NX)); c = np.zeros((NY, NX))
    for f in nc_files("dem"):
        h, ds, lat, lon, _ = nc_layer(f, "SRTMGL3_DEM")
        ix = np.round((lon - LON0_) / RES).astype(int)
        okx = (ix >= 0) & (ix < NX)
        for r0 in range(0, len(lat), 600):
            blk = np.asarray(ds[0, r0:r0 + 600] if ds.ndim == 3 else ds[r0:r0 + 600]).astype(np.float32)
            iy = np.round((LAT1_ - lat[r0:r0 + 600]) / RES).astype(int)
            for k in range(blk.shape[0]):
                if not 0 <= iy[k] < NY:
                    continue
                row = blk[k][okx]
                good = (row > -1000) & (row < 9000)
                np.add.at(s[iy[k]], ix[okx][good], row[good])
                np.add.at(c[iy[k]], ix[okx][good], 1)
        h.close()
    dem = np.where(c > 0, s / np.maximum(c, 1), 0.0)       # ocean (no SRTM data) = 0 m
    np.save(OUT / "dem_006.npy", np.clip(np.round(dem), -500, 6000).astype("<i2"))
    print(f"  DEM {NX}x{NY} at {RES} deg, max {dem.max():.0f} m")


if __name__ == "__main__":
    import sys
    steps = sys.argv[1:] or ["indices", "merra2", "land", "fires", "treecover", "dem"]
    for st in steps:
        print(st.upper())
        {"indices": process_indices, "merra2": process_merra2, "land": process_land, "fires": process_fires,
         "treecover": process_treecover, "dem": process_dem}[st]()
