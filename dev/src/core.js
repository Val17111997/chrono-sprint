// Chrono Sprint — cœur DSP (sans DOM). Testé sous Node, inliné dans la page.
(function (root) {
  'use strict';

  const SOUND_SPEED = 343; // m/s (distances < 2 m : l'erreur de température est négligeable)

  // ---------------- FFT radix-2 ----------------
  class FFT {
    constructor(n) {
      const lv = Math.round(Math.log2(n));
      if (1 << lv !== n) throw new Error('FFT size must be power of 2');
      this.n = n; this.lv = lv;
      this.c = new Float64Array(n / 2); this.s = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.c[i] = Math.cos(2 * Math.PI * i / n); this.s[i] = Math.sin(2 * Math.PI * i / n); }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) { let r = 0, x = i; for (let j = 0; j < lv; j++) { r = (r << 1) | (x & 1); x >>>= 1; } this.rev[i] = r; }
    }
    // in place ; inverse = true → twiddles conjugués, sans normalisation
    run(re, im, inverse) {
      const n = this.n, rev = this.rev, C = this.c, S = this.s, sg = inverse ? -1 : 1;
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half, a = re[l], b = im[l], c = C[k], s = S[k];
            const tr = a * c + sg * b * s, ti = b * c - sg * a * s;
            re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
    }
  }

  // ---------------- Signaux ----------------
  function makeChirp(sr, f0, f1, dur, rampMs = 5, amp = 1) {
    const n = Math.round(dur * sr), out = new Float32Array(n), k = (f1 - f0) / dur, rn = Math.max(1, Math.round(rampMs / 1000 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let w = 1;
      if (i < rn) w = 0.5 - 0.5 * Math.cos(Math.PI * i / rn);
      else if (i >= n - rn) w = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / rn);
      out[i] = amp * w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return out;
  }

  // Bip de départ : claquement type « clapet » (bruit large bande, attaque < 1 ms, décroissance rapide)
  function makeGun(sr, dur = 0.16, amp = 1) {
    const n = Math.round(dur * sr), out = new Float32Array(n);
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    let lp1 = 0, lp2 = 0; const a1 = Math.exp(-2 * Math.PI * 9000 / sr), a2 = Math.exp(-2 * Math.PI * 900 / sr);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const x = rnd();
      lp1 = a1 * lp1 + (1 - a1) * x; // passe-bas 9 kHz
      lp2 = a2 * lp2 + (1 - a2) * x; // passe-bas 900 Hz
      const band = lp1 - lp2; // ≈ passe-bande 0,9–9 kHz
      const t = i / sr, att = Math.min(1, t / 0.0006), env = att * (0.25 + 0.75 * Math.exp(-t / 0.045)) * (i > n - 64 ? (n - i) / 64 : 1);
      out[i] = band * env; peak = Math.max(peak, Math.abs(out[i]));
    }
    for (let i = 0; i < n; i++) out[i] = out[i] / peak * amp;
    return out;
  }

  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y), n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }
  function mad(arr) { const m = median(arr); return median(Array.from(arr, v => Math.abs(v - m))); }

  // ---------------- Filtre adapté (corrélation enveloppe, FFT) ----------------
  // templates : [{name, data:Float32Array}] ; tous de longueur ≤ maxLen.
  class MatchedFilter {
    constructor(sr, templates, N) {
      this.sr = sr; this.N = N; this.fft = new FFT(N);
      this.L = Math.max(...templates.map(t => t.data.length));
      if (this.L >= N / 2) throw new Error('template too long for N');
      this.hop = N - this.L + 1;
      this.margin = this.L + Math.round(0.02 * sr);
      this.step = this.hop - 2 * this.margin;
      if (this.step < sr * 0.05) throw new Error('N too small');
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      this.zr = new Float64Array(N); this.zi = new Float64Array(N);
      this.env = new Float32Array(N);
      this.tpl = templates.map(t => {
        const hr = new Float64Array(N), hi = new Float64Array(N);
        for (let i = 0; i < t.data.length; i++) hr[i] = t.data[i];
        this.fft.run(hr, hi, false);
        // conj(H) × poids analytique (bins positifs ×2, négatifs à 0)
        let energy = 0; for (let i = 0; i < t.data.length; i++) energy += t.data[i] * t.data[i];
        for (let k = 0; k < N; k++) {
          const w = k === 0 || k === N / 2 ? 1 : (k < N / 2 ? 2 : 0);
          hr[k] = hr[k] * w; hi[k] = -hi[k] * w;
        }
        return { name: t.name, group: t.group || 'a', hr, hi, len: t.data.length, norm: Math.sqrt(energy) };
      });
      this.ms = sr / 1000;
    }
    // Découpage : blocs de N, avancés de this.step ; seules les détections de lag ∈ [M, M+step) sont rendues
    // (M = L + 20 ms de marge de chaque côté pour les contrôles de netteté et le dédoublonnage).
    process(x, opts = {}) {
      const N = this.N, re = this.re, im = this.im, thr = opts.minRatio || 8, maxPer = opts.maxPerTemplate || 4;
      const M = this.margin, valid = this.hop, ms = this.ms;
      for (let i = 0; i < N; i++) { re[i] = x[i]; im[i] = 0; }
      this.fft.run(re, im, false);
      const all = [];
      for (const t of this.tpl) {
        const zr = this.zr, zi = this.zi, env = this.env;
        for (let k = 0; k < N; k++) { const a = re[k], b = im[k]; zr[k] = a * t.hr[k] - b * t.hi[k]; zi[k] = a * t.hi[k] + b * t.hr[k]; }
        this.fft.run(zr, zi, true);
        for (let i = 0; i < valid; i++) env[i] = Math.hypot(zr[i], zi[i]) / N;
        const stride = Math.max(1, Math.floor(valid / 3000)), sub = [];
        for (let i = 0; i < valid; i += stride) sub.push(env[i]);
        const floor = Math.max(median(sub), 1e-12);
        const taken = [];
        for (let rep = 0; rep < maxPer; rep++) {
          let pk = -1, pv = 0;
          for (let i = 1; i < valid - 1; i++) {
            if (env[i] > pv) {
              let ok = true; for (const q of taken) if (Math.abs(i - q) < t.len) { ok = false; break; }
              if (ok) { pv = env[i]; pk = i; }
            }
          }
          if (pk < 0 || pv / floor < thr) break;
          taken.push(pk);
          let best = pk; const back = Math.round(10 * ms);
          for (let i = Math.max(1, pk - back); i < pk; i++) {
            if (env[i] >= 0.5 * pv && env[i] >= env[i - 1] && env[i] >= env[i + 1]) { best = i; break; }
          }
          const bv = env[best];
          // netteté : juste avant le pic l'enveloppe doit être basse ; autour (±M hors ±4 ms), la moyenne aussi
          const a0 = Math.max(0, best - Math.round(15 * ms)), a1 = Math.max(0, best - Math.round(3 * ms));
          let s = 0, c = 0; for (let i = a0; i < a1; i++) { s += env[i]; c++; }
          let sharp = !(c > 20 && s / c > 0.35 * bv);
          const w0 = Math.max(0, best - M), w1 = Math.min(valid, best + M), ex = Math.round(4 * ms);
          let s2 = 0, c2 = 0; for (let i = w0; i < w1; i++) { if (i > best - ex && i < best + ex) continue; s2 += env[i]; c2++; }
          if (c2 > 50 && s2 / c2 > 0.2 * bv) sharp = false;
          let frac = 0;
          const y0 = env[best - 1], y1 = env[best], y2 = env[best + 1], den = y0 - 2 * y1 + y2;
          if (den < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den));
          all.push({ type: t.name, group: t.group, idx: best + frac, ratio: bv / floor, snrDb: 20 * Math.log10(bv / floor), amp: bv / t.norm, sharp });
        }
      }
      // dédoublonnage par bande de fréquence (corrélations croisées montée/descente) sur ±(L+10 ms), puis netteté + zone rendue
      all.sort((a, b) => b.ratio - a.ratio);
      const kept = [], win = this.L + 10 * ms;
      for (const d of all) if (!kept.some(r => r.group === d.group && Math.abs(r.idx - d.idx) < win)) kept.push(d);
      return kept.filter(d => d.sharp && d.idx >= M && d.idx < M + this.step).sort((a, b) => a.idx - b.idx);
    }
  }

  // ---------------- Filtres biquad (claquement de mains) ----------------
  function biquadHP(sr, fc, q = 0.7071) {
    const w = 2 * Math.PI * fc / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }
  function filt(x, c) {
    const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  }
  // Détecte l'attaque d'un claquement dans x (aigus > 7 kHz, insensible aux bips 2–6 kHz).
  // excl : liste d'intervalles [a,b] (indices) à ignorer (débuts de bips connus).
  function detectClapOnset(x, sr, excl = []) {
    const fc = Math.min(7500, sr * 0.4);
    let y = x; const c = biquadHP(sr, fc);
    for (let s = 0; s < 4; s++) y = filt(y, c);
    const n = y.length, win = Math.max(2, Math.round(0.00025 * sr)), env = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += Math.abs(y[i]); if (i >= win) acc -= Math.abs(y[i - win]); env[i] = acc / win; }
    const skip = (i) => excl.some(([a, b]) => i >= a && i <= b);
    let pk = -1, pv = 0;
    for (let i = Math.round(0.01 * sr); i < n; i++) if (env[i] > pv && !skip(i)) { pv = env[i]; pk = i; }
    if (pk < 0) return null;
    const stride = Math.max(1, Math.floor(n / 4000)), sub = [];
    for (let i = 0; i < n; i += stride) sub.push(env[i]);
    const floor = Math.max(median(sub), 1e-9);
    if (pv / floor < 12) return null;
    const lvl = Math.max(floor * 4, 0.12 * pv);
    let i = pk; const lim = Math.max(0, pk - Math.round(0.02 * sr));
    while (i > lim && env[i - 1] > lvl) i--;
    // l'enveloppe glissante retarde de ~win/2 : on recule d'autant
    const onset = Math.max(0, i - win / 2);
    return { idx: onset, ratio: pv / floor };
  }

  // ---------------- Détecteur de passage caméra ----------------
  // Image luminance w×h (portrait). Ligne de cellule = colonne centrale.
  // Mode « torse » (band ≠ null) : le déclenchement initial (bras, main…) ouvre une attente ; l'instant retenu est celui où
  // le front d'une bande horizontale « poitrine–bassin » (fraction de la hauteur du coureur) franchit la ligne.
  // Mode « main » (band = null) : front d'occupation pleine hauteur, utilisé pour la calibration par claquement.
  class GateDetector {
    constructor(w, h, o = {}) {
      this.w = w; this.h = h;
      this.o = Object.assign({ occGate: 0.04, pixMin: 14, pixMax: 45, cooldownMs: 1200, clearMs: 350, dir: 0, minMass: 0.12, refractoryAfterReset: 8,
        band: [0.18, 0.48], bandThr: 0.4, maxWaitMs: 350 }, o);
      this.gx = (w - 1) / 2;
      this.bg = null; this.prev = null; this.prevT = 0; this.prev2 = null; this.prev2T = 0;
      this.occ = new Float32Array(w); this.occS = new Float32Array(w);
      this.colMin = new Int32Array(w); this.colMax = new Int32Array(w);
      this.mask = new Uint8Array(w * h); this.pmask = new Uint8Array(w * h); this.hasPmask = false;
      this.bA = new Float32Array(w); this.bB = new Float32Array(w);
      this.noise = 4; this.armed = true; this.lastTrig = -1e12; this.clearSince = -1e12; this.wasOcc = false;
      this.unstable = 0; this.fgFrac = 0; this.lastOccGate = 0; this.pend = null;
    }
    reset() { this.bg = null; this.prev = null; this.prev2 = null; this.hasPmask = false; this.pend = null; }
    _edges(occS, from) { // blob autour de la colonne 'from' (tolère des trous de ~6 % de la largeur : bras détaché du corps)
      const w = this.w, oc = this.o.occGate * 0.6, maxGap = Math.max(2, Math.round(0.06 * w));
      let L = from, R = from, gap = 0;
      for (let x = from - 1; x >= 0; x--) { if (occS[x] >= oc) { L = x; gap = 0; } else if (++gap > maxGap) break; }
      gap = 0;
      for (let x = from + 1; x < w; x++) { if (occS[x] >= oc) { R = x; gap = 0; } else if (++gap > maxGap) break; }
      return [L, R];
    }
    _band(mask, y0, y1, out) {
      const w = this.w, n = y1 - y0 + 1; out.fill(0);
      for (let y = y0; y <= y1; y++) { const r = y * w; for (let x = 0; x < w; x++) out[x] += mask[r + x]; }
      for (let x = 0; x < w; x++) out[x] /= n;
      return out;
    }
    // instant de franchissement par interpolation des fronts (profil courant / précédent)
    _cross(cur, prv, thr, dir, t0, t1) {
      const w = this.w, gl = Math.floor(this.gx), gr = Math.ceil(this.gx), lim = Math.round(w * 0.45);
      let eCur = NaN, ePrev = NaN;
      if (dir > 0) { let x = cur[gl] >= thr ? gl : (cur[gr] >= thr ? gr : -1); if (x >= 0) { while (x + 1 < w && cur[x + 1] >= thr) x++; eCur = x + 0.5; } }
      else { let x = cur[gr] >= thr ? gr : (cur[gl] >= thr ? gl : -1); if (x >= 0) { while (x - 1 >= 0 && cur[x - 1] >= thr) x--; eCur = x - 0.5; } }
      if (prv) {
        if (dir > 0) { for (let x = gl; x >= Math.max(0, gl - lim); x--) if (prv[x] >= thr) { ePrev = x + 0.5; break; } }
        else { for (let x = gr; x <= Math.min(w - 1, gr + lim); x++) if (prv[x] >= thr) { ePrev = x - 0.5; break; } }
      }
      if (isFinite(eCur) && isFinite(ePrev) && t1 - t0 < 200) {
        const s = dir > 0 ? 1 : -1, dist = s * (eCur - ePrev), toGate = s * (this.gx - ePrev);
        if (dist > 0.3) return { t: t0 + Math.max(0, Math.min(1, toGate / dist)) * (t1 - t0), interp: true, vpx: dist / (t1 - t0) };
      }
      return { t: (t0 + t1) / 2, interp: false, vpx: NaN };
    }
    _ev(c, tFrame, p, torso) {
      const speed = isFinite(c.vpx) ? c.vpx * 1000 * 1.75 / Math.max(1, p.hFrac * this.h) : NaN; // m/s, ~1,75 m visibles
      return { t: c.t, tFrame, dir: p.dir, interp: c.interp, speed, hFrac: p.hFrac, mass: p.mass, torso };
    }
    _pending(t) {
      const p = this.pend, o = this.o, gl = Math.floor(this.gx), gr = Math.ceil(this.gx);
      const cur = this._band(this.mask, p.y0, p.y1, this.bA);
      if (Math.max(cur[gl], cur[gr]) >= o.bandThr) {
        const prv = this.hasPmask ? this._band(this.pmask, p.y0, p.y1, this.bB) : null;
        const c = this._cross(cur, prv, o.bandThr, p.dir, this.prevT, t);
        this.pend = null; return this._ev(c, t, p, true);
      }
      if (t - p.t0 > o.maxWaitMs || this.lastOccGate < o.occGate * 0.5) { this.pend = null; return this._ev(p.full, t, p, false); }
      return null;
    }
    push(lum, t) {
      const w = this.w, h = this.h, N = w * h, o = this.o;
      if (!this.bg) { this.bg = Float32Array.from(lum); this.prevT = t; this.prev = null; this.hasPmask = false; this.unstable = o.refractoryAfterReset; return null; }
      const bg = this.bg, mask = this.mask;
      // décalage global (exposition auto) : médiane des différences sur un sous-échantillon
      const sub = [];
      for (let i = 0; i < N; i += 7) sub.push(lum[i] - bg[i]);
      sub.sort((a, b) => a - b);
      const g = sub[sub.length >> 1];
      const thr = Math.max(o.pixMin, Math.min(o.pixMax, this.noise * 4.5));
      const occ = this.occ, cmin = this.colMin, cmax = this.colMax;
      occ.fill(0); cmin.fill(h); cmax.fill(-1);
      let fg = 0, madAcc = 0, madN = 0;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x, d = lum[i] - bg[i] - g, ad = d < 0 ? -d : d;
          if (ad > thr) {
            mask[i] = 1; occ[x]++; fg++; if (y < cmin[x]) cmin[x] = y; if (y > cmax[x]) cmax[x] = y;
            bg[i] += 0.004 * (lum[i] - bg[i]);
          } else {
            mask[i] = 0;
            bg[i] += 0.04 * (lum[i] - bg[i]);
            if ((i & 15) === 0) { madAcc += ad; madN++; }
          }
        }
      }
      this.fgFrac = fg / N;
      if (madN) this.noise = 0.97 * this.noise + 0.03 * (madAcc / madN) * 1.25;
      if (this.fgFrac > 0.5) { // téléphone bougé / saut d'éclairage
        this.bg = Float32Array.from(lum); this.unstable = o.refractoryAfterReset; this.prev = null; this.prev2 = null; this.hasPmask = false; this.pend = null; this.prevT = t; return null;
      }
      const occS = this.occS;
      for (let x = 0; x < w; x++) occ[x] /= h;
      for (let x = 0; x < w; x++) occS[x] = (occ[Math.max(0, x - 1)] + 2 * occ[x] + occ[Math.min(w - 1, x + 1)]) / 4;
      const gi = Math.round(this.gx), gl = Math.floor(this.gx), gr = Math.ceil(this.gx);
      const occG = Math.max(occ[gl], occ[gr]);
      this.lastOccGate = occG;
      const prev = this.prev, prevT = this.prevT;
      let ev = null;
      const occupied = occG >= o.occGate;
      if (!occupied && occG < o.occGate * 0.6) { if (this.wasOcc) this.clearSince = t; this.wasOcc = false; }
      if (this.pend) ev = this._pending(t);
      else if (occupied) {
        const canFire = this.armed && this.unstable <= 0 && !this.wasOcc && (t - this.clearSince) >= o.clearMs && (t - this.lastTrig) >= o.cooldownMs;
        this.wasOcc = true;
        if (canFire) {
          const [L, R] = this._edges(occS, gi);
          let mass = 0; for (let x = L; x <= R; x++) mass += occS[x];
          // sens : déplacement du centre de masse depuis l'image précédente (repli : asymétrie du blob)
          let dir = (this.gx - L) >= (R - this.gx) ? 1 : -1; // 1 : va vers la droite
          if (prev) {
            const lim = Math.round(w * 0.45), x0 = Math.max(0, gi - lim), x1 = Math.min(w - 1, gi + lim);
            let m0 = 0, s0 = 0, m1 = 0, s1 = 0;
            for (let x = x0; x <= x1; x++) { m0 += prev[x]; s0 += prev[x] * x; m1 += occ[x]; s1 += occ[x] * x; }
            if (m0 > 0.05 && m1 > 0.05) { const sh = s1 / m1 - s0 / m0; if (Math.abs(sh) > 0.4) dir = sh > 0 ? 1 : -1; }
          }
          if (mass >= o.minMass && (o.dir === 0 || o.dir === dir)) {
            let top = h, bot = -1; for (let x = L; x <= R; x++) { if (cmin[x] < top) top = cmin[x]; if (cmax[x] > bot) bot = cmax[x]; }
            const hpx = Math.max(1, bot - top + 1);
            const p = { dir, hFrac: hpx / h, mass, t0: t };
            this.lastTrig = t;
            if (o.band) {
              p.full = this._cross(occ, prev, o.occGate, dir, prevT, t);
              p.y0 = Math.min(h - 1, top + Math.round(o.band[0] * hpx));
              p.y1 = Math.max(p.y0, Math.min(h - 1, top + Math.round(o.band[1] * hpx)));
              this.pend = p;
              ev = this._pending(t);
            } else {
              // mode main : front = colonnes NOUVELLEMENT occupées à partir de la ligne (ignore la main tenue immobile)
              const isNew = (x) => occ[x] >= o.occGate && !(prev && prev[x] >= o.occGate);
              let eCur = NaN;
              if (dir > 0) { let x = gl; if (!isNew(x) && isNew(gr)) x = gr; if (isNew(x)) { while (x + 1 < w && isNew(x + 1)) x++; eCur = x + 0.5; } }
              else { let x = gr; if (!isNew(x) && isNew(gl)) x = gl; if (isNew(x)) { while (x - 1 >= 0 && isNew(x - 1)) x--; eCur = x - 0.5; } }
              const back = (prof) => {
                if (!prof) return NaN;
                const lim = Math.round(w * 0.45);
                if (dir > 0) { for (let x = gl; x >= Math.max(0, gl - lim); x--) if (prof[x] >= o.occGate) return x + 0.5; }
                else { for (let x = gr; x <= Math.min(w - 1, gr + lim); x++) if (prof[x] >= o.occGate) return x - 0.5; }
                return NaN;
              };
              const c = { t: (prevT + t) / 2, interp: false, vpx: NaN };
              const sgn = dir > 0 ? 1 : -1;
              if (prev && t - prevT < 200 && isFinite(eCur)) {
                const ePrev = back(prev);
                if (isFinite(ePrev)) {
                  const dist = sgn * (eCur - ePrev), toGate = sgn * (this.gx - ePrev);
                  if (dist > 0.3) {
                    c.t = prevT + Math.max(0, Math.min(1, toGate / dist)) * (t - prevT); c.interp = true; c.vpx = dist / (t - prevT);
                    // freinage brutal pendant l'image (mains qui se rencontrent) : extrapolation avec la vitesse d'avant
                    const ePrev2 = this.prev2 && prevT - this.prev2T < 200 ? back(this.prev2) : NaN;
                    if (isFinite(ePrev2)) {
                      const d1 = sgn * (ePrev - ePrev2), v1 = d1 / (prevT - this.prev2T);
                      if (d1 > 0.3 && c.vpx < 0.7 * v1) { c.t = Math.min(t, prevT + toGate / v1); c.vpx = v1; }
                    }
                  }
                }
              }
              ev = this._ev(c, t, p, false);
            }
          }
        }
      }
      if (this.unstable > 0) this.unstable--;
      this.prev2 = this.prev; this.prev2T = this.prevT;
      this.prev = Float32Array.from(occ); this.prevT = t;
      const tmp = this.pmask; this.pmask = this.mask; this.mask = tmp; this.hasPmask = true;
      return ev;
    }
  }

  // ---------------- Régression robuste ----------------
  function linfit(xs, ys) {
    const n = xs.length; let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    const mx = sx / n, my = sy / n; let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx; sxx += dx * dx; sxy += dx * (ys[i] - my); }
    const b = sxx > 0 ? sxy / sxx : 0, a = my - b * mx;
    let ss = 0; for (let i = 0; i < n; i++) { const r = ys[i] - a - b * xs[i]; ss += r * r; }
    const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
    const seB = sxx > 0 ? resid / Math.sqrt(sxx) : Infinity;
    return { a, b, resid, seB, n, mx };
  }

  // Côté Arrivée : bips de synchro (ancre = bip descendant, puis bips montants toutes les P ms, horloge du Départ).
  // Une ancre n'est adoptée qu'après 3 bips cohérents avec elle (évite qu'un faux bip décale toute la grille).
  // Une marche de latence (décrochage audio) ouvre un nouveau segment : pente commune à tous les segments,
  // ordonnée à l'origine propre à chacun ; h0 = niveau du segment courant. Aucun point n'est perdu.
  class SyncFit {
    constructor(periodMs = 1000) { this.P = periodMs; this.reset(); }
    reset() { this.h0 = null; this.pts = []; this.cand = null; this.candPts = []; this.rej = []; this.shifts = 0; this.seg = 0; }
    anchor(h) {
      if (this.h0 !== null) { const f = this.fit(); const k = Math.round((h - f.h0) / f.b); if (k >= 0 && Math.abs(h - f.h0 - k * f.b) < 3) return 'same'; }
      this.cand = h; this.candPts = [[0, h, 0]]; return 'candidate';
    }
    chirp(h) {
      if (this.cand !== null) {
        const k = Math.round((h - this.cand) / this.P), r = h - (this.cand + k * this.P);
        if (k >= 1 && Math.abs(r) < 3 + k * this.P * 2e-4) {
          if (!this.candPts.some(p => p[0] === k)) this.candPts.push([k, h, 0]);
          if (this.candPts.length >= 3) { this.h0 = this.cand; this.pts = this.candPts.slice(); this.seg = 0; this.rej = []; this.cand = null; this.candPts = []; return { k, switched: true }; }
        }
      }
      if (this.h0 === null) return { k: -1 };
      const f = this.fit();
      const k = Math.round((h - f.h0) / f.b), r = h - (f.h0 + k * f.b);
      if (k <= 0) return { k: -1 };
      const thr = this.pts.length >= 8 ? Math.max(1.5, 6 * f.resid) : 5;
      if (Math.abs(r) > thr) {
        if (Math.abs(r) > 200) return { k: -1 };
        this.rej.push([k, h, r]); if (this.rej.length > 6) this.rej.shift();
        const last = this.rej.slice(-4);
        if (last.length === 4 && new Set(last.map(x => x[0])).size === 4) {
          const rs = last.map(x => x[2]);
          if (Math.max(...rs) - Math.min(...rs) < 1.2) {
            this.seg++; this.shifts++;
            for (const x of last) if (!this.pts.some(q => q[0] === x[0])) this.pts.push([x[0], x[1], this.seg]);
            this.rej = [];
            return { k, shifted: true, step: median(rs) };
          }
        }
        return { k: -1 };
      }
      this.rej = [];
      const e = this.pts.findIndex(p => p[0] === k);
      if (e >= 0) { if (Math.abs(r) < Math.abs(this.pts[e][1] - (f.h0 + k * f.b))) this.pts[e] = [k, h, this.seg]; return { k, dup: true }; }
      this.pts.push([k, h, this.seg]); return { k };
    }
    get ready() { return this.h0 !== null; }
    _pooled(pts) {
      const segs = new Map();
      for (const p of pts) { const sg = p[2] || 0; if (!segs.has(sg)) segs.set(sg, []); segs.get(sg).push(p); }
      let sxx = 0, sxy = 0; const mean = new Map();
      for (const [sg, arr] of segs) {
        let mk = 0, mh = 0; for (const p of arr) { mk += p[0]; mh += p[1]; } mk /= arr.length; mh /= arr.length;
        mean.set(sg, [mk, mh]);
        for (const p of arr) { sxx += (p[0] - mk) ** 2; sxy += (p[0] - mk) * (p[1] - mh); }
      }
      const b = sxx > 0 ? sxy / sxx : this.P, a = new Map();
      for (const [sg, [mk, mh]] of mean) a.set(sg, mh - b * mk);
      let ss = 0; for (const p of pts) { const r = p[1] - a.get(p[2] || 0) - b * p[0]; ss += r * r; }
      const dof = pts.length - 1 - segs.size, resid = dof > 0 ? Math.sqrt(ss / dof) : 0;
      let lastSeg = -1; for (const sg of segs.keys()) if (sg > lastSeg) lastSeg = sg;
      return { b, a, aLast: a.get(this.seg) ?? a.get(lastSeg), resid, seB: sxx > 0 ? resid / Math.sqrt(sxx) : Infinity, r: (p) => p[1] - a.get(p[2] || 0) - b * p[0] };
    }
    fit() {
      if (this.h0 === null || this.pts.length < 1) return null;
      if (this.pts.length < 3) return { h0: this.h0, b: this.P, rhoPpm: 0, resid: 0, n: this.pts.length, spanS: 0, err30: Infinity };
      let pts = this.pts.slice(), f = this._pooled(pts);
      for (let it = 0; it < 2 && pts.length > 5; it++) {
        const r = pts.map(p => Math.abs(f.r(p)));
        const lim = Math.max(0.6, 4 * median(r));
        const keep = pts.filter((p, i) => r[i] <= lim);
        if (keep.length === pts.length || keep.length < 4) break;
        pts = keep; f = this._pooled(pts);
      }
      if (!isFinite(f.aLast)) return { h0: this.h0, b: this.P, rhoPpm: 0, resid: 0, n: pts.length, spanS: 0, err30: Infinity };
      const kmax = Math.max(...pts.map(p => p[0])), kmin = Math.min(...pts.map(p => p[0]));
      return { h0: f.aLast, b: f.b, rhoPpm: (f.b / this.P - 1) * 1e6, resid: f.resid, n: pts.length, spanS: (kmax - kmin) * this.P / 1000,
        err30: f.seB / this.P * 1800000 }; // incertitude (1σ) sur l'horloge commune après 30 min, en ms
    }
  }

  // ---------------- Temps commun τ (ms, unités de l'horloge du Départ) ----------------
  // τ = 0 à l'émission physique du bip d'ancre ; τ = k·P pour le bip k ; départs programmés à τ = n·60000.
  // fit = SyncFit.fit() (h0 : arrivée du bip 0, b : ms Arrivée par période), P = période en ms Départ
  function tauFinish(tCam, fit, P, Dfin, dSyncM) {
    return (tCam - Dfin + dSyncM / SOUND_SPEED * 1000 - fit.h0) * (P / fit.b);
  }
  function tauStart(tCam, s0, Dstart, Rstart, dSelfM) {
    return tCam - s0 - Dstart - (Rstart - dSelfM / SOUND_SPEED * 1000);
  }
  const GRID = 60000, CODE_MOD = 100000;
  function gridResult(tau, tMinMs) { const n = Math.floor((tau - tMinMs) / GRID); return { n, T: tau - n * GRID }; }
  function codeOf(tau) { return ((Math.round(tau) % CODE_MOD) + CODE_MOD) % CODE_MOD; }
  function codeDiff(code, tauA) { return ((code - Math.round(tauA)) % CODE_MOD + CODE_MOD) % CODE_MOD; }

  const API = { SOUND_SPEED, FFT, makeChirp, makeGun, median, mad, MatchedFilter, detectClapOnset, GateDetector, linfit, SyncFit, tauFinish, tauStart, gridResult, codeOf, codeDiff, GRID, CODE_MOD };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ChronoCore = API;
})(typeof self !== 'undefined' ? self : this);
