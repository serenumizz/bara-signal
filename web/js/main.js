import * as d3 from "d3";
import { MapScene } from "./scene.js";
import { EXPLAIN_URL } from "./config.js";
import { Chain } from "./model.js";
import * as charts from "./charts.js";

const $ = (s) => document.querySelector(s);
const fmt = d3.format(",.0f");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const [T, A, land, terrain] = await Promise.all(["timeline", "analysis", "land", "terrain"].map((f) => fetch(`data/${f}.json`).then((r) => r.json())));
const chain = new Chain(A, T);
const O = A.obs2026;

const tipHead = (d) => `<b>near ${d.town.name}</b> <span class="tk">· ${d.lat.toFixed(2)}°, ${d.lon.toFixed(2)}°E</span><br>`;

const warmOf = (oni) => Math.max(0, Math.min(1, (oni ?? 0) / 2.4));
const dryOf = (soil) => Math.max(0, Math.min(1, (0.9 - soil) / 0.26));
const smokeOf = (aod) => Math.max(0, Math.min(1.15, ((aod ?? 0.35) - 0.33) / 0.6));

// ------------------------------------------------------------------ hero
const y2015 = T.find((d) => d.year === 2015);
$("#heroStat").textContent = `Niño 3.4 hit +${O.nino34_max_2026.toFixed(2)} °C in ${MONTHS[O.nino34_monthly.at(-1)[0] - 1]} 2026.`;
$("#heroSub").innerHTML = `The previous record since satellite SSTs began (1982) was +${O.nino34_record_before_2026.toFixed(2)} °C, in ${MONTHS[O.nino34_record_before_2026_when[1] - 1]} ${O.nino34_record_before_2026_when[0]}. That year, satellites counted <b>${fmt(y2015.fires_season)} fires</b> across Sumatra and Kalimantan in four months, and the haze crossed borders.`;
$("#liveLine").textContent = `Live · ${A.live.n} MODIS fire detections in the study area, ${A.live.from} → ${A.live.to} (NASA FIRMS NRT)`;
$("#genTime").textContent = A.generated.replace("T", " ");

const hero = new MapScene($("#heroScene"), { terrain, grid: A.grid, autoRotate: true, camera: "hero", labels: false, interactive: false, rotate: true });
hero.setFires(y2015.cells);
hero.setClimate({ dryness: dryOf(y2015.soil), warm: warmOf(O.oni_latest), smoke: smokeOf(y2015.aod) * 0.9 });
hero.start();
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

// ------------------------------------------------------------------ timeline
const tl = new MapScene($("#tlScene"), { terrain, grid: A.grid, contours: true, clickCard: true, explainUrl: EXPLAIN_URL, explainCtx: () => ({ year: +$("#tlSlider").value }),
  describe: (d) => `${tipHead(d)}🔥 <b>${fmt(d.n)}</b> MODIS fire detections in ${$("#tlSlider").value}<br><span class="tk">in this ${d.cell}° cell (~28 km) · NASA FIRMS</span>` });
let updInd = charts.indicators($("#tlIndicators"), T, (y) => setYear(y));
$("#tlTicks").innerHTML = [2000, 2005, 2010, 2015, 2020, 2025].map((y) => `<span>${y}</span>`).join("");
const tags = { 2015: "Strong El Niño · record haze", 2019: "Positive IOD + weak El Niño", 2006: "El Niño + positive IOD", 2002: "El Niño", 2010: "La Niña · wettest dry season", 2023: "El Niño + strong IOD", 2016: "Peat restoration agency founded", 1997: "" };
function setYear(y) {
  const r = T.find((d) => d.year === y);
  $("#tlSlider").value = y;
  $("#tlYear").textContent = y;
  $("#tlTag").textContent = (r.terra_only ? "Terra only · " : "") + (tags[y] || "");
  $("#tlFires").textContent = r.fires_season == null ? "n/a" : fmt(r.fires_season);
  $("#tlSum").textContent = r.sumatra == null ? "n/a" : fmt(r.sumatra);
  $("#tlKal").textContent = r.kalimantan == null ? "n/a" : fmt(r.kalimantan);
  tl.setFires(r.cells);
  tl.setClimate({ dryness: dryOf(r.soil), warm: warmOf(r.oni), smoke: smokeOf(r.aod) });
  updInd(y);
}
setYear(2015);
$("#tlSlider").addEventListener("input", (e) => { stopPlay(); setYear(+e.target.value); });
let playT = null;
function stopPlay() { clearInterval(playT); playT = null; $("#tlPlay").textContent = "▶"; }
$("#tlPlay").addEventListener("click", () => {
  if (playT) return stopPlay();
  let y = +$("#tlSlider").value; if (y >= 2025) y = 1999;
  $("#tlPlay").textContent = "❚❚";
  playT = setInterval(() => { y++; setYear(y); if (y >= 2025) stopPlay(); }, 1100);
});

// ------------------------------------------------------------------ evidence
const tr = Object.fromEntries(A.trends.map((t) => [t.key, t]));
const cellsSig = A.spatial.filter((c) => c.sig_fdr);
const verdicts = [
  ["What", `Fire is falling`, `Fire-season detections are down ${Math.abs(tr.fires_season.pct_per_decade).toFixed(0)}% per decade (p = ${tr.fires_season.p.toFixed(3)}). Aqua-only and Terra-only counts agree.`],
  ["Where", `${Math.round(100 * cellsSig.filter((c) => c.sen < 0).length / A.spatial.length)}% of cells`, `are significantly falling after FDR control, led by the Riau and Central Kalimantan peat domes. A few East Kalimantan cells are rising, and Indonesia's fire share outside these two islands grew ${tr.share_outside.pct_per_decade.toFixed(0)}% per decade.`],
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

// ------------------------------------------------------------------ 2026 simulator
const sim = new MapScene($("#simScene"), { terrain, grid: A.grid,
  describe: (d) => `${tipHead(d)}🔥 <b>${fmt(d.n)}</b> simulated detections in ${$("#simMonth").textContent}<br><span class="tk">in this ${d.cell}° cell · spread by the observed 2003–2025 fire pattern</span>` });
const S = { oni: O.oni, dmi: O.dmi_latest, rain: O.rain, soil: O.soil, gov: 1, useObs: true, override: "obs" };
const ctl = { oni: $("#c_oni"), dmi: $("#c_dmi"), rain: $("#c_rain"), soil: $("#c_soil"), gov: $("#c_gov") };
let simRes = null, monthT = null, monthIdx = 0;

function simInputs() {
  if (S.override === "obs") return { oni: S.oni, dmi: S.dmi, rain: O.rain, soil: O.soil, gov: S.gov };
  if (S.override === "soil") return { oni: S.oni, dmi: S.dmi, rain: S.rain, soil: S.soil, gov: S.gov };
  if (S.override === "rain") return { oni: S.oni, dmi: S.dmi, rain: S.rain, gov: S.gov };
  return { oni: S.oni, dmi: S.dmi, gov: S.gov };
}
function hazeStatus(aod) {
  if (aod < 0.42) return ["good", "✓", "Typical"];
  if (aod < 0.55) return ["warning", "!", "Elevated"];
  if (aod < 0.8) return ["serious", "▲", "Severe"];
  return ["critical", "✕", "Extreme (2015-like)"];
}
function renderSim() {
  const r = (simRes = chain.run(simInputs()));
  S.rain = r.rain; S.soil = r.soil;
  for (const k of Object.keys(ctl)) ctl[k].value = S[k];
  $("#o_oni").textContent = d3.format("+.2f")(S.oni);
  $("#o_dmi").textContent = d3.format("+.2f")(S.dmi);
  $("#o_rain").textContent = r.rain.toFixed(2);
  $("#o_soil").textContent = r.soil.toFixed(3);
  $("#o_gov").textContent = S.gov === 0 ? "0 · pre-2016" : S.gov === 1 ? "1 · observed" : S.gov.toFixed(2) + (S.gov > 1 ? " · extrapolated" : "");
  $("#c_useObs").checked = S.override === "obs";
  const [cls, ic, lbl] = hazeStatus(r.aod);
  const worse = r.rankAbove;
  $("#simTiles").innerHTML = `
    <div class="tile"><div class="k">Fire detections, Jul–Oct 2026</div><div class="v">${fmt(r.fires)}</div><div class="s">10–90%: ${fmt(r.lo)} – ${fmt(r.hi)}</div></div>
    <div class="tile"><div class="k">Closest past season</div><div class="v">${r.analog.year}</div><div class="s">${fmt(r.analog.fires)} detections · ${worse} of 23 seasons were worse</div></div>
    <div class="tile"><div class="k">Haze, AOD Aug–Oct</div><div class="v">${r.aod.toFixed(2)}</div><div class="s"><span class="status ${cls}">${ic} ${lbl}</span></div></div>
    <div class="tile"><div class="k">Fire radiative power, season</div><div class="v">${fmt(r.frp)} GW</div><div class="s">sum of detection FRP · 2015: ${fmt(T.find((d) => d.year === 2015).frp_GW)} GW</div></div>`;
  const rng = A.ranges;
  const meter = (v, a, b) => Math.max(2, Math.min(100, (100 * (v - a)) / (b - a)));
  const rows = [
    ["🌊", "ENSO (ONI)", `${d3.format("+.2f")(S.oni)} °C`, `[${rng.oni[0].toFixed(1)} to ${rng.oni[1].toFixed(1)}]`, meter(S.oni, -1.5, 2.5)],
    ["🌧", "Dry-season rain", `${r.rain.toFixed(2)} mm/d`, `[${rng.rain[0].toFixed(1)}–${rng.rain[1].toFixed(1)}] · ${S.override === "obs" ? "observed 2026" : S.override === "rain" || S.override === "soil" ? "your input" : "from ocean"}`, 100 - meter(r.rain, 1.5, 9.5)],
    ["🟫", "Root-zone soil wetness", r.soil.toFixed(3), `[${rng.soil[0].toFixed(2)}–${rng.soil[1].toFixed(2)}] · ${S.override === "obs" ? "observed 2026" : S.override === "soil" ? "your input" : "from rain"}`, 100 - meter(r.soil, 0.6, 0.93)],
    ["🔥", "Fire detections", fmt(r.fires), "[3,023–105,106]", meter(Math.log(r.fires), Math.log(3000), Math.log(110000))],
    ["🌫", "Aerosol optical depth", r.aod.toFixed(2), `[${rng.aod[0].toFixed(2)}–${rng.aod[1].toFixed(2)}]`, meter(r.aod, 0.33, 1.12)],
  ];
  $("#simChain").innerHTML = rows.map(([ic, nm, v, s, m]) => `<div class="sc-row"><span class="ic">${ic}</span><span class="nm">${nm}<small>${s}</small></span><span class="vl">${v}</span><div class="sc-meter"><i style="width:${m}%"></i></div></div>`).join("");
  charts.simHist($("#simHistChart"), T, r);
  sim.setClimate({ dryness: dryOf(r.soil), warm: warmOf(S.oni) });
  playSeason(true);
  updateFuture();
}
function playSeason(restart) {
  const r = simRes;
  const prof = chain.monthProfile(r.w);
  const annual = r.fires / chain.seasonShare(prof);
  const pattern = chain.pattern(1, r.w, S.gov);
  const peak = Math.max(...prof);
  $("#simMonthBar").innerHTML = prof.map((p) => `<i style="height:${Math.max(4, (100 * p) / peak)}%"></i>`).join("");
  const bars = [...document.querySelectorAll("#simMonthBar i")];
  clearInterval(monthT);
  if (restart) monthIdx = 0;
  const step = () => {
    const m = monthIdx;
    const n = annual * prof[m];
    sim.setFires(pattern.map(([i, j, v]) => [i, j, v * n]), { min: 0.5 });
    sim.setClimate({ smoke: smokeOf(r.aod) * Math.min(1, (prof[m] / peak) * 1.3) });
    const cum = d3.sum(prof.slice(0, m + 1)) * annual;
    $("#simMonth").textContent = `${MONTHS[m]} 2026`;
    $("#simFiresLive").textContent = fmt(cum);
    bars.forEach((b, i) => b.classList.toggle("on", i <= m));
    monthIdx = (m + 1) % 12;
  };
  step();
  monthT = setInterval(step, 1300);
}
for (const k of ["oni", "dmi"]) ctl[k].addEventListener("input", (e) => { S[k] = +e.target.value; S.override = "none"; renderSim(); });
ctl.rain.addEventListener("input", (e) => { S.rain = +e.target.value; S.override = "rain"; renderSim(); });
ctl.soil.addEventListener("input", (e) => { S.soil = +e.target.value; S.override = "soil"; renderSim(); });
ctl.gov.addEventListener("input", (e) => { S.gov = +e.target.value; renderSim(); });
$("#c_useObs").addEventListener("change", (e) => { S.override = e.target.checked ? "obs" : "none"; renderSim(); });
$("#simPlay").addEventListener("click", () => playSeason(true));
const y15 = T.find((d) => d.year === 2015);
const presets = {
  obs: () => Object.assign(S, { oni: O.oni, dmi: O.dmi_latest, gov: 1, override: "obs" }),
  2015: () => Object.assign(S, { oni: y15.oni, dmi: y15.dmi, rain: y15.rain, soil: y15.soil, gov: 0, override: "soil" }),
  relapse: () => Object.assign(S, { oni: O.oni, dmi: O.dmi_latest, gov: 0, override: "obs" }),
  lanina: () => Object.assign(S, { oni: -1.2, dmi: -0.3, gov: 1, override: "none" }),
};
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-preset]").forEach((x) => x.classList.toggle("on", x === b));
  presets[b.dataset.preset](); renderSim();
}));

// ------------------------------------------------------------------ 2027-2030
const fut = new MapScene($("#futScene"), { terrain, grid: A.grid,
  describe: (d) => `${tipHead(d)}🔥 <b>${fmt(d.n)}</b> detections in ${FS.year} (median of 4,000 runs)<br><span class="tk">in this ${d.cell}° cell · fire season Jul–Oct</span>` });
const FS = { path: "analog", shift: 0, gov: 1, year: 2027 };
let mc = null, futCycle = null;
function updateFuture() {
  if (!simRes) return;
  mc = chain.monteCarlo({ path: FS.path, shift: FS.shift, gov: FS.gov });
  $("#o_shift").textContent = `${FS.shift > 0 ? "+" : ""}${FS.shift}%`;
  $("#o_fgov").textContent = FS.gov.toFixed(2);
  charts.fanChart($("#fanChart"), $("#fanLegend"), T, simRes, mc, FS.year);
  $("#futTiles").innerHTML = mc.map((m) => `<div class="tile"><div class="k">${m.year} · median</div><div class="v">${fmt(m.p50)}</div>
    <div class="s">10–90%: ${fmt(m.p10)} – ${fmt(m.p90)}<br>P(&gt; 2019): <b>${Math.round(100 * m.pOver2019)}%</b> · P(&gt; 2015): <b>${Math.round(100 * m.pOver2015)}%</b></div></div>`).join("");
  showFutYear(FS.year);
}
function showFutYear(y) {
  FS.year = y;
  const m = mc.find((d) => d.year === y);
  const ln = Math.log(m.p50);
  const ww = Math.max(0, Math.min(1, (ln - chain.lnLo) / (chain.lnHi - chain.lnLo)));
  fut.setFires(chain.pattern(m.p50, ww, FS.gov), { min: 2 });
  fut.setClimate({ dryness: Math.min(1, ww * 0.9), warm: FS.path === "nino" ? 0.8 : 0.15, smoke: smokeOf(m.aod50) });
  $("#futYear").textContent = y;
  $("#futFires").textContent = fmt(m.p50);
  $("#futRisk").textContent = `${Math.round(100 * m.pOver2019)}%`;
  document.querySelectorAll("#futPills button").forEach((b) => b.classList.toggle("on", +b.dataset.y === y));
}
$("#futPills").innerHTML = [2027, 2028, 2029, 2030].map((y) => `<button data-y="${y}">${y}</button>`).join("");
$("#futPills").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  clearInterval(futCycle); futCycle = null;
  showFutYear(+b.dataset.y);
  charts.fanChart($("#fanChart"), $("#fanLegend"), T, simRes, mc, FS.year);
});
$("#f_path").addEventListener("change", (e) => { FS.path = e.target.value; updateFuture(); });
$("#f_shift").addEventListener("input", (e) => { FS.shift = +e.target.value; updateFuture(); });
$("#f_gov").addEventListener("input", (e) => { FS.gov = +e.target.value; document.querySelectorAll("[data-fgov]").forEach((b) => b.classList.toggle("on", +b.dataset.fgov === FS.gov)); updateFuture(); });
document.querySelectorAll("[data-fgov]").forEach((b) => b.addEventListener("click", () => {
  FS.gov = +b.dataset.fgov; $("#f_gov").value = FS.gov;
  document.querySelectorAll("[data-fgov]").forEach((x) => x.classList.toggle("on", x === b)); updateFuture();
}));
futCycle = setInterval(() => { showFutYear(FS.year >= 2030 ? 2027 : FS.year + 1); }, 3500);

renderSim();

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
  ["ln(fire) ← soil + regime", "ln detections", ch.soil_to_fires, ["soil", "regime"]],
  ["AOD ← ln(fire)", "AOD Aug–Oct", ch.fires_to_aod, ["ln_fires"]],
];
$("#coefTable").innerHTML = `<thead><tr><th>Link</th><th>Term</th><th class="num">Coef.</th><th class="num">p</th><th class="num">R²</th><th class="num">LOO R²</th></tr></thead><tbody>${
  coefRows.map(([nm, , L, terms]) => terms.map((t, i) => `<tr><td>${i ? "" : nm}</td><td>${t}</td><td class="num">${d3.format("+.3f")(L.coef[t])}</td><td class="num">${pf(L.p[t])}</td><td class="num">${i ? "" : L.r2.toFixed(2)}</td><td class="num">${i ? "" : L.r2_loo.toFixed(2)}</td></tr>`).join("")).join("")}</tbody>`;
const seasonShare = d3.sum(fit, (d) => d.fires_season) / d3.sum(fit, (d) => d.fires_year);
$("#keyResults").innerHTML = [
  `Fire-season detections: Sen slope ${fmt(tr.fires_season.sen_slope)} per year (${tr.fires_season.pct_per_decade.toFixed(0)}%/decade), p = ${pf(tr.fires_season.p)}. Aqua-only: p = ${pf(tr.fires_aqua_season.p)}. Terra-only 2001–2025: p = ${pf(tr.fires_terra_year.p)}.`,
  `Root-zone soil wetness trended up ${tr.soil.pct_per_decade.toFixed(1)}%/decade (p = ${pf(tr.soil.p)}), but rainfall (p = ${pf(tr.rain.p)}), Tmax (p = ${pf(tr.tmax.p)}), ONI and DMI show no significant trend.`,
  `Pettitt change point: raw fire after ${A.changepoint.raw_after} (p = ${pf(A.changepoint.raw_p)}). Climate-adjusted residual: new regime from ${A.changepoint.regime_start} (p = ${pf(A.changepoint.regime_p)}).`,
  `Spatial: ${A.spatial.length} cells tested; ${A.spatial.filter((c) => c.sig_fdr && c.sen < 0).length} significantly decreasing and ${A.spatial.filter((c) => c.sig_fdr && c.sen > 0).length} increasing after FDR.`,
  `Lag structure: rain → soil wetness peaks at a 1-month lag; soil → fire and fire → AOD respond in the same month.`,
  `2026 so far: Jul–Oct root-zone soil wetness ${O.soil.toFixed(3)}, the 2nd driest of 27 years (only 2015 was drier); RH ${O.rh.toFixed(1)}%, the lowest on record.`,
  `${Math.round(100 * seasonShare)}% of 2003–2025 detections fall in the Jul–Oct season.`,
].map((s) => `<li>${s}</li>`).join("");

let rT;
window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => redraw[activeTab]?.(), 250); });

// ------------------------------------------------------------------ tabs (one numbered section at a time)
const TABS = [...document.querySelectorAll("#tabbar [data-tab]")].map((b) => ({ id: b.dataset.tab, btn: b, label: b.textContent.replace(/^\d+/, "").trim(), num: b.querySelector("span").textContent }));
const redraw = {
  explore: () => { const f = $("#exploreFrame"); if (!f.src) f.src = f.dataset.src; },
  timeline: () => { updInd = charts.indicators($("#tlIndicators"), T, (y) => setYear(y)); updInd(+$("#tlSlider").value); },
  evidence: () => drawEvidence(),
  sim2026: () => charts.simHist($("#simHistChart"), T, simRes),
  future: () => updateFuture(),
};
// prev / next buttons at the bottom of every panel
TABS.forEach((t, i) => {
  const nav = document.createElement("div");
  nav.className = "tabnav";
  const prev = TABS[i - 1], next = TABS[i + 1];
  nav.innerHTML = (prev ? `<button class="prev" data-go="${prev.id}"><small>← ${prev.num}</small>${prev.label}</button>` : "")
    + (next ? `<button class="next" data-go="${next.id}"><small>${next.num} →</small>${next.label}</button>` : "");
  document.getElementById(t.id).appendChild(nav);
});
let activeTab = null;
function showTab(id, { scroll = true } = {}) {
  if (!TABS.some((t) => t.id === id)) return;
  activeTab = id;
  TABS.forEach((t) => {
    const on = t.id === id;
    t.btn.classList.toggle("on", on);
    t.btn.setAttribute("aria-selected", on);
    document.getElementById(t.id).classList.toggle("active", on);
  });
  document.querySelectorAll(".nav-links a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + id));
  history.replaceState(null, "", "#" + id);
  requestAnimationFrame(() => { redraw[id]?.(); });
  TABS.find((t) => t.id === id).btn.scrollIntoView({ block: "nearest", inline: "center" });
  if (scroll) {
    const bar = $("#tabbar");
    window.scrollTo({ top: bar.getBoundingClientRect().top + scrollY - $("#nav").offsetHeight + 1, behavior: "smooth" });
  }
}
$("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-go]");
  if (g) return showTab(g.dataset.go);
  const a = e.target.closest('a[href^="#"]');
  if (a && TABS.some((t) => "#" + t.id === a.getAttribute("href"))) { e.preventDefault(); showTab(a.getAttribute("href").slice(1)); }
});
$("#tabbar").addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
  const i = TABS.findIndex((t) => t.id === activeTab);
  const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  showTab(n.id, { scroll: false }); n.btn.focus();
});
const startTab = location.hash.slice(1);
if (TABS.some((t) => t.id === startTab)) showTab(startTab); else showTab("question", { scroll: false });
const setNavH = () => document.documentElement.style.setProperty("--navh", $("#nav").offsetHeight + "px");
setNavH(); window.addEventListener("resize", setNavH);

// ------------------------------------------------------------------ guided questions → the answer opens right below, on the map
(() => {
  const form = $("#gq"), place = $("#gqPlace"), year = $("#gqYear"), box = $("#gqResult"), frame = $("#gqFrame"), dlg = $("#gqDlg");
  const LBL = { fire: "Fires & haze", drought: "Drought & rain", smoke: "Air from space", forest: "Forests", ocean: "Ocean & wind", wildlife: "Wildlife impacts" };
  const read = () => {
    const f = new FormData(form), w = f.get("where");
    return { what: f.get("what"), where: w === "place" ? place.value : w, year: year.value };
  };
  const summary = (a) => `${LBL[a.what]} · ${a.where} · ${a.year === "now" ? "now (Oct 2026)" : "peak of " + a.year}`;
  const sync = () => { place.disabled = new FormData(form).get("where") !== "place"; $("#gqSum").textContent = summary(read()); };
  form.addEventListener("change", sync);
  place.addEventListener("focus", () => { form.elements.where.value = "place"; sync(); });
  // ---- "ask in your own words": English + Indonesian keywords → topic, place and year
  const TOWNS_ALL = [...place.options].map((o) => o.value);
  const TOPICS = [
    ["wildlife", /orangutan|wildlife|animal|satwa|hewan|habitat/i],
    ["ocean", /ocean|sea\b|wind|el ni|la ni|enso|iod|dipole|laut|angin|samudra/i],
    ["smoke", /smoke|haze|air quality|aerosol|asap|kabut|udara|polusi/i],
    ["drought", /drought|dry|rain|water|peat|moist|kering|kemarau|hujan|gambut|air tanah|lembap/i],
    ["forest", /forest|tree|deforest|logging|hutan|pohon|tebang|tutupan/i],
    ["fire", /fire|burn|hotspot|blaze|api\b|kebakaran|bakar|karhutla/i],
  ];
  function parseAsk(t) {
    const out = {}, low = t.toLowerCase();
    const hit = TOPICS.find(([, re]) => re.test(t)); if (hit) out.what = hit[0];
    if (/\b(hot|hotter|heat|temperature|warm|panas|suhu|gerah)\b/i.test(t)) { out.what = out.what || "drought"; out.heat = true; }
    const town = TOWNS_ALL.find((n) => low.includes(n.toLowerCase().replace(/ \(.*\)/, "")));
    if (town) out.where = town; else if (/sumatra|sumatera/.test(low)) out.where = "Sumatra"; else if (/kalimantan|borneo/.test(low)) out.where = "Kalimantan";
    else { const prov = { riau: "Pekanbaru", jambi: "Jambi", aceh: "Banda Aceh", lampung: "Bandar Lampung", bengkulu: "Bengkulu", "sumatera utara": "Medan", "north sumatra": "Medan", "south sumatra": "Palembang", "sumatera selatan": "Palembang", "central kalimantan": "Palangka Raya", "kalimantan tengah": "Palangka Raya", "west kalimantan": "Pontianak", "kalimantan barat": "Pontianak", "south kalimantan": "Banjarmasin", "kalimantan selatan": "Banjarmasin", "east kalimantan": "Samarinda", "kalimantan timur": "Samarinda" };
      const k = Object.keys(prov).find((p) => low.includes(p)); if (k) out.where = prov[k]; }
    const y = t.match(/\b(20(?:0[3-9]|1\d|2[0-6]))\b/); if (y) out.year = y[1] === "2026" ? "now" : y[1];
    else if (/\b(now|latest|current|today|sekarang|terbaru|saat ini)\b/i.test(t)) out.year = "now";
    return out;
  }
  const askGo = () => {
    const t = $("#gqText").value.trim(), hint = $("#gqHint"); if (!t) { hint.textContent = "Type a question, or pick a topic above."; return; }
    const p = parseAsk(t);
    if (!p.what) { hint.textContent = "I could not tell the topic. Mention fires, drought, smoke, forests, the ocean or orangutans, or pick a card above."; return; }
    form.elements.what.value = p.what;
    if (p.where) { if (TOWNS_ALL.includes(p.where)) { form.elements.where.value = "place"; place.value = p.where; } else form.elements.where.value = p.where; }
    if (p.year) year.value = p.year;
    hint.textContent = (p.heat ? "Heat is not a layer on this map yet, so I am showing drought (dry air and soil). " : "") + `Showing: ${summary(read())}` + (p.where ? "" : " (place and year: pick below or I use the defaults)");
    sync(); showStep(3); form.requestSubmit();
  };
  // ---- step by step: 1 topic → 2 place → 3 year
  let step = 1;
  const showStep = (n) => {
    step = n;
    form.querySelectorAll(".gq-step").forEach((f) => (f.hidden = +f.dataset.step !== n));
    form.querySelectorAll(".gq-prog i").forEach((b, i) => b.classList.toggle("on", i < n));
    $("#gqBack").hidden = n === 1; $("#gqNext").hidden = n === 3; $("#gqSubmit").hidden = n !== 3;
  };
  $("#gqNext").addEventListener("click", () => showStep(Math.min(3, step + 1)));
  $("#gqBack").addEventListener("click", () => showStep(Math.max(1, step - 1)));
  const openDlg = () => { showStep(1); sync(); dlg.showModal(); };
  $("#gqOpen").addEventListener("click", openDlg);
  $("#heroOpen").addEventListener("click", openDlg);
  $("#gqDlgClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop
  $("#gqGo").addEventListener("click", askGo);
  $("#gqText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askGo(); } });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (step < 3) { showStep(step + 1); return; } // Enter key moves to the next step
    const a = read();
    const url = `explore/?layer=${a.what}&where=${encodeURIComponent(a.where)}&year=${a.year}` + (EXPLAIN_URL ? `&ex=${encodeURIComponent(EXPLAIN_URL)}` : "");
    frame.src = url; $("#gqFull").href = url;
    dlg.close();
    $("#gqResultTitle").textContent = summary(a);
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("#gqClose").addEventListener("click", () => { frame.src = "explore/"; $("#gqFull").href = "explore/"; $("#gqResultTitle").textContent = "The full map · explore freely"; });
  sync();
})();
