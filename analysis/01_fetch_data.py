"""
Step 1 - Pull public data for the Indonesian peatland fire ("karhutla") study.

Sources (all public, no login required):
  * NASA FIRMS  - MODIS (Terra+Aqua) C6.1 active fire detections, Indonesia country archive, 2000-2025
  * NASA POWER  - MERRA-2 / satellite derived monthly climate & aerosol at fire-hotspot points
                  (precipitation, root-zone & surface soil wetness, Tmax, RH, wind, aerosol optical depth)
  * NOAA CPC    - Oceanic Nino Index (ONI)
  * NOAA PSL    - Dipole Mode Index (DMI, Indian Ocean Dipole), HadISST based

Run:  python analysis/01_fetch_data.py
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

YEARS = range(2000, 2026)

# Hotspot sampling points for NASA POWER (lon, lat, label). Chosen on the large peat domes
# that dominate Indonesian fire emissions (Riau, Jambi, South Sumatra, West/Central/South Kalimantan).
POWER_POINTS = [
    (101.5, 1.3, "Riau-Bengkalis"),
    (102.6, 0.3, "Riau-Pelalawan"),
    (103.8, -1.3, "Jambi-MuaroJambi"),
    (105.3, -3.0, "SumSel-OKI"),
    (104.6, -2.6, "SumSel-Banyuasin"),
    (109.6, -0.6, "KalBar-KubuRaya"),
    (113.9, -2.3, "KalTeng-Palangkaraya"),
    (114.4, -3.0, "KalTeng-Pulangpisau"),
    (112.6, -2.9, "KalTeng-Katingan"),
    (115.0, -3.0, "KalSel-Barito"),
]
POWER_PARAMS = "PRECTOTCORR,GWETROOT,GWETTOP,T2M_MAX,RH2M,WS2M,AOD_55"


def get(url: str, dest: Path, tries: int = 4) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  skip (cached) {dest.name}")
        return
    for i in range(tries):
        try:
            r = requests.get(url, timeout=300)
            r.raise_for_status()
            dest.write_bytes(r.content)
            print(f"  ok {dest.name} ({len(r.content)/1e6:.1f} MB)")
            return
        except Exception as e:  # noqa: BLE001
            print(f"  retry {i+1} {dest.name}: {e}")
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"failed {url}")


def fetch_firms() -> None:
    out = RAW / "firms"
    out.mkdir(parents=True, exist_ok=True)
    print("NASA FIRMS MODIS Indonesia archive")
    for y in YEARS:
        url = f"https://firms.modaps.eosdis.nasa.gov/data/country/modis/{y}/modis_{y}_Indonesia.csv"
        get(url, out / f"modis_{y}_Indonesia.csv")


def fetch_power() -> None:
    out = RAW / "power"
    out.mkdir(parents=True, exist_ok=True)
    print("NASA POWER monthly point data")
    for lon, lat, name in POWER_POINTS:
        url = (
            "https://power.larc.nasa.gov/api/temporal/monthly/point"
            f"?parameters={POWER_PARAMS}&community=AG&longitude={lon}&latitude={lat}"
            f"&start={YEARS.start}&end={YEARS.stop - 1}&format=JSON"
        )
        get(url, out / f"{name}.json")
    (out / "_points.json").write_text(json.dumps(POWER_POINTS, indent=1))


def fetch_indices() -> None:
    out = RAW / "climate"
    out.mkdir(parents=True, exist_ok=True)
    print("Climate indices")
    get("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt", out / "oni.ascii.txt")
    get("https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data", out / "dmi.had.long.data")
    # Monthly Nino SST indices (has the newest months, incl. 2026)
    get("https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices", out / "sstoi.indices")


def fetch_current_year() -> None:
    """2026 = running year. NASA POWER daily (near-real-time) + FIRMS last-7-day MODIS NRT detections."""
    out = RAW / "current"
    out.mkdir(parents=True, exist_ok=True)
    print("2026 near-real-time data")
    for lon, lat, name in POWER_POINTS:
        url = (
            "https://power.larc.nasa.gov/api/temporal/daily/point"
            f"?parameters={POWER_PARAMS}&community=AG&longitude={lon}&latitude={lat}"
            "&start=20260101&end=20261231&format=JSON"
        )
        get(url, out / f"power_daily_2026_{name}.json")
    get(
        "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_SouthEast_Asia_7d.csv",
        out / "firms_modis_SEA_7d.csv",
    )


if __name__ == "__main__":
    fetch_indices()
    fetch_power()
    fetch_firms()
    fetch_current_year()
