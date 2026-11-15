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
$("#heroSub").innerHTML = `NASA satellites count fire hotspots (FIRMS), smoke haze (aerosol optical depth, AOD) and fine particles near the ground (surface PM₂.₅, MERRA-2) over Sumatra and Kalimantan, 2003–2025. Below we test whether each one changed and whether it is significant, and whether the seasons with the most fire also have the worst pollution. For scale: in 2015 MODIS counted <b>${fmt(y2015.fires_season)} fire detections</b> in four months.`;
$("#liveLine").textContent = "NASA FIRMS MODIS fire detections, 2003–2025 (Terra + Aqua)";
$("#genTime").textContent = A.generated.replace("T", " ");

const hero = new MapScene($("#heroScene"), { terrain, grid: A.grid, autoRotate: true, camera: "hero", labels: false, interactive: false, rotate: true });
hero.setFires(y2015.cells);
hero.setClimate({ dryness: dryOf(y2015.soil), warm: warmOf(y2015.oni), smoke: smokeOf(y2015.aod) * 0.9 });
hero.start();
window.addEventListener("scroll", () => $("#nav").classList.toggle("solid", scrollY > 60), { passive: true });
// ------------------------------------------------------------------ tabs: Question · Map · Findings (the fourth, Case, evidence & methods, is its own page)
const TABIDS = ["landing", "map", "findings"], ALIAS = { scout: "findings", trend: "findings", guide: "landing", top: "landing", question: "landing" };
function showTab(id, { scroll = true } = {}) {
  id = ALIAS[id] || id; if (!TABIDS.includes(id)) return;
  TABIDS.forEach((t) => $("#" + t).classList.toggle("active", t === id));
  $$(".nav-links [data-tab]").forEach((a) => { const on = a.dataset.tab === id; a.classList.toggle("on", on); a.setAttribute("aria-selected", on); });
  history.replaceState(null, "", "#" + id);
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
}
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]'); if (!a) return;
  const id = ALIAS[a.getAttribute("href").slice(1)] || a.getAttribute("href").slice(1);
  if (TABIDS.includes(id)) { e.preventDefault(); showTab(id); }
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1), { scroll: false }));
showTab(location.hash.slice(1) || "landing", { scroll: false });

const setNavH =() => document.documentElement.style.setProperty("--navh", $("#nav").offsetHeight + "px");
setNavH(); window.addEventListener("resize", setNavH);

// ------------------------------------------------------------------ guided questions → the answer opens right below, on the map
(() => {
  const form = $("#gq"), place = $("#gqPlace"), year = $("#gqYear"), box = $("#gqResult"), frame = $("#gqFrame"), dlg = $("#gqDlg");
  const LBL = { fire: "Fires & haze", drought: "Drought & rain", smoke: "Air from space", forest: "Forests" };
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
    const y = t.match(/\b(20(?:0[3-9]|1\d|2[0-5]))\b/); if (y) out.year = y[1];
    else if (/\b(now|latest|current|today|sekarang|terbaru|saat ini)\b/i.test(t)) out.year = "2025"; // the latest year covered
    return out;
  }
  const OUT_OF_SCOPE = "Out of scope: this site only answers questions about fire hotspots, smoke haze (AOD) and surface PM₂.₅ in Sumatra and Kalimantan, 2003–2025. Try “Where did fires peak in 2015?” or “How bad was the smoke in Kalimantan in 2019?”, or pick a topic above.";
  const askGo = () => {
    const t = $("#gqText").value.trim(), hint = $("#gqHint"); if (!t) { hint.classList.remove("oos"); hint.textContent = "Type a question, or pick a topic above."; return; }
    const p = parseAsk(t);
    // a place named in the question that is not on Sumatra or Kalimantan (known outside regions, or any unrecognised "in/at/di <place>")
    const named = [...t.matchAll(/\b(?:in|at|near|around|di|ke|dari|sekitar)\s+([a-z][a-z-]+)/gi)].map((m) => m[1].toLowerCase());
    const NOT_PLACE = /^(the|a|an|my|our|this|that|these|those|recent|last|past|each|every|all|general|total|both|two|many|most|some|any|what|which|how|why|when|where|season|seasons|year|years|tahun|musim|bulan|indonesia|sumatra|sumatera|kalimantan|borneo|asia|southeast|tropics|peatlands?|forests?|fires?|smoke|haze|drought|dry|wet|rain|air|space|total|decade|decades|time|general|summer|august|september|october|july|jun|june|november|december|january|february|march|april|may)$/i;
    const unknownPlace = !p.where && named.some((w) => !NOT_PLACE.test(w));
    const outside = /\b(19\d\d|20(?:0[0-2]|2[6-9]|[3-9]\d))\b/.test(t) || unknownPlace || /java|jawa|jakarta|bandung|surabaya|semarang|yogyakarta|bali\b|sulawesi|makassar|papua|maluku|ambon|lombok|ntt|ntb|flores|timor|singapore|malaysia|thailand|vietnam|myanmar|philippines|australia|amazon|california|africa|europe|america|china|india|japan/i.test(t);
    if (!p.what || outside) { hint.classList.add("oos"); hint.textContent = OUT_OF_SCOPE; return; }
    hint.classList.remove("oos");
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
  $("#gqDlgClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop
  // other parts of the page (the trend scout) can run an investigation on the map
  document.addEventListener("gq:run", (e) => {
    const { what, where: w, year: y } = e.detail;
    form.elements.what.value = what;
    if (TOWNS_ALL.includes(w)) { form.elements.where.value = "place"; place.value = w; } else form.elements.where.value = w;
    year.value = y; sync(); showStep(3); form.requestSubmit();
    showTab("map");
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
    showTab("map");
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
        ${a?.site ? `<button class="btn primary" type="button" id="svSite">${esc(a.site.text)} →</button>` : `<span class="sv-none">This site maps Sumatra and Kalimantan; use the tools above for your region.</span>`}
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
