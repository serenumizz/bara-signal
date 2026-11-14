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

// ------------------------------------------------------------------ timeline small multiples
export function indicators(el, T, onPick) {
  const defs = [
    { k: "fires_season", name: "Fire detections, Jul–Oct", src: "NASA FIRMS MODIS", unit: "", f: fmt, bar: true, color: C.obs },
    { k: "oni", name: "ENSO (ONI, Jul–Sep)", src: "NOAA CPC", unit: "°C", f: d3.format("+.2f"), zero: true, color: C.model },
    { k: "dmi", name: "Indian Ocean Dipole (DMI)", src: "NOAA PSL", unit: "°C", f: d3.format("+.2f"), zero: true, color: C.model },
    { k: "rain", name: "Dry-season rainfall", src: "NASA POWER", unit: "mm/day", f: d3.format(".1f"), color: C.model },
    { k: "soil", name: "Root-zone soil wetness", src: "NASA POWER", unit: "", f: d3.format(".2f"), color: C.aqua },
    { k: "aod", name: "Haze: aerosol optical depth", src: "MERRA-2", unit: "", f: d3.format(".2f"), color: C.muted },
  ];
  el.innerHTML = "";
  const parts = defs.map((d) => {
    const box = document.createElement("div");
    box.className = "ind";
    box.innerHTML = `<div class="ind-head"><span class="ind-name">${d.name}</span><span class="ind-src">${d.src}</span></div>
      <div class="ind-val"><span>—</span><small>${d.unit}</small></div><div class="ind-chart"></div>`;
    el.appendChild(box);
    const ch = box.querySelector(".ind-chart");
    const F = frame(ch, 74, { t: 6, r: 4, b: 16, l: 4 });
    const data = T.filter((r) => r[d.k] != null);
    const x = d3.scaleBand().domain(T.map((r) => r.year)).range([0, F.iw]).padding(0.25);
    const ext = d3.extent(data, (r) => r[d.k]);
    const y = d3.scaleLinear().domain(d.bar ? [0, ext[1]] : d.zero ? [Math.min(ext[0], 0), Math.max(ext[1], 0)] : ext).nice().range([F.ih, 0]);
    if (d.zero) F.g.append("line").attr("x1", 0).attr("x2", F.iw).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", C.grid);
    if (d.bar) {
      F.g.selectAll("rect").data(data).join("rect").attr("x", (r) => x(r.year)).attr("width", x.bandwidth())
        .attr("y", (r) => y(r[d.k])).attr("height", (r) => F.ih - y(r[d.k])).attr("rx", 1.5).attr("fill", d.color).attr("opacity", 0.55);
    } else {
      F.g.append("path").datum(data).attr("fill", "none").attr("stroke", d.color).attr("stroke-width", 2)
        .attr("d", d3.line().x((r) => x(r.year) + x.bandwidth() / 2).y((r) => y(r[d.k])).curve(d3.curveMonotoneX));
    }
    F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.ih})`)
      .call(d3.axisBottom(x).tickValues([2000, 2005, 2010, 2015, 2020, 2025]).tickSize(0).tickPadding(4)).select(".domain").remove();
    const cur = F.g.append("g");
    cur.append("line").attr("y1", 0).attr("y2", F.ih).attr("stroke", "#ffd36b").attr("stroke-width", 1).attr("opacity", 0.6);
    cur.append("circle").attr("r", 4).attr("fill", "#ffd36b").attr("stroke", "#0c1016").attr("stroke-width", 2);
    F.g.append("rect").attr("width", F.iw).attr("height", F.ih).attr("fill", "transparent").style("cursor", "pointer")
      .on("mousemove", (ev) => {
        const [mx] = d3.pointer(ev);
        const yr = T[Math.max(0, Math.min(T.length - 1, Math.floor(mx / x.step())))];
        showTip(`<span class="tk">${yr.year}</span><br>${d.name}: <b>${yr[d.k] == null ? "n/a" : d.f(yr[d.k])}</b> ${d.unit}`, ev);
      })
      .on("mouseleave", hideTip)
      .on("click", (ev) => { const [mx] = d3.pointer(ev); onPick(T[Math.floor(mx / x.step())].year); });
    return { d, x, y, cur, val: box.querySelector(".ind-val span") };
  });
  return (year) => {
    const r = T.find((t) => t.year === year);
    parts.forEach(({ d, x, y, cur, val }) => {
      const v = r[d.k];
      val.textContent = v == null ? "n/a" : d.f(v);
      const cx = x(year) + x.bandwidth() / 2;
      cur.attr("transform", `translate(${cx},0)`);
      cur.select("circle").attr("cy", v == null ? -20 : y(v)).attr("opacity", v == null ? 0 : 1);
    });
  };
}

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

// ------------------------------------------------------------------ 2026 vs history
export function simHist(el, T, sim) {
  const F = frame(el, 280);
  const rows = T.filter((r) => r.year >= 2003 && r.fires_season).map((r) => ({ year: r.year, v: r.fires_season }));
  rows.push({ year: 2026, v: sim.fires, lo: sim.lo, hi: sim.hi, sim: true });
  const x = d3.scaleBand().domain(rows.map((r) => r.year)).range([0, F.iw]).padding(0.25);
  const y = d3.scaleLog().domain([2000, 300000]).range([F.ih, 0]);
  F.g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickSize(-F.iw).tickFormat(""));
  F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickFormat(kfmt)).select(".domain").remove();
  F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.ih})`).call(d3.axisBottom(x).tickValues([2003, 2007, 2011, 2015, 2019, 2023, 2026])).select(".domain").remove();
  F.g.selectAll("rect.b").data(rows).join("rect").attr("class", "b").attr("x", (r) => x(r.year)).attr("width", x.bandwidth())
    .attr("y", (r) => y(r.v)).attr("height", (r) => F.ih - y(r.v)).attr("rx", 2)
    .attr("fill", (r) => (r.sim ? "#ffd36b" : r.year === 2015 || r.year === 2019 ? C.obs : "#4a5260"))
    .on("mousemove", (ev, r) => showTip(`<span class="tk">${r.year}${r.sim ? " (simulated)" : ""}</span><br><b>${fmt(r.v)}</b> detections${r.sim ? `<br>10–90%: ${fmt(r.lo)} – ${fmt(r.hi)}` : ""}`, ev))
    .on("mouseleave", hideTip);
  const s = rows[rows.length - 1], cx = x(2026) + x.bandwidth() / 2;
  F.g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", y(s.lo)).attr("y2", y(s.hi)).attr("stroke", "#f0efec").attr("stroke-width", 1.5);
  [s.lo, s.hi].forEach((v) => F.g.append("line").attr("x1", cx - 5).attr("x2", cx + 5).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", "#f0efec").attr("stroke-width", 1.5));
  [[2015, "2015"], [2019, "2019"]].forEach(([yr, t]) => {
    const r = rows.find((d) => d.year === yr);
    F.g.append("text").attr("x", x(yr) + x.bandwidth() / 2).attr("y", y(r.v) - 6).attr("text-anchor", "middle").attr("fill", C.text).attr("font-size", 11).text(t);
  });
  F.g.append("text").attr("x", cx).attr("y", y(s.hi) - 8).attr("text-anchor", "middle").attr("fill", "#ffd36b").attr("font-size", 11).attr("font-weight", 600).text("2026");
}

// ------------------------------------------------------------------ fan chart
export function fanChart(el, legendEl, T, now, mc, active) {
  const F = frame(el, 340);
  const obs = T.filter((r) => r.year >= 2003 && r.fires_season).map((r) => ({ year: r.year, v: r.fires_season }));
  const band = [{ year: 2026, p10: now.lo, p50: now.fires, p90: now.hi }, ...mc];
  const years = d3.range(2003, 2031);
  const x = d3.scaleBand().domain(years).range([0, F.iw]).padding(0.3);
  const cx = (yr) => x(yr) + x.bandwidth() / 2;
  const y = d3.scaleLog().domain([1000, 300000]).range([F.ih, 0]).clamp(true);
  F.g.append("rect").attr("x", x(2026) - x.step() * 0.15).attr("width", F.iw - x(2026) + x.step() * 0.15).attr("height", F.ih).attr("fill", "#ffffff06");
  F.g.append("text").attr("x", x(2026) + 2).attr("y", 12).attr("fill", C.text3).attr("font-size", 11).text("simulated →");
  F.g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickSize(-F.iw).tickFormat(""));
  F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(logTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1])).tickFormat(kfmt)).select(".domain").remove();
  F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.ih})`).call(d3.axisBottom(x).tickValues(years.filter((v) => v % 3 === 0 || v === 2030))).select(".domain").remove();
  F.g.selectAll("rect.o").data(obs).join("rect").attr("class", "o").attr("x", (r) => x(r.year)).attr("width", x.bandwidth())
    .attr("y", (r) => y(r.v)).attr("height", (r) => F.ih - y(r.v)).attr("rx", 2).attr("fill", C.obs).attr("opacity", 0.85)
    .on("mousemove", (ev, r) => showTip(`<span class="tk">${r.year} observed</span><br><b>${fmt(r.v)}</b> detections`, ev)).on("mouseleave", hideTip);
  F.g.append("path").datum(band).attr("fill", C.model).attr("opacity", 0.22)
    .attr("d", d3.area().x((r) => cx(r.year)).y0((r) => y(r.p10)).y1((r) => y(r.p90)));
  F.g.append("path").datum(band).attr("fill", "none").attr("stroke", C.model).attr("stroke-width", 2)
    .attr("d", d3.line().x((r) => cx(r.year)).y((r) => y(r.p50)));
  F.g.selectAll("circle.m").data(band).join("circle").attr("class", "m").attr("cx", (r) => cx(r.year)).attr("cy", (r) => y(r.p50))
    .attr("r", (r) => (r.year === active ? 6 : 4)).attr("fill", (r) => (r.year === active ? "#ffd36b" : C.model)).attr("stroke", "#0f131a").attr("stroke-width", 2);
  F.g.selectAll("rect.h").data(band).join("rect").attr("class", "h").attr("x", (r) => x(r.year) - x.step() * 0.15).attr("width", x.step()).attr("height", F.ih).attr("fill", "transparent")
    .on("mousemove", (ev, r) => showTip(`<span class="tk">${r.year} simulated</span><br>Median: <b>${fmt(r.p50)}</b><br>10–90%: ${fmt(r.p10)} – ${fmt(r.p90)}${r.pOver2019 != null ? `<br>P(worse than 2019): <b>${Math.round(100 * r.pOver2019)}%</b>` : ""}`, ev))
    .on("mouseleave", hideTip);
  legendEl.innerHTML = `<span><i class="sw" style="background:${C.obs}"></i>Observed (MODIS)</span><span><i class="sw line" style="background:${C.model}"></i>Simulated median</span><span><i class="sw band" style="background:${C.model}"></i>10–90% range</span>`;
}
