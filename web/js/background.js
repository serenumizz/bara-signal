import * as d3 from "d3";
import { nearestTown } from "./scene.js";
import { EXPLAIN_URL } from "./config.js";
import * as charts from "./charts.js";

const $ = (s) => document.querySelector(s);
const fmt = d3.format(",.0f");

// the big JSON files come from Cloudflare R2 (through the Worker) when it is configured, otherwise from this site
let r2Ready;
async function getData(name) {
  if (EXPLAIN_URL) {
    try {
      r2Ready ||= fetch(`${EXPLAIN_URL.replace(/\/$/, "")}/api/health`).then((r) => r.json()).then((j) => !!j.r2).catch(() => false);
      if (!(await r2Ready)) throw new Error("R2 not enabled");
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(`${EXPLAIN_URL.replace(/\/$/, "")}/data/${name}.json`, { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) return await r.json();
    } catch { /* fall back to the local copy */ }
  }
  return (await fetch(`data/${name}.json`)).json();
}
// the site covers 2003–2025: 2026 is a partial year and is left out of every table and chart
const [T0, A, land] = await Promise.all(["timeline", "analysis", "land"].map(getData));
const T = T0.filter((d) => d.year <= 2025);
$("#genTime").textContent = A.generated.replace("T", " ");
window.addEventListener("scroll", () => $("#nav").classList.toggle("solid", scrollY > 60), { passive: true });

// ------------------------------------------------------------------ chain diagram (correlations from data)
const fit = T.filter((d) => d.year >= 2003 && d.fires_season);
const pear = (a, b) => {
  const xs = fit.map(a), ys = fit.map(b), mx = d3.mean(xs), my = d3.mean(ys);
  return d3.sum(xs, (x, i) => (x - mx) * (ys[i] - my)) / Math.sqrt(d3.sum(xs, (x) => (x - mx) ** 2) * d3.sum(ys, (y) => (y - my) ** 2));
};
const rr = [pear((d) => d.oni, (d) => d.rain), pear((d) => d.rain, (d) => d.soil), pear((d) => d.soil, (d) => Math.log(d.fires_season)), pear((d) => Math.log(d.fires_season), (d) => d.aod)];
rr.forEach((r, i) => ($(`#arr${i}`).textContent = `r = ${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}`));
const nodes = [...document.querySelectorAll("#chainDiagram .node")];
let litI = 0;
setInterval(() => { nodes.forEach((n, i) => n.classList.toggle("lit", i === litI)); litI = (litI + 1) % (nodes.length + 2); }, 900);

// ------------------------------------------------------------------ evidence
const tr = Object.fromEntries(A.trends.map((t) => [t.key, t]));
const cellsSig = A.spatial.filter((c) => c.sig_fdr);
// name the places from the data: the nearest town to the strongest falling / rising cells
const falling = cellsSig.filter((c) => c.sen < 0).sort((a, b) => a.sen - b.sen), rising = cellsSig.filter((c) => c.sen > 0).sort((a, b) => b.sen - a.sen);
const townsOf = (cs, n) => [...new Set(cs.map((c) => nearestTown(c.lon, c.lat)).filter((t) => t.km <= 120 && !/^(Singapore|Kuala Lumpur)$/.test(t.name)).map((t) => t.name))].slice(0, n);
const joinList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : a[0] ?? "");
const fallList = joinList(townsOf(falling.slice(0, 12), 3)), riseList = joinList(townsOf(rising, 2));
const whereText = `are significantly falling after FDR control${fallList ? `, strongest around ${fallList}` : ""}. `
  + (rising.length ? `${rising.length === 1 ? "One cell is" : `${rising.length} cells are`} significantly rising${riseList ? `, around ${riseList}` : ""}.` : "No cell is significantly rising.")
  + (tr.share_outside ? ` The share of fires outside these two islands grew ${tr.share_outside.pct_per_decade.toFixed(0)}% per decade.` : "");
const verdicts = [
  ["What", `Fire is falling`, `Fire-season detections are down ${Math.abs(tr.fires_season.pct_per_decade).toFixed(0)}% per decade (p = ${tr.fires_season.p.toFixed(3)}). Aqua-only and Terra-only counts agree.`],
  ["Where", `${Math.round(100 * falling.length / A.spatial.length)}% of cells`, whereText],
  ["How much", `−${Math.round(-100 * A.chain.regime_effect)}% at equal dryness`, `After ${A.changepoint.regime_start}, the same soil wetness produces about ${(1 / (1 + A.chain.regime_effect)).toFixed(1)}× fewer fires. Soil wetness also trended wetter (+${tr.soil.pct_per_decade.toFixed(0)}%/decade, p = ${tr.soil.p.toFixed(3)}).`],
  ["Significant?", `Yes, twice`, `Mann–Kendall trend p = ${tr.fires_season.p.toFixed(3)}, and a Pettitt break in climate-adjusted fire at ${A.changepoint.regime_start} (p = ${A.changepoint.regime_p.toFixed(3)}). The chain model scores LOO R² = ${A.chain.soil_to_fires.r2_loo.toFixed(2)}.`],
];
$("#verdicts").innerHTML = verdicts.map(([q, a, p]) => `<div class="verdict"><div class="q">${q}</div><div class="a">${a}</div><p>${p}</p></div>`).join("");
charts.trendTable($("#trendTable"), A.trends);
const drawEvidence = () => {
  charts.trendMap($("#trendMap"), $("#trendMapLegend"), A.spatial, land);
  charts.gapChart($("#gapChart"), $("#gapLegend"), T, A);
  charts.lagChart($("#lagChart"), A.lags);
  charts.hindChart($("#hindChart"), $("#hindLegend"), A);
};
drawEvidence();
// ------------------------------------------------------------------ methods
document.querySelectorAll(".mtabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".mtabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".mpanel").forEach((p) => p.classList.toggle("on", p.id === b.dataset.tab));
}));
const ch = A.chain;
const pf = (p) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const coefRows = [
  ["Rain ← ENSO + IOD", "rain (mm/d)", ch.climate_to_rain, ["oni", "dmi"]],
  ["Soil ← rain", "GWETROOT", ch.rain_to_soil, ["rain"]],
  ["ln(fire) ← soil + regime", "ln fire detections", ch.soil_to_fires, ["soil", "regime"]],
  ["AOD ← ln(fire)", "AOD Aug–Oct", ch.fires_to_aod, ["ln_fires"]],
];
$("#coefTable").innerHTML = `<thead><tr><th>Link</th><th>Term</th><th class="num">Coef.</th><th class="num">p</th><th class="num">R²</th><th class="num">LOO R²</th></tr></thead><tbody>${
  coefRows.map(([nm, , L, terms]) => terms.map((t, i) => `<tr><td>${i ? "" : nm}</td><td>${t}</td><td class="num">${d3.format("+.3f")(L.coef[t])}</td><td class="num">${pf(L.p[t])}</td><td class="num">${i ? "" : L.r2.toFixed(2)}</td><td class="num">${i ? "" : L.r2_loo.toFixed(2)}</td></tr>`).join("")).join("")}</tbody>`;
const seasonShare = d3.sum(fit, (d) => d.fires_season) / d3.sum(fit, (d) => d.fires_year);
$("#seasonSharePct").textContent = Math.round(100 * seasonShare);
$("#aquaTrend").textContent = `${tr.fires_aqua_season.pct_per_decade.toFixed(0)}%/decade, p = ${pf(tr.fires_aqua_season.p)}; combined ${tr.fires_season.pct_per_decade.toFixed(0)}%/decade`;
$("#keyResults").innerHTML = [
  `Fire-season detections: Sen slope ${fmt(tr.fires_season.sen_slope)} per year (${tr.fires_season.pct_per_decade.toFixed(0)}%/decade), p = ${pf(tr.fires_season.p)}. Aqua-only: p = ${pf(tr.fires_aqua_season.p)}. Terra-only 2001–2025: p = ${pf(tr.fires_terra_year.p)}.`,
  `Root-zone soil wetness trended up ${tr.soil.pct_per_decade.toFixed(1)}%/decade (p = ${pf(tr.soil.p)}), but rainfall (p = ${pf(tr.rain.p)}), ${tr.t2m ? "air temperature" : "Tmax"} (p = ${pf((tr.t2m ?? tr.tmax).p)}), ONI and DMI show no significant trend.`,
  `Pettitt change point: raw fire after ${A.changepoint.raw_after} (p = ${pf(A.changepoint.raw_p)}). Climate-adjusted residual: new regime from ${A.changepoint.regime_start} (p = ${pf(A.changepoint.regime_p)}).`,
  `Spatial: ${A.spatial.length} cells tested; ${A.spatial.filter((c) => c.sig_fdr && c.sen < 0).length} significantly decreasing and ${A.spatial.filter((c) => c.sig_fdr && c.sen > 0).length} increasing after FDR.`,
  `Lag structure: rain → soil wetness peaks at a 1-month lag; soil → fire and fire → AOD respond in the same month.`,
  `${Math.round(100 * seasonShare)}% of 2003–2025 detections fall in the Jul–Oct season.`,
].map((s) => `<li>${s}</li>`).join("");

let rT;
window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(drawEvidence, 250); });
