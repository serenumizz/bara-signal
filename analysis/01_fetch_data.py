"""
Step 1 - Pull the data, using ONLY sources from the NASA Space Apps 2026 challenge Resources tab
(https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/?tab=resources):

  AppEEARS (NASA LP DAAC)
    * MOD14A2.061 / MYD14A2.061  MODIS Terra/Aqua Thermal Anomalies & Fire, 8-day, 1 km  -> fire pixels
    * MOD44B.061                 MODIS Vegetation Continuous Fields, yearly, 250 m        -> % tree cover
    * MOD44W.061                 MODIS Land/Water mask, 250 m                              -> coastlines, islands
    * SRTMGL3_NC.003             NASA SRTM elevation, 90 m                                 -> terrain
  Giovanni (NASA GES DISC)
    * MERRA-2 monthly: PRECTOTCORR (rain), GWETROOT/GWETTOP (soil wetness), TOTEXTTAU (aerosol optical depth),
      T2M / QV2M / PS (air temperature, humidity), SPEED (surface wind). Giovanni tells us which archive files it reads;
      we fetch only the Sumatra-Borneo box from each of those files.
  KNMI Climate Explorer
    * Nino3.4 SST anomaly (NOAA ERSSTv5) and Dipole Mode Index (NOAA ERSSTv5), monthly since 1854
    * daily Nino3.4 (NOAA OISST v2.1), only to extend Nino3.4 past the last ERSSTv5 month

Login: NASA Earthdata account in ~/.netrc (never printed or stored in this project).

Run:
  python analysis/01_fetch_data.py submit     # 1. send the AppEEARS requests (NASA prepares them, can take hours)
  python analysis/01_fetch_data.py indices    # 2. KNMI ocean indices          (seconds)
  python analysis/01_fetch_data.py merra2     # 3. Giovanni / MERRA-2 monthly  (~20 min)
  python analysis/01_fetch_data.py appeears   # 4. wait for + download AppEEARS results
"""
from __future__ import annotations

import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from earthdata import KNMI, AppEEARS, get_bytes, giovanni_data_urls, load_json, public_session, session

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

TODAY = time.strftime("%m-%d-%Y")
# fire/forest domain: Sumatra + Borneo (0.5 deg cell grid of the explorer: lon 95..119.5, lat -6..7)
FIRE_BOX = (95.0, 119.5, -6.5, 7.5)
# map/terrain domain of the 3D scenes
MAP_BOX = (94.4, 119.8, -8.4, 7.5)

APPEEARS_TASKS = {
    # name: (layers, start, end, bbox)
    **{f"fire_terra_{a}_{b}": ([("MOD14A2.061", "FireMask")], f"11-01-{a}", f"12-31-{b}" if b < 2026 else TODAY, FIRE_BOX)
       for a, b in [(2000, 2006), (2007, 2013), (2014, 2020), (2021, 2026)]},
    **{f"fire_aqua_{a}_{b}": ([("MYD14A2.061", "FireMask")], f"07-01-{a}", f"12-31-{b}" if b < 2026 else TODAY, FIRE_BOX)
       for a, b in [(2002, 2008), (2009, 2015), (2016, 2021), (2022, 2026)]},
    "treecover": ([("MOD44B.061", "Percent_Tree_Cover")], "01-01-2000", "12-31-2025", FIRE_BOX),
    "water": ([("MOD44W.061", "water_mask")], "01-01-2020", "12-31-2020", MAP_BOX),
    "dem": ([("SRTMGL3_NC.003", "SRTMGL3_DEM")], "02-11-2000", "02-21-2000", MAP_BOX),
}

# ----------------------------------------------------------------------------- MERRA-2 via Giovanni
# MERRA-2 grid: lat -90..90 step 0.5 (361), lon -180..179.375 step 0.625 (576)
LAT_I = (162, 196)   # -9.0 .. 8.0
LON_I = (439, 481)   # 94.375 .. 120.625
MERRA = {
    # collection: (Giovanni variable id used to look up the files, variables we read from each file)
    "flx": ("M2TMNXFLX_5_12_4_PRECTOTCORR", ["PRECTOTCORR", "SPEED"]),
    "lnd": ("M2TMNXLND_5_12_4_GWETROOT", ["GWETROOT", "GWETTOP"]),
    "aer": ("M2TMNXAER_5_12_4_TOTEXTTAU", ["TOTEXTTAU"]),
    "slv": ("M2TMNXSLV_5_12_4_T2M", ["T2M", "QV2M", "PS"]),
}


def fetch_indices() -> None:
    out = RAW / "knmi"
    out.mkdir(parents=True, exist_ok=True)
    s = public_session()  # KNMI needs no login: no credentials are ever sent there
    # monthly ERSSTv5 Nino3.4 + DMI since 1854, and the daily OISST Nino3.4 (fills the latest months)
    for f in ["iersst_nino3.4a.dat", "idmi_ersst.dat", "inino34_daily.dat"]:
        (out / f).write_bytes(get_bytes(s, f"{KNMI}/{f}"))
        print(f"  KNMI {f}")


def fetch_merra2() -> None:
    s = session()
    bbox = "94.375,-9,120.625,8"
    for coll, (gvar, variables) in MERRA.items():
        out = RAW / "merra2" / coll
        out.mkdir(parents=True, exist_ok=True)
        urls = giovanni_data_urls(s, gvar, "2000-01-01T00:00:00Z", time.strftime("%Y-%m-%dT00:00:00Z"), bbox)
        (out / "_giovanni_files.txt").write_text("\n".join(urls))
        print(f"  Giovanni lists {len(urls)} monthly files for {gvar}")
        a, b = LAT_I
        c, d = LON_I
        ce = ";".join([f"/{v}[0:0][{a}:{b}][{c}:{d}]" for v in variables] + [f"/lat[{a}:{b}]", f"/lon[{c}:{d}]", "/time[0:0]"])

        def one(u: str) -> None:
            ym = re.search(r"\.(\d{6})\.nc4", u).group(1)
            u = u[: u.index(".nc4") + 4] + ".dap.nc4"  # DAP4 netCDF-4 response of the same granule
            dest = out / f"{ym}.nc4"
            if dest.exists() and dest.stat().st_size > 1000:
                return
            for k in range(6):
                b_ = get_bytes(s, f"{u}?dap4.ce={ce}")
                if b_.startswith(b"\x89HDF"):
                    dest.write_bytes(b_)
                    return
                time.sleep(5 * (k + 1))   # login page instead of data: wait and retry
            raise RuntimeError(f"not netCDF after retries: {u}")

        one(urls[0])  # log in once before going parallel
        with ThreadPoolExecutor(4) as ex:
            list(ex.map(one, urls))
        print(f"  {coll}: {len(list(out.glob('*.nc4')))} months on disk")


def submit_appeears() -> None:
    out = RAW / "appeears"
    out.mkdir(parents=True, exist_ok=True)
    reg = out / "tasks.json"
    tasks = load_json(reg, {})
    a = AppEEARS()
    for name, (layers, start, end, bbox) in APPEEARS_TASKS.items():
        if name in tasks:
            print(f"  already submitted {name}")
            continue
        tasks[name] = a.submit(f"ember-signal {name}", layers, start, end, bbox)
        reg.write_text(__import__("json").dumps(tasks, indent=1))
        print(f"  submitted {name}")


def download_appeears(wait: bool = True) -> None:
    out = RAW / "appeears"
    tasks = load_json(out / "tasks.json", {})
    a = AppEEARS()
    pending = dict(tasks)
    while pending:
        for name, tid in list(pending.items()):
            st = a.status(tid)
            if st == "done":
                d = out / name
                d.mkdir(exist_ok=True)
                for f in a.files(tid):
                    if f["file_name"].endswith((".nc", ".nc4", ".tif", ".csv", ".json")):
                        a.download(tid, f, d / Path(f["file_name"]).name)
                print(f"  downloaded {name}")
                pending.pop(name)
            elif st in ("error", "expired", "deleted"):
                print(f"  !! {name}: {st}")
                pending.pop(name)
        if pending:
            print(f"  waiting for {len(pending)} AppEEARS tasks: {sorted(pending)}  ({time.strftime('%H:%M')})")
            if not wait:
                return
            time.sleep(300)
            a = AppEEARS()  # fresh token for long waits


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("submit", "all"):
        submit_appeears()
    if step in ("indices", "all"):
        fetch_indices()
    if step in ("merra2", "all"):
        fetch_merra2()
    if step in ("appeears", "all"):
        download_appeears(wait=True)
    if step == "status":
        download_appeears(wait=False)
