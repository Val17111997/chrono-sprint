const C = require('../src/core.js');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails++; };
let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// 1. FFT vs DFT
{
  const n = 64, f = new C.FFT(n), re = new Float64Array(n), im = new Float64Array(n), x = [];
  for (let i = 0; i < n; i++) { x.push(rnd() - 0.5); re[i] = x[i]; }
  f.run(re, im, false);
  let err = 0;
  for (let k = 0; k < n; k++) { let a = 0, b = 0; for (let t = 0; t < n; t++) { a += x[t] * Math.cos(2 * Math.PI * k * t / n); b -= x[t] * Math.sin(2 * Math.PI * k * t / n); } err = Math.max(err, Math.abs(a - re[k]), Math.abs(b - im[k])); }
  f.run(re, im, true); let e2 = 0; for (let i = 0; i < n; i++) e2 = Math.max(e2, Math.abs(re[i] / n - x[i]));
  ok(err < 1e-9 && e2 < 1e-12, `FFT exact (err ${err.toExponential(1)}, inv ${e2.toExponential(1)})`);
}

// 2. Détection de bips (sous-échantillon, SNR variés, dérive)
const sr = 48000;
const up = C.makeChirp(sr, 2000, 6000, 0.12), dn = C.makeChirp(sr, 6000, 2000, 0.12), gun = C.makeGun(sr);
function renderChirp(buf, t0s, f0, f1, dur, amp, sr) { // rendu analytique à délai fractionnaire
  const k = (f1 - f0) / dur, rn = 0.005;
  const i0 = Math.floor(t0s * sr), i1 = Math.ceil((t0s + dur) * sr);
  for (let i = i0; i <= i1 && i < buf.length; i++) {
    const t = i / sr - t0s; if (t < 0 || t > dur) continue;
    let w = 1; if (t < rn) w = 0.5 - 0.5 * Math.cos(Math.PI * t / rn); else if (t > dur - rn) w = 0.5 - 0.5 * Math.cos(Math.PI * (dur - t) / rn);
    buf[i] += amp * w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
}
function runDetect(buf, mf, minRatio = 8) {
  const out = []; const N = mf.N;
  for (let s = 0; s + N <= buf.length; s += mf.step) {
    const d = mf.process(buf.subarray(s, s + N), { minRatio });
    for (const x of d) out.push(Object.assign({}, x, { abs: s + x.idx }));
  }
  return out;
}
{
  const mf = new C.MatchedFilter(sr, [{ name: 'up', data: up }, { name: 'down', data: dn }], 32768);
  for (const [snrLabel, amp, sigma] of [['fort', 0.5, 0.01], ['moyen (SNR -10 dB)', 0.03, 0.1], ['faible (SNR -13 dB)', 0.022, 0.1]]) {
    const len = sr * 12, buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = sigma * gauss();
    const truth = [];
    for (let k = 0; k < 10; k++) { const t0 = 0.5 + k * 1.0003 + rnd() * 1e-4; const type = k === 0 ? 'down' : 'up'; truth.push({ t0, type }); type === 'up' ? renderChirp(buf, t0, 2000, 6000, 0.12, amp, sr) : renderChirp(buf, t0, 6000, 2000, 0.12, amp, sr); }
    const det = runDetect(buf, mf);
    let maxErr = 0, matched = 0, wrongType = 0;
    for (const tr of truth) {
      const d = det.find(x => Math.abs(x.abs / sr - tr.t0) < 0.01);
      if (d) { matched++; maxErr = Math.max(maxErr, Math.abs(d.abs / sr - tr.t0) * 1000); if (d.type !== tr.type) wrongType++; }
    }
    const falseDet = det.filter(x => !truth.some(tr => Math.abs(x.abs / sr - tr.t0) < 0.01)).length;
    ok(matched === 10 && wrongType === 0 && falseDet === 0 && maxErr < 0.05, `bips ${snrLabel}: ${matched}/10, type ok, ${falseDet} fausse(s), erreur max ${maxErr.toFixed(4)} ms, SNR ~${(det[0] || {}).snrDb?.toFixed(1)} dB`);
  }
  // bruit seul + claquements + « voix » (sinus modulés) → aucune détection
  const len = sr * 20, buf = new Float32Array(len);
  for (let i = 0; i < len; i++) { const t = i / sr; const ph = 2 * Math.PI * (300 * t - 200 / 3 * Math.cos(3 * t)); let v = 0; for (let hN = 1; hN <= 12; hN++) v += Math.sin(hN * ph) / hN; buf[i] = 0.05 * gauss() + 0.2 * v * (Math.sin(t * 7) > 0 ? 1 : 0.1); }
  for (let c = 0; c < 15; c++) { const p = Math.floor((1 + c * 1.2) * sr); for (let i = 0; i < 300; i++) buf[p + i] += (rnd() * 2 - 1) * Math.exp(-i / 60); }
  const det = runDetect(buf, mf);
  ok(det.length === 0, `aucune fausse détection sur bruit + claquements + voix (${det.length})`);
}

// 2b. Bips de contrôle (6,5–9,5 kHz, 60 ms) mêlés aux bips de synchro, chevauchements compris
{
  const hello = C.makeChirp(sr, 6500, 9500, 0.06), okc = C.makeChirp(sr, 9500, 6500, 0.06);
  const mf = new C.MatchedFilter(sr, [{ name: 'up', data: up, group: 's' }, { name: 'down', data: dn, group: 's' }, { name: 'hello', data: hello, group: 'c' }, { name: 'ok', data: okc, group: 'c' }], 32768);
  const len = sr * 14, buf = new Float32Array(len);
  for (let i = 0; i < len; i++) buf[i] = 0.01 * gauss();
  const truth = [];
  for (let k = 0; k < 10; k++) { const t0 = 0.5 + k; truth.push({ t0, type: k === 0 ? 'down' : 'up' }); k === 0 ? renderChirp(buf, t0, 6000, 2000, 0.12, 0.05, sr) : renderChirp(buf, t0, 2000, 6000, 0.12, 0.05, sr); }
  for (let k = 0; k < 8; k++) { const t0 = 0.55 + k * 1.5; const ty = k < 5 ? 'hello' : 'ok'; truth.push({ t0, type: ty }); ty === 'hello' ? renderChirp(buf, t0, 6500, 9500, 0.06, 0.6, sr) : renderChirp(buf, t0, 9500, 6500, 0.06, 0.6, sr); }
  const det = runDetect(buf, mf);
  let matched = 0, wrong = 0, maxErr = 0;
  for (const tr of truth) { const d = det.find(x => x.type === tr.type && Math.abs(x.abs / sr - tr.t0) < 0.005); if (d) { matched++; maxErr = Math.max(maxErr, Math.abs(d.abs / sr - tr.t0) * 1000); } }
  const extra = det.filter(x => !truth.some(tr => tr.type === x.type && Math.abs(x.abs / sr - tr.t0) < 0.005));
  ok(matched === truth.length && extra.length === 0 && maxErr < 0.05, `synchro + contrôle mêlés : ${matched}/${truth.length}, ${extra.length} intrus ${extra.map(e => e.type + '@' + (e.abs / sr).toFixed(3)).join(' ')}, erreur max ${maxErr.toFixed(3)} ms`);
}

// 3. Attaque de claquement en présence de bips
{
  const len = sr * 1, x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = 0.003 * gauss();
  renderChirp(x, 0.1, 2000, 6000, 0.12, 0.6, sr); // bip fort juste avant
  const tc = 0.4123; const pc = tc * sr;
  for (let i = Math.ceil(pc); i < pc + 2000; i++) { const t = (i - pc) / sr; x[i] += (rnd() * 2 - 1) * 0.8 * Math.exp(-t / 0.004); }
  const r = C.detectClapOnset(x, sr, [[0.1 * sr - 100, 0.1 * sr + 500]]);
  ok(r && Math.abs(r.idx / sr - tc) * 1000 < 0.4, `attaque claquement: erreur ${r ? ((r.idx / sr - tc) * 1000).toFixed(3) : '—'} ms`);
}

// 3b. Synchro « clap-clap » : deux téléphones (micros différents) entendent les mêmes claquements
{
  const len = sr * 6;
  const room = new Float32Array(len); // son au niveau des téléphones
  const claps = [1.8123, 2.5467];
  for (let i = 0; i < len; i++) room[i] = 0.004 * gauss() + 0.05 * Math.sin(2 * Math.PI * 90 * i / sr) * (0.5 + 0.5 * Math.sin(i / sr)); // bruit + vent grave
  for (const tc of claps) { const pc = tc * sr; for (let i = Math.ceil(pc); i < pc + 4000; i++) { const tt = (i - pc) / sr; room[i] += (rnd() * 2 - 1) * 0.6 * Math.exp(-tt / 0.005); } }
  const phone = (gain, lp, delaySamples, noise) => { // micro : gain, passe-bas du premier ordre, retard, bruit propre
    const y = new Float32Array(len); let s1 = 0; const a = Math.exp(-2 * Math.PI * lp / sr);
    for (let i = 0; i < len; i++) { const xi = i - delaySamples >= 0 ? room[i - delaySamples] : 0; s1 = a * s1 + (1 - a) * xi; y[i] = gain * s1 + noise * gauss(); }
    return y;
  };
  const res = [];
  for (const [g, lp, d] of [[1, 16000, 0], [0.3, 9000, 5], [2.5, 12000, 2]]) {
    const det = new C.OnsetDetector(sr), x = phone(g, lp, d, 0.001), ons = [];
    for (let s = 0; s < len; s += 2048) for (const o of det.push(x.subarray(s, s + 2048), s)) ons.push(o);
    const pair = C.findClapPair(ons, sr);
    res.push({ ons: ons.length, pair, err: pair ? ((pair.a.frame - d) / sr - claps[0]) * 1000 : NaN });
  }
  const errs = res.map(r => r.err), spread = Math.max(...errs) - Math.min(...errs);
  const ivs = res.map(r => r.pair && r.pair.interval);
  ok(res.every(r => r.pair && r.ons === 2) && spread < 0.15 && Math.max(...ivs) - Math.min(...ivs) < 0.1, `clap-clap sur 3 micros différents : ${res.map(r => r.ons).join('/')} attaques, origine à ${errs.map(e => e.toFixed(3)).join(' / ')} ms, écart ${spread.toFixed(3)} ms, intervalle ${ivs.map(v => v && v.toFixed(2)).join(' / ')} ms`);
  // voix + pas : aucune paire
  const y = new Float32Array(sr * 8);
  for (let i = 0; i < y.length; i++) { const t = i / sr; const ph = 2 * Math.PI * (180 * t + 20 * Math.sin(2 * t)); let v = 0; for (let h = 1; h < 15; h++) v += Math.sin(h * ph) / h; y[i] = 0.003 * gauss() + 0.15 * v * Math.max(0, Math.sin(t * 5)); }
  for (const tp of [1, 1.6, 2.2, 2.8, 3.4, 4.0]) { const p0 = tp * sr; for (let i = p0; i < p0 + 2000; i++) y[i] += 0.08 * Math.sin(2 * Math.PI * 60 * (i - p0) / sr) * Math.exp(-(i - p0) / 400); } // pas (graves)
  const det = new C.OnsetDetector(sr), ons = [];
  for (let s = 0; s < y.length; s += 2048) for (const o of det.push(y.subarray(s, s + 2048), s)) ons.push(o);
  ok(!C.findClapPair(ons, sr), `voix + pas : pas de fausse paire (${ons.length} attaques)`);
}

// 4. Détecteur caméra (images synthétiques, bord anti-aliasé, bruit capteur)
function frames(o) {
  const w = 120, h = 160, gd = new C.GateDetector(w, h, o.det || {});
  const bgTex = new Float32Array(w * h); for (let i = 0; i < w * h; i++) bgTex[i] = 90 + 60 * rnd();
  const evs = []; const fps = o.fps, dt = 1000 / fps;
  for (let f = 0; f < o.n; f++) {
    const t = 1000 + f * dt + (o.jitter ? (rnd() - 0.5) * o.jitter : 0); // jitter = erreur d'horodatage
    const tt = 1000 + f * dt; // vrai instant
    const lum = new Uint8ClampedArray(w * h);
    const xl = o.x0 + o.dir * o.v * (tt - 1000) / 1000; // bord avant (px), body width bw
    const left = o.dir > 0 ? xl - o.bw : xl, right = o.dir > 0 ? xl : xl + o.bw;
    const gain = 1 + (o.expo ? 0.15 * Math.sin(f / 20) : 0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = bgTex[y * w + x] * gain;
      if (y > h * o.top && y < h * o.bot) {
        let cov = Math.max(0, Math.min(x + 0.5, right) - Math.max(x - 0.5, left));
        if (o.arm && (f % 4) < 2) { // bras/main devant le torse une image sur deux
          const yb = (y - h * o.top) / (h * (o.bot - o.top));
          if (yb > o.arm.rows[0] && yb < o.arm.rows[1]) {
            const al = o.dir > 0 ? xl + o.arm.lead - o.arm.w : xl - o.arm.lead, ar = al + o.arm.w;
            cov = Math.min(1, cov + Math.max(0, Math.min(x + 0.5, ar) - Math.max(x - 0.5, al)));
          }
        }
        if (cov > 0) v = v * (1 - cov) + 30 * cov;
      }
      lum[y * w + x] = v + 3 * gauss();
    }
    const e = gd.push(lum, t); if (e) evs.push(e);
  }
  const gx = (w - 1) / 2;
  const tTrue = 1000 + (o.dir > 0 ? (gx - o.x0) : (o.x0 - gx)) / o.v * 1000;
  return { evs, tTrue };
}
for (const c of [
  { name: 'sprinter 60 fps → droite', fps: 60, v: 600, dir: 1, x0: -120, bw: 25, top: 0.3, bot: 0.85, n: 50 },
  { name: 'sprinter 30 fps → droite', fps: 30, v: 600, dir: 1, x0: -250, bw: 25, top: 0.3, bot: 0.85, n: 35 },
  { name: 'sprinter 30 fps ← gauche, loin', fps: 30, v: -450, dir: -1, x0: 330, bw: 10, top: 0.55, bot: 0.68, n: 40 },
  { name: 'main 30 fps (expo auto, mode main)', fps: 30, v: 900, dir: 1, x0: -400, bw: 40, top: 0.2, bot: 0.6, n: 25, expo: true, det: { band: null } },
  { name: 'sprinter 30 fps + bras en avant (torse)', fps: 30, v: 600, dir: 1, x0: -250, bw: 25, top: 0.25, bot: 0.9, n: 35, arm: { lead: 9, w: 4, rows: [0.22, 0.3] } },
  { name: 'sprinter 60 fps ← + bras (torse)', fps: 60, v: 600, dir: -1, x0: 330, bw: 25, top: 0.25, bot: 0.9, n: 60, arm: { lead: 9, w: 4, rows: [0.22, 0.3] } },
]) {
  if (c.v < 0) { c.v = -c.v; }
  const r = frames(c);
  const e = r.evs[0];
  const err = e ? e.t - r.tTrue : NaN;
  ok(r.evs.length === 1 && Math.abs(err) < (c.fps === 60 ? 2 : 3.5) && e.dir === c.dir, `${c.name}: ${r.evs.length} évt, dir ${e && e.dir}, erreur ${isFinite(err) ? err.toFixed(2) : '—'} ms, interp ${e && e.interp}`);
}
{ // filtre de sens
  const r = frames({ fps: 30, v: 600, dir: 1, x0: -250, bw: 25, top: 0.3, bot: 0.85, n: 25, det: { dir: -1 } });
  ok(r.evs.length === 0, 'filtre de sens : passage ignoré dans le mauvais sens');
}

{ // claquement : main gauche immobile à 1 px de la ligne, main droite arrive de la droite à 2,5 m/s (~750 px/s)
  const w = 120, h = 160, gd = new C.GateDetector(w, h, { band: null }); const gx = (w - 1) / 2;
  const bgTex = new Float32Array(w * h); for (let i = 0; i < w * h; i++) bgTex[i] = 90 + 60 * rnd();
  const stillR = gx - 1, v = 750, x0 = 420; // bord gauche de la main mobile
  const tContact = 1000 + (x0 - stillR) / v * 1000, tGate = 1000 + (x0 - gx) / v * 1000;
  let ev = null;
  for (let f = 0; f < 40; f++) {
    const tt = 1000 + f * 1000 / 30, lum = new Uint8ClampedArray(w * h);
    const ml = Math.max(stillR, x0 - v * (tt - 1000) / 1000);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let val = bgTex[y * w + x];
      if (y > 40 && y < 120) {
        const cs = f > 0 ? Math.max(0, Math.min(x + 0.5, stillR) - Math.max(x - 0.5, stillR - 30)) : 0; // main fixe (apparaît à f=1)
        const cm = Math.max(0, Math.min(x + 0.5, ml + 30) - Math.max(x - 0.5, ml));
        const cov = Math.min(1, cs + cm); if (cov > 0) val = val * (1 - cov) + 200 * cov;
      }
      lum[y * w + x] = val + 3 * gauss();
    }
    const e = gd.push(lum, tt); if (e && !ev) ev = e;
  }
  ok(ev && ev.dir === -1 && Math.abs(ev.t - tGate) < 3, `claquement main fixe : dir ${ev && ev.dir}, erreur vs ligne ${ev ? (ev.t - tGate).toFixed(2) : '—'} ms (contact à +${(tContact - tGate).toFixed(1)} ms)`);
}

{ // synchro avec deux marches de latence (+10 ms au bip 15, −6 ms au bip 30)
  const s = new C.SyncFit(1000), off = 5000, rho = 31e-6;
  const lvl = (k) => (k >= 15 ? 10 : 0) + (k >= 30 ? -6 : 0);
  s.anchor(off + 0.05 * gauss());
  for (let k = 1; k <= 45; k++) s.chirp(off + k * 1000 * (1 + rho) + lvl(k) + 0.05 * gauss());
  const f = s.fit();
  ok(f.n >= 40 && Math.abs(f.rhoPpm - 31) < 5 && Math.abs(f.h0 - (off + 4)) < 0.15 && s.shifts === 2, `synchro avec marches : ${f.n} points gardés, ${s.shifts} marches, dérive ${f.rhoPpm.toFixed(2)} ppm, niveau final ${(f.h0 - off).toFixed(2)} ms (attendu 4)`);
}

{ // claquement vu par la caméra (mains qui se rejoignent n'importe où dans l'image)
  let worst = 0, miss = 0, n = 0;
  for (const fps of [30, 60]) for (const style of ['sym', 'still']) for (const meet of [40, 60, 80]) for (const ph of [0, 0.4, 0.8]) {
    const w = 120, h = 160, gd = new C.GateDetector(w, h, { band: null }), cv = new C.ClapVision(w);
    const bgT = new Float32Array(w * h); for (let i = 0; i < w * h; i++) bgT[i] = 90 + 60 * rnd();
    const v = style === 'sym' ? 300 : 500, contact = 2200 + ph * 1000 / fps;
    let ev = null;
    for (let f = 0; f < fps * 2.5; f++) {
      const t = 1000 + f * 1000 / fps, gap = Math.max(0, (contact - t) / 1000 * v), vis = t >= 1500;
      const lr = style === 'sym' ? meet - gap : meet, rl = style === 'sym' ? meet + gap : meet + 2 * gap;
      const lum = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let val = bgT[y * w + x]; if (vis && y > 40 && y < 120) { const cl = Math.max(0, Math.min(x + .5, lr) - Math.max(x - .5, lr - 25)), cr = Math.max(0, Math.min(x + .5, rl + 25) - Math.max(x - .5, rl)); const cov = Math.min(1, cl + cr); if (cov > 0) val = val * (1 - cov) + 200 * cov; } lum[y * w + x] = val + 3 * gauss(); }
      gd.push(lum, t); const e = cv.push(gd.occ, t); if (e && !ev) ev = e;
    }
    n++; if (!ev || !ev.interp) miss++; else worst = Math.max(worst, Math.abs(ev.t - contact));
  }
  ok(miss <= 6 && worst < 2.5, `claquement vu par la caméra : ${n - miss}/${n} retenus (les autres sont ignorés, on reclaque), erreur max ${worst.toFixed(2)} ms`);
}

// 5. Synchro : dérive + bruit
{
  const s = new C.SyncFit(1000);
  const off = 123456.7, rho = 23e-6;
  s.chirp(off - 3000); // bip montant avant toute ancre : ignoré
  s.anchor(off + 0.05 * gauss());
  for (let k = 1; k <= 45; k++) { s.chirp(off + k * 1000 * (1 + rho) + 0.05 * gauss()); if (k === 20) s.chirp(off + 20000 * (1 + rho) + 3); }
  s.anchor(off + 30400); // faux bip descendant isolé : ne doit pas déplacer la grille
  const f = s.fit();
  ok(Math.abs(f.rhoPpm - 23) < 1 && Math.abs(f.h0 - off) < 0.1, `synchro : dérive ${f.rhoPpm.toFixed(2)} ppm (vrai 23), h0 err ${(f.h0 - off).toFixed(3)} ms, err 30 min ±${f.err30.toFixed(2)} ms`);
  // τ arrivée : passage 600 s après l'ancre (horloge Départ)
  const tau = C.tauFinish(off + 600000 * (1 + rho) + 80 /*Lc-La*/, f, 1000, 80, 0);
  ok(Math.abs(tau - 600000) < 0.5, `τ arrivée cohérent (${(tau - 600000).toFixed(3)} ms)`);
  const g = C.gridResult(10 * 60000 + 11420, 8000);
  ok(g.n === 10 && Math.abs(g.T - 11420) < 1e-9, 'grille minute → 11,420 s');
  const code = C.codeOf(1234567.4), T = C.codeDiff(code, 1234567.4 - 3021);
  ok(code === 34567 && T === 3021, `code ${code}, temps ${T} ms`);
}
console.log(fails ? `\n${fails} échec(s)` : '\nTout est vert');
process.exit(fails ? 1 : 0);
