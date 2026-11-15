// 3D map scene in the "Jejak Api" style: real terrain (AWS Terrain Tiles, SRTM/GMTED-derived), coastlines, glowing fire
// particles, rising smoke, ENSO-tinted ocean and burn-scar darkening, with hover read-outs.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { showTip, hideTip } from "./charts.js";

const XC = 107, ZC = 0.3;
export const toXZ = (lon, lat) => [lon - XC, -(lat - ZC)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function ramp(stops, t) { t = clamp(t, 0, 1); const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i; return mix(stops[i], stops[i + 1], f); }
const OCEAN = ["#0d2233", "#0f3550", "#1c5a8a", "#3f8fd6", "#9fd0ff"].map(hex);

export const TOWNS = [
  ["Banda Aceh", 95.32, 5.55, 1], ["Medan", 98.67, 3.59, 1], ["Padang", 100.35, -0.95, 1], ["Pekanbaru", 101.45, 0.51, 1], ["Dumai", 101.45, 1.67, 0],
  ["Jambi", 103.61, -1.61, 1], ["Palembang", 104.75, -2.98, 1], ["Kayu Agung (OKI)", 104.83, -3.39, 0], ["Bandar Lampung", 105.26, -5.43, 0],
  ["Pangkal Pinang", 106.11, -2.13, 0], ["Pontianak", 109.33, -0.03, 1], ["Ketapang", 109.98, -1.85, 0], ["Sintang", 111.5, 0.07, 0],
  ["Pangkalan Bun", 111.63, -2.68, 0], ["Sampit", 112.95, -2.53, 0], ["Palangka Raya", 113.92, -2.21, 1], ["Pulang Pisau", 114.25, -2.75, 0],
  ["Banjarmasin", 114.59, -3.32, 1], ["Samarinda", 117.15, -0.5, 1], ["Balikpapan", 116.83, -1.27, 0], ["Nusantara (IKN)", 116.7, -0.97, 0],
  ["Singapore", 103.82, 1.35, 1], ["Kuala Lumpur", 101.69, 3.14, 1], ["Jakarta", 106.85, -6.2, 1],
];
export function nearestTown(lon, lat) {
  let best = TOWNS[0], bd = 1e9;
  for (const t of TOWNS) { const d = (t[1] - lon) ** 2 + (t[2] - lat) ** 2; if (d < bd) { bd = d; best = t; } }
  return { name: best[0], km: Math.round(Math.sqrt(bd) * 111) };
}

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

export class MapScene {
  /**
   * terrain: {dem:{lon0,lat1,res,nx,ny,b64}, land: FeatureCollection}
   * grid:    {lon0, lat0, cell} of the fire-count cells passed to setFires
   * describe(info) -> html for the hover tooltip (optional)
   */
  constructor(el, { terrain, grid, autoRotate = false, camera = "default", labels = true, describe = null, interactive = true, rotate = interactive, contours = false, clickCard = false, explainUrl = "", explainCtx = () => ({}) }) {
    this.el = el; this.grid = grid; this.describe = describe;
    this.running = false; this.clock = new THREE.Clock();
    this.counts = new Map();
    this.state = { dryness: 0.4, warm: 0, smoke: 0.5 }; this.target = { ...this.state };

    const w = el.clientWidth || 800, h = el.clientHeight || 500;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.setSize(w, h);
    el.appendChild(r.domElement);
    if (labels) {
      this.labelRenderer = new CSS2DRenderer();
      this.labelRenderer.setSize(w, h);
      Object.assign(this.labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      el.appendChild(this.labelRenderer.domElement);
    }
    const scene = (this.scene = new THREE.Scene());
    const BG = new THREE.Color("#070b10");
    scene.background = BG;
    scene.fog = new THREE.Fog(BG, 18, 46);
    const cam = (this.camera = new THREE.PerspectiveCamera(42, w / h, 0.05, 200));
    cam.position.set(...(camera === "hero" ? [5, 10.5, 13] : [-0.5, 10.5, 12.5]));
    this.basePos = cam.position.clone();
    const ctl = (this.controls = new OrbitControls(cam, r.domElement));
    ctl.target.set(camera === "hero" ? 3.5 : 0.5, 0, 0.9);
    ctl.enableDamping = true; ctl.dampingFactor = 0.08;
    ctl.maxPolarAngle = 1.32; ctl.minDistance = 1.6; ctl.maxDistance = 34;
    ctl.enableZoom = false; ctl.screenSpacePanning = false;
    ctl.autoRotate = autoRotate; ctl.autoRotateSpeed = 0.3;
    ctl.enableRotate = rotate;
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1208, 0.95));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.35); sun.position.set(-6, 9, 5); scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6a8cff, 0.25); rim.position.set(8, 3, -8); scene.add(rim);

    this._buildTerrain(terrain);
    this._buildFireMaterials();
    if (labels) this._buildLabels();
    if (interactive) this._bindHover();
    if (contours) this._buildContours();
    this.explainUrl = explainUrl; this.explainCtx = explainCtx;
    if (clickCard) this._bindClick();

    new ResizeObserver(() => this.resize()).observe(el);
    new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? this.start() : this.stop())), { threshold: 0.01 }).observe(el);
  }

  // ------------------------------------------------------------------ terrain (real elevation)
  _buildTerrain({ dem, land }) {
    const { lon0: LON0, lat1: LAT1, res: RES, nx: NX, ny: NY } = dem;
    Object.assign(this, { LON0, LAT1, RES, NX, NY });
    const bin = atob(dem.b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const ELEV = new Int16Array(u8.buffer);
    const N = NX * NY;
    // land mask from coastline polygons
    const can = document.createElement("canvas"); can.width = NX; can.height = NY;
    const ctx = can.getContext("2d"); ctx.fillStyle = "#fff";
    for (const f of land.features) for (const ring of f.geometry.coordinates) {
      ctx.beginPath(); ring.forEach(([lon, lat], k) => { const x = (lon - LON0) / RES, y = (LAT1 - lat) / RES; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.fill("evenodd");
    }
    const px = ctx.getImageData(0, 0, NX, NY).data;
    const mask = new Float32Array(N); for (let i = 0; i < N; i++) mask[i] = px[i * 4 + 3] / 255;
    const heights = (this.heights = new Float32Array(N));
    const base = (this.baseCol = new Float32Array(N * 3));
    this.mask = mask;
    const elevM = (this.elevM = new Float32Array(N));
    this.vCell = new Int32Array(N).fill(-1);
    const pos = new Float32Array(N * 3);
    const { lon0: g0, lat0: gl0, cell } = this.grid;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const k = j * NX + i, lon = LON0 + i * RES, lat = LAT1 - j * RES, em = Math.max(0, ELEV[k]);
      const hgt = mask[k] < 0.5 ? -0.09 : 0.012 + em * 0.00011;
      heights[k] = hgt; elevM[k] = mask[k] < 0.5 ? 0 : em;
      let c;
      if (mask[k] < 0.5) c = hex("#0c1c28");
      else if (em < 100) c = mix(hex("#2c4a2a"), hex("#2f5c33"), em / 100);
      else if (em < 1200) c = mix(hex("#2f5c33"), hex("#4f5e3c"), (em - 100) / 1100);
      else c = mix(hex("#4f5e3c"), hex("#8c8678"), clamp((em - 1200) / 2000, 0, 1));
      base.set(c, k * 3);
      const [x, z] = toXZ(lon, lat);
      pos[k * 3] = x; pos[k * 3 + 1] = hgt; pos[k * 3 + 2] = z;
      if (mask[k] >= 0.5) {
        const ci = Math.floor((lon - g0) / cell), cj = Math.floor((lat - gl0) / cell);
        if (ci >= 0 && cj >= 0) this.vCell[k] = ci * 1000 + cj;
      }
    }
    const idx = [];
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      if (mask[a] + mask[b] + mask[c] + mask[d] < 0.2) continue;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.colArr = new Float32Array(N * 3);
    this.colAttr = new THREE.BufferAttribute(this.colArr, 3);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeVertexNormals();
    this.posArr = pos;
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    this.scene.add(this.terrain);

    // ocean
    const og = new THREE.PlaneGeometry(70, 46, 140, 92); og.rotateX(-Math.PI / 2);
    this.ocol = new Float32Array(og.attributes.position.count * 3);
    og.setAttribute("color", new THREE.BufferAttribute(this.ocol, 3));
    this.ogeo = og;
    const ocean = new THREE.Mesh(og, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 }));
    ocean.position.set(0, -0.005, 0); this.scene.add(ocean);
    // graticule + coastline
    const grid = [];
    for (let lon = 95; lon <= 120; lon += 5) { const [x, z1] = toXZ(lon, -9), [, z2] = toXZ(lon, 8); grid.push(x, 0.002, z1, x, 0.002, z2); }
    for (let lat = -5; lat <= 5; lat += 5) { const [x1, z] = toXZ(93, lat), [x2] = toXZ(121, lat); grid.push(x1, 0.002, z, x2, 0.002, z); }
    const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
    this.scene.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x2a4a63, transparent: true, opacity: 0.35 })));
    const coast = [];
    for (const f of land.features) for (const ring of f.geometry.coordinates) for (let k = 0; k < ring.length - 1; k++) {
      const [x1, z1] = toXZ(...ring[k]), [x2, z2] = toXZ(...ring[k + 1]); coast.push(x1, 0.012, z1, x2, 0.012, z2);
    }
    const cg = new THREE.BufferGeometry(); cg.setAttribute("position", new THREE.Float32BufferAttribute(coast, 3));
    this.scene.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.45 })));
  }

  heightAt(lon, lat) {
    const gx = (lon - this.LON0) / this.RES, gy = (this.LAT1 - lat) / this.RES;
    const i = clamp(Math.floor(gx), 0, this.NX - 2), j = clamp(Math.floor(gy), 0, this.NY - 2), fx = gx - i, fy = gy - j;
    const h = (a, b) => this.heights[b * this.NX + a];
    return (h(i, j) * (1 - fx) + h(i + 1, j) * fx) * (1 - fy) + (h(i, j + 1) * (1 - fx) + h(i + 1, j + 1) * fx) * fy;
  }

  _buildFireMaterials() {
    this.fireMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, dim: { value: 1 }, grow: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float size; attribute float phase; uniform float time; uniform float dim; uniform float grow; varying float vF; varying float vH;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); float fl = 0.65 + 0.35*sin(time*7.0 + phase*31.0) * sin(time*3.1 + phase*11.0);
          vF = fl * dim; vH = phase; gl_PointSize = min(16.0, size * fl * grow * (34.0 / -mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vF; varying float vH; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d); vec3 c = mix(vec3(1.0,0.35,0.08), vec3(1.0,0.86,0.45), smoothstep(0.25,0.0,d) * (0.5+0.5*vH));
          gl_FragColor = vec4(c, a * vF); }`,
    });
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, dim: { value: 1 } }, transparent: true, depthWrite: false,
      vertexShader: `attribute float size; attribute float phase; uniform float time; varying float vA;
        void main(){ float t = fract(time*0.06 + phase); vec3 p = position; p.y += t*0.9; p.x -= t*0.55 + sin(phase*20.0+time*0.4)*0.05; p.z -= t*0.35;
          vec4 mv = modelViewMatrix * vec4(p,1.0); vA = smoothstep(0.0,0.15,t) * (1.0 - t); gl_PointSize = min(70.0, size * (0.4 + t*1.6) * (55.0 / -mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float dim; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * 0.11 * vA * dim; gl_FragColor = vec4(vec3(0.62,0.6,0.56), a); }`,
    });
  }

  _buildLabels() {
    this.townEls = TOWNS.map(([n, lon, lat, major]) => {
      const d = document.createElement("div"); d.className = "lbl3d" + (major ? "" : " minor"); d.textContent = n;
      const o = new CSS2DObject(d); const [x, z] = toXZ(lon, lat); o.position.set(x, this.heightAt(lon, lat) + 0.03, z); this.scene.add(o); return { o, major };
    });
  }

  // ------------------------------------------------------------------ hover read-out
  _pick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction; if (d.y >= 0) return null;
    let h = 0, p;
    for (let it = 0; it < 4; it++) { const s = (h - o.y) / d.y; p = { x: o.x + d.x * s, z: o.z + d.z * s }; h = Math.max(0, this.heightAt(p.x + XC, ZC - p.z)); }
    return { lon: p.x + XC, lat: ZC - p.z };
  }
  _bindHover() {
    let last = 0;
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", (ev) => {
      if (ev.buttons) { hideTip(); return; }
      if (performance.now() - last < 60) return; last = performance.now();
      const g = this._pick(ev);
      if (!g) return hideTip();
      const gi = Math.round((g.lon - this.LON0) / this.RES), gj = Math.round((this.LAT1 - g.lat) / this.RES);
      const onLand = gi >= 0 && gj >= 0 && gi < this.NX && gj < this.NY && this.mask[gj * this.NX + gi] >= 0.5;
      if (!onLand) { hideTip(); el.style.cursor = "grab"; return; }
      el.style.cursor = "crosshair";
      showTip(this._html(g), ev);
    });
    el.addEventListener("pointerleave", hideTip);
  }
  _html(g) {
    const { lon0, lat0, cell } = this.grid;
    const ci = Math.floor((g.lon - lon0) / cell), cj = Math.floor((g.lat - lat0) / cell);
    const n = this.counts.get(ci * 1000 + cj) || 0;
    const town = nearestTown(g.lon, g.lat);
    return this.describe ? this.describe({ n, lon: g.lon, lat: g.lat, town, cell }) :
      `<b>near ${town.name}</b><br><span class="tk">${g.lat.toFixed(2)}°, ${g.lon.toFixed(2)}°E</span><br>🔥 <b>${Math.round(n).toLocaleString()}</b> fire detections in this ${cell}° cell`;
  }
  _onLand(g) {
    const gi = Math.round((g.lon - this.LON0) / this.RES), gj = Math.round((this.LAT1 - g.lat) / this.RES);
    return gi >= 0 && gj >= 0 && gi < this.NX && gj < this.NY && this.mask[gj * this.NX + gi] >= 0.5 ? gj * this.NX + gi : -1;
  }

  // ------------------------------------------------------------------ elevation contours (marching squares on the DEM)
  _buildContours() {
    const { NX, NY, mask, elevM, posArr: pos } = this, out = [];
    const run = (levels) => {
      const o = [];
      for (const L of levels) for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
        const k0 = j * NX + i, ks = [k0, k0 + 1, k0 + NX + 1, k0 + NX];
        if (ks.some((k) => mask[k] < 0.5)) continue;
        const v = ks.map((k) => elevM[k]), up = v.map((x) => x >= L);
        if (up.every(Boolean) || !up.some(Boolean)) continue;
        const pts = [];
        for (let q = 0; q < 4; q++) {
          const a = q, b = (q + 1) % 4; if (up[a] === up[b]) continue;
          const t = (L - v[a]) / (v[b] - v[a]), A = ks[a] * 3, B = ks[b] * 3;
          pts.push([pos[A] + (pos[B] - pos[A]) * t, pos[A + 1] + (pos[B + 1] - pos[A + 1]) * t + 0.006, pos[A + 2] + (pos[B + 2] - pos[A + 2]) * t]);
        }
        for (let q = 0; q + 1 < pts.length; q += 2) o.push(...pts[q], ...pts[q + 1]);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(o, 3)); return g;
    };
    const minor = new THREE.LineSegments(run([100, 200, 300, 400, 600, 700, 800, 900, 1200, 1400, 1600, 1800, 2200, 2400, 2600, 2800, 3200, 3400, 3600]),
      new THREE.LineBasicMaterial({ color: 0xe8dcc0, transparent: true, opacity: 0.2, depthWrite: false }));
    const major = new THREE.LineSegments(run([500, 1000, 1500, 2000, 2500, 3000, 3500]),
      new THREE.LineBasicMaterial({ color: 0xf6ecd2, transparent: true, opacity: 0.5, depthWrite: false }));
    this.contourLines = [minor, major]; this.scene.add(minor, major);
    const btn = document.createElement("button"); btn.className = "mapbtn"; btn.type = "button"; btn.textContent = "⛰ Contours"; btn.setAttribute("aria-pressed", "true");
    btn.onclick = () => { const on = !minor.visible; this.contourLines.forEach((l) => (l.visible = on)); btn.setAttribute("aria-pressed", on); };
    this.el.appendChild(btn);
  }

  // ------------------------------------------------------------------ click → pinned description card
  _bindClick() {
    const el = this.renderer.domElement; let down = null;
    const card = (this.card = document.createElement("div")); card.className = "mapcard"; card.style.display = "none"; this.el.appendChild(card);
    const pin = (this.pin = new THREE.Group());
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.9, 8), new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
    beam.position.y = 0.45; pin.add(beam);
    const ring = (this.pinRing = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.17, 40), new THREE.MeshBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.85, side: THREE.DoubleSide })));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; pin.add(ring);
    pin.visible = false; this.scene.add(pin);
    el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; down = null;
      const g = this._pick(e); const k = g ? this._onLand(g) : -1;
      if (k < 0) return this._closeCard();
      this.sel = { lon: g.lon, lat: g.lat, el: Math.round(this.elevM[k]) };
      const [x, z] = toXZ(g.lon, g.lat);
      pin.position.set(x, Math.max(0, this.heightAt(g.lon, g.lat)), z); pin.visible = true;
      hideTip(); this._cardHtml = ""; this._updateCard();
    });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this._closeCard(); });
    card.addEventListener("click", (e) => {
      if (e.target.closest(".x")) this._closeCard();
      else if (e.target.closest(".exbtn")) this._explain();
    });
  }
  async _explain() {
    const s = this.sel; if (!s || s.ex?.state === "loading") return;
    s.ex = { state: "loading" }; this._cardHtml = ""; this._updateCard();
    const { lon0, lat0, cell } = this.grid;
    const fires = this.counts.get(Math.floor((s.lon - lon0) / cell) * 1000 + Math.floor((s.lat - lat0) / cell)) || 0;
    try {
      const r = await fetch(this.explainUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place: nearestTown(s.lon, s.lat).name, lat: +s.lat.toFixed(2), lon: +s.lon.toFixed(2), elevation_m: s.el, fires: Math.round(fires), cell_deg: cell, lang: "en", ...this.explainCtx() }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      if (this.sel === s) s.ex = { state: "done", text: j.text };
    } catch (e) { if (this.sel === s) s.ex = { state: "err" }; }
    this._cardHtml = ""; this._updateCard();
  }
  _closeCard() { if (!this.card) return; this.sel = null; this.pin.visible = false; this.card.style.display = "none"; }
  _exHtml(s) {
    if (!this.explainUrl) return "";
    const e = s.ex || { state: "idle" };
    if (e.state === "loading") return `<div class="ex tk">✨ Asking the AI…</div>`;
    if (e.state === "done") return `<div class="ex">${e.text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}<div class="tk">AI summary · Cloudflare Workers AI · check against the numbers above</div></div>`;
    if (e.state === "err") return `<div class="ex tk">Could not reach the explainer. <button class="exbtn" type="button">Try again</button></div>`;
    return `<div class="ex"><button class="exbtn" type="button">✨ Explain this place</button></div>`;
  }
  _updateCard() {
    if (!this.card || !this.sel) return;
    const s = this.sel, html = `<button class="x" type="button" aria-label="Close">×</button>${this._html(s)}<br><span class="tk">elevation ${s.el.toLocaleString()}&nbsp;m</span>${this._exHtml(s)}`;
    if (html !== this._cardHtml) { this.card.innerHTML = html; this._cardHtml = html; }
    const v = this.pin.position.clone(); v.y += 0.05; v.project(this.camera);
    const w = this.el.clientWidth, h = this.el.clientHeight, cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    this.card.style.display = v.z < 1 ? "block" : "none";
    this.card.style.left = clamp((v.x + 1) / 2 * w + 16, 8, w - cw - 8) + "px";
    this.card.style.top = clamp((1 - v.y) / 2 * h - ch / 2, 8, h - ch - 8) + "px";
    const p = (this.clock.elapsedTime * 0.8) % 1; this.pinRing.scale.setScalar(1 + 0.35 * p); this.pinRing.material.opacity = 0.85 * (1 - p);
  }

  // ------------------------------------------------------------------ data → visuals
  /** counts: array of [i, j, n] on this.grid */
  setFires(counts, { scale = 1, min = 0.5 } = {}) {
    this.counts = new Map();
    for (const [i, j, n] of counts) if (n * scale >= min) this.counts.set(i * 1000 + j, n * scale);
    this._rebuildFire();
    this._paint();
  }
  _rebuildFire() {
    [this.firePts, this.smokePts].forEach((o) => { if (o) { this.scene.remove(o); o.geometry.dispose(); } });
    seed = 1000 + this.counts.size;
    const { lon0, lat0, cell } = this.grid;
    const fp = [], fs = [], fph = [], sp = [], ss = [], sph = [];
    let total = 0;
    for (const [key, f] of this.counts) {
      total += f;
      const lonC = lon0 + (Math.floor(key / 1000) + 0.5) * cell, latC = lat0 + ((key % 1000) + 0.5) * cell;
      const n = Math.min(40, Math.round(Math.sqrt(f) * 1.6) + 1);
      for (let q = 0; q < n; q++) {
        const lon = lonC + (rnd() - 0.5) * cell * 0.96, lat = latC + (rnd() - 0.5) * cell * 0.96, h = this.heightAt(lon, lat);
        if (h < 0) continue;
        const [x, z] = toXZ(lon, lat);
        fp.push(x, h + 0.012, z); fs.push(2.2 + rnd() * 3.5 + Math.min(4, f / 60)); fph.push(rnd());
      }
      const ns = f > 15 ? Math.min(6, Math.round(Math.sqrt(f) * 0.3)) : 0;
      for (let q = 0; q < ns; q++) {
        const lon = lonC + (rnd() - 0.5) * cell, lat = latC + (rnd() - 0.5) * cell, [x, z] = toXZ(lon, lat);
        sp.push(x, Math.max(0, this.heightAt(lon, lat)) + 0.05, z); ss.push(18 + rnd() * 22); sph.push(rnd());
      }
    }
    const mk = (p, s, ph, mat) => {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute("size", new THREE.Float32BufferAttribute(s, 1)); g.setAttribute("phase", new THREE.Float32BufferAttribute(ph, 1));
      const o = new THREE.Points(g, mat); o.frustumCulled = false; this.scene.add(o); return o;
    };
    this.firePts = mk(fp, fs, fph, this.fireMat);
    this.smokePts = mk(sp, ss, sph, this.smokeMat);
    this.fireMat.uniforms.grow.value = 0.3;
    this.total = total;
  }

  /** dryness 0..1 (soil), warm 0..1 (ENSO pressure), smoke 0..1 (AOD) */
  setClimate({ dryness, warm, smoke }) {
    if (dryness !== undefined) this.target.dryness = dryness;
    if (warm !== undefined) this.target.warm = warm;
    if (smoke !== undefined) this.target.smoke = smoke;
  }

  _paint() {
    const N = this.NX * this.NY, dry = this.state.dryness;
    const charcoal = hex("#17140f"), parched = hex("#6e5d40");
    for (let k = 0; k < N; k++) {
      let c = [this.baseCol[k * 3], this.baseCol[k * 3 + 1], this.baseCol[k * 3 + 2]];
      if (this.mask[k] >= 0.5) {
        c = mix(c, parched, dry * 0.45);
        const key = this.vCell[k];
        if (key >= 0) { const f = this.counts.get(key); if (f) c = mix(c, charcoal, clamp(Math.sqrt(f) / 18, 0, 0.8)); }
      }
      this.colArr[k * 3] = c[0]; this.colArr[k * 3 + 1] = c[1]; this.colArr[k * 3 + 2] = c[2];
    }
    this.colAttr.needsUpdate = true;
    const op = this.ogeo.attributes.position.array, warm = this.state.warm;
    for (let v = 0; v < op.length / 3; v++) {
      const lon = op[v * 3] + XC, lat = ZC - op[v * 3 + 2];
      const wave = 0.04 * (Math.sin(lon * 1.3) * Math.cos(lat * 1.7) + 1);
      const east = clamp((lon - 110) / 20, 0, 1);
      const c = mix(mix(hex("#0a1823"), hex("#10273a"), clamp(0.5 + wave * 3 - Math.hypot(lon - 107, lat) / 30, 0, 1)), ramp(OCEAN, 0.3 + 0.7 * east), warm * (0.25 + 0.6 * east));
      this.ocol[v * 3] = c[0]; this.ocol[v * 3 + 1] = c[1]; this.ocol[v * 3 + 2] = c[2];
    }
    this.ogeo.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------------ loop
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    const f = Math.max(1, Math.pow(1.45 / (w / h), 0.85));
    const off = this.basePos.clone().sub(this.controls.target).multiplyScalar(f);
    this.camera.position.copy(this.controls.target).add(off);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer?.setSize(w, h);
  }
  start() { if (this.running) return; this.running = true; this.clock.getDelta(); this._loop(); }
  stop() { this.running = false; }
  _loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.elapsedTime, k = 1 - Math.exp(-dt * 4);
    let changed = false;
    for (const key of ["dryness", "warm", "smoke"]) {
      const d = this.target[key] - this.state[key];
      if (Math.abs(d) > 0.004) { this.state[key] += d * k; changed = true; }
    }
    if (changed && ((this._pf = (this._pf || 0) + 1) % 4 === 0)) this._paint();
    this.fireMat.uniforms.time.value = t; this.smokeMat.uniforms.time.value = t;
    this.fireMat.uniforms.grow.value += (1 - this.fireMat.uniforms.grow.value) * k;
    this.smokeMat.uniforms.dim.value = 0.35 + 1.4 * this.state.smoke;
    if (this.townEls) {
      const dist = this.camera.position.distanceTo(this.controls.target);
      for (const { o, major } of this.townEls) o.visible = !!major || dist < 9;
    }
    this.controls.update();
    this._updateCard();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer?.render(this.scene, this.camera);
  }
}
