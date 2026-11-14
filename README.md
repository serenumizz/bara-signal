# Ember Signal: Earth System Trend Detective (NASA Space Apps 2026)

Live: https://web-zeta-six-76.vercel.app

**Research question:** Has a decade of peat-fire governance broken the chain that turns ocean heat (ENSO/IOD) into drought, drought into fire, and fire into haze over Sumatra and Kalimantan? And what will the record 2026 El Niño (Niño 3.4 = +3.25 °C in Oct 2026) and the years after it do?

## Pipeline

All data is public and real. Nothing is synthetic.

```
python analysis/01_fetch_data.py   # NASA FIRMS MODIS, NASA POWER (MERRA-2), NOAA ONI / Niño3.4 / DMI, Natural Earth
python analysis/02_process.py      # tidy monthly tables, 0.25° fire grid, coastlines
python analysis/03_analysis.py     # trends, change point, FDR map, chain model, analogs -> web/data/*.json
python analysis/04_regions.py      # every fire point -> province/regency (geoBoundaries), regency trends + FDR
python analysis/05_explore_data.py # real-data build of the "Jejak Api" 3D explorer -> web/explore/data.json
```

`web/explore/` is the "Jejak Api · Explore the Islands" map, adapted from a prototype whose numbers were placeholders.
Every layer is now measured data:
- **Fires:** NASA FIRMS
- **A, B, E:** NASA POWER (MERRA-2) rain, root-zone wetness and AOD
- **C:** Hansen/GFW tree-cover loss
- **D:** NOAA ONI/DMI
- **Peat extent:** PEATMAP
- **Terrain:** AWS Terrain Tiles

The risk and July-check scores come from logistic models fitted on 2003–2025 data and validated leave-one-year-out.

| Folder | Contents |
|---|---|
| `data/raw` | downloaded source files (not deployed) |
| `data/processed` | tidy CSV tables, including `annual_table.csv` |
| `web/` | static site (Three.js + D3), deployed to Vercel from this folder |

## Methods

- **Trends:** Mann–Kendall with the Hamed–Rao autocorrelation correction, plus Sen's slope.
- **Spatial trends:** a test for each 0.5° cell, with Benjamini–Hochberg FDR control.
- **Change point:** Pettitt test on raw counts and on the climate-adjusted residual.
- **Chain model:** OLS links ENSO+IOD → rain → soil wetness → ln(fire) (+ regime term) → AOD, validated by leave-one-year-out CV.
- **2027–2030:** a 4,000-run Monte Carlo over real post-El Niño ocean sequences (1957–2015), with bootstrapped residuals.

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
- `.github/workflows/cloudflare.yml` deploys the Cloudflare side: the Worker when `worker/` changes, the D1 seed when `worker/db/seed.sql` changes, and the R2 files when `web/data/*.json` or `web/explore/data.json` change. It needs the repository secret `CLOUDFLARE_API_TOKEN` (a Cloudflare API token with Workers Scripts, D1, R2 and KV edit rights on the account); without it the jobs are skipped.
- Run it by hand with `gh workflow run cloudflare.yml -f everything=true`.
