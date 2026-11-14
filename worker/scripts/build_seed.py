"""Build worker/db/seed.sql (D1) from the analysis outputs.

LEGACY: the website does not run this script. The site only calls the deployed Worker, and the Worker reads the
D1 database that this script's output (worker/db/seed.sql) already filled. Re-run it only to rebuild that seed.
It needs data/processed/fires_regency_monthly.csv and the regency table of web/explore/data.json, which come from
the old pipeline (NASA FIRMS points + geoBoundaries regencies). The Resources-tab pipeline has no regency
borders, so a rebuild needs a new design (island / grid-cell level) once the AppEEARS fire data is downloaded.

Tables:
  regency(id, name, province, rank, total_fires, pct_per_decade, sen_slope, p, significant)   <- web/explore/data.json (kabs)
  regency_year(kab_id, year, fires_total, fires_season)                                        <- data/processed/fires_regency_monthly.csv
  cell_trend(lon, lat, sen, p, sig_fdr, total_fires)                                           <- web/data/analysis.json (spatial, FDR-tested)
"""
import csv, json, collections, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
if not (root / "data/processed/fires_regency_monthly.csv").exists():
    raise SystemExit("data/processed/fires_regency_monthly.csv is gone (the Resources-tab pipeline has no regency borders). "
                     "worker/db/seed.sql is the last seed built from it; keep using that file.")
kabs = json.load(open(root / "web/explore/data.json"))["kabs"]
spatial = json.load(open(root / "web/data/analysis.json"))["spatial"]

tot = collections.defaultdict(int); sea = collections.defaultdict(int)
for r in csv.DictReader(open(root / "data/processed/fires_regency_monthly.csv")):
    k, y, m, n = int(r["kab"]), int(r["year"]), int(r["month"]), int(float(r["n"]))
    tot[(k, y)] += n
    if 7 <= m <= 10: sea[(k, y)] += n

q = lambda s: "'" + str(s).replace("'", "''") + "'"
out = ["DROP TABLE IF EXISTS regency_year;", "DROP TABLE IF EXISTS regency;", "DROP TABLE IF EXISTS cell_trend;",
 "CREATE TABLE regency (id INTEGER PRIMARY KEY, name TEXT NOT NULL, province TEXT, rank INTEGER, total_fires INTEGER, pct_per_decade REAL, sen_slope REAL, p REAL, significant INTEGER);",
 "CREATE TABLE regency_year (kab_id INTEGER NOT NULL, year INTEGER NOT NULL, fires_total INTEGER NOT NULL, fires_season INTEGER NOT NULL, PRIMARY KEY (kab_id, year));",
 "CREATE TABLE cell_trend (lon REAL, lat REAL, sen REAL, p REAL, sig_fdr INTEGER, total_fires INTEGER);",
 "CREATE INDEX idx_regency_name ON regency(name);"]
rows = [f"({int(i)},{q(k['name'])},{q(k['prov'])},{k['rank']},{k['tot']},{k['pct_dec']},{k['sen']},{k['p']},{int(bool(k['sig']))})" for i, k in sorted(kabs.items(), key=lambda t: int(t[0]))]
out.append("INSERT INTO regency VALUES " + ",".join(rows) + ";")
ry = [f"({k},{y},{tot[(k, y)]},{sea[(k, y)]})" for k in sorted(int(i) for i in kabs) for y in range(2003, 2026)]
for i in range(0, len(ry), 400): out.append("INSERT INTO regency_year VALUES " + ",".join(ry[i:i+400]) + ";")
ct = [f"({c['lon']},{c['lat']},{c['sen']},{c['p']},{int(bool(c['sig_fdr']))},{c['total']})" for c in spatial]
for i in range(0, len(ct), 400): out.append("INSERT INTO cell_trend VALUES " + ",".join(ct[i:i+400]) + ";")
(root / "worker/db/seed.sql").write_text("\n".join(out) + "\n")
print(f"regency {len(rows)} | regency_year {len(ry)} | cell_trend {len(ct)} | {(root/'worker/db/seed.sql').stat().st_size//1024} KB")
