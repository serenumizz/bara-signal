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
