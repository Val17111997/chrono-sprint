(function () {
  'use strict';
  const CC = window.ChronoCore;
  const MS_PER_M = 1000 / CC.SOUND_SPEED;
  const D_CLAP_M = 0.35, D_SELF_M = 0.08;
  const VERSION = '2.1.0';

  // ---------------- utilitaires ----------------
  const $ = (s) => document.querySelector(s);
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const now = () => performance.now();
  const store = {
    get(k, d) { try { const v = localStorage.getItem('chrono.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('chrono.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
  };
  const comma = (s) => s.replace('.', ',');
  const fmt = {
    t2: (ms) => comma((ms / 1000).toFixed(2)),
    t3: (ms) => comma((ms / 1000).toFixed(3)),
    ms1: (ms) => comma(ms.toFixed(1)),
    clock: (ms) => { const s = ((ms % 3600000) + 3600000) % 3600000 / 1000; const m = Math.floor(s / 60); return m + ':' + comma((s % 60).toFixed(1).padStart(4, '0')); },
    code: (c) => { const s = String(c).padStart(5, '0'); return s.slice(0, 2) + ' ' + s.slice(2); },
    hm: (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };

  // ---------------- état ----------------
  const S = {
    role: null, screen: 'home', started: false,
    mode: store.get('mode', 'bip'),
    settings: Object.assign({ runDist: 100, athDist: 1, dir: 0, voice: true, lead: 25, autoRearm: false }, store.get('settings', {})),
    origin: null, interval: null, // zéro commun : 1er clap de synchro (perf de ce téléphone) ; intervalle entre les 2 claps
    R: null,                     // Départ : latence haut-parleur → micro
    rho: 0,                      // Arrivée : dérive de son horloge par rapport au Départ (mémorisée)
    D: null, Dspread: null,      // latence caméra − micro (ce téléphone)
    results: store.get('results', []),
    starts: [],                  // Départ (cellule) : départs enregistrés
    lastPassage: null,
    warnings: new Set(),
    syncGen: 0, lastRes: null, lastCheck: null,
  };
  const saveSettings = () => store.set('settings', S.settings);
  // temps acceptés : de 1,5 s à 59 s (la distance ne sert qu'à afficher la vitesse)
  const tMin = () => 1500;
  const tMax = () => S.mode === 'bip' ? 59000 : 99000;

  // ---------------- voix ----------------
  const Voice = {
    v: null,
    init() {
      if (!('speechSynthesis' in window)) return;
      const pick = () => { const vs = speechSynthesis.getVoices(); this.v = vs.find(v => /^fr[-_]FR/i.test(v.lang) && v.localService) || vs.find(v => /^fr/i.test(v.lang)) || null; };
      pick(); try { speechSynthesis.addEventListener('voiceschanged', pick); } catch (e) { }
    },
    unlock() { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { } },
    say(text) {
      if (!S.settings.voice || !('speechSynthesis' in window) || !this.v) return false;
      try { const u = new SpeechSynthesisUtterance(text); u.lang = 'fr-FR'; u.voice = this.v; u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u); return true; } catch (e) { return false; }
    },
    cancel() { try { speechSynthesis.cancel(); } catch (e) { } },
    time(ms) { const s = Math.floor(ms / 1000), c = Math.round((ms % 1000) / 10); return c === 100 ? `${s + 1} secondes` : `${s} secondes ${String(c).padStart(2, '0')}`; },
  };

  // ---------------- maintien de l'écran ----------------
  const Wake = { async on() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { } } };

  // ---------------- audio ----------------
  const BUF = {};
  const Audio = {
    ctx: null, sr: 48000, ring: null, mask: 0, writeFrame: -1, nextBlock: null, offs: [], off: null, method: null, inB: [], inCur: null, inFit: null, inStep: 0, inPend: [], inSteps: 0, zb: [], zTotal: 0, zRun: 0,
    mf: null, dets: [], onDet: null, blk: null, interrupted: false,
    async start(tplNames) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !navigator.mediaDevices) throw new Error('audio');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
      this.ctx = new AC({ latencyHint: 'interactive' });
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { } }
      this.sr = this.ctx.sampleRate;
      const sr = this.sr;
      const mkBuf = (data) => { const b = this.ctx.createBuffer(1, data.length, sr); b.getChannelData(0).set(data); return b; };
      // synchro : balayages 2–6 kHz (120 ms) ; signaux d'appairage : 6,5–9,5 kHz (60 ms), autre bande donc sans confusion
      const T = { down: CC.makeChirp(sr, 6000, 2000, 0.12), up: CC.makeChirp(sr, 2000, 6000, 0.12), hello: CC.makeChirp(sr, 6500, 9500, 0.06), ok: CC.makeChirp(sr, 9500, 6500, 0.06), gun: CC.makeGun(sr, 0.16) };
      const G = { down: 's', up: 's', hello: 'c', ok: 'c', gun: 'g' };
      for (const k in T) BUF[k] = mkBuf(T[k]);
      BUF.cue = mkBuf((() => { const n = Math.round(0.12 * sr), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 880 * i / sr) * Math.min(1, i / 200, (n - i) / 200); return a; })());
      // signal quasi inaudible en boucle : garde la sortie audio active (latence stable)
      const kb = this.ctx.createBuffer(1, sr, sr), kd = kb.getChannelData(0); for (let i = 0; i < sr; i++) kd[i] = (Math.random() * 2 - 1) * 2e-5;
      const ks = this.ctx.createBufferSource(); ks.buffer = kb; ks.loop = true; ks.connect(this.ctx.destination); ks.start();
      this.ring = new Float32Array(1 << 20); this.mask = (1 << 20) - 1;
      const src = this.ctx.createMediaStreamSource(this.stream);
      const sink = this.ctx.createGain(); sink.gain.value = 0; sink.connect(this.ctx.destination);
      let ok = false;
      if (this.ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          const code = 'class Cap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0;this.f=0;}process(i){const c=i[0]&&i[0][0];if(c){if(this.n===0)this.f=currentFrame;this.b.set(c,this.n);this.n+=c.length;if(this.n+c.length>2048){this.port.postMessage({f:this.f,d:this.b.slice(0,this.n)});this.n=0;}}return true;}}registerProcessor("cap",Cap);';
          const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
          await this.ctx.audioWorklet.addModule(url);
          const node = new AudioWorkletNode(this.ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          node.port.onmessage = (e) => this._push(e.data.f, e.data.d);
          src.connect(node); node.connect(sink); ok = true; this.capMode = 'worklet';
        } catch (e) { console.warn('worklet indisponible', e); }
      }
      if (!ok) {
        const sp = this.ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (e) => this._push(Math.round(e.playbackTime * sr), new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(sp); sp.connect(sink); this.capMode = 'script';
      }
      if (tplNames.length) { this.mf = new CC.MatchedFilter(sr, tplNames.map(n => ({ name: n, data: T[n], group: G[n] })), 32768); this.blk = new Float32Array(this.mf.N); }
      this.onset = new CC.OnsetDetector(sr);
      this.ctx.onstatechange = () => { if (this.ctx.state !== 'running') { this.interrupted = true; if (S.origin != null) { S.warnings.add('audio'); renderBanners(); } } };
      this.stream.getAudioTracks()[0].onended = () => { S.warnings.add('audio'); renderBanners(); };
      // méthode de correspondance horloge audio ↔ performance.now(), choisie une fois
      await new Promise(r => setTimeout(r, 250));
      const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
      this.method = ts && ts.contextTime > 0 && ts.performanceTime > 0 ? 'ots' : 'cur';
      this._map(); setInterval(() => this._map(), 100);
      setInterval(() => this._detect(), 60);
    },
    _map() {
      const c = this.ctx; if (!c || c.state !== 'running') return;
      let off;
      if (this.method === 'ots') { const ts = c.getOutputTimestamp(); if (!(ts.contextTime > 0)) return; off = ts.performanceTime - ts.contextTime * 1000; }
      else off = now() + ((c.outputLatency || c.baseLatency || 0) * 1000) - c.currentTime * 1000;
      this.offs.push(off); if (this.offs.length > 15) this.offs.shift();
      this.off = CC.median(this.offs);
    },
    // micro : correspondance trame ↔ performance.now(), continue en trames.
    // Mesure : minimum par seconde de (instant d'arrivée − fin du paquet). Un saut brutal de ce minimum
    // (décrochage du fil audio, file d'attente qui grossit) n'est pas suivi : le contenu reste continu en trames.
    // Pente (dérive horloge audio / horloge système) estimée sur toute la séance, à partir de 20 s de données.
    offInAt(fms) {
      const f = this.inFit;
      if (f) return f.a + f.b * fms;
      return this.inCur ? this.inCur.m : 0;
    },
    // silences insérés par le navigateur (sous-alimentation du micro : suite de zéros exacts) : le son qui suit arrive
    // d'autant plus tard en trames, on le recale
    zShiftAt(f) { let z = 0; for (const b of this.zb) { if (b[0] <= f) z = b[1]; else break; } return z; },
    perfOfFrame(f) { const fms = f / this.sr * 1000; return fms + this.offInAt(fms) - this.zShiftAt(f); },
    frameOfPerf(p) { let fms = p - this.offInAt(p) + this.zTotal; fms = p - this.offInAt(fms) + this.zTotal; return fms / 1000 * this.sr; },
    _bucket(x, m) {
      const y = m - this.inStep, f = this.inFit;
      if (f && this.inB.length >= 3) {
        const dev = y - (f.a + f.b * x);
        if (Math.abs(dev) > 2) {
          const P2 = this.inPend; P2.push(dev);
          if (P2.length >= 2 && Math.abs(P2[P2.length - 1] - P2[P2.length - 2]) < 1.5) {
            this.inStep += (P2[P2.length - 1] + P2[P2.length - 2]) / 2; this.inSteps++; this.inPend = [];
            this.inB.push([x, m - this.inStep]); this._fitIn();
          } else if (P2.length > 4) this.inPend = [];
          return;
        }
        this.inPend = [];
      }
      this.inB.push([x, y]); if (this.inB.length > 4000) this.inB.shift();
      this._fitIn();
    },
    _fitIn() {
      const B = this.inB;
      if (!B.length) { this.inFit = null; return; }
      const span = B[B.length - 1][0] - B[0][0];
      if (B.length < 20 || span < 20000) { this.inFit = { a: CC.median(B.map(v => v[1])), b: 0 }; return; }
      let pts = B, f = CC.linfit(pts.map(v => v[0]), pts.map(v => v[1]));
      for (let it = 0; it < 2; it++) {
        const keep = pts.filter(v => v[1] - (f.a + f.b * v[0]) < 1);
        if (keep.length < 20 || keep.length === pts.length) break;
        pts = keep; f = CC.linfit(pts.map(v => v[0]), pts.map(v => v[1]));
      }
      let bb = Math.max(-1e-4, Math.min(1e-4, f.b));
      const a = CC.median(pts.map(v => v[1] - bb * v[0]));
      this.inFit = { a, b: bb };
    },
    play(buf, perfTarget, gain = 1) {
      const c = this.ctx, t = (perfTarget - this.off) / 1000;
      const s = c.createBufferSource(); s.buffer = buf;
      const g = c.createGain(); g.gain.value = gain; s.connect(g); g.connect(c.destination);
      const late = t < c.currentTime + 0.01;
      s.start(late ? 0 : t);
      return { src: s, late };
    },
    beep(n = 1) { if (!this.ctx) return; const t0 = this.ctx.currentTime + 0.03; for (let i = 0; i < n; i++) { const s = this.ctx.createBufferSource(); s.buffer = BUF.cue; s.connect(this.ctx.destination); s.start(t0 + i * 0.2); } },
    _push(f, d) {
      const arr = now(), fe = (f + d.length) / this.sr * 1000, o = arr - fe;
      if (!this.inCur || arr - this.inCur.t0 >= 1000) {
        if (this.inCur) this._bucket(this.inCur.x, this.inCur.m);
        this.inCur = { t0: arr, x: fe, m: o };
      } else if (o < this.inCur.m) { this.inCur.m = o; this.inCur.x = fe; }
      if (this.writeFrame >= 0 && f !== this.writeFrame) {
        if (f > this.writeFrame && f - this.writeFrame < 48000) { for (let x = this.writeFrame; x < f; x++) this.ring[x & this.mask] = 0; }
        else { this.nextBlock = f; }
      }
      for (let i = 0; i < d.length; i++) {
        const v = d[i]; this.ring[(f + i) & this.mask] = v;
        if (v < 2e-6 && v > -2e-6) this.zRun++;
        else { if (this.zRun >= 48 && this.inB.length >= 2) { this.zTotal += this.zRun / this.sr * 1000; this.zb.push([f + i, this.zTotal]); if (this.zb.length > 500) this.zb.shift(); } this.zRun = 0; }
      }
      this.writeFrame = f + d.length;
      if (this.nextBlock == null) this.nextBlock = f;
      // niveau du micro (affichage) et attaques (claquements de synchro)
      let e = 0; for (let i = 0; i < d.length; i += 4) e += d[i] * d[i];
      const db = 10 * Math.log10(e / Math.ceil(d.length / 4) + 1e-12);
      this.level = this.level == null ? db : Math.max(db, this.level - 1.5);
      if (this.onset) for (const o of this.onset.push(d, f)) if (this.inB.length >= 2 && this.onOnset) this.onOnset({ frame: o.frame, perf: this.perfOfFrame(o.frame), peak: o.peak, ratio: o.ratio });
    },
    _detect() {
      if (!this.mf || this.nextBlock == null || this.inB.length < 3) return;
      const N = this.mf.N;
      if (this.writeFrame - this.nextBlock > this.ring.length - N) this.nextBlock = this.writeFrame - N;
      let guard = 0;
      while (this.writeFrame - this.nextBlock >= N && guard++ < 6) {
        const b = this.blk, s = this.nextBlock;
        for (let i = 0; i < N; i++) b[i] = this.ring[(s + i) & this.mask];
        const dets = this.mf.process(b, { minRatio: 8 });
        for (const d of dets) {
          const frame = s + d.idx, det = { type: d.type, frame, perf: this.perfOfFrame(frame), snr: d.snrDb, amp: d.amp };
          this.dets.push(det); if (this.dets.length > 60) this.dets.shift();
          if (this.onDet) this.onDet(det);
        }
        this.nextBlock += this.mf.step;
      }
    },
    // fenêtre d'échantillons couvrant [p0, p1] (perf), ou null si pas encore enregistrée
    window(p0, p1) {
      const f0 = Math.floor(this.frameOfPerf(p0)), f1 = Math.ceil(this.frameOfPerf(p1));
      if (f1 > this.writeFrame) return null;
      if (this.writeFrame - f0 > this.ring.length) return { gone: true };
      const n = f1 - f0, data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = this.ring[(f0 + i) & this.mask];
      return { f0, data };
    },
  };

  // ---------------- caméra ----------------
  const Cam = {
    video: null, det: null, W: 0, H: 0, canvas: null, g: null, fps: 0, fcount: 0, fT: 0, src: null, srcLocked: null,
    lastMT: null, offWin: [], onEvent: null, restarts: 0, started: false, landscape: false,
    async start() {
      this.video = $('#video');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } }, audio: false });
      this.stream = stream; this.track = stream.getVideoTracks()[0];
      this.video.srcObject = stream; this.video.muted = true; this.video.setAttribute('playsinline', '');
      await this.video.play().catch(() => { });
      this.track.onended = () => { S.warnings.add('camera'); renderBanners(); };
      this.canvas = document.createElement('canvas');
      this.g = this.canvas.getContext('2d', { willReadFrequently: true });
      this.started = true;
      const loop = (nowT, md) => { this._frame(nowT, md); this._req(loop); };
      this._req = 'requestVideoFrameCallback' in HTMLVideoElement.prototype
        ? (fn) => this.video.requestVideoFrameCallback(fn)
        : (fn) => { const tick = () => { const ct = this.video.currentTime; if (ct !== this._lastCT) { this._lastCT = ct; fn(now(), null); } else requestAnimationFrame(tick); }; requestAnimationFrame(tick); };
      this._req(loop);
    },
    _setup(vw, vh) {
      this.landscape = vw > vh;
      const W = this.landscape ? 160 : 120, H = Math.min(240, Math.round(W * vh / vw));
      this.W = W; this.H = H; this.canvas.width = W; this.canvas.height = H;
      this.lum = new Uint8Array(W * H);
      const prevO = this.det ? this.det.o : (this._pendingO || {}), armed = this.det ? this.det.armed : true;
      this.det = new CC.GateDetector(W, H, prevO);
      this.cv = new CC.ClapVision(W);
      this.det.armed = armed;
      this.vw = vw; this.vh = vh;
      $('#camWarn').hidden = !this.landscape; $('#camWarn').textContent = 'Tiens le téléphone debout (portrait).';
    },
    _ts(nowT, md) {
      if (md) {
        if ((this.srcLocked === null || this.srcLocked === 'capture') && typeof md.captureTime === 'number' && md.captureTime > 0) { this.srcLocked = 'capture'; return md.captureTime; }
        if ((this.srcLocked === null || this.srcLocked === 'media') && typeof md.mediaTime === 'number' && typeof md.presentationTime === 'number' && md.presentationTime > 0) {
          const mt = md.mediaTime * 1000;
          if (this.lastMT !== null && mt <= this.lastMT) { if (mt < this.lastMT - 1000) this.offWin = []; }
          this.lastMT = mt;
          this.offWin.push(md.presentationTime - mt); if (this.offWin.length > 300) this.offWin.shift();
          let mn = Infinity; for (const v of this.offWin) if (v < mn) mn = v;
          if (this.offWin.length >= 10) { this.srcLocked = 'media'; return mt + mn; }
          return md.presentationTime;
        }
        if (md.presentationTime > 0) { if (this.srcLocked === null) this.srcLocked = 'present'; return md.presentationTime; }
      }
      return nowT;
    },
    _frame(nowT, md) {
      const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;
      if (vw !== this.vw || vh !== this.vh) { if (this.det) { this.restarts++; } this._setup(vw, vh); }
      const t = this._ts(nowT, md);
      this.g.drawImage(v, 0, 0, this.W, this.H);
      const px = this.g.getImageData(0, 0, this.W, this.H).data, lum = this.lum;
      for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      const ev = this.det.push(lum, t);
      this.fcount++;
      if (nowT - this.fT > 1000) { this.fps = this.fcount * 1000 / (nowT - this.fT); this.fcount = 0; this.fT = nowT; renderChips(); }
      const m = $('#meterBar'); if (m) m.style.width = Math.min(100, this.det.lastOccGate / this.det.o.occGate * 50) + '%';
      const fire = (e, fn) => {
        const box = $('#videoHome'); box.parentElement && box.parentElement.classList.add('fired');
        setTimeout(() => box.parentElement && box.parentElement.classList.remove('fired'), 350);
        fn(e);
      };
      if (Clap.active) { const e = this.cv.push(this.det.occ, t); if (e) fire(e, (x) => Clap.onGate(x)); } // claquement : fermeture de l'écart entre les mains
      else if (ev && this.onEvent) fire(ev, this.onEvent);
    },
    mount(target, hint) { const n = $('#videoHome'); if (target && n.parentElement !== target) target.appendChild(n); $('#camHint').textContent = hint || ''; },
    config(o) { if (this.det) Object.assign(this.det.o, o); else this._pendingO = o; },
  };

  // ---------------- synchro « clap-clap » ----------------
  // Les deux téléphones, côte à côte, entendent les deux mêmes claquements : l'instant du 1er devient le zéro commun.
  // Aucun signal ne passe d'un téléphone à l'autre. L'intervalle entre les deux claps, affiché sur les deux écrans,
  // permet de vérifier d'un coup d'œil qu'ils ont bien entendu les mêmes.
  const devId = (() => { let v = store.get('devId', null); if (!v) { v = Math.random().toString(36).slice(2, 8); store.set('devId', v); } return v; })();
  const Sync = {
    listening: false, purpose: 'start', onsets: [], ignoreUntil: 0, got: null, autoTimer: null, heardAt: 0,
    listen(purpose) {
      this.listening = true; this.purpose = purpose; this.onsets = []; this.got = null; this.ignoreUntil = 0;
      clearTimeout(this.autoTimer); Drift.reset(); renderPrep();
    },
    onOnset(o) {
      if (!this.listening || S.screen !== 'prep') return;
      const t = now(); if (t < this.ignoreUntil) return;
      this.onsets = this.onsets.filter(x => t - x.perf < 3000); this.onsets.push(o); this.heardAt = t;
      const p = CC.findClapPair(this.onsets, Audio.sr);
      if (p) { p.interval = p.b.perf - p.a.perf; this.ignoreUntil = t + 1500; this.onsets = []; this._got(p); } // intervalle en temps réel (silences insérés compensés)
      renderPrep();
    },
    _got(p) {
      Audio.beep(1);
      if (this.purpose === 'start') {
        S.origin = p.a.perf; S.interval = p.interval; S.syncGen++; S.lastRes = null; S.starts = [];
        if (S.warnings.has('audio')) S.D = null;
        S.warnings.delete('clock'); S.warnings.delete('audio'); renderBanners();
        this.got = { interval: p.interval, at: now() };
        if (S.role === 'start') SelfTest.run();
        clearTimeout(this.autoTimer);
        const go = () => { if (S.screen !== 'prep' || this.purpose !== 'start') return; if (S.role === 'start' && SelfTest.busy) { this.autoTimer = setTimeout(go, 400); return; } this.listening = false; show('run'); };
        this.autoTimer = setTimeout(go, 4500);
      } else {
        if (S.origin == null) return;
        this.got = { interval: p.interval, at: now() };
        Drift.local = { tau: p.a.perf - S.origin, interval: p.interval };
        this.listening = false;
        if (S.role === 'start') Drift.showQr(); else Drift.startScan();
      }
    },
  };

  // ---------------- Départ : latence propre du haut-parleur (pour caler le bip de départ) ----------------
  const SelfTest = {
    busy: false, sched: [], Rs: [], tries: 0,
    run(gain = 0.25) {
      this.busy = true; this.Rs = []; this.sched = []; this.tries++;
      const t0 = now() + 300;
      for (let i = 0; i < 4; i++) { const p = t0 + i * 350; Audio.play(BUF.up, p, gain); this.sched.push(p); }
      setTimeout(() => {
        if (this.Rs.length >= 3) { S.R = CC.median(this.Rs); S.Rspread = CC.mad(this.Rs); this.busy = false; this.tries = 0; }
        else if (this.tries < 2) { this.run(0.7); return; }
        else { this.busy = false; this.tries = 0; flashPrep('Le Départ ne s\'entend pas : monte le volume.'); flashNote('Le Départ ne s\'entend pas : monte le volume puis « Tester le haut-parleur ».'); }
        renderPrep(); renderRun();
      }, 2200);
    },
    onDet(d) {
      if (d.type === 'gun') return Go.onOwnGun(d);
      if (d.type !== 'up' || !this.busy) return;
      for (let i = 0; i < this.sched.length; i++) { const r = d.perf - this.sched[i]; if (r > -5 && r < 600) { this.Rs.push(r); this.sched.splice(i, 1); break; } }
    },
  };

  // ---------------- fin de séance : dérive des horloges (clap-clap + QR code) ----------------
  const Drift = {
    local: null, scanning: false, scanTimer: null, result: null, bd: null, cv: null,
    reset() { this.local = null; this.result = null; this.stopScan(); const q = $('#qrBox'); if (q) q.replaceChildren(); },
    payload() { return ['CS2', devId, this.local.tau.toFixed(3), this.local.interval.toFixed(2)].join('|'); },
    showQr() {
      const qr = qrcode(0, 'M'); qr.addData(this.payload()); qr.make();
      $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
      renderPrep();
    },
    startScan() {
      this.scanning = true; this.stopTimer();
      if (!this.cv) { this.cv = document.createElement('canvas'); this.g = this.cv.getContext('2d', { willReadFrequently: true }); }
      if (!this.bd && 'BarcodeDetector' in window) { try { this.bd = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { this.bd = null; } }
      Cam.mount($('#camPrep'), 'Montre l\'écran du Départ à cette caméra.');
      this.scanTimer = setInterval(() => this._scan(), 220); renderPrep();
    },
    stopTimer() { if (this.scanTimer) clearInterval(this.scanTimer); this.scanTimer = null; },
    stopScan() { this.scanning = false; this.stopTimer(); },
    async _scan() {
      if (this._busy || !this.scanning) return; this._busy = true;
      try {
        const v = Cam.video, vw = v.videoWidth, vh = v.videoHeight; if (!vw) return;
        let text = null;
        if (this.bd) { try { const r = await this.bd.detect(v); if (r && r.length) text = r[0].rawValue; } catch (e) { this.bd = null; } }
        if (!text && window.jsQR) {
          const side = Math.min(vw, vh) * 0.8, sx = (vw - side) / 2, sy = (vh - side) / 2, n = 520;
          this.cv.width = n; this.cv.height = n; this.g.drawImage(v, sx, sy, side, side, 0, 0, n, n);
          const img = this.g.getImageData(0, 0, n, n), r = window.jsQR(img.data, n, n, { inversionAttempts: 'dontInvert' });
          if (r) text = r.data;
        }
        if (text) this._read(text);
      } finally { this._busy = false; }
    },
    _read(text) {
      const f = String(text).split('|');
      if (f[0] !== 'CS2' || f.length < 4) return;
      const tauD = parseFloat(f[2]), ivD = parseFloat(f[3]), L = this.local;
      if (!isFinite(tauD) || !L) return;
      this.stopScan(); Audio.beep(2);
      if (Math.abs(ivD - L.interval) > 3) { this.result = { error: `Les deux téléphones n'ont pas entendu les mêmes claps (${fmt.t3(L.interval)} s contre ${fmt.t3(ivD)} s). Refais un clap-clap.` }; renderPrep(); return; }
      const rho = L.tau / tauD - 1, before = S.rho || 0;
      S.rho = rho; store.set('rho', { id: f[1], rho, at: Date.now() });
      let fixed = 0;
      for (const res of S.results) if (res.gen === S.syncGen && res.raw != null) { res.T = res.raw / (1 + rho) - res.n * CC.GRID - res.ath * MS_PER_M; res.fixed = true; fixed++; }
      store.set('results', S.results);
      this.result = { rho, err: (rho - before) * tauD, min: tauD / 60000, fixed };
      renderPrep(); renderChips();
    },
  };

  // ---------------- calibration caméra : 3 claquements sur la ligne, téléphone en place ----------------
  const Clap = {
    active: false, vals: [], pending: [], timer: null, N: 3,
    start() {
      this.active = true; this.vals = []; this.pending = []; S.D = null; S.Dspread = null; S.calibSaved = false;
      Cam.config({ dir: 0, cooldownMs: 700, clearMs: 250, band: null }); if (Cam.det) Cam.det.armed = true;
      if (Cam.cv) Cam.cv.hist = [];
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this._poll(), 100); renderRun(); renderChips();
    },
    stop() { this.active = false; if (this.timer) clearInterval(this.timer); this.timer = null; applyGateConfig(); renderRun(); renderChips(); },
    onGate(ev) { if (ev.interp === false) return; this.pending.push(ev.t); }, // contact non extrapolable : ignoré
    _poll() {
      const sr = Audio.sr, n0 = this.vals.length;
      this.pending = this.pending.filter(t => {
        const w = Audio.window(t - 450, t + 150);
        if (!w) return now() - t < 3000;
        if (w.gone) return false;
        const excl = Audio.dets.filter(d => d.frame > w.f0 - 0.2 * sr && d.frame < w.f0 + w.data.length).map(d => [d.frame - w.f0 - 0.006 * sr, d.frame - w.f0 + 0.13 * sr]);
        const r = CC.detectClapOnset(w.data, sr, excl);
        if (r) { const Dp = t - Audio.perfOfFrame(w.f0 + r.idx); if (Dp > -80 && Dp < 400) this.vals.push(Dp); }
        return false;
      });
      if (this.vals.length >= this.N) {
        const med = CC.median(this.vals);
        const best = this.vals.map(v => [v, Math.abs(v - med)]).sort((a, b) => a[1] - b[1]).slice(0, this.N).map(x => x[0]);
        const spread = Math.max(...best) - Math.min(...best);
        if (spread <= 8 || this.vals.length >= 7) {
          S.D = CC.median(best) + D_CLAP_M * MS_PER_M; S.Dspread = spread; S.camRestartsAtClap = Cam.restarts; S.calibSaved = false;
          store.set('calib', { D: S.D, fps: Math.round(Cam.fps), vw: Cam.vw, vh: Cam.vh, at: Date.now() });
          this.stop(); Audio.beep(2);
          showBig('Prêt', 'Calibré et mémorisé pour les prochaines séances.' + (S.role === 'finish' ? ' Pose le téléphone sur la ligne.' : ' Arme la cellule.'), 'Caméra calibrée');
          Voice.say('Prêt');
          return;
        }
      }
      if (this.vals.length !== n0) { Audio.beep(1); renderRun(); }
    },
  };
  const needCalib = () => S.role === 'finish' || S.mode === 'cell';

  // ---------------- Départ : départ au bip programmé ----------------
  const Go = {
    p: null, timer: null, log: [],
    launch() {
      if (S.origin == null || S.R == null) return;
      const t = now(), lead = Math.max(15, S.settings.lead) * 1000;
      // le son doit sortir du haut-parleur pile à zéro + n minutes : on l'envoie en avance de la latence propre
      const n = Math.ceil((t + lead - S.origin) / CC.GRID), sPerf = S.origin + n * CC.GRID - (S.R - D_SELF_M * MS_PER_M);
      const mLead = Math.min(sPerf - t - 2500, 13000 + Math.random() * 5000), setLead = 1600 + Math.random() * 800;
      S.warnings.delete('late'); S.warnings.delete('drift-audio'); renderBanners();
      this.p = { n, sPerf, tMarks: sPerf - mLead, tSet: sPerf - setLead, marks: false, set: false, sched: null };
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this._tick(), 30); this._tick(); renderRun();
    },
    _tick() {
      const p = this.p; if (!p) return;
      const t = now();
      if (!p.marks && t >= p.tMarks) { p.marks = true; Voice.say('À vos marques') || Audio.beep(2); }
      // « prêts » : simple bip (la synthèse vocale juste avant le départ peut perturber la sortie audio)
      if (!p.set && t >= p.tSet) { p.set = true; Audio.beep(1); }
      if (!p.sched && t >= p.sPerf - 600) { p.sched = Audio.play(BUF.gun, p.sPerf, 1); if (p.sched.late) { S.warnings.add('late'); renderBanners(); } }
      if (t >= p.sPerf + 900) {
        this.log.unshift({ n: p.n, at: Date.now(), Rgo: p.Rgo ?? null }); this.p = null; clearInterval(this.timer); this.timer = null;
        renderRun(); return;
      }
      renderCountdown();
    },
    cancel() { if (this.p && this.p.sched) { try { this.p.sched.src.stop(); } catch (e) { } } Voice.cancel(); this.p = null; clearInterval(this.timer); this.timer = null; renderRun(); },
    onOwnGun(d) { // le Départ s'écoute : vérifie que le bip est parti à l'heure prévue
      const p = this.p; if (!p || S.R == null) return;
      const r = d.perf - p.sPerf; if (r < -5 || r > 600) return;
      p.Rgo = r;
      if (Math.abs(r - S.R) > 2) { S.warnings.add('drift-audio'); S.lastRgoDiff = r - S.R; renderBanners(); S.R = r; }
      else S.R = 0.7 * S.R + 0.3 * r; // suit les petites variations pour les départs suivants
    },
  };

  // ---------------- événements caméra ----------------
  function onGate(ev) {
    if (Clap.active) return Clap.onGate(ev);
    if (S.screen !== 'run') return;
    if (S.role === 'finish') onFinish(ev); else onStart(ev);
  }
  function addResult(r) {
    S.results.unshift(r); if (S.results.length > 200) S.results.pop();
    store.set('results', S.results); renderList();
  }
  function showBig(text, sub, lbl, cls) {
    const b = $('#big'); b.textContent = text; b.className = 'big num ' + (cls || ''); void b.offsetWidth; if (cls !== 'dim') b.classList.add('flash');
    $('#bigSub').textContent = sub || ' '; if (lbl) $('#bigLbl').textContent = lbl;
  }
  const detail = (T) => `${fmt.t3(T)} s · ${S.settings.runDist} m · ${comma((S.settings.runDist / (T / 1000)).toFixed(2))} m/s`;
  function onFinish(ev) {
    if (S.origin == null) { flashNote('Passage détecté, mais la synchro manque.'); return; }
    const D = S.D != null ? S.D : 0;
    const raw = ev.t - D - S.origin;           // temps depuis le clap, horloge de l'Arrivée
    const tau = raw / (1 + (S.rho || 0));      // ramené à l'horloge du Départ (dérive mémorisée)
    const code = CC.codeOf(tau);
    S.lastPassage = { tau, code, at: Date.now(), dir: ev.dir };
    if (S.mode === 'bip') {
      const g = CC.gridResult(tau, tMin()), T = g.T - S.settings.athDist * MS_PER_M;
      const walking = isFinite(ev.speed) && ev.speed < 2.5;
      if (T < tMin() || T > tMax() || walking) { flashNote(walking ? 'Passage ignoré (trop lent).' : 'Passage ignoré (aucun départ donné dans la minute).'); return; }
      const extra = S.lastRes && S.lastRes.n === g.n && S.lastRes.gen === S.syncGen;
      const r = { T, mode: 'bip', dist: S.settings.runDist, at: Date.now(), calib: S.D != null, raw, n: g.n, ath: S.settings.athDist, gen: S.syncGen, extra, torso: ev.torso };
      addResult(r);
      if (extra) { flashNote('Autre passage sur le même départ : ' + fmt.t2(T) + ' s (ajouté à la liste).'); return; }
      S.lastRes = { n: g.n, gen: S.syncGen };
      showBig(fmt.t2(T), detail(T), 'Dernier temps');
      Voice.say(Voice.time(T));
    } else {
      showBig(fmt.code(code), 'Tape ce code sur le Départ', 'Code du passage');
      Voice.say('Code ' + String(code).padStart(5, '0').split('').join(' '));
      renderList();
    }
  }
  function onStart(ev) {
    if (S.mode !== 'cell') return;
    if (S.origin == null) { flashNote('Départ détecté, mais la synchro manque.'); return; }
    const tau = ev.t - (S.D != null ? S.D : 0) - S.origin;
    S.starts.unshift({ tau, at: Date.now(), used: false }); if (S.starts.length > 12) S.starts.pop();
    if (!S.settings.autoRearm && Cam.det) Cam.det.armed = false;
    showBig('Parti', 'Départ enregistré à ' + fmt.hm(Date.now()) + '. Tape le code affiché par l\'Arrivée.', 'Cellule', 'go');
    renderRun();
  }
  function enterCode(code) {
    for (const st of S.starts) {
      const T = CC.codeDiff(code, st.tau);
      if (T >= tMin() && T <= tMax()) {
        st.used = true;
        showBig(fmt.t2(T), detail(T), 'Dernier temps');
        addResult({ T, mode: 'cell', dist: S.settings.runDist, at: Date.now(), calib: S.D != null });
        Voice.say(Voice.time(T));
        return true;
      }
    }
    return false;
  }
  function applyGateConfig() {
    if (!Cam.det || Clap.active) return;
    const band = [0.18, 0.48];
    if (S.role === 'finish') { Cam.config({ dir: +S.settings.dir, cooldownMs: 1500, clearMs: 300, band }); Cam.det.armed = true; }
    else { Cam.config({ dir: +S.settings.dir, cooldownMs: 2500, clearMs: 400, band }); if (S.mode !== 'cell') Cam.det.armed = false; }
  }

  // ---------------- rendu ----------------
  let noteTimer = null;
  function flashNote(t) { const e = $('#runNote'); if (!e) return; e.textContent = t; clearTimeout(noteTimer); noteTimer = setTimeout(() => { e.textContent = ''; }, 7000); }
  function renderChips() {
    const c = $('#chips'); if (!S.started) return;
    const chips = [];
    chips.push(S.origin != null ? ['ok', 'Synchro ' + fmt.t3(S.interval) + ' s'] : ['bad', 'Pas de synchro']);
    if (S.role === 'start') chips.push(S.R != null ? ['ok', 'Haut-parleur OK'] : ['warn', 'Haut-parleur ?']);
    if (S.role === 'finish' && S.origin != null) chips.push(S.rho ? ['ok', 'Dérive ' + comma((S.rho * 1e6).toFixed(1)) + ' ppm'] : ['', 'Dérive à mesurer']);
    if (needCalib()) chips.push(S.D != null ? ['ok', S.calibSaved ? 'Calibration mémorisée' : 'Caméra calibrée'] : ['warn', 'Caméra à calibrer']);
    chips.push([Cam.fps >= 50 ? 'ok' : Cam.fps >= 24 ? '' : 'bad', Math.round(Cam.fps) + ' i/s']);
    c.replaceChildren(...chips.map(([k, t]) => mk('span', 'chip ' + k, t)));
  }
  function renderBanners() {
    const b = $('#banners'), items = [];
    if (S.warnings.has('clock')) items.push(['bad', 'Horloge interrompue (mise en veille ou appli quittée) : remets les téléphones côte à côte et refais un clap-clap (Réglages → Refaire la synchro).']);
    if (S.warnings.has('audio')) items.push(['bad', 'Le micro a été interrompu : refais un clap-clap (Réglages → Refaire la synchro).']);
    if (S.warnings.has('camera')) items.push(['bad', 'La caméra s\'est arrêtée : recharge la page puis refais la synchro.']);
    if (S.warnings.has('late')) items.push(['bad', 'Le bip est parti en retard (téléphone surchargé) : ce départ n\'est pas fiable.']);
    if (S.warnings.has('drift-audio')) items.push(['', `Le dernier bip de départ est parti avec ${fmt.ms1(Math.abs(S.lastRgoDiff || 0))} ms d'écart : ce temps peut être faussé d'autant. Refais la synchro si ça se répète.`]);
    if (S.D != null && Cam.restarts > (S.camRestartsAtClap || 0)) items.push(['', 'La caméra a redémarré : Réglages → Recalibrer la caméra.']);
    b.replaceChildren(...items.map(([k, t]) => mk('div', 'banner ' + k, t)));
  }
  function kv(el, pairs) { el.replaceChildren(...pairs.map(([k, v]) => { const d = mk('div'); d.append(mk('dt', null, k), mk('dd', null, v)); return d; })); }
  function renderPrep() {
    if (S.screen !== 'prep') return;
    const btns = $('#pairBtns'); btns.replaceChildren();
    const btn = (label, cls, fn) => { const b = mk('button', 'btn ' + cls, label); b.onclick = fn; btns.append(b); return b; };
    const end = Sync.purpose === 'end', g = Sync.got, scr = $('#scrPrep');
    let title, help, state = 'wait', big = '';
    $('#qrWrap').hidden = true; $('#camPrep').hidden = true;
    if (!g) {
      const heard = Sync.onsets.length && now() - Sync.heardAt < 1600;
      title = end ? 'Fin de séance' : 'Clap-clap';
      help = end ? 'Remets les deux téléphones côte à côte et claque 2 fois des mains juste au-dessus. La dérive des horloges sera mesurée et tes temps corrigés.'
        : 'Pose les deux téléphones côte à côte, écrans vers le haut, et claque 2 fois des mains juste au-dessus d\'eux.';
      big = heard ? '1 clap…' : '';
      state = heard ? 'run' : 'wait';
      if (end) btn('Annuler', 'ghost', () => { Sync.listening = false; show('run'); });
    } else if (!end) {
      title = 'Synchro faite'; state = 'ok'; big = fmt.t3(g.interval) + ' s';
      help = 'L\'autre téléphone doit afficher le même nombre (à 1 millième près). Sinon, refais un clap-clap.';
      if (S.role === 'start') help += SelfTest.busy ? ' Test du haut-parleur…' : S.R != null ? ' Haut-parleur OK.' : '';
      btn('Continuer', 'primary', () => { clearTimeout(Sync.autoTimer); Sync.listening = false; show('run'); });
      btn('Refaire', 'ghost', () => Sync.listen('start'));
    } else {
      big = fmt.t3(g.interval) + ' s'; state = 'ok';
      if (S.role === 'start') {
        title = 'Montre ce QR code';
        help = 'Présente cet écran à la caméra de l\'Arrivée, à 20–30 cm. Elle doit afficher le même nombre (à 1 millième près).';
        $('#qrWrap').hidden = false;
        btn('Terminé', 'primary', () => { Drift.reset(); show('run'); });
      } else {
        const r = Drift.result;
        if (!r) { title = 'Scanne le Départ'; help = 'Pointe la caméra vers le QR code affiché par le Départ.'; $('#camPrep').hidden = false; state = 'run'; }
        else if (r.error) { title = 'À refaire'; state = 'wait'; help = r.error; btn('Refaire un clap-clap', 'primary', () => Sync.listen('end')); }
        else {
          title = 'Dérive corrigée';
          help = `Écart d'horloge : ${fmt.ms1(Math.abs(r.err))} ms en ${Math.max(1, Math.round(r.min))} min (${comma((r.rho * 1e6).toFixed(1))} ppm, mémorisé pour les prochaines séances).` + (r.fixed ? ` ${r.fixed} temps corrigé${r.fixed > 1 ? 's' : ''}.` : '');
          btn('Continuer', 'primary', () => { Drift.reset(); show('run'); });
        }
        if (!r) btn('Annuler', 'ghost', () => { Drift.reset(); show('run'); });
      }
    }
    $('#pairTitle').textContent = title; $('#pairHelp').textContent = help; $('#pairBig').textContent = big;
    scr.dataset.state = state;
    renderChips();
  }
  function flashPrep(t) { const e = $('#prepNote'); if (e) e.textContent = t; }
  // niveau du micro sur l'écran de synchro
  setInterval(() => { if (S.screen !== 'prep' || Audio.level == null) return; const m = $('#micBar'); if (m) m.style.width = Math.max(0, Math.min(100, (Audio.level + 70) / 60 * 100)) + '%'; }, 80);
  function renderCountdown() {
    if (S.screen !== 'run' || S.role !== 'start' || S.mode !== 'bip') return;
    const p = Go.p, b = $('#big');
    if (!p) return;
    const left = p.sPerf - now();
    if (left > 0) { b.textContent = fmt.clock(left).replace(/,\d$/, ''); b.className = 'big num ' + (left < 2600 ? 'go' : ''); $('#bigSub').textContent = left > p.sPerf - p.tMarks ? 'Place-toi. « À vos marques » arrive.' : left > p.sPerf - p.tSet ? 'À vos marques' : 'Prêts'; }
    else { b.textContent = 'Parti'; b.className = 'big go'; $('#bigSub').textContent = 'Le temps s\'affiche sur l\'Arrivée.'; }
  }
  const CLAP_HELP = 'Téléphone posé debout, claque des mains à 30–60 cm devant l\'objectif, mains bien visibles à l\'écran. Un bip confirme chaque claquement. Sert à mesurer le retard de la caméra de ce téléphone ; c\'est mémorisé ensuite.';
  function renderRun() {
    if (S.screen !== 'run') return;
    $('#modeBip').setAttribute('aria-pressed', S.mode === 'bip'); $('#modeCell').setAttribute('aria-pressed', S.mode === 'cell');
    if (needCalib() && S.D == null && !Clap.active) {
      // calibration mémorisée : même caméra (résolution) et même cadence → pas besoin de recommencer
      const c = store.get('calib', null);
      if (c && c.vw === Cam.vw && c.vh === Cam.vh && (!Cam.fps || Math.abs(c.fps - Cam.fps) <= 8) && Date.now() - c.at < 365 * 864e5) {
        S.D = c.D; S.calibSaved = true; S.camRestartsAtClap = Cam.restarts;
        showBig('Prêt', S.role === 'finish' ? 'Calibration caméra mémorisée. Pose le téléphone sur la ligne.' : 'Calibration caméra mémorisée.', 'Caméra calibrée');
      } else { Clap.start(); return; }
    }
    if (!needCalib() && Clap.active) { Clap.stop(); return; }
    const ctl = $('#ctl'); ctl.replaceChildren();
    const camRun = $('#camRun');
    $('#calibHelp').hidden = true;
    camRun.classList.toggle('calib', Clap.active);
    if (Clap.active) {
      camRun.hidden = false;
      Cam.mount(camRun, 'Claque des mains devant l\'objectif.');
      showBig(Math.min(Clap.N, Clap.vals.length) + '/' + Clap.N, 'Claque 3 fois des mains devant l\'objectif', 'Calibration caméra (une seule fois)', Clap.vals.length ? '' : 'dim');
      const ch = $('#calibHelp'); ch.hidden = false; ch.textContent = CLAP_HELP;
      renderList(); renderChips(); renderBanners();
      return;
    }
    if (S.role === 'start') {
      camRun.hidden = S.mode !== 'cell';
      if (S.mode === 'bip') {
        $('#bigLbl').textContent = 'Départ au bip';
        if (!Go.p) { const b = $('#big'); b.textContent = '—'; b.className = 'big num dim'; $('#bigSub').textContent = 'Le bip tombera sur la prochaine minute ronde (≥ ' + S.settings.lead + ' s).'; }
        const b = mk('button', 'btn ' + (Go.p ? '' : 'primary') + ' wide', Go.p ? 'Annuler ce départ' : 'Lancer un départ');
        b.onclick = () => { Voice.unlock(); Go.p ? Go.cancel() : Go.launch(); };
        b.disabled = S.origin == null || S.R == null;
        ctl.append(b);
        if (S.origin != null && S.R == null && !SelfTest.busy) {
          const tb = mk('button', 'btn', 'Tester le haut-parleur'); tb.onclick = () => { SelfTest.tries = 0; SelfTest.run(); renderRun(); };
          ctl.append(mk('p', 'note', 'Le Départ doit s\'entendre une fois pour caler le bip. Monte le volume puis :'), tb);
        }
        if (Go.log.length) ctl.append(mk('p', 'note', `${Go.log.length} départ(s) donné(s). Dernier à ${fmt.hm(Go.log[0].at)}.`));
      } else {
        Cam.mount(camRun, 'Ligne rouge 50 cm devant ta ligne de départ.');
        const armed = Cam.det && Cam.det.armed;
        const arm = mk('button', 'btn ' + (armed ? '' : 'primary'), armed ? 'Cellule armée — désarmer' : 'Armer la cellule');
        arm.onclick = () => { if (Cam.det) { Cam.det.armed = !Cam.det.armed; Cam.det.clearSince = now(); } renderRun(); };
        ctl.append(arm);
        const box = mk('div', 'codein', S.codeBuf ? S.codeBuf.padEnd(5, '·') : '·····'); box.id = 'codeIn';
        const pad = mk('div', 'keypad');
        const press = (k) => {
          if (k === 'del') S.codeBuf = (S.codeBuf || '').slice(0, -1);
          else if (k === 'ok') {
            const c = parseInt(S.codeBuf || '', 10);
            if ((S.codeBuf || '').length === 5 && enterCode(c)) S.codeBuf = '';
            else { box.classList.add('err'); setTimeout(() => box.classList.remove('err'), 900); flashNote(S.starts.length ? 'Code incohérent avec les départs enregistrés. Vérifie les 5 chiffres.' : 'Aucun départ enregistré par la cellule.'); return; }
          } else if ((S.codeBuf || '').length < 5) S.codeBuf = (S.codeBuf || '') + k;
          box.textContent = S.codeBuf ? S.codeBuf.padEnd(5, '·') : '·····';
        };
        for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']) {
          const kb = mk('button', 'key' + (k === 'ok' ? ' ok' : ''), k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k);
          kb.setAttribute('aria-label', k === 'del' ? 'Effacer' : k === 'ok' ? 'Valider le code' : k);
          kb.onclick = () => press(k); pad.append(kb);
        }
        ctl.append(mk('span', 'lbl note', 'Code affiché par l\'Arrivée'), box, pad);
      }
      // fin de séance : correction de la dérive
      const row = mk('div', 'check-row');
      const cb = mk('button', 'btn ghost', 'Corriger la dérive'); cb.disabled = S.origin == null || !!Go.p;
      cb.onclick = () => { show('prep'); Sync.listen('end'); };
      row.append(cb, mk('span', 'note', 'En fin de séance (ou après l\'échauffement), téléphones côte à côte : clap-clap puis QR code.'));
      ctl.append(row);
    } else {
      camRun.hidden = false;
      Cam.mount(camRun, 'Ligne rouge sur ta ligne d\'arrivée.');
      const row = mk('div', 'check-row');
      const cb = mk('button', 'btn ghost', 'Corriger la dérive'); cb.disabled = S.origin == null;
      cb.onclick = () => { show('prep'); Sync.listen('end'); };
      row.append(cb, mk('span', 'note', S.rho ? 'Dérive mémorisée : temps déjà corrigés. Refais-la de temps en temps.' : 'À faire en fin de séance (ou après l\'échauffement) : corrige tous les temps.'));
      ctl.append(row);
      if (!S.results.length && !S.lastPassage && $('#bigLbl').textContent !== 'Caméra calibrée') showBig('—', S.mode === 'bip' ? 'En attente d\'un passage' : 'Le code de ton passage s\'affichera ici', S.mode === 'bip' ? 'Dernier temps' : 'Code du passage', 'dim');
    }
    renderList(); renderChips(); renderBanners();
  }
  function renderList() {
    const l = $('#list'); if (!l) return;
    const items = [];
    if (S.role === 'finish' && S.mode === 'cell' && S.lastPassage) {
      const li = mk('li'); li.append(mk('span', 't', fmt.code(S.lastPassage.code)), mk('span', 'm', 'code · ' + fmt.hm(S.lastPassage.at)), mk('span'));
      items.push(li);
    }
    S.results.slice(0, 30).forEach((r, i) => {
      const li = mk('li');
      const x = mk('button', 'x', '×'); x.setAttribute('aria-label', 'Supprimer ce temps');
      x.onclick = () => { S.results.splice(i, 1); store.set('results', S.results); renderList(); };
      const tags = [r.dist + ' m', r.mode === 'bip' ? 'bip' : 'cellule', fmt.hm(r.at)];
      if (r.extra) tags.push('autre passage'); if (r.fixed) tags.push('corrigé'); if (!r.calib) tags.push('non calibré');
      li.append(mk('span', 't', fmt.t2(r.T)), mk('span', 'm', tags.join(' · ')), x);
      items.push(li);
    });
    if (!items.length) { const li = mk('li', 'empty', 'Aucun temps pour l\'instant.'); items.push(li); }
    l.replaceChildren(...items);
  }
  // horloge commune
  setInterval(() => {
    if (S.screen !== 'run') return;
    let tau = null;
    if (S.origin != null) tau = (now() - S.origin) / (S.role === 'finish' ? 1 + (S.rho || 0) : 1);
    $('#commonClock').textContent = tau == null ? '—' : fmt.clock(tau);
    const ri = $('#runInfo');
    if (S.role === 'finish' && S.mode === 'bip' && tau != null) ri.textContent = '+' + comma(((tau % CC.GRID) / 1000).toFixed(1)) + ' s depuis la minute ronde';
    else if (S.role === 'start' && S.mode === 'bip' && tau != null && !Go.p) ri.textContent = 'prochaine minute dans ' + Math.ceil((CC.GRID - (tau % CC.GRID)) / 1000) + ' s';
    else ri.textContent = '';
  }, 100);

  // surveillance de l'horloge (mise en veille, page masquée)
  let lastGap = Date.now() - performance.now(), hiddenAt = null;
  setInterval(() => { const g = Date.now() - performance.now(); if (Math.abs(g - lastGap) > 40 && (S.origin != null)) { S.warnings.add('clock'); renderBanners(); } lastGap = g; }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = now();
    else { if (S.started) Wake.on(); if (hiddenAt && now() - hiddenAt > 3000 && (S.origin != null)) { S.warnings.add('clock'); renderBanners(); } hiddenAt = null; }
  });

  // ---------------- navigation ----------------
  function show(screen) {
    S.screen = screen;
    for (const id of ['scrHome', 'scrPrep', 'scrRun']) $('#' + id).hidden = id !== 'scr' + screen[0].toUpperCase() + screen.slice(1);
    $('#btnSettings').hidden = screen === 'home'; $('#chips').hidden = screen === 'home';
    if (screen === 'prep') { if (Clap.active) { Clap.active = false; clearInterval(Clap.timer); Clap.timer = null; applyGateConfig(); } renderPrep(); }
    else { Drift.stopScan(); }
    if (screen === 'run') { applyGateConfig(); renderRun(); }
    window.scrollTo(0, 0);
  }
  async function begin(role) {
    S.role = role;
    const pill = $('#rolePill'); pill.hidden = false; pill.textContent = role === 'start' ? 'Départ' : 'Arrivée'; pill.className = 'role-pill on';
    const err = $('#homeErr'); err.hidden = true;
    for (const b of document.querySelectorAll('.role')) b.disabled = true;
    Voice.init(); Voice.unlock();
    try {
      if (!window.isSecureContext) throw new Error('secure');
      await Audio.start(role === 'start' ? ['up', 'gun'] : []);
      await Cam.start();
    } catch (e) {
      console.error(e);
      for (const b of document.querySelectorAll('.role')) b.disabled = false;
      err.hidden = false;
      err.textContent = e && e.message === 'secure'
        ? 'Cette page doit être ouverte en https pour accéder au micro et à la caméra.'
        : 'Accès au micro ou à la caméra refusé. Autorise-les dans les réglages du navigateur puis recharge la page.';
      return;
    }
    S.started = true; Wake.on();
    Audio.onDet = (d) => { if (role === 'start') SelfTest.onDet(d); };
    Audio.onOnset = (o) => Sync.onOnset(o);
    Cam.onEvent = onGate;
    const saved = store.get('rho', null); S.rho = saved && Date.now() - saved.at < 120 * 864e5 ? saved.rho : 0;
    show('prep'); Sync.listen('start');
  }

  // reprise du son après une interruption (appel, mise en arrière-plan) : nécessite un toucher sur iOS
  document.addEventListener('pointerdown', () => { if (Audio.ctx && Audio.ctx.state !== 'running') Audio.ctx.resume().catch(() => { }); }, true);

  // ---------------- liaisons UI ----------------
  $('#roleStart').onclick = () => begin('start');
  $('#roleFinish').onclick = () => begin('finish');
  $('#modeBip').onclick = () => { S.mode = 'bip'; store.set('mode', 'bip'); if (S.role === 'start' && Cam.det) Cam.det.armed = false; applyGateConfig(); renderRun(); };
  $('#modeCell').onclick = () => { S.mode = 'cell'; store.set('mode', 'cell'); if (Go.p) Go.cancel(); applyGateConfig(); renderRun(); };
  const dlg = $('#dlgSettings');
  $('#btnSettings').onclick = () => {
    $('#setRun').value = S.settings.runDist; $('#setLead').value = S.settings.lead; $('#setAth').value = S.settings.athDist;
    $('#setDir').value = String(S.settings.dir); $('#setRearm').checked = S.settings.autoRearm; $('#setVoice').checked = S.settings.voice;
    for (const e of dlg.querySelectorAll('[data-for]')) e.hidden = e.dataset.for !== S.role;
    $('#btnRecalib').hidden = !needCalib();
    $('#clearConfirm').hidden = true;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  };
  const readSettings = () => {
    const num = (id, d, lo, hi) => { const v = parseFloat($(id).value); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    S.settings.runDist = Math.round(num('#setRun', S.settings.runDist, 10, 400));
    S.settings.lead = Math.round(num('#setLead', S.settings.lead, 15, 90));
    S.settings.athDist = num('#setAth', S.settings.athDist, 0, 10);
    S.settings.dir = parseInt($('#setDir').value, 10) || 0;
    S.settings.autoRearm = $('#setRearm').checked; S.settings.voice = $('#setVoice').checked;
    saveSettings(); applyGateConfig(); renderRun();
  };
  $('#formSettings').addEventListener('change', readSettings);
  dlg.addEventListener('close', readSettings);
  $('#btnResync').onclick = () => {
    dlg.close(); if (Go.p) Go.cancel();
    show('prep'); Sync.listen('start');
    renderBanners();
  };
  $('#btnRecalib').onclick = () => { dlg.close(); S.D = null; S.calibSaved = false; store.set('calib', null); if (S.screen === 'run') Clap.start(); };
  $('#btnClear').onclick = () => { $('#clearConfirm').hidden = false; };
  $('#btnClearNo').onclick = () => { $('#clearConfirm').hidden = true; };
  $('#btnClearYes').onclick = () => { S.results = []; store.set('results', []); $('#clearConfirm').hidden = true; renderList(); };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadCtl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => { });
    // nouvelle version installée : on recharge tout de suite si aucune séance n'est en cours
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtl && !S.started) location.reload(); });
  }
  window.ChronoApp = { S, Audio, Cam, Sync, SelfTest, Drift, Clap, Go, VERSION, enterCode, show };
})();
