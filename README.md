# Ember Signal: Earth System Trend Detective (NASA Space Apps 2026)

Live: https://web-zeta-six-76.vercel.app

**Research question:** Has a decade of peat-fire governance broken the chain that turns ocean heat (ENSO/IOD) into drought, drought into fire, and fire into haze over Sumatra and Kalimantan? Is the decline significant, and does it survive once the climate is taken into account? Data cover 2003–2025.

## Data

**Fire comes from NASA FIRMS** (MODIS Collection 6.1, Terra and Aqua active-fire detections, Indonesia archive), the source named in the team's judging one-pager. We also tried the Resources-tab route (MOD14A2/MYD14A2 8-day composites through AppEEARS, `analysis/` since the merge of `resources-tab-sources-only`) and compared the two: re-gridding the FIRMS points into 8-day 1 km composites gives 92% of the detection count (range 82–98%), r = 0.999 between yearly totals, the same top-5 fire years, and the same trend (−46%/decade, p = 0.015 vs −47%/decade, p = 0.011). The choice of product does not change the conclusion, so the AppEEARS requests were cancelled.

| Variable | Source | Where it is used |
|---|---|---|
| Active fires | NASA FIRMS · MODIS C6.1, Terra + Aqua (type 0, confidence ≥ 30) | all fire counts, trends, risk models |
| Rain, root-zone wetness, aerosol optical depth (map cells, Evidence tab) | NASA POWER (MERRA-2): PRECTOTCORR, GWETROOT, AOD_55 | clues A, B, E |
| Air temperature, humidity, wind (Trend Lab, whole study area) | MERRA-2 via NASA Giovanni / GES DISC: T2M, RH2M, SPEED | `web/explore/regional.json` |
| Surface PM2.5 (in progress) | MERRA-2 aerosol components via NASA Giovanni (`analysis/07_pm25.py`) | PM2.5 layer and Trend Lab |
| ENSO and Indian Ocean Dipole | NOAA CPC Oceanic Niño Index, NOAA PSL Dipole Mode Index | clue D |
| Tree-cover loss | Hansen/UMD Global Forest Change via Global Forest Watch | clue C |
| Peat extent | PEATMAP (Xu et al. 2018) | model feature (peat fraction per cell) |
| Terrain, coastlines, boundaries | AWS Terrain Tiles, Natural Earth, geoBoundaries | 3D map, province and regency names |

**What is in the repository.** `web/data/*.json` and `web/explore/data.json` were built by the FIRMS / NASA POWER pipeline (`analysis/01`–`05` at commit `ca8a2b1`, `git checkout ca8a2b1 -- analysis/ data/processed/` restores it). Since the Resources-tab merge, `analysis/01`–`05` implement the AppEEARS / Giovanni / KNMI variant, which was never completed (no AppEEARS data was downloaded), and `data/processed/drivers_monthly*.csv`, `merra2_grid.npz` and `indices_monthly.csv` are that variant's MERRA-2 tables. `06_regional_series.py` and `07_pm25.py` work on those tables. Bringing the two pipelines back into one is open work.

## Login (NASA Earthdata)

Giovanni / GES DISC (MERRA-2) needs a free NASA Earthdata account. Put the login in `~/.netrc`, outside this project:

```
machine urs.earthdata.nasa.gov login YOUR_USER password YOUR_PASS
```

The code reads it at run time and never prints or stores it (see `analysis/earthdata.py`). The username and password are only sent to NASA's login server, `urs.earthdata.nasa.gov`. In Earthdata Login, approve the application **NASA GESDISC DATA ARCHIVE** once, or MERRA-2 downloads answer 403.

## Pipeline for the new pieces

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd analysis
../.venv/bin/python 01_fetch_data.py indices    # ocean indices
../.venv/bin/python 01_fetch_data.py merra2     # MERRA-2 monthly via Giovanni's file list
../.venv/bin/python 02_process.py indices merra2   # -> data/processed/drivers_monthly*.csv, merra2_grid.npz, indices_monthly.csv
../.venv/bin/python 06_regional_series.py       # monthly T2M / humidity / wind for the Trend Lab -> web/explore/regional.json
../.venv/bin/python 07_pm25.py                  # surface PM2.5 from MERRA-2 aerosol components -> data/processed/pm25_grid.npz
```

| Folder | Contents |
|---|---|
| `data/raw` | downloaded source files (not committed, not deployed) |
| `data/processed` | tidy tables, including `annual_table.csv` |
| `web/` | static site (Three.js + D3), deployed to Vercel from this folder |

## Methods

- **Fire index:** NASA FIRMS MODIS detections of type 0 (presumed vegetation fire) with confidence ≥ 30, Terra and Aqua, summed per month and season.
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
| **D1** | Fire counts per regency and year plus the FDR-tested cell trends (built from NASA FIRMS and geoBoundaries; `worker/db/seed.sql` is the seed, and `worker/scripts/build_seed.py` rebuilds it from the old pipeline's tables). `GET /api/trend?regency=Pulang Pisau&from=2003&to=2025` computes Mann–Kendall and Sen's slope on the fly. |
| **KV** | Caches every AI answer, so the same question is generated once. |
| **R2** | Serves the big JSON files (`/data/explore.json`, ...) when the bucket is enabled; the site falls back to its own copies. |

The model can only reword numbers that the Worker supplies, and the Trend scout can only pick ids from a fixed catalog of NASA/NOAA variables.

```
cd worker
# python3 scripts/build_seed.py                       # only with the old pipeline's tables (see Data); db/seed.sql is the last build
npx wrangler d1 execute ember-signal --remote --file=db/seed.sql
npx wrangler deploy
```

Local test without Workers AI: `npx wrangler dev -c wrangler.test.toml` (real D1 and KV, fake model).

### Auto-deploy

- `web/` is deployed by Vercel on every push to `main`.
- `.github/workflows/cloudflare.yml` deploys the Cloudflare side: the Worker when `worker/` changes, the D1 seed when `worker/db/seed.sql` changes, and the R2 files when `web/data/*.json` or `web/explore/data.json` change. It needs the repository secret `CF_GITHUB_TOKEN` (a Cloudflare API token with Workers Scripts, D1, R2 and KV edit rights on the account); without it the jobs are skipped.
- Run it by hand with `gh workflow run cloudflare.yml -f everything=true`.

### Trend Lab (Explore map, button "📈 Trend Lab")

Pick a place (15 provinces, an island or the whole study area), a way to look at each year (Jul–Oct fire season or whole year), a start year and a variable. The lab draws the yearly values with a trend line and 95% confidence band and runs three tests in the browser: Mann–Kendall (Z, p), a t-test on the regression slope, and the 95% confidence interval of the rate per decade, plus Sen's slope and R². Fires, smoke (MERRA-2 TOTEXTTAU), rainfall (PRECTOTCORR), soil moisture (GWETROOT) and tree-cover loss (MOD44B) are per area; air temperature (T2M), humidity (RH2M), wind (SPEED), ONI and the Dipole index (ERSSTv5 via KNMI) exist only for the whole study area and are labelled so. The "Ask the AI" box sends the computed numbers to the Worker (`mode: "stat"`), which only rewords them.
