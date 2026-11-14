// 2D evidence charts (D3). One y-axis per chart, thin marks, recessive grid, hover tooltips.
import * as d3 from "d3";

const C = {
  obs: "#d95926", model: "#3987e5", aqua: "#199e70", muted: "#4a5260", grid: "#262d38",
  neg: "#3987e5", mid: "#383835", pos: "#e66767", text: "#c3c2b7", text3: "#8d8c84",
};
const fmt = d3.format(",.0f");
const tip = document.getElementById("tip");
export function showTip(html, ev) {
  tip.innerHTML = html;
  tip.style.opacity = 1;
  const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = ev.clientY + 14 + tip.offsetHeight > window.innerHeight ? ev.clientY - tip.offsetHeight - 10 : ev.clientY + 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
export function hideTip() { tip.style.opacity = 0; }

function frame(el, h, m = { t: 14, r: 16, b: 30, l: 52 }) {
  el.innerHTML = "";
  const W = el.clientWidth || 500;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${h}`).attr("height", h);
  return { svg, W, H: h, m, iw: W - m.l - m.r, ih: h - m.t - m.b, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`) };
}
const logTicks = [1000, 3000, 10000, 30000, 100000, 300000];
const kfmt = (v) => (v >= 1000 ? d3.format("~s")(v).replace("k", "k") : v);

// ------------------------------------------------------------------ trend table
export function trendTable(el, trends) {
  const fmtP = (p) => (p < 0.001 ? "<0.001" : p.toFixed(3));
  const maxPct = d3.max(trends, (t) => Math.abs(t.pct_per_decade ?? 0));
  const rows = trends.filter((t) => !["oni", "dmi"].includes(t.key)).concat(trends.filter((t) => ["oni", "dmi"].includes(t.key)));
  el.innerHTML = `<thead><tr><th>Variable</th><th>Years</th><th>Direction</th><th class="num">Sen slope</th><th class="num">% / decade</th><th class="num">p (Hamed–Rao)</th><th>Significant?</th></tr></thead>
  <tbody>${rows.map((t) => {
    const pct = t.pct_per_decade;
    const showPct = ["oni", "dmi"].includes(t.key) ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
    const bw = ["oni", "dmi"].includes(t.key) ? 0 : Math.round(60 * Math.abs(pct) / Math.min(maxPct, 60));
    return `<tr><td>${t.label}<br><span class="note">${t.unit}</span></td><td class="num">${t.years[0]}–${t.years[1]}</td>
      <td><span class="dir ${t.sen_slope < 0 ? "down" : "up"}">${t.sen_slope < 0 ? "▼ falling" : "▲ rising"}</span></td>
      <td class="num">${Math.abs(t.sen_slope) >= 100 ? d3.format("+,.0f")(t.sen_slope) : d3.format("+.3~g")(t.sen_slope)}</td>
      <td class="num">${showPct} <span class="slopebar" style="width:${Math.min(bw, 60)}px;background:${t.sen_slope < 0 ? C.neg : C.pos};opacity:${t.significant ? 0.9 : 0.3}"></span></td>
      <td class="num">${fmtP(t.p)}</td>
      <td><span class="sig ${t.significant ? "yes" : "no"}"><span class="dot"></span>${t.significant ? "Yes" : "No"}</span></td></tr>`;
  }).join("")}</tbody>`;
}

// ------------------------------------------------------------------ spatial trend map
export function trendMap(el, legendEl, cells, land) {
  const F = frame(el, Math.max(300, (el.clientWidth || 500) * 0.56), { t: 6, r: 6, b: 6, l: 6 });
  const proj = d3.geoEquirectangular().fitExtent([[0, 0], [F.iw, F.ih]], {
    type: "MultiPoint", coordinates: [[95, -6.5], [119, 6]] });
  const ringPath = (r) => "M" + r.map((c) => proj(c).map((v) => v.toFixed(1)).join(",")).join("L") + "Z";
  F.g.append("g").selectAll("path").data(land).join("path")
    .attr("d", ringPath)
    .attr("fill", "#1b212b").attr("stroke", "#323a47").attr("stroke-width", 0.6);
  const lim = d3.quantile(cells.map((c) => Math.abs(c.sen)).sort(d3.ascending), 0.95);
  const col = d3.scaleDiverging([-lim, 0, lim], (t) => d3.interpolateRgbBasis([C.neg, C.mid, C.pos])(t)).clamp(true);
  const [x0, y0] = proj([95, 6]), [x1] = proj([95.5, 6]);
  const s = x1 - x0;
  F.g.append("g").selectAll("rect").data(cells).join("rect")
    .attr("x", (c) => proj([c.lon - 0.25, c.lat + 0.25])[0] + 0.5)
    .attr("y", (c) => proj([c.lon - 0.25, c.lat + 0.25])[1] + 0.5)
    .attr("width", s - 1).attr("height", s - 1).attr("rx", 1.5)
    .attr("fill", (c) => col(c.sen)).attr("opacity", (c) => (c.sig_fdr ? 1 : 0.35))
    .on("mousemove", (ev, c) => showTip(
      `<span class="tk">${c.lon.toFixed(2)}°E, ${c.lat.toFixed(2)}°</span><br>Trend: <b>${d3.format("+.1f")(c.sen)}</b> detections/yr<br>
       Mean before 2016: <b>${fmt(c.pre)}</b> · after: <b>${fmt(c.post)}</b><br>p = ${c.p.toFixed(3)} · ${c.sig_fdr ? "<b>FDR significant</b>" : "not significant after FDR"}`, ev))
    .on("mouseleave", hideTip);
  // label a few places
  [["Riau", 101.6, 0.9], ["South Sumatra", 104.6, -3.5], ["Central Kalimantan", 113.4, -2.6], ["East Kalimantan", 116.4, 1.8]].forEach(([n, lo, la]) => {
    const [px, py] = proj([lo, la]);
    F.g.append("text").attr("x", px).attr("y", py).attr("fill", C.text).attr("font-size", 11).attr("text-anchor", "middle")
      .attr("paint-order", "stroke").attr("stroke", "#151a22").attr("stroke-width", 3).text(n);
  });
  const dec = cells.filter((c) => c.sen < 0 && c.sig_fdr).length, inc = cells.filter((c) => c.sen > 0 && c.sig_fdr).length;
  legendEl.innerHTML = `<span>Falling</span><span class="divbar"></span><span>Rising</span>
    <span class="note">±${lim.toFixed(0)} detections/yr per cell · ${dec} cells significantly falling, ${inc} rising, ${cells.length} tested</span>`;
}

// ------------------------------------------------------------------ governance gap
export function gapChart(el, legendEl, T, A) {
  const F = frame(el, 300);
  const cf = A.chain.soil_to_fires.coef;
  const rows = T.filter((r) => r.year >= 2003 && r.fires_season).map((r) => ({
    year: r.year, obs: r.fires_season, pre: Math.exp(cf.intercept + cf.soil * r.soil),
  }));
  const x = d3.scaleBand().domain(rows.map((r) => r.year)).range([0, F.iw]).padding(0.3);
  const y = d3.scaleLog().domain([2000, 300000]).range([F.ih, 0]);
  const rs = A.changepoint.regime_start;
  F.g.append("rect").attr("x", x(rs) - x.step() * 0.15).attr("width", F.iw - x(rs) + x.step() * 0.15).attr("height", F.ih).attr("fill", "#ffffff06");
  F.g.append("text").attr("x", x(rs) + 4).attr("y", 12).attr("fill", C.text3).attr("font-size", 11).text(`Pettitt break → ${rs} (p = ${A.changepoint.regime_p.toFixed(3)})`);
  F.g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickSize(-F.iw).tickFormat(""));
  F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickFormat(kfmt)).select(".domain").remove();
  F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.ih})`).call(d3.axisBottom(x).tickValues(rows.map((r) => r.year).filter((v) => v % 4 === 3))).select(".domain").remove();
  F.g.selectAll(".b").data(rows).join("rect").attr("x", (r) => x(r.year)).attr("width", x.bandwidth())
    .attr("y", (r) => y(r.obs)).attr("height", (r) => F.ih - y(r.obs)).attr("rx", 2).attr("fill", C.obs);
  F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", C.model).attr("stroke-width", 2)
    .attr("d", d3.line().x((r) => x(r.year) + x.bandwidth() / 2).y((r) => y(r.pre)));
  F.g.selectAll(".p").data(rows).join("circle").attr("cx", (r) => x(r.year) + x.bandwidth() / 2).attr("cy", (r) => y(r.pre)).attr("r", 3)
    .attr("fill", C.model).attr("stroke", "#151a22").attr("stroke-width", 2);
  F.g.selectAll(".hit").data(rows).join("rect").attr("x", (r) => x(r.year) - x.step() * 0.15).attr("width", x.step()).attr("height", F.ih).attr("fill", "transparent")
    .on("mousemove", (ev, r) => showTip(`<span class="tk">${r.year}</span><br>Observed: <b>${fmt(r.obs)}</b><br>Expected from soil wetness, pre-2016 regime: <b>${fmt(r.pre)}</b><br>Ratio: <b>${(r.obs / r.pre).toFixed(2)}×</b>`, ev))
    .on("mouseleave", hideTip);
  const eff = Math.round(-100 * A.chain.regime_effect);
  legendEl.innerHTML = `<span><i class="sw" style="background:${C.obs}"></i>Observed detections</span><span><i class="sw line" style="background:${C.model}"></i>Expected from soil wetness alone (pre-2016 regime)</span><span class="note">At equal dryness, post-2016 seasons burn ${eff}% less (p &lt; 0.001)</span>`;
}

// ------------------------------------------------------------------ lag small multiples
export function lagChart(el, lags) {
  const names = { "oni->rain": "ENSO → rain", "dmi->rain": "IOD → rain", "rain->soil": "Rain → soil", "soil->fires": "Soil → fire", "fires->aod": "Fire → haze" };
  const keys = Object.keys(names);
  const F = frame(el, 280, { t: 26, r: 8, b: 30, l: 36 });
  const gw = F.iw / keys.length;
  const y = d3.scaleLinear().domain([-0.8, 0.8]).range([F.ih, 0]);
  F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSize(-F.iw)).call((g) => { g.select(".domain").remove(); g.selectAll("line").attr("stroke", C.grid); });
  F.g.append("line").attr("x1", 0).attr("x2", F.iw).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#4a5260");
  keys.forEach((k, gi) => {
    const g = F.g.append("g").attr("transform", `translate(${gi * gw + 6},0)`);
    const x = d3.scaleBand().domain(d3.range(7)).range([0, gw - 12]).padding(0.25);
    const best = d3.maxIndex(lags[k], (d) => Math.abs(d.r));
    g.append("text").attr("x", (gw - 12) / 2).attr("y", -10).attr("text-anchor", "middle").attr("fill", C.text).attr("font-size", 12).text(names[k]);
    g.selectAll("rect").data(lags[k]).join("rect").attr("x", (d) => x(d.lag)).attr("width", x.bandwidth())
      .attr("y", (d) => y(Math.max(0, d.r))).attr("height", (d) => Math.abs(y(d.r) - y(0))).attr("rx", 1.5)
      .attr("fill", (d, i) => (i === best ? "#ff9a3c" : "#4a5260"))
      .on("mousemove", (ev, d) => showTip(`${names[k]}<br>lag <b>${d.lag}</b> month(s): r = <b>${d.r.toFixed(2)}</b><br><span class="tk">p ${d.p < 0.001 ? "< 0.001" : "= " + d.p.toFixed(3)}</span>`, ev))
      .on("mouseleave", hideTip);
    g.append("text").attr("x", (gw - 12) / 2).attr("y", F.ih + 18).attr("text-anchor", "middle").attr("fill", C.text3).attr("font-size", 10).text("lag 0 → 6 mo");
  });
}

// ------------------------------------------------------------------ hindcast
export function hindChart(el, legendEl, A) {
  const F = frame(el, 280);
  const rows = A.hindcast;
  const x = d3.scaleLinear().domain(d3.extent(rows, (r) => r.year)).range([0, F.iw]);
  const y = d3.scaleLog().domain([2000, 300000]).range([F.ih, 0]);
  F.g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickSize(-F.iw).tickFormat(""));
  F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickFormat(kfmt)).select(".domain").remove();
  F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(d3.format("d"))).select(".domain").remove();
  const line = (k) => d3.line().x((r) => x(r.year)).y((r) => y(r[k]));
  F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", C.obs).attr("stroke-width", 2).attr("d", line("obs"));
  F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", C.model).attr("stroke-width", 2).attr("d", line("loo"));
  F.g.selectAll(".o").data(rows).join("circle").attr("cx", (r) => x(r.year)).attr("cy", (r) => y(r.obs)).attr("r", 3.5).attr("fill", C.obs).attr("stroke", "#151a22").attr("stroke-width", 2);
  const fl = A.chain.soil_to_fires;
  F.g.append("rect").attr("width", F.iw).attr("height", F.ih).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const [mx] = d3.pointer(ev);
      const r = rows[d3.minIndex(rows, (d) => Math.abs(x(d.year) - mx))];
      showTip(`<span class="tk">${r.year}</span><br>Observed: <b>${fmt(r.obs)}</b><br>Predicted (year held out): <b>${fmt(r.loo)}</b>`, ev);
    }).on("mouseleave", hideTip);
  legendEl.innerHTML = `<span><i class="sw line" style="background:${C.obs}"></i>Observed</span><span><i class="sw line" style="background:${C.model}"></i>Cross-validated prediction</span><span class="note">LOO R² = ${fl.r2_loo.toFixed(2)} on ln(detections)</span>`;
}
