// The fitted Earth-system chain (coefficients come from analysis/03_analysis.py) + Monte Carlo.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const quantile = (arr, q) => {
  const s = Float64Array.from(arr).sort();
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
export { quantile };

// small deterministic RNG so simulations are reproducible between reloads
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Chain {
  constructor(A, timeline) {
    this.A = A;
    const c = A.chain;
    this.cr = c.climate_to_rain.coef;
    this.cs = c.rain_to_soil.coef;
    this.cf = c.soil_to_fires.coef;
    this.ca = c.fires_to_aod.coef;
    this.rr = c.resid_rain; this.rs = c.resid_soil; this.rf = c.resid_fire;
    this.q10 = quantile(this.rf, 0.1);
    this.q90 = quantile(this.rf, 0.9);

    // spatial pattern anchors: median ln fires of low- and high-fire years
    const fit = timeline.filter((d) => d.year >= 2003 && d.fires_season);
    const hi = fit.filter((d) => A.high_years.includes(d.year)).map((d) => Math.log(d.fires_season));
    const lo = fit.filter((d) => !A.high_years.includes(d.year)).map((d) => Math.log(d.fires_season));
    this.lnHi = quantile(hi, 0.5); this.lnLo = quantile(lo, 0.5);
    this.history = fit.map((d) => ({ year: d.year, fires: d.fires_season, aod: d.aod, soil: d.soil }));
    this.seasonShare = (p) => p.slice(6, 10).reduce((a, b) => a + b, 0);
  }

  rainFrom(oni, dmi) { return clamp(this.cr.intercept + this.cr.oni * oni + this.cr.dmi * dmi, 0.5, 14); }
  soilFrom(rain) { return clamp(this.cs.intercept + this.cs.rain * rain, 0.5, 0.98); }
  lnFire(soil, gov) { return this.cf.intercept + this.cf.soil * soil + this.cf.regime * gov; }
  aod(lnF) { return Math.max(0.2, this.ca.intercept + this.ca.ln_fires * lnF); }

  /** inputs: {oni, dmi, rain?, soil?, gov}; rain/soil override the upstream chain when given */
  run(inp) {
    const rain = inp.rain ?? this.rainFrom(inp.oni, inp.dmi);
    const soil = inp.soil ?? this.soilFrom(rain);
    const ln = this.lnFire(soil, inp.gov);
    const fires = Math.exp(ln);
    const out = {
      rain, soil, ln, fires,
      lo: Math.exp(ln + this.q10), hi: Math.exp(ln + this.q90),
      aod: this.aod(ln),
      w: clamp((ln - this.lnLo) / (this.lnHi - this.lnLo), 0, 1),
    };
    // nearest historical season
    out.analog = this.history.reduce((b, d) => (Math.abs(Math.log(d.fires) - ln) < Math.abs(Math.log(b.fires) - ln) ? d : b));
    out.rankAbove = this.history.filter((d) => d.fires > fires).length;
    return out;
  }

  /** Blend observed fire patterns into per-cell counts for a season total. */
  pattern(total, w, gov) {
    const P = this.A.patterns;
    const g = clamp(gov, 0, 1) * 0.5;
    const m = new Map();
    const add = (arr, wt) => { if (wt <= 0) return; for (const [i, j, v] of arr) { const k = i * 1000 + j; m.set(k, (m.get(k) || 0) + v * wt); } };
    add(P.high, (1 - g) * w); add(P.low, (1 - g) * (1 - w)); add(P.post_regime, g);
    const out = [];
    for (const [k, v] of m) out.push([Math.floor(k / 1000), k % 1000, v * total]);
    return out;
  }

  monthProfile(w) {
    const { high, low } = this.A.month_profile;
    return high.map((h, i) => h * w + low[i] * (1 - w));
  }

  /** Monte Carlo 2027-2030. path: analog | clim | nino */
  monteCarlo({ path = "analog", shift = 0, gov = 1, n = 4000, seed = 7 }) {
    const rnd = mulberry32(seed);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const clim = this.A.climatology;
    const ninoYears = clim.filter((d) => d.oni >= 1.0);
    const years = [2027, 2028, 2029, 2030];
    const sims = years.map(() => new Float64Array(n));
    const aods = years.map(() => new Float64Array(n));
    for (let r = 0; r < n; r++) {
      let seq;
      if (path === "analog") seq = pick(this.A.analogs).seq;
      else if (path === "nino") seq = years.map(() => pick(ninoYears));
      else seq = years.map(() => pick(clim));
      for (let y = 0; y < 4; y++) {
        const { oni, dmi } = seq[y];
        let rain = (this.cr.intercept + this.cr.oni * oni + this.cr.dmi * dmi + pick(this.rr)) * (1 + shift / 100);
        rain = clamp(rain, 0.5, 14);
        const soil = clamp(this.cs.intercept + this.cs.rain * rain + pick(this.rs), 0.5, 0.98);
        const ln = this.lnFire(soil, gov) + pick(this.rf);
        sims[y][r] = Math.exp(ln);
        aods[y][r] = this.aod(ln);
      }
    }
    const ref2019 = this.history.find((d) => d.year === 2019).fires;
    const ref2015 = this.history.find((d) => d.year === 2015).fires;
    return years.map((year, y) => ({
      year,
      p10: quantile(sims[y], 0.1), p50: quantile(sims[y], 0.5), p90: quantile(sims[y], 0.9),
      aod50: quantile(aods[y], 0.5),
      pOver2019: sims[y].filter((v) => v > ref2019).length / n,
      pOver2015: sims[y].filter((v) => v > ref2015).length / n,
    }));
  }
}
