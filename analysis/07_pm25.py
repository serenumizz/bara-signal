"""
Step 7 - Surface PM2.5 from MERRA-2 aerosol components (what the judging one-pager asks for).

MERRA-2 M2TMNXAER (monthly, 0.5 x 0.625 deg), NASA GES DISC, read through the same granules and the same Giovanni file list as
01_fetch_data.py. Surface PM2.5 is not a MERRA-2 variable; it is derived from the aerosol mass components (kg m-3), following the NASA GMAO
MERRA-2 FAQ ("How do I obtain surface PM2.5 concentration in MERRA-2?", tavg1_2d_aer_Nx):

    PM2.5 = DUSMASS25 + OCSMASS + BCSMASS + SSSMASS25 + SO4SMASS * (132.14 / 96.06)      (ug m-3 after x 1e9)

No factor is applied to OCSMASS (the FAQ states that, unlike MERRAero, the organic-carbon to organic-matter conversion is
already handled in the model); SO4SMASS is the sulfate ion and is scaled by 132.14/96.06 (= 1.3756, ammonium sulfate). The
equation has no nitrate term because MERRA-2 does not include nitrate aerosol.
Earlier builds of this project used OCSMASS x 1.4 and SO4SMASS x 1.375 (Buchard et al. 2016 style); that raised PM2.5 by
17-22 % and is no longer used. OM_OC below is kept as the one number to change for a sensitivity check (1.0 = NASA FAQ).

Run:   python analysis/07_pm25.py fetch      # ~300 small downloads, needs the NASA Earthdata login in ~/.netrc
       python analysis/07_pm25.py process    # -> data/processed/pm25_grid.npz (same grid and months as merra2_grid.npz)
"""
from __future__ import annotations

import io
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h5py
import numpy as np

from earthdata import get_bytes, session

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "merra2" / "aer_pm"
LIST = ROOT / "data" / "raw" / "merra2" / "aer" / "_giovanni_files.txt"   # written by 01_fetch_data.py merra2
OUT = ROOT / "data" / "processed"
LAT_I, LON_I = (162, 196), (439, 481)          # same box as 01_fetch_data.py: lat -9..8, lon 94.375..120.625
VARS = ["DUSMASS25", "SSSMASS25", "BCSMASS", "OCSMASS", "SO4SMASS"]
OM_OC, SULFATE = 1.0, 132.14 / 96.06


def fetch() -> None:
    urls = LIST.read_text().split()
    RAW.mkdir(parents=True, exist_ok=True)
    s = session()
    a, b = LAT_I
    c, d = LON_I
    ce = ";".join([f"/{v}[0:0][{a}:{b}][{c}:{d}]" for v in VARS] + [f"/lat[{a}:{b}]", f"/lon[{c}:{d}]", "/time[0:0]"])

    def one(u: str) -> None:
        ym = re.search(r"\.(\d{6})\.nc4", u).group(1)
        dest = RAW / f"{ym}.nc4"
        if dest.exists() and dest.stat().st_size > 1000:
            return
        u = u[: u.index(".nc4") + 4] + ".dap.nc4"
        for k in range(6):
            data = get_bytes(s, f"{u}?dap4.ce={ce}")
            if data.startswith(b"\x89HDF"):
                dest.write_bytes(data)
                return
            time.sleep(5 * (k + 1))
        raise RuntimeError(f"not netCDF after retries: {u}")

    one(urls[0])
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, urls))
    print(f"  aerosol components for {len(list(RAW.glob('*.nc4')))} months in {RAW}")


def process() -> None:
    files = sorted(RAW.glob("*.nc4"))
    months = [f.stem for f in files]
    ref = np.load(OUT / "merra2_grid.npz", allow_pickle=True)
    assert months == [str(m) for m in ref["months"]], "months differ from merra2_grid.npz"
    pm = np.full((len(files), len(ref["lat"]), len(ref["lon"])), np.nan, dtype="float32")
    comp = {v: pm.copy() for v in VARS}
    for i, f in enumerate(files):
        with h5py.File(f) as h:
            assert np.allclose(h["lat"][:], ref["lat"], atol=1e-3) and np.allclose(h["lon"][:], ref["lon"], atol=1e-3)
            x = {v: np.where(np.array(h[v])[0] > 1e10, np.nan, np.array(h[v])[0]) for v in VARS}
        for v in VARS:
            comp[v][i] = x[v] * 1e9
        pm[i] = (x["DUSMASS25"] + x["SSSMASS25"] + x["BCSMASS"] + OM_OC * x["OCSMASS"] + SULFATE * x["SO4SMASS"]) * 1e9
    np.savez_compressed(OUT / "pm25_grid.npz", months=np.array(months), lat=ref["lat"], lon=ref["lon"], PM25=pm,
                        **{v: comp[v] for v in VARS}, recipe=np.array(f"DUSMASS25+SSSMASS25+BCSMASS+{OM_OC}*OCSMASS+{SULFATE:.4f}*SO4SMASS (NASA GMAO MERRA-2 FAQ), ug m-3"))
    print(f"  PM2.5 grid {pm.shape}: {months[0]} .. {months[-1]}; study-box mean {np.nanmean(pm):.1f} ug/m3, max {np.nanmax(pm):.0f}")


if __name__ == "__main__":
    for step in sys.argv[1:] or ["fetch", "process"]:
        {"fetch": fetch, "process": process}[step]()
