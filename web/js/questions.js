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

function miniChart(host, years, vals, tr, color, fmt, ymax, mark) {
  const W = 440, H = 118, m = { l: 40, r: 8, t: 8, b: 20 };
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Yearly line chart with the Sen's slope trend line; hover a year for its value");
  const x = d3.scalePoint().domain(years).range([m.l + 4, W - m.r - 4]), y = d3.scaleLinear().domain([0, ymax ?? d3.max(vals) * 1.06]).nice().range([H - m.b, m.t]);
  svg.append("g").selectAll("line").data(y.ticks(3)).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y).attr("stroke", "rgba(255,255,255,.08)");
  svg.append("g").selectAll("text").data(y.ticks(3)).join("text").attr("x", m.l - 5).attr("y", (d) => y(d) + 3).attr("text-anchor", "end").attr("fill", "#8d8c84").attr("font-size", 9).attr("font-family", "monospace").text((d) => (d >= 1000 ? d3.format(".2s")(d) : d));
  const n = vals.length - 1, med = tr ? d3.median(vals.map((v, i) => v - tr.sen_per_year * i)) : 0, trendAt = (i) => Math.max(0, med + (tr ? tr.sen_per_year : 0) * i);
  const col = (yr) => (mark ? (mark.hi.has(yr) ? HIGH : mark.lo.has(yr) ? LOW : MID) : color), rad = (yr) => (mark && (mark.hi.has(yr) || mark.lo.has(yr)) ? 3.4 : 2.2);
  if (mark) svg.insert("g", "path").selectAll("rect").data(years.filter((yr) => mark.hi.has(yr) || mark.lo.has(yr))).join("rect").attr("x", (d) => x(d) - x.step() / 2).attr("width", x.step()).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", (d) => (mark.hi.has(d) ? HIGH : LOW)).attr("opacity", 0.1);
  if (tr) svg.append("line").attr("x1", x(years[0])).attr("x2", x(years.at(-1))).attr("y1", y(trendAt(0))).attr("y2", y(trendAt(n)))
    .attr("stroke", "#f0efec").attr("stroke-width", 1.6).attr("stroke-dasharray", "5 3").attr("opacity", 0.85);
  svg.append("path").datum(vals).attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.8).attr("stroke-linejoin", "round").attr("d", d3.line().x((d, i) => x(years[i])).y((d) => y(d)));
  const dots = svg.append("g").selectAll("circle").data(years).join("circle").attr("cx", (d) => x(d)).attr("cy", (d, i) => y(vals[i])).attr("r", rad).attr("fill", col).attr("stroke", "#0b0e14").attr("stroke-width", 0.8);
  const peak = vals.indexOf(d3.max(vals));
  if (!mark) svg.append("text").attr("x", x(years[peak])).attr("y", y(vals[peak]) - 5).attr("text-anchor", "middle").attr("fill", "#c9c7bd").attr("font-size", 8.5).attr("font-family", "monospace").text(years[peak]);
  [years[0], years[Math.floor(n / 2)], years.at(-1)].forEach((d) => svg.append("text").attr("x", x(d)).attr("y", H - 6).attr("text-anchor", "middle").attr("fill", "#8d8c84").attr("font-size", 9).attr("font-family", "monospace").text(d));
  const cur = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "rgba(255,255,255,.45)").style("display", "none");
  const ring = svg.append("circle").attr("r", 5).attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 1.5).style("display", "none");
  const tip = document.createElement("div"); tip.className = "qtip"; host.append(tip);
  const idxAt = (ev) => { const [mx] = d3.pointer(ev, svg.node()); return Math.max(0, Math.min(n, Math.round(((mx - x.range()[0]) / (x.range()[1] - x.range()[0])) * n))); };
  function show(i) {
    const cx = x(years[i]), t = trendAt(i), dv = t ? ((vals[i] - t) / t) * 100 : 0;
    cur.attr("x1", cx).attr("x2", cx).style("display", ""); ring.attr("cx", cx).attr("cy", y(vals[i])).style("display", "");
    dots.attr("r", (d, k) => (k === i ? 4.6 : rad(d)));
    tip.style.display = "block";
    tip.innerHTML = mark
      ? `<b>${years[i]}</b> · ${fmt(vals[i])}<br><span>${mark.hi.has(years[i]) ? "one of the highest-fire seasons" : mark.lo.has(years[i]) ? "one of the lowest-fire seasons" : "an average-fire season"}</span>`
      : `<b>${years[i]}</b> · ${fmt(vals[i])}${i === peak ? " <em>(peak season)</em>" : ""}<br><span>trend line: ${fmt(t)} → this season is ${Math.abs(dv).toFixed(0)}% ${dv >= 0 ? "above" : "below"} trend</span>`;
    const r = svg.node().getBoundingClientRect(), hr = host.getBoundingClientRect(), left = (r.left - hr.left) + (cx / W) * r.width;
    tip.style.left = Math.max(0, Math.min(hr.width - 200, left - 100)) + "px";
  }
  function hide() { cur.style("display", "none"); ring.style("display", "none"); dots.attr("r", rad); tip.style.display = "none"; }
  svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l).attr("height", H).attr("fill", "transparent")
    .on("mousemove", (ev) => host.dispatchEvent(new CustomEvent("qyear", { bubbles: true, detail: idxAt(ev) }))).on("mouseleave", () => host.dispatchEvent(new CustomEvent("qyear", { bubbles: true, detail: -1 })));
  return { show, hide };
}

export async function initQuestions() {
  const p1 = $("#qPanel1"), p2 = $("#qPanel2"); if (!p1 || !p2) return;
  let Q; try { Q = await (await fetch("data/questions.json")).json(); } catch { p1.textContent = "Could not load the results."; return; }
  const st = { q: 1, area: "Both islands", plain: false }, years = Q.years;
  // every answer comes in two versions: technical (statistics) and plain words (no jargon); the choice is kept across both questions
  const answerBlock = (tech, plain) => `<div class="q-answer-wrap">
      <div class="q-mode" role="group" aria-label="Answer style"><button type="button" data-mode="tech" aria-pressed="${!st.plain}">Technical</button><button type="button" data-mode="plain" aria-pressed="${st.plain}">In plain words</button></div>
      <div class="q-answer q-ans" data-ans="tech" ${st.plain ? "hidden" : ""}><b>Answer.</b> ${tech}</div>
      <div class="q-answer q-ans" data-ans="plain" ${st.plain ? "" : "hidden"}>${plain}</div></div>`;
  const setMode = (plain) => { st.plain = plain; document.querySelectorAll(".q-mode button").forEach((b) => b.setAttribute("aria-pressed", (b.dataset.mode === "plain") === plain)); document.querySelectorAll(".q-ans").forEach((a) => (a.hidden = (a.dataset.ans === "plain") !== plain)); };
  document.addEventListener("click", (e) => { const b = e.target.closest(".q-mode button"); if (b) setMode(b.dataset.mode === "plain"); });
  const sure = (t) => (t.significant ? "<b>clearly real</b>" : "<b>too uncertain to be sure</b>");
  const timesWord = (r) => (r >= 2.95 ? "about three times" : `about ${r.toFixed(1)} times`);

  const ISL1 = ["Sumatra", "Kalimantan"];
  const DESC = {
    fire: "Active-fire detections by the MODIS satellites (Terra + Aqua), summed over the area's cells for July–October each year.",
    aod: "Aerosol optical depth: how much sunlight airborne particles block through the whole air column, from ground to space. Above about 1 the sky looks hazy.",
    pm25: "Surface PM₂.₅: mass of particles smaller than 2.5 µm in the air near the ground (µg/m³), estimated from MERRA-2 aerosol components.",
  };
  function trendCard(v, name, ymax) {
    const A = Q.areas[name], t = A.trend[v.k], s = A.series[v.k];
    const el = document.createElement("div"); el.className = "qcard";
    const sen = (v.k === "aod" ? d3.format(".3f") : v.k === "pm25" ? d3.format(".2f") : v.fmt)(Math.abs(t.sen_per_year));
    el.innerHTML = `<div class="qc-top"><div class="qc-head"><b>${name}</b><small>${A.n_cells} cells</small></div>
      <div class="qc-big ${t.direction}" data-tip="Change per decade = Sen's slope ÷ the average, ×10. Slope: ${t.sen_per_year > 0 ? "+" : "−"}${sen} per year.">${pc(t.pct_per_decade)}<small>per decade</small></div>
      <span class="qbadge ${t.significant ? "sig" : "ns"}" data-tip="${t.significant ? "Significant: p < 0.05, so a change this large would be unlikely by chance alone." : "Not significant: p ≥ 0.05, so the data cannot rule out no change."} Autocorrelation-adjusted Mann–Kendall.">${t.significant ? "Significant" : "Not significant"} · p = ${pTxt(t.p_adjusted)}</span></div>
      <div class="qc-chart"></div>`;
    const ctl = miniChart(el.querySelector(".qc-chart"), years, s, t, v.color, v.fmt, ymax);
    return { el, ctl };
  }

  function renderQ1() {
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const word = (v) => (v.k === "fire" ? "fire hotspots" : v.k === "aod" ? "AOD" : "surface PM₂.₅");
    const phrase = (n, v) => { const t = Q.areas[n].trend[v.k]; return `${word(v)} ${t.direction === "down" ? "fell" : "rose"} ${Math.abs(t.pct_per_decade).toFixed(0)}% per decade (p = ${pTxt(t.p_adjusted)}, ${t.significant ? "significant" : "not significant"})`; };
    const ansIsl = ISL1.map((n) => `<b>${n}:</b> ${joinList(VARS.map((v) => phrase(n, v)))}.`).join(" ");
    const fall = (n, v) => { const t = Q.areas[n].trend[v.k]; return `${Math.abs(t.pct_per_decade).toFixed(0)}% ${t.direction === "down" ? "lower" : "higher"} each decade in ${n} (${sure(t)})`; };
    const plain1 = `<b>In short:</b> fires have clearly gone down, while smoke haze and fine particles have gone down too, but we are less sure about them.<ul class="q-plain">${VARS.map((v) => `<li><b>${v.k === "fire" ? "Fires" : v.k === "aod" ? "Smoke haze (AOD)" : "Fine particles near the ground (PM₂.₅)"}:</b> ${ISL1.map((n) => fall(n, v)).join("; ")}.</li>`).join("")}</ul>
      “Too uncertain” does not mean nothing changed. It means these years of data are too bumpy to be sure, and a longer record could settle it. One very smoky year is not a rising trend.`;
    p1.innerHTML = `<h3 class="q-title">Have fire hotspots, AOD and surface PM₂.₅ changed in Sumatra and Kalimantan, ${years[0]}–${years.at(-1)}? Side by side</h3>
      <div class="q1-rows"></div>
      ${answerBlock(`${ansIsl} Where p ≥ 0.05 the data cannot rule out no change; a trend that is not yet significant is still a finding, and a longer record could settle it. A recurring pollution peak does not necessarily indicate an increasing trend.`, plain1)}
      <h4 class="q-sub">Sumatra vs Kalimantan vs both islands</h4>
      <div class="q-tablewrap"><table class="qtable"><thead><tr><th>Variable</th><th>Sumatra</th><th>Kalimantan</th><th>Both islands</th></tr></thead><tbody>${VARS.map((v) => `<tr><td><b>${v.name}</b></td>${["Sumatra", "Kalimantan", "Both islands"].map((a) => { const t = Q.areas[a].trend[v.k]; return `<td class="${t.significant ? "qsig" : ""}">${pc(t.pct_per_decade)} <small>p = ${pTxt(t.p_adjusted)}${t.significant ? " ✓" : ""}</small></td>`; }).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="q-method">${Q.method.trend}. ✓ = significant at 5%. Values are one Jul–Oct summary per year (23 complete seasons, no missing months). Both panels of a variable share the same y axis; hover a year to compare the islands. ${Q.method.pm25}: model-based, and it can overestimate inside fire plumes.</p>`;
    const host = p1.querySelector(".q1-rows");
    VARS.forEach((v) => {
      const ymax = d3.max(ISL1, (n) => d3.max(Q.areas[n].series[v.k])) * 1.06;
      const row = document.createElement("div"); row.className = "q1-row";
      row.innerHTML = `<div class="q1-var" style="color:${v.color}"><b>${v.name}</b> <span class="q1-info" tabindex="0" data-tip="${DESC[v.k]}">ⓘ</span> <small>${v.unit} · ${v.src}</small></div><div class="q1-pair"></div>`;
      const cards = ISL1.map((n) => trendCard(v, n, ymax)); cards.forEach((c) => row.querySelector(".q1-pair").append(c.el));
      // hovering a year in one island shows the same year in the other
      row.addEventListener("qyear", (e) => cards.forEach((c) => (e.detail < 0 ? c.ctl.hide() : c.ctl.show(e.detail))));
      host.append(row);
    });
  }

  function renderQ2() {
    const ISL = ["Sumatra", "Kalimantan"], idx = (ys) => ys.map((y) => years.indexOf(y));
    const mean = (S, k, ys) => d3.mean(idx(ys).map((i) => S[k][i]));
    const k8 = Q.areas.Sumatra.compare.k;
    const rowsHtml = ISL.map((n) => { const C = Q.areas[n].compare, S = Q.areas[n].series; return `
        <tr class="grp"><td colspan="6">${n}</td></tr>
        <tr><td><b>Fire hotspots</b></td><td>${VARS[0].fmt(mean(S, "fire", C.high_years))}</td><td>${VARS[0].fmt(mean(S, "fire", C.low_years))}</td><td>×${(mean(S, "fire", C.high_years) / mean(S, "fire", C.low_years)).toFixed(1)}</td><td>—</td><td>—</td></tr>
        ${["aod", "pm25"].map((k, i) => { const x = C[k], v = VARS[i + 1]; return `<tr><td><b>${v.name}</b></td><td>${v.fmt(x.high_mean)}</td><td>${v.fmt(x.low_mean)}</td><td>×${x.ratio.toFixed(1)}</td><td>${pTxt(x.mannwhitney_p)}</td><td>${x.spearman_rho.toFixed(2)} <small>p ${pTxt(x.spearman_p)}</small></td></tr>`; }).join("")}`; }).join("");
    const ans = ISL.map((n) => { const C = Q.areas[n].compare; return `<b>${n}</b>: AOD <b>×${C.aod.ratio.toFixed(1)}</b> and surface PM₂.₅ <b>×${C.pm25.ratio.toFixed(1)}</b> (both p ${pTxt(Math.max(C.aod.mannwhitney_p, C.pm25.mannwhitney_p))}; Spearman ρ = ${C.aod.spearman_rho.toFixed(2)} for AOD, ${C.pm25.spearman_rho.toFixed(2)} for PM₂.₅)`; }).join("; ");
    const plain2 = `<b>In short: yes.</b> The years with the most fires were also the smokiest years, in both islands.<ul class="q-plain">${ISL.map((n) => { const C = Q.areas[n].compare; return `<li><b>${n}:</b> in the ${k8} worst fire years the haze was ${timesWord(C.aod.ratio)} and the fine particles ${timesWord(C.pm25.ratio)} as high as in the ${k8} calmest years.</li>`; }).join("")}</ul>
      This is a very strong pattern, but it shows that fire and smoke rise together, not that fire is the only cause. Dust, other burning and weather also add particles.`;
    p2.innerHTML = `<h3 class="q-title">Do seasons with more fire hotspots coincide with higher AOD and surface PM₂.₅? Sumatra and Kalimantan side by side</h3>
      <div class="q-legend"><span><i class="dot" style="background:${HIGH}"></i>${k8} highest-fire seasons</span><span><i class="dot" style="background:${LOW}"></i>${k8} lowest-fire seasons</span><span><i class="dot" style="background:${MID}"></i>other seasons</span><span>Same y axis in both panels · hover a year to see it in every chart</span></div>
      <div class="q1-rows"></div>
      <div class="q-tablewrap"><table class="qtable"><thead><tr><th></th><th>${k8} highest-fire seasons</th><th>${k8} lowest-fire seasons</th><th>Ratio</th><th>Mann–Whitney p</th><th>Spearman ρ, all ${years.length} seasons</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      ${answerBlock(`Yes, in both. In the highest-fire seasons the Jul–Oct level was ${ans}, relative to the lowest-fire seasons.`, plain2)}
      <p class="q-method"><b>Association, not causation.</b> AOD and PM₂.₅ do not identify fire as the only source of particles, and both come from the same MERRA-2 aerosol model, so they are not independent evidence of each other. High-fire years: Sumatra ${Q.areas.Sumatra.compare.high_years.join(", ")}; Kalimantan ${Q.areas.Kalimantan.compare.high_years.join(", ")}. <button class="q-link" type="button" id="qMap">Open 2015 on the map →</button></p>`;
    const host = p2.querySelector(".q1-rows"), all = [];
    VARS.forEach((v) => {
      const ymax = d3.max(ISL, (n) => d3.max(Q.areas[n].series[v.k])) * 1.06;
      const row = document.createElement("div"); row.className = "q1-row";
      row.innerHTML = `<div class="q1-var" style="color:${v.color}"><b>${v.name}</b> <span class="q1-info" tabindex="0" data-tip="${DESC[v.k]}">ⓘ</span> <small>${v.unit} · ${v.src}</small></div><div class="q1-pair"></div>`;
      ISL.forEach((n) => {
        const A = Q.areas[n], C = A.compare, el = document.createElement("div"); el.className = "qcard";
        const stat = v.k === "fire" ? { big: `×${(mean(A.series, "fire", C.high_years) / mean(A.series, "fire", C.low_years)).toFixed(1)}`, badge: "", tip: "Average fire hotspots in the highest-fire seasons divided by the lowest-fire seasons." }
          : { big: `×${C[v.k].ratio.toFixed(1)}`, badge: `Spearman ${C[v.k].spearman_rho.toFixed(2)} · p ${pTxt(C[v.k].mannwhitney_p)}`, tip: `Average ${v.name} in the highest-fire seasons divided by the lowest-fire seasons. Mann–Whitney p compares the two groups; Spearman ρ is the rank correlation with fire over all ${years.length} seasons.` };
        el.innerHTML = `<div class="qc-top"><div class="qc-head"><b>${n}</b><small>${A.n_cells} cells</small></div>
          <div class="qc-big up" data-tip="${stat.tip}">${stat.big}<small>high vs low-fire seasons</small></div>${stat.badge ? `<span class="qbadge sig" data-tip="${stat.tip}">${stat.badge}</span>` : ""}</div><div class="qc-chart"></div>`;
        const ctl = miniChart(el.querySelector(".qc-chart"), years, A.series[v.k], null, v.color, v.fmt, ymax, { hi: new Set(C.high_years), lo: new Set(C.low_years) });
        all.push(ctl); row.querySelector(".q1-pair").append(el);
      });
      host.append(row);
    });
    // one hover shows the same season in all six charts
    host.addEventListener("qyear", (e) => all.forEach((c) => (e.detail < 0 ? c.hide() : c.show(e.detail))));
    $("#qMap")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("gq:run", { detail: { what: "smoke", where: "Kalimantan", year: "2015" } })));
  }

  function render() {
    $("#qt1").setAttribute("aria-selected", st.q === 1); $("#qt2").setAttribute("aria-selected", st.q === 2);
    document.querySelectorAll("[data-area]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.area === st.area));
    p1.hidden = st.q !== 1; p2.hidden = st.q !== 2;
    const ar = document.querySelector(".qarea"); if (ar) ar.hidden = true;   // both questions show the two islands side by side
    (st.q === 1 ? renderQ1 : renderQ2)();
  }
  $("#qt1").addEventListener("click", () => { st.q = 1; render(); });
  $("#qt2").addEventListener("click", () => { st.q = 2; render(); });
  document.querySelectorAll("[data-area]").forEach((b) => b.addEventListener("click", () => { st.area = b.dataset.area; render(); }));
  render();

  // data quality, coverage, missing observations
  const q = Q.quality, tt = Object.values(Q.areas).flatMap((A) => Object.values(A.trend)), nSeasonalSig = tt.filter((t) => t.p_seasonal_monthly < 0.05).length;
  $("#qQualityBody").innerHTML = `<ul class="q-quality">
    <li><b>Coverage.</b> ${q.months} months (${q.years[0]}–${q.years[1]}), ${q.cells} half-degree cells (Sumatra ${Q.areas.Sumatra.n_cells}, Kalimantan ${Q.areas.Kalimantan.n_cells}), ${q.seasons} complete Jul–Oct seasons. The 2026 months are excluded because the year is incomplete.</li>
    <li><b>Missing observations.</b> ${q.fire_missing} missing fire, ${q.aod_missing} missing AOD and ${q.pm25_missing} missing PM₂.₅ cell-months in that period, so no gap-filling or interpolation was needed. ${q.zero_fire_cell_months_pct}% of cell-months have zero fire detections: that is a true zero (no detection), not missing data.</li>
    <li><b>Alignment.</b> Fire counts are per cell and month; each cell is matched to its nearest MERRA-2 grid point (${q.grid_points} distinct points, at most ${q.max_offset_deg}° away). An area's AOD and PM₂.₅ are means over its cells, its fire count is the sum. All series are then reduced to one Jul–Oct value per year, so seasonality cannot bias the trend.</li>
    <li><b>Sensitivity check.</b> A seasonal Mann–Kendall on all ${q.months} monthly values (not autocorrelation-adjusted, so more permissive) flags ${nSeasonalSig} of ${tt.length} area-variable series as significant, against the stricter yearly test shown above. Where the two disagree, the weaker evidence of the yearly test is the one reported.</li>
    <li><b>Known limits.</b> MODIS counts hotspots, not burned area, and cloud or thick smoke can hide fires. AOD and PM₂.₅ are MERRA-2 model analyses that assimilate satellite AOD, not independent ground measurements, and they come from the same aerosol model. Neither identifies fire as the only source of particles, and association is not causation.</li>
  </ul>`;
}
