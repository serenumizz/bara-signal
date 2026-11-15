// The two questions of the judging one-pager, answered from data/questions.json (built by analysis/08_questions.py):
//   Q1  have fire hotspots, AOD (550 nm) and surface PM2.5 changed 2003-2025, and are the trends significant?
//   Q2  do seasons with more fire hotspots coincide with higher AOD and PM2.5?
import * as d3 from "d3";

const VARS = [
  { k: "fire", name: "Fire hotspots", unit: "FIRMS detections per Jul–Oct season", color: "#ff7a3d", src: "NASA FIRMS · MODIS C6.1", fmt: d3.format(",.0f") },
  { k: "aod", name: "Aerosol optical depth", unit: "AOD at 550 nm, Jul–Oct mean", color: "#e0a94a", src: "MERRA-2 TOTEXTTAU · NASA Giovanni", fmt: d3.format(".2f") },
  { k: "pm25", name: "Surface PM₂.₅", unit: "µg/m³, Jul–Oct mean", color: "#b39ddb", src: "MERRA-2 aerosol components · NASA Giovanni", fmt: d3.format(".1f") },
];
const HIGH = "#ff7a3d", LOW = "#5fa8ff", MID = "#4a5260";
const pTxt = (p) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const pc = (v) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}%`;
const joinList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : a[0] ?? "");
const $ = (s) => document.querySelector(s);

function miniChart(host, years, vals, tr, color, fmt) {
  const W = 300, H = 120, m = { l: 38, r: 6, t: 8, b: 20 };
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Yearly values with the Sen's slope trend line");
  const x = d3.scaleBand().domain(years).range([m.l, W - m.r]).padding(0.18), y = d3.scaleLinear().domain([0, d3.max(vals) * 1.06]).nice().range([H - m.b, m.t]);
  svg.append("g").selectAll("line").data(y.ticks(3)).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y).attr("stroke", "rgba(255,255,255,.08)");
  svg.append("g").selectAll("text").data(y.ticks(3)).join("text").attr("x", m.l - 5).attr("y", (d) => y(d) + 3).attr("text-anchor", "end").attr("fill", "#8d8c84").attr("font-size", 9).attr("font-family", "monospace").text((d) => (d >= 1000 ? d3.format(".2s")(d) : d));
  svg.append("g").selectAll("rect").data(years).join("rect").attr("x", (d) => x(d)).attr("width", x.bandwidth()).attr("y", (d, i) => y(vals[i])).attr("height", (d, i) => y(0) - y(vals[i])).attr("rx", 1.5).attr("fill", color).attr("opacity", 0.75)
    .append("title").text((d, i) => `${d}: ${fmt(vals[i])}`);
  const med = d3.median(vals.map((v, i) => v - tr.sen_per_year * i)), n = vals.length - 1;
  svg.append("line").attr("x1", x(years[0]) + x.bandwidth() / 2).attr("x2", x(years.at(-1)) + x.bandwidth() / 2).attr("y1", y(Math.max(0, med))).attr("y2", y(Math.max(0, med + tr.sen_per_year * n)))
    .attr("stroke", "#f0efec").attr("stroke-width", 2).attr("stroke-dasharray", "5 3");
  [years[0], years[Math.floor(n / 2)], years.at(-1)].forEach((d) => svg.append("text").attr("x", x(d) + x.bandwidth() / 2).attr("y", H - 6).attr("text-anchor", "middle").attr("fill", "#8d8c84").attr("font-size", 9).attr("font-family", "monospace").text(d));
}

export async function initQuestions() {
  const p1 = $("#qPanel1"), p2 = $("#qPanel2"); if (!p1 || !p2) return;
  let Q; try { Q = await (await fetch("data/questions.json")).json(); } catch { p1.textContent = "Could not load the results."; return; }
  const st = { q: 1, area: "Both islands" }, years = Q.years;

  function trendCard(v, A) {
    const t = A.trend[v.k], s = A.series[v.k];
    const el = document.createElement("div"); el.className = "qcard";
    el.innerHTML = `<div class="qc-head"><b>${v.name}</b><small>${v.unit}</small></div>
      <div class="qc-big ${t.direction}">${pc(t.pct_per_decade)}<small>per decade</small></div>
      <span class="qbadge ${t.significant ? "sig" : "ns"}">${t.significant ? "Significant" : "Not significant"} · p = ${pTxt(t.p_adjusted)}</span>
      <div class="qc-chart"></div>
      <p class="qc-fine">Sen's slope ${t.sen_per_year > 0 ? "+" : "−"}${v.fmt(Math.abs(t.sen_per_year))} per year · autocorrelation-adjusted Mann–Kendall · <span>${v.src}</span></p>`;
    miniChart(el.querySelector(".qc-chart"), years, s, t, v.color, v.fmt);
    return el;
  }

  function renderQ1() {
    const A = Q.areas[st.area], tr = A.trend;
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const phrase = (v) => { const t = tr[v.k]; return `${v.k === "fire" ? "fire hotspots" : v.k === "aod" ? "AOD" : "surface PM₂.₅"} ${t.direction === "down" ? "fell" : "rose"} ${Math.abs(t.pct_per_decade).toFixed(0)}% per decade (p = ${pTxt(t.p_adjusted)})`; };
    const sig = VARS.filter((v) => tr[v.k].significant), ns = VARS.filter((v) => !tr[v.k].significant);
    p1.innerHTML = `<h3 class="q-title">Have fire hotspots, AOD and surface PM₂.₅ changed in ${st.area === "Both islands" ? "Sumatra and Kalimantan" : st.area}, ${years[0]}–${years.at(-1)}?</h3>
      <div class="qgrid"></div>
      <p class="q-answer"><b>Answer.</b> ${cap(joinList(sig.map(phrase)) || "No variable shows a statistically significant trend")}${sig.length ? ` — ${sig.length === 1 ? "this trend is" : "these trends are"} statistically significant at 5%` : ""}.
        ${ns.length ? `${cap(joinList(ns.map(phrase)))} — ${ns.length === 1 ? "this trend is" : "these trends are"} <b>not</b> significant at 5%, so the data cannot rule out no change. A trend that is not yet significant is still a finding: a longer record could settle it.` : ""}
        A recurring pollution peak does not necessarily indicate an increasing trend.</p>
      <h4 class="q-sub">Sumatra vs Kalimantan</h4>
      <div class="q-tablewrap"><table class="qtable"><thead><tr><th>Variable</th><th>Sumatra</th><th>Kalimantan</th><th>Both islands</th></tr></thead><tbody>${VARS.map((v) => `<tr><td><b>${v.name}</b></td>${["Sumatra", "Kalimantan", "Both islands"].map((a) => { const t = Q.areas[a].trend[v.k]; return `<td class="${t.significant ? "sig" : ""}">${pc(t.pct_per_decade)} <small>p = ${pTxt(t.p_adjusted)}${t.significant ? " ✓" : ""}</small></td>`; }).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="q-method">${Q.method.trend}. ✓ = significant at 5%. Values are one Jul–Oct summary per year (23 complete seasons, no missing months). ${Q.method.pm25}: model-based, and it can overestimate inside fire plumes.</p>`;
    const g = p1.querySelector(".qgrid"); VARS.forEach((v) => g.append(trendCard(v, A)));
  }

  function renderQ2() {
    const A = Q.areas[st.area], C = A.compare, S = A.series, hi = new Set(C.high_years), lo = new Set(C.low_years);
    const idx = (ys) => ys.map((y) => years.indexOf(y)), mean = (k, ys) => d3.mean(idx(ys).map((i) => S[k][i]));
    p2.innerHTML = `<h3 class="q-title">Do seasons with more fire hotspots coincide with higher AOD and surface PM₂.₅ in ${st.area === "Both islands" ? "Sumatra and Kalimantan" : st.area}?</h3>
      <div class="q-legend"><span><i style="background:${HIGH}"></i>${C.k} highest-fire seasons</span><span><i style="background:${LOW}"></i>${C.k} lowest-fire seasons</span><span><i style="background:${MID}"></i>other seasons</span></div>
      <div class="q-linked" id="qLinked"><div class="qtip" id="qTip"></div></div>
      <div class="q-tablewrap"><table class="qtable"><thead><tr><th></th><th>${C.k} highest-fire seasons</th><th>${C.k} lowest-fire seasons</th><th>Ratio</th><th>Mann–Whitney p</th><th>Spearman ρ, all ${years.length} seasons</th></tr></thead><tbody>
        <tr><td><b>Fire hotspots</b></td><td>${VARS[0].fmt(mean("fire", C.high_years))}</td><td>${VARS[0].fmt(mean("fire", C.low_years))}</td><td>×${(mean("fire", C.high_years) / mean("fire", C.low_years)).toFixed(1)}</td><td>—</td><td>—</td></tr>
        ${["aod", "pm25"].map((k, i) => { const x = C[k], v = VARS[i + 1]; return `<tr><td><b>${v.name}</b></td><td>${v.fmt(x.high_mean)}</td><td>${v.fmt(x.low_mean)}</td><td>×${x.ratio.toFixed(1)}</td><td>${pTxt(x.mannwhitney_p)}</td><td>${x.spearman_rho.toFixed(2)} <small>p ${pTxt(x.spearman_p)}</small></td></tr>`; }).join("")}</tbody></table></div>
      <p class="q-answer"><b>Answer.</b> Yes. In the ${C.k} highest-fire seasons the Jul–Oct AOD was <b>×${C.aod.ratio.toFixed(1)}</b> and surface PM₂.₅ <b>×${C.pm25.ratio.toFixed(1)}</b> the level of the ${C.k} lowest-fire seasons (both p ${pTxt(Math.max(C.aod.mannwhitney_p, C.pm25.mannwhitney_p)) }), and across all ${years.length} seasons fire rank tracks AOD (ρ = ${C.aod.spearman_rho.toFixed(2)}) and PM₂.₅ (ρ = ${C.pm25.spearman_rho.toFixed(2)}).</p>
      <p class="q-method"><b>Association, not causation.</b> AOD and PM₂.₅ do not identify fire as the only source of particles, and both come from the same MERRA-2 aerosol model, so they are not independent evidence of each other. High-fire years here: ${C.high_years.join(", ")}; low-fire years: ${C.low_years.join(", ")}. <button class="q-link" type="button" id="qMap">Open 2015 on the map →</button></p>`;
    // three linked charts sharing the x axis
    const host = $("#qLinked"), W = 920, rowH = 112, m = { l: 62, r: 10, t: 22, b: 4 }, xAx = 20;
    const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${rowH * 3 + xAx}`).attr("role", "img").attr("aria-label", "Linked yearly charts of fire hotspots, AOD and PM2.5, highlighting the highest- and lowest-fire seasons");
    const x = d3.scaleBand().domain(years).range([m.l, W - m.r]).padding(0.2), cols = (yr) => (hi.has(yr) ? HIGH : lo.has(yr) ? LOW : MID);
    const rows = VARS.map((v, r) => {
      const g = svg.append("g").attr("transform", `translate(0,${r * rowH})`), vals = S[v.k], y = d3.scaleLinear().domain([0, d3.max(vals) * 1.08]).nice().range([rowH - m.b, m.t]);
      g.selectAll("line").data(y.ticks(3)).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y).attr("stroke", "rgba(255,255,255,.07)");
      g.selectAll("text.t").data(y.ticks(3)).join("text").attr("class", "t").attr("x", m.l - 6).attr("y", (d) => y(d) + 3).attr("text-anchor", "end").attr("fill", "#8d8c84").attr("font-size", 10).attr("font-family", "monospace").text((d) => (d >= 1000 ? d3.format(".2s")(d) : d));
      g.append("text").attr("x", m.l).attr("y", 14).attr("fill", v.color).attr("font-size", 11).attr("font-weight", 600).text(v.name);
      g.selectAll("rect").data(years).join("rect").attr("x", (d) => x(d)).attr("width", x.bandwidth()).attr("y", (d, i) => y(vals[i])).attr("height", (d, i) => y(0) - y(vals[i])).attr("rx", 2).attr("fill", cols);
      return { g, y, vals, v };
    });
    [years[0], 2005, 2010, 2015, 2020, years.at(-1)].forEach((d) => svg.append("text").attr("x", x(d) + x.bandwidth() / 2).attr("y", rowH * 3 + 14).attr("text-anchor", "middle").attr("fill", "#8d8c84").attr("font-size", 10).attr("font-family", "monospace").text(d));
    const cur = svg.append("line").attr("y1", 0).attr("y2", rowH * 3).attr("stroke", "rgba(255,255,255,.5)").style("display", "none"), tip = $("#qTip");
    svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", rowH * 3).attr("fill", "transparent")
      .on("mousemove", (ev) => { const [mx] = d3.pointer(ev); const i = Math.max(0, Math.min(years.length - 1, Math.floor(((mx - m.l) / (W - m.l - m.r)) * years.length))), cx = x(years[i]) + x.bandwidth() / 2;
        cur.attr("x1", cx).attr("x2", cx).style("display", ""); const kind = hi.has(years[i]) ? "highest-fire season" : lo.has(years[i]) ? "lowest-fire season" : "";
        tip.style.display = "block"; tip.innerHTML = `<b>${years[i]}</b>${kind ? ` · ${kind}` : ""}<br>${VARS.map((v) => `${v.name}: <b>${v.fmt(S[v.k][i])}</b>`).join("<br>")}`;
        const r = svg.node().getBoundingClientRect(), hr = host.getBoundingClientRect(); tip.style.left = Math.min(hr.width - 210, (r.left - hr.left) + (cx / W) * r.width + 14) + "px"; tip.style.top = "14px"; })
      .on("mouseleave", () => { cur.style("display", "none"); tip.style.display = "none"; });
    $("#qMap")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("gq:run", { detail: { what: "smoke", where: st.area === "Both islands" ? "Kalimantan" : st.area, year: "2015" } })));
  }

  function render() {
    $("#qt1").setAttribute("aria-selected", st.q === 1); $("#qt2").setAttribute("aria-selected", st.q === 2);
    document.querySelectorAll("[data-area]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.area === st.area));
    p1.hidden = st.q !== 1; p2.hidden = st.q !== 2;
    (st.q === 1 ? renderQ1 : renderQ2)();
  }
  $("#qt1").addEventListener("click", () => { st.q = 1; render(); });
  $("#qt2").addEventListener("click", () => { st.q = 2; render(); });
  document.querySelectorAll("[data-area]").forEach((b) => b.addEventListener("click", () => { st.area = b.dataset.area; render(); }));
  render();
}
