import * as d3 from "d3";
import { MapScene, nearestTown } from "./scene.js";
import { EXPLAIN_URL } from "./config.js";
import { ARCH, VARS, SOURCES, GUIDES, matchText } from "./scout.js";
import { initQuestions } from "./questions.js";
import * as charts from "./charts.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = d3.format(",.0f");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
const [T0, A, land, terrain] = await Promise.all(["timeline", "analysis", "land", "terrain"].map(getData));
const T = T0.filter((d) => d.year <= 2025);

const tipHead = (d) => `<b>near ${d.town.name}</b> <span class="tk">· ${d.lat.toFixed(2)}°, ${d.lon.toFixed(2)}°E</span><br>`;

const warmOf = (oni) => Math.max(0, Math.min(1, (oni ?? 0) / 2.4));
const dryOf = (soil) => Math.max(0, Math.min(1, (0.9 - soil) / 0.26));
const smokeOf = (aod) => Math.max(0, Math.min(1.15, ((aod ?? 0.35) - 0.33) / 0.6));

// ------------------------------------------------------------------ hero
const y2015 = T.find((d) => d.year === 2015);
const fireTr = A.trends.find((t) => t.key === "fires_season");
$("#heroStat").textContent = `fire detections are down ${Math.abs(fireTr.pct_per_decade).toFixed(0)}% per decade. Is that real?`;
$("#heroSub").innerHTML = `In 2015, MODIS counted <b>${fmt(y2015.fires_season)} fire detections</b> across Sumatra and Kalimantan in four months, and the haze crossed borders. Ten years on, we test what changed, where, by how much, and whether the change is statistically significant.`;
$("#liveLine").textContent = "NASA FIRMS MODIS fire detections, 2003–2025 (Terra + Aqua)";
$("#genTime").textContent = A.generated.replace("T", " ");

const hero = new MapScene($("#heroScene"), { terrain, grid: A.grid, autoRotate: true, camera: "hero", labels: false, interactive: false, rotate: true });
hero.setFires(y2015.cells);
hero.setClimate({ dryness: dryOf(y2015.soil), warm: warmOf(y2015.oni), smoke: smokeOf(y2015.aod) * 0.9 });
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
window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => redraw[activeTab]?.(), 250); });

// ------------------------------------------------------------------ tabs (one numbered section at a time)
const TABS = [...document.querySelectorAll("#tabbar [data-tab]")].map((b) => ({ id: b.dataset.tab, btn: b, label: b.textContent.replace(/^\d+/, "").trim(), num: b.querySelector("span").textContent }));
const redraw = {
  evidence: () => drawEvidence(),
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
  const LBL = { fire: "Fires & haze", drought: "Drought & rain", smoke: "Air from space", forest: "Forests", ocean: "Ocean & wind" };
  const read = () => {
    const f = new FormData(form), w = f.get("where");
    return { what: f.get("what"), where: w === "place" ? place.value : w, year: year.value };
  };
  const summary = (a) => `${LBL[a.what]} · ${a.where} · peak of ${a.year}`;
  const sync = () => { place.disabled = new FormData(form).get("where") !== "place"; $("#gqSum").textContent = summary(read()); };
  form.addEventListener("change", sync);
  place.addEventListener("focus", () => { form.elements.where.value = "place"; sync(); });
  // ---- "ask in your own words": English + Indonesian keywords → topic, place and year
  const TOWNS_ALL = [...place.options].map((o) => o.value);
  const TOPICS = [
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
    if (town) out.where = town; else if (/sumatra|sumatera/.test(low)) out.where = "Sumatra"; else if (/kalimantan|borneo/.test(low)) out.where = "Borneo";
    else { const prov = { riau: "Pekanbaru", jambi: "Jambi", aceh: "Banda Aceh", lampung: "Bandar Lampung", bengkulu: "Bengkulu", "sumatera utara": "Medan", "north sumatra": "Medan", "south sumatra": "Palembang", "sumatera selatan": "Palembang", "central kalimantan": "Palangka Raya", "kalimantan tengah": "Palangka Raya", "west kalimantan": "Pontianak", "kalimantan barat": "Pontianak", "south kalimantan": "Banjarmasin", "kalimantan selatan": "Banjarmasin", "east kalimantan": "Samarinda", "kalimantan timur": "Samarinda" };
      const k = Object.keys(prov).find((p) => low.includes(p)); if (k) out.where = prov[k]; }
    const y = t.match(/\b(20(?:0[3-9]|1\d|2[0-5]))\b/); if (y) out.year = y[1];
    else if (/\b(now|latest|current|today|sekarang|terbaru|saat ini)\b/i.test(t)) out.year = "2025"; // the latest year covered
    return out;
  }
  const askGo = () => {
    const t = $("#gqText").value.trim(), hint = $("#gqHint"); if (!t) { hint.textContent = "Type a question, or pick a topic above."; return; }
    const p = parseAsk(t);
    if (!p.what) { hint.textContent = "I could not tell the topic. Mention fires, drought, smoke, forests or the ocean, or pick a card above."; return; }
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
  // other parts of the page (the trend scout) can run an investigation on the map
  document.addEventListener("gq:run", (e) => {
    const { what, where: w, year: y } = e.detail;
    form.elements.what.value = what;
    if (TOWNS_ALL.includes(w)) { form.elements.where.value = "place"; place.value = w; } else form.elements.where.value = w;
    year.value = y; sync(); showStep(3); form.requestSubmit();
    box.scrollIntoView({ block: "start", behavior: "smooth" });
  });
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
  // the Trend Lab (inside the map frame) asks the page to pop the frame out while it is open, and to put it back
  const setLabPopup = (open) => { box.classList.toggle("lab-popup", open); document.body.classList.toggle("lab-open", open); };
  window.addEventListener("message", (e) => { if (e.source === frame.contentWindow && e.data && e.data.type === "lab") setLabPopup(!!e.data.open); });
  box.addEventListener("click", (e) => { if (e.target === box && box.classList.contains("lab-popup")) frame.contentWindow.postMessage({ type: "close-lab" }, "*"); }); // dimmed backdrop
  frame.addEventListener("load", () => setLabPopup(false));
  $("#gqClose").addEventListener("click", () => { frame.src = "explore/"; $("#gqFull").href = "explore/"; $("#gqResultTitle").textContent = "The full map · explore freely"; });
  sync();
})();

// ------------------------------------------------------------------ trend scout: which variables could trend for this kind of place?
(() => {
  const out = $("#scoutOut"), hint = $("#scoutHint");
  const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const link = (k) => `<a href="${SOURCES[k].url}" target="_blank" rel="noopener">${esc(SOURCES[k].name)} ↗</a>`;
  let current = null;
  function render({ kind, items, note, ai, picked }) {
    const a = ARCH[kind];
    const rows = items.map(([id, why]) => { const v = VARS[id]; return `<li>
      <div class="sv-h"><b>${esc(v.name)}</b></div>
      <p class="sv-def">${esc(v.def)}</p>
      <p class="sv-why">${esc(why || v.def)}</p>
      <p class="sv-src"><span>${esc(v.product)}</span> ${v.src.map(link).join(" · ")}</p></li>`; }).join("");
    out.innerHTML = `<h3>${a ? a.emoji + " " + esc(a.label) : "Your region"} · ${items.length} variables worth checking</h3>
      ${picked ? `<p class="sv-note">I picked up: <b>${esc(picked)}</b></p>` : ""}
      ${note ? `<p class="sv-note ${ai ? "ai" : ""}">${ai ? "✨ " : ""}${esc(note)}${ai ? ' <span>AI note · Cloudflare Workers AI · the variables are chosen from a fixed NASA/NOAA list</span>' : ""}</p>` : ""}
      <ol class="sv">${rows}</ol>
      <div class="sv-how"><b>Then test it like a data detective.</b> Download the monthly series (daily and monthly data are the easiest), remove the seasonal cycle, then run a Mann–Kendall test and Sen's slope for the size of the trend. A trend that is not yet significant is still a finding: a longer record can make it significant. Guides: ${GUIDES.map((g) => `<a href="${g.url}" target="_blank" rel="noopener">${esc(g.name)} ↗</a>`).join(" · ")}</div>
      <div class="sv-act">
        ${a?.site ? `<button class="btn primary" type="button" id="svSite">${esc(a.site.text)} →</button>` : `<span class="sv-none">This site maps Sumatra and Borneo; use the tools above for your region.</span>`}
        ${EXPLAIN_URL ? `<button class="btn" type="button" id="svAi">✨ Tailor with AI</button>` : ""}
      </div>`;
    out.hidden = false;
    current = { kind, text: $("#scoutText").value.trim() };
    $("#svSite")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("gq:run", { detail: a.site })));
    $("#svAi")?.addEventListener("click", tailor);
  }
  const fromKind = (kind, extra = {}) => render({ kind, items: ARCH[kind].vars, ...extra });
  function suggest() {
    const t = $("#scoutText").value.trim(); if (!t) { hint.textContent = "Pick a kind of place above, or type a few words."; return; }
    const kinds = matchText(t);
    if (!kinds.length) { hint.textContent = "I could not match that to a kind of place. Pick a card above" + (EXPLAIN_URL ? ", or press “Tailor with AI” after choosing one." : "."); return; }
    hint.textContent = "";
    fromKind(kinds[0], { picked: kinds.map((k) => ARCH[k].label).join(", ") });
  }
  async function tailor() {
    const btn = $("#svAi"); btn.disabled = true; btn.textContent = "✨ Asking the AI…";
    const text = current.text || ARCH[current.kind].label;
    try {
      const r = await fetch(EXPLAIN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "scout", text, lang: "en" }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      const kind = ARCH[j.kind] ? j.kind : current.kind;
      render({ kind, items: j.ids.filter((i) => VARS[i]).map((i) => [i, (ARCH[kind].vars.find((v) => v[0] === i) || [])[1]]), note: j.note, ai: true });
    } catch { btn.disabled = false; btn.textContent = "✨ Tailor with AI"; hint.textContent = "Could not reach the AI. The built-in suggestions above still apply."; }
  }
  $("#scoutCards").addEventListener("click", (e) => {
    const b = e.target.closest("[data-arch]"); if (!b) return;
    $$("#scoutCards .scard").forEach((x) => x.setAttribute("aria-pressed", x === b));
    hint.textContent = ""; $("#scoutText").value = ""; fromKind(b.dataset.arch);
  });
  $("#scoutGo").addEventListener("click", suggest);
  $("#scoutText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); suggest(); } });
})();

// ------------------------------------------------------------------ ask the data: regency trends from Cloudflare D1 (via the Worker)
(() => {
  if (!EXPLAIN_URL) return;
  const API = EXPLAIN_URL.replace(/\/$/, ""), box = $("#tq"), out = $("#tqOut"), hint = $("#tqHint");
  const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const years = Array.from({ length: 23 }, (_, i) => 2003 + i);
  $("#tqFrom").innerHTML = years.map((y) => `<option>${y}</option>`).join("");
  $("#tqTo").innerHTML = years.map((y) => `<option>${y}</option>`).reverse().join(""); $("#tqTo").value = 2025;
  fetch(`${API}/api/regencies`).then((r) => r.json()).then(({ regencies }) => {
    const by = {}; regencies.forEach((r) => (by[r.province] ||= []).push(r));
    $("#tqReg").innerHTML = Object.keys(by).sort().map((p) => `<optgroup label="${esc(p)}">${by[p].map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</optgroup>`).join("");
    const d = regencies.find((r) => r.name === "Pulang Pisau"); if (d) $("#tqReg").value = d.id;
    box.hidden = false;
  }).catch(() => { /* the Worker is not reachable: keep the widget hidden */ });

  function chart(series, sen) {
    const W = 640, H = 170, m = { l: 44, r: 10, t: 10, b: 22 }, xs = series.map((d) => d[0]), ys = series.map((d) => d[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1], ymax = Math.max(1, ...ys), X = (x) => m.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r), Y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
    const bw = Math.max(4, (W - m.l - m.r) / series.length - 4);
    const icpt = [...ys.map((y, i) => y - sen * xs[i])].sort((a, b) => a - b), c0 = icpt[Math.floor(icpt.length / 2)];
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual fire detections with the Sen's slope trend line">
      <line x1="${m.l}" y1="${Y(0)}" x2="${W - m.r}" y2="${Y(0)}" stroke="#323a47"/>
      ${series.map(([x, v]) => `<rect x="${X(x) - bw / 2}" y="${Y(v)}" width="${bw}" height="${Math.max(0, Y(0) - Y(v))}" rx="2" fill="#ff9a3c" opacity=".75"><title>${x}: ${v.toLocaleString()}</title></rect>`).join("")}
      <line x1="${X(x0)}" y1="${Y(Math.max(0, c0 + sen * x0))}" x2="${X(x1)}" y2="${Y(Math.max(0, c0 + sen * x1))}" stroke="#f0efec" stroke-width="2" stroke-dasharray="6 4"/>
      <text x="${m.l - 6}" y="${Y(ymax) + 4}" text-anchor="end" fill="#8d8c84" font-size="11">${ymax.toLocaleString()}</text><text x="${m.l - 6}" y="${Y(0) + 4}" text-anchor="end" fill="#8d8c84" font-size="11">0</text>
      <text x="${X(x0)}" y="${H - 5}" text-anchor="middle" fill="#8d8c84" font-size="11">${x0}</text><text x="${X(x1)}" y="${H - 5}" text-anchor="end" fill="#8d8c84" font-size="11">${x1}</text></svg>`;
  }
  async function go() {
    const body = { mode: "trend", regency: $("#tqReg").value, from: +$("#tqFrom").value, to: +$("#tqTo").value, metric: $("#tqMetric").value, lang: "en" };
    const btn = $("#tqGo"); btn.disabled = true; btn.textContent = "Computing…"; hint.textContent = "";
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      const s = j.stats, dir = s.sen < 0 ? "down" : s.sen > 0 ? "up" : "flat", pct = s.pct_per_decade == null ? "n/a" : `${s.pct_per_decade > 0 ? "+" : "−"}${Math.abs(s.pct_per_decade)}%`;
      out.innerHTML = `<div class="tq-head"><b>${esc(j.regency.name)}</b> <span>${esc(j.regency.province)} · rank #${j.regency.rank} for fires</span></div>
        <p class="tq-big ${dir}">${esc(j.metric)} are <b>${dir === "flat" ? "flat" : dir === "down" ? "falling" : "rising"}</b>: ${pct} per decade <small>p = ${s.p} · ${s.significant ? "significant" : "not significant"} (p &lt; 0.05)</small></p>
        ${chart(j.series, s.sen)}
        <p class="tq-stats">Sen's slope <b>${s.sen}</b> detections/year · Mann–Kendall z = ${s.z} · ${s.n} years (${j.from}–${j.to}) · mean ${s.mean.toLocaleString()}/year</p>
        ${j.text ? `<p class="sv-note ai">✨ ${esc(j.text)} <span>AI explanation · Cloudflare Workers AI · it only rewords the numbers above</span></p>` : ""}
        <p class="tq-src">${esc(j.source)}. Whole 2003–2025 period in the analysis pipeline (autocorrelation-corrected): ${j.whole_period_from_pipeline.pct_per_decade}%/decade, p = ${j.whole_period_from_pipeline.p}.</p>`;
      out.hidden = false;
    } catch (e) { hint.textContent = e.message === "choose at least 5 years" ? "Choose a period of at least 5 years." : "Could not compute that trend. Try again."; }
    btn.disabled = false; btn.textContent = "Compute trend";
  }
  $("#tqGo").addEventListener("click", go);
})();

// the two questions of the one-pager (Trend scout section)
initQuestions().catch((e) => console.error("questions", e));
