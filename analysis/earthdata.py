"""
Shared helpers for the data sources listed on the NASA Space Apps 2026 challenge Resources tab
("Be An Earth System Trend Detective!"):

  * AppEEARS             https://appeears.earthdatacloud.nasa.gov/   (MODIS fire, tree cover, land/water; SRTM elevation)
  * Giovanni / GES DISC  https://giovanni.gsfc.nasa.gov/             (MERRA-2 monthly rain, soil wetness, aerosol, air)
  * KNMI Climate Explorer https://climexp.knmi.nl/                   (Nino3.4 and Dipole Mode Index, ERSSTv5)

Login: NASA Earthdata credentials are read from ~/.netrc (machine urs.earthdata.nasa.gov) at run time.
They are never printed, logged or written anywhere by this code, and the AppEEARS session token is kept in memory only.
"""
from __future__ import annotations

import io
import json
import netrc
import re
import time
from pathlib import Path

import requests

APPEEARS = "https://appeears.earthdatacloud.nasa.gov/api"
GIOVANNI = "https://giovanni.gsfc.nasa.gov/giovanni/daac-bin"
KNMI = "https://climexp.knmi.nl/data"


def _creds() -> tuple[str, str]:
    try:
        auth = netrc.netrc().authenticators("urs.earthdata.nasa.gov")
    except FileNotFoundError:
        auth = None
    if not auth:
        raise SystemExit("NASA Earthdata login missing: add 'machine urs.earthdata.nasa.gov login ... password ...' to ~/.netrc")
    return auth[0], auth[2]


EDL_HOST = "urs.earthdata.nasa.gov"


class _EDLSession(requests.Session):
    """Sends the Earthdata login ONLY to urs.earthdata.nasa.gov (when a NASA data server redirects there to log in).

    Every other host - the data servers themselves, and any non-NASA site - never receives the username/password."""

    def __init__(self) -> None:
        super().__init__()
        self.trust_env = False  # do not let requests pick credentials from ~/.netrc on its own
        self._edl = _creds()

    def rebuild_auth(self, prepared_request, response):  # called on every redirect
        prepared_request.headers.pop("Authorization", None)
        if requests.utils.urlparse(prepared_request.url).hostname == EDL_HOST:
            requests.auth.HTTPBasicAuth(*self._edl)(prepared_request)


def session() -> requests.Session:
    """Session for NASA Earthdata data servers (Giovanni, Earthdata Cloud OPeNDAP)."""
    return _EDLSession()


def public_session() -> requests.Session:
    """Session for public, no-login sources (KNMI Climate Explorer). Never carries any credentials."""
    s = requests.Session()
    s.trust_env = False
    return s


def get_bytes(s: requests.Session, url: str, tries: int = 5, timeout: int = 300, **kw) -> bytes:
    for i in range(tries):
        try:
            r = s.get(url, timeout=timeout, **kw)
            r.raise_for_status()
            return r.content
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"   retry {i + 1}: {type(e).__name__} {str(e)[:120]}")
            time.sleep(5 * (i + 1))
    raise RuntimeError(url)


# ----------------------------------------------------------------------------- Giovanni
def giovanni_data_urls(s: requests.Session, variable: str, start: str, end: str, bbox: str) -> list[str]:
    """Ask Giovanni which archive files it reads for a variable/time range (its 'Data File Search' provenance step).

    Giovanni's own workflow lists the exact NASA Earthdata Cloud OPeNDAP granule URLs for the request. We read that
    list and then fetch only our region from each granule, which gives the same numbers Giovanni plots."""
    q = dict(service="ArAvTs", starttime=start, endtime=end, bbox=bbox, data=variable, portal="GIOVANNI", format="json")
    j = s.get(f"{GIOVANNI}/service_manager.pl", params=q, timeout=120).json()
    sid = j["session"]["id"]
    rs = j["session"]["resultset"][0]["id"]
    rid = j["session"]["resultset"][0]["result"][0]["id"]
    for _ in range(400):
        j = s.get(f"{GIOVANNI}/service_manager.pl", params=dict(session=sid, resultset=rs, result=rid, format="json"), timeout=120).json()
        st = j["session"]["resultset"][0]["result"][0]["status"][0]
        if str(st["percentComplete"][0].get("value")) == "100" or str(st["code"][0].get("value")) not in ("0", ""):
            break
        time.sleep(3)
    # full list of files from Giovanni's "Data File Search" step ("Download list of all URLs in step")
    txt = s.get(f"{GIOVANNI}/lineageText.pl", params=dict(step="data_search", session=sid, resultset=rs, result=rid), timeout=300).text
    urls = re.findall(r"https://opendap\.earthdata\.nasa\.gov/[^\s\"'<]+", txt)
    if not urls:
        raise RuntimeError(f"Giovanni returned no data file list for {variable}")
    return sorted({u.split("?")[0] for u in urls})


# ----------------------------------------------------------------------------- AppEEARS
class AppEEARS:
    def __init__(self) -> None:
        u, p = _creds()
        r = requests.post(f"{APPEEARS}/login", auth=(u, p), timeout=120)
        r.raise_for_status()
        self.h = {"Authorization": f"Bearer {r.json()['token']}"}

    def submit(self, name: str, layers: list[tuple[str, str]], start: str, end: str, bbox: tuple[float, float, float, float],
               fmt: str = "netcdf4") -> str:
        x0, x1, y0, y1 = bbox
        geo = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {
            "type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}}]}
        task = {"task_type": "area", "task_name": name, "params": {
            "dates": [{"startDate": start, "endDate": end}],
            "layers": [{"product": p, "layer": l} for p, l in layers],
            "geo": geo, "output": {"format": {"type": fmt}, "projection": "geographic"}}}
        r = requests.post(f"{APPEEARS}/task", json=task, headers=self.h, timeout=120)
        if not r.ok:
            raise RuntimeError(f"AppEEARS submit {name}: {r.status_code} {r.text[:300]}")
        return r.json()["task_id"]

    def status(self, task_id: str) -> str:
        return requests.get(f"{APPEEARS}/task/{task_id}", headers=self.h, timeout=120).json().get("status", "?")

    def files(self, task_id: str) -> list[dict]:
        return requests.get(f"{APPEEARS}/bundle/{task_id}", headers=self.h, timeout=120).json()["files"]

    def download(self, task_id: str, f: dict, dest: Path) -> None:
        if dest.exists() and dest.stat().st_size == f.get("file_size", -1):
            return
        tmp = dest.with_suffix(dest.suffix + ".part")
        with requests.get(f"{APPEEARS}/bundle/{task_id}/{f['file_id']}", headers=self.h, stream=True,
                          allow_redirects=True, timeout=600) as r:
            r.raise_for_status()
            with open(tmp, "wb") as out:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    out.write(chunk)
        tmp.rename(dest)


def load_json(p: Path, default):
    return json.loads(p.read_text()) if p.exists() else default


def open_nc(b: bytes):
    import xarray as xr
    return xr.open_dataset(io.BytesIO(b), engine="h5netcdf")
