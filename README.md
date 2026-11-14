# Ember Signal: Earth System Trend Detective (NASA Space Apps 2026)

Live: https://web-zeta-six-76.vercel.app

**Research question:** Has a decade of peat-fire governance broken the chain that turns ocean heat (ENSO/IOD) into drought, drought into fire, and fire into haze over Sumatra and Kalimantan? Is the decline significant, and is the record 2026 El Niño (Niño 3.4 = +3.25 °C in Oct 2026) putting it to the test?

## Data sources

Every dataset comes from a source listed on the challenge
[Resources tab](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/?tab=resources).
Nothing is synthetic, and there are no placeholder numbers.

| Resources-tab source | Datasets | Used for |
|---|---|---|
| **NASA AppEEARS** | MODIS MOD14A2 / MYD14A2 (fire, 8-day, 1 km) | fire pixels, the fire trend, the latest fires |
| | MODIS MOD44B (% tree cover, yearly, 250 m) | clue C: tree-cover decline since 2001 |
| | MODIS MOD44W (land/water mask, 250 m) | coastlines, and which land belongs to Sumatra or Borneo |
| | SRTM SRTMGL3 (elevation, 90 m) | terrain of the 3D maps |
| **NASA Giovanni / GES DISC** | MERRA-2 monthly: PRECTOTCORR, GWETROOT, GWETTOP, TOTEXTTAU, T2M, QV2M, PS, SPEED | rain, soil wetness, haze (AOD), air temperature, humidity, wind |
| **KNMI Climate Explorer** | Niño 3.4 and the Dipole Mode Index (NOAA ERSSTv5), daily Niño 3.4 (NOAA OISST) | ENSO/ONI and IOD; OISST only for the months after the last ERSSTv5 month |

Giovanni's own workflow lists the MERRA-2 files it reads for a variable. Step 1 asks Giovanni for that list,
then fetches only the Sumatra–Borneo box from each file. These are the same numbers Giovanni would plot.

The method references on the Resources tab (Mann–Kendall and significance testing) are the basis of the statistics below.

### What could not be kept

These earlier inputs are **not** on the Resources tab and were removed:

- NASA FIRMS: replaced by MODIS fire through AppEEARS.
- NASA POWER: replaced by MERRA-2 through Giovanni.
- NOAA CPC/PSL index files: replaced by KNMI.
- Hansen/Global Forest Watch: replaced by MODIS VCF.
- Natural Earth and AWS Terrain Tiles: replaced by MOD44W and SRTM.
- PEATMAP peat extent: removed. No listed source has peat extent.
- geoBoundaries regencies: removed. No listed source has borders.

As a result, "Borneo" includes Malaysia and Brunei, there is no regency-level atlas, and there is no near-real-time feed.
The newest MODIS 8-day composite is the "latest fires" layer.

## Login (NASA Earthdata)

AppEEARS and Giovanni need a free NASA Earthdata account. Put the login in `~/.netrc`, outside this project:

```
machine urs.earthdata.nasa.gov login YOUR_USER password YOUR_PASS
```

The code reads it at run time and never prints or stores it (see `analysis/earthdata.py`).
The username and password are only ever sent to NASA's login server, `urs.earthdata.nasa.gov`, and to the AppEEARS login API.
KNMI needs no login, and it never receives any credentials.

## Pipeline

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd analysis
../.venv/bin/python 01_fetch_data.py submit     # send the AppEEARS requests (NASA prepares them; can take hours)
../.venv/bin/python 01_fetch_data.py indices    # KNMI ocean indices
../.venv/bin/python 01_fetch_data.py merra2     # MERRA-2 monthly via Giovanni's file list
../.venv/bin/python 01_fetch_data.py appeears   # wait for and download the AppEEARS results
../.venv/bin/python 02_process.py               # islands, coastlines, fire tables, MERRA-2 tables, indices, tree cover, terrain
../.venv/bin/python 03_analysis.py              # trends, change point, FDR map, chain model, analogs -> web/data/*.json
../.venv/bin/python 05_explore_data.py          # the "Jejak Api" 3D explorer -> web/explore/data.json
../.venv/bin/python 06_regional_series.py       # monthly Tmax / humidity / wind for the Trend Lab -> web/explore/regional.json
```

| Folder | Contents |
|---|---|
| `data/raw` | downloaded source files (not committed, not deployed) |
| `data/processed` | tidy tables, including `annual_table.csv` |
| `web/` | static site (Three.js + D3), deployed to Vercel from this folder |

## Methods

- **Fire index:** MODIS FireMask classes 8–9 (nominal and high confidence) in 8-day composites, summed per month and season.
- **Trends:** Mann–Kendall with the Hamed–Rao autocorrelation correction, plus Sen's slope.
- **Spatial trends:** a test for each 0.5° cell, with Benjamini–Hochberg FDR control.
- **Change point:** Pettitt test on raw counts and on the climate-adjusted residual.
- **Chain model:** OLS links ENSO+IOD → rain → soil wetness → ln(fire) (+ regime term) → AOD, validated by leave-one-year-out CV.
- **Explorer models:** logistic regressions fitted on 2003–2025 cell data and validated leave-one-year-out. The B (soil wetness) and C (tree-cover decline) danger lines are fitted from the data.

## Deploy

```
cd web && vercel deploy --prod
```

## Cloudflare (Worker + Workers AI + D1 + KV + R2)

`worker/` is a Cloudflare Worker, `ember-signal-api`, that the site calls from the browser.

| Product | What it does here |
|---|---|
| **Workers AI** | Plain-language answers (`env.AI.run`, Llama 3.1 8B fp8): explain a map cell, answer a question about a year, suggest variables in the Trend scout, and explain a computed trend. No API key or secret. |
| **D1** | Fire counts per regency and year plus the FDR-tested cell trends. `GET /api/trend?regency=Pulang Pisau&from=2003&to=2025` computes Mann–Kendall and Sen's slope on the fly. |
| **KV** | Caches every AI answer, so the same question is generated once. |
| **R2** | Serves the big JSON files (`/data/explore.json`, ...) when the bucket is enabled; the site falls back to its own copies. |

The model can only reword numbers that the Worker supplies, and the Trend scout can only pick ids from a fixed catalog of NASA/NOAA variables.

```
cd worker
python3 scripts/build_seed.py                          # analysis outputs -> db/seed.sql
npx wrangler d1 execute ember-signal --remote --file=db/seed.sql
npx wrangler deploy
```

Local test without Workers AI: `npx wrangler dev -c wrangler.test.toml` (real D1 and KV, fake model).

### Auto-deploy

- `web/` is deployed by Vercel on every push to `main`.
- `.github/workflows/cloudflare.yml` deploys the Cloudflare side: the Worker when `worker/` changes, the D1 seed when `worker/db/seed.sql` changes, and the R2 files when `web/data/*.json` or `web/explore/data.json` change. It needs the repository secret `CF_GITHUB_TOKEN` (a Cloudflare API token with Workers Scripts, D1, R2 and KV edit rights on the account); without it the jobs are skipped.
- Run it by hand with `gh workflow run cloudflare.yml -f everything=true`.

### Trend Lab (Explore map, button "📈 Trend Lab")

Pick a place (15 provinces, an island or the whole study area), a way to look at each year (Jul–Oct fire season or whole year), a start year and a variable. The lab draws the yearly values with a trend line and 95% confidence band and runs three tests in the browser: Mann–Kendall (Z, p), a t-test on the regression slope, and the 95% confidence interval of the rate per decade, plus Sen's slope and R². Fires, smoke, rainfall, soil moisture and tree-cover loss are per province; temperature, humidity, wind, ONI and the Dipole index exist only for the whole study area and are labelled so. The "Ask the AI" box sends the computed numbers to the Worker (`mode: "stat"`), which only rewords them.
