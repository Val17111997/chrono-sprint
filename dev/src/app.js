(function () {
  'use strict';
  const CC = window.ChronoCore;
  const P = 1000;                       // période des bips de synchro (ms, horloge du Départ)
  const MS_PER_M = 1000 / CC.SOUND_SPEED;
  const D_SYNC_M = 0.1, D_CLAP_M = 0.35, D_SELF_M = 0.08;
  const VERSION = '1.1.1';

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
    s0: null, R: null,           // Départ : origine de la grille (perf) et latence haut-parleur→micro
    fit: null,                   // Arrivée : ajustement de la synchro
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
      try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { }
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
      this.mf = new CC.MatchedFilter(sr, tplNames.map(n => ({ name: n, data: T[n], group: G[n] })), 32768);
      this.blk = new Float32Array(this.mf.N);
      this.ctx.onstatechange = () => { if (this.ctx.state !== 'running') { this.interrupted = true; if (S.s0 != null || S.fit) { S.warnings.add('audio'); renderBanners(); } } };
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
        if (v === 0) this.zRun++;
        else { if (this.zRun >= 32 && this.inB.length >= 2) { this.zTotal += this.zRun / this.sr * 1000; this.zb.push([f + i, this.zTotal]); if (this.zb.length > 500) this.zb.shift(); } this.zRun = 0; }
      }
      this.writeFrame = f + d.length;
      if (this.nextBlock == null) this.nextBlock = f;
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
      if (ev) {
        const box = $('#videoHome'); box.parentElement && box.parentElement.classList.add('fired');
        setTimeout(() => box.parentElement && box.parentElement.classList.remove('fired'), 350);
        if (this.onEvent) this.onEvent(ev);
      }
    },
    mount(target, hint) { const n = $('#videoHome'); if (target && n.parentElement !== target) target.appendChild(n); $('#camHint').textContent = hint || ''; },
    config(o) { if (this.det) Object.assign(this.det.o, o); else this._pendingO = o; },
  };

  const CTL_GAIN = 0.35;

  // ---------------- appairage (signaux courts 6,5–9,5 kHz) ----------------
  // L'Arrivée émet « hello » tant qu'elle n'a pas l'ancre de synchro ; le Départ démarre ses bips en l'entendant.
  // Quand la synchro est bonne, l'Arrivée émet « ok » ×3 ; le Départ s'arrête et les deux passent à l'écran piste.
  const Pair = {
    timer: null,
    startHello() {
      this.stopHello();
      const tick = () => {
        const sf = Listen.sf;
        if (S.role === 'finish' && Listen.active && Listen.mode === 'sync' && !sf.ready && (sf.cand === null || now() - Listen.candAt > 5000)) Audio.play(BUF.hello, now() + 40, CTL_GAIN);
      };
      this.timer = setInterval(tick, 1500); tick();
    },
    stopHello() { if (this.timer) clearInterval(this.timer); this.timer = null; },
    sendOk() { for (let i = 0; i < 3; i++) Audio.play(BUF.ok, now() + 60 + i * 350, CTL_GAIN); },
  };

  // ---------------- Départ : bips de synchro ----------------
  const Emit = {
    active: false, checking: false, k: 0, sched: new Map(), Rs: [], timer: null, count: 0, startedAt: 0, helloAt: [], okAt: [],
    _run() {
      if (this.timer) clearInterval(this.timer);
      this.startedAt = now();
      this.timer = setInterval(() => {
        this._tick();
        if (now() - this.startedAt > (this.checking ? 60000 : 120000)) { this.stop(); flashNote('Bips arrêtés : l\'Arrivée n\'a pas répondu.'); renderRun(); }
        renderPrep();
      }, 150);
      this._tick(); renderPrep(); renderRun();
    },
    start() { // nouvelle synchro : nouvelle grille
      this.stop(); this.active = true; this.checking = false; this.k = 0; this.sched.clear(); this.Rs = []; this.count = 0;
      S.s0 = Math.round(now() + 900); S.R = null; S.Rspread = null; S.prevR = null; S.starts = []; S.syncGen++;
      if (S.warnings.has('audio')) S.D = null;
      S.warnings.delete('clock'); S.warnings.delete('audio'); S.warnings.delete('drift-audio'); renderBanners();
      this._run();
    },
    resume() { // contrôle : même grille, bips montants seulement
      if (S.s0 == null) return this.start();
      this.stop(); this.active = true; this.checking = true; this.sched.clear(); S.prevR = S.R; this.Rs = []; this.count = 0;
      this.k = Math.max(1, Math.ceil((now() + 900 - S.s0) / P));
      this._run();
    },
    _tick() {
      const t = now();
      while (S.s0 + this.k * P < t + 1000) {
        const p = S.s0 + this.k * P, r = Audio.play(this.k === 0 ? BUF.down : BUF.up, p, 0.45);
        if (!r.late) this.sched.set(this.k, { p, src: r.src });
        this.k++; this.count++;
      }
      for (const [k, e] of this.sched) if (t - e.p > 3000) this.sched.delete(k);
    },
    stop() {
      if (this.timer) clearInterval(this.timer); this.timer = null; this.active = false; this.checking = false;
      const t = now(); for (const e of this.sched.values()) if (e.p > t + 30) { try { e.src.stop(); } catch (x) { } } // bips déjà programmés
    },
    onDet(d) {
      if (d.type === 'gun') return Go.onOwnGun(d);
      if (d.type === 'hello') return this._onHello();
      if (d.type === 'ok') return this._onOk();
      for (const [k, e] of this.sched) {
        const r = d.perf - e.p;
        if (r > -5 && r < 600) { this.Rs.push(r); this.sched.delete(k); break; }
      }
      if (this.Rs.length > 60) this.Rs.shift();
      // latence propre modifiée pendant la synchro (décrochage audio) : on ne garde que les mesures récentes
      if (this.Rs.length >= 9) {
        const last = this.Rs.slice(-5), dm = CC.median(last) - CC.median(this.Rs.slice(0, -5));
        if (Math.abs(dm) > 2 && CC.mad(last) < 0.7) this.Rs = last;
      }
      if (this.Rs.length >= 3) { S.R = CC.median(this.Rs); S.Rspread = CC.mad(this.Rs); }
    },
    _onHello() {
      const t = now(); this.helloAt = this.helloAt.filter(x => t - x < 4000); this.helloAt.push(t);
      if (Go.p) return;
      if (this.active && !this.checking && t - this.startedAt < 5000) return; // l'Arrivée n'a pas encore entendu le début
      if (S.screen === 'prep' || this.helloAt.length >= 2) { // l'Arrivée attend (ou a perdu sa synchro) : on (re)lance
        this.start(); if (S.screen !== 'prep') show('prep');
      }
    },
    _onOk() {
      const t = now(); this.okAt = this.okAt.filter(x => t - x < 2500); this.okAt.push(t);
      if (!this.active || this.okAt.length < 2) return;
      const wasCheck = this.checking; this.stop(); this.okAt = [];
      if (S.screen === 'prep') { Audio.beep(1); show('run'); }
      else { Audio.beep(1); renderRun(); flashNote(wasCheck ? 'Contrôle fait : l\'Arrivée a recalé l\'horloge et corrigé ses temps.' : 'Synchro OK.'); }
    },
  };

  // ---------------- Arrivée : écoute de la synchro ----------------
  const Listen = {
    active: false, mode: 'sync', sf: new CC.SyncFit(P), sfNew: null, chk: [], chkRes: null, candAt: 0, okSent: false, amps: [], cooldownUntil: 0,
    start(o = {}) { // nouvelle synchro (écran d'appairage)
      this.active = true; this.mode = 'sync'; this.sf = o.sf || new CC.SyncFit(P); this.sfNew = null; this.chk = []; this.chkRes = null;
      this.candAt = now(); this.okSent = false; this.amps = o.amps || [];
      S.fit = this.sf.fit(); S.syncGen++; S.lastCheck = null; S.lastRes = null;
      if (S.warnings.has('audio')) S.D = null;
      S.warnings.delete('clock'); S.warnings.delete('audio'); renderBanners();
      if (o.hello !== false) Pair.startHello();
      renderPrep();
    },
    watch() { this.mode = 'watch'; this.chk = []; this.sfNew = null; Pair.stopHello(); },
    stop() { this.active = false; Pair.stopHello(); },
    onDet(d) {
      if (!this.active || d.type === 'hello' || d.type === 'ok') return; // nos propres signaux
      if (this.mode === 'watch') return this._watch(d);
      if (d.type === 'down') { this.sf.anchor(d.perf); this.candAt = now(); }
      else if (d.type === 'up') { const r = this.sf.chirp(d.perf); if (r.k > 0 && d.amp) { this.amps.push(d.amp); if (this.amps.length > 60) this.amps.shift(); } }
      const f = this.sf.fit(); if (f) S.fit = f;
      if (!this.okSent && this.status() === 'ok') this._done();
      renderPrep();
    },
    _done() {
      this.okSent = true; S.syncAmp = this.amps.length ? CC.median(this.amps) : null;
      Pair.stopHello(); Pair.sendOk(); this.cooldownUntil = now() + 10000;
      setTimeout(() => { if (S.role === 'finish' && this.mode === 'sync') { this.watch(); if (S.screen === 'prep') show('run'); } }, 1400);
    },
    _watch(d) { // écran piste : écoute passive (contrôle de fin de séance, ou nouvelle synchro lancée sur le Départ)
      const t = now();
      if (d.type === 'down') { this.sfNew = new CC.SyncFit(P); this.sfNew.anchor(d.perf); this.newAmps = []; return; }
      if (d.type !== 'up') return;
      if (this.sfNew) {
        this.sfNew.chirp(d.perf); if (d.amp) this.newAmps.push(d.amp);
        if (this.sfNew.ready) { const sf = this.sfNew; this.start({ sf, amps: this.newAmps, hello: false }); this.candAt = now(); show('prep'); return; }
      }
      if (t < this.cooldownUntil) return;
      const f = S.fit; if (!f) return;
      if (S.syncAmp && !(d.amp >= 0.25 * S.syncAmp)) return; // trop faible : les téléphones ne sont pas côte à côte
      const k = Math.round((d.perf - f.h0) / f.b), r = d.perf - (f.h0 + k * f.b);
      if (k <= 0 || Math.abs(r) > 80 || this.chk.some(c => c[0] === k)) return;
      this.chk.push([k, d.perf, r]);
      if (this.chk.length > 20) this.chk.shift();
      if (this.chk.length >= 8) {
        const rs = this.chk.map(c => c[2]), med = CC.median(rs), mad = CC.mad(rs);
        if (mad < 1) {
          this.chkRes = { r: med, mad, n: this.chk.length, min: CC.median(this.chk.map(c => c[0])) * P / 60000 };
          this._apply(); Pair.sendOk(); this.chk = []; this.cooldownUntil = t + 20000;
          const lc = S.lastCheck;
          if (lc.min >= 3) flashNote(`Contrôle : dérive de ${fmt.ms1(Math.abs(lc.r))} ms en ${Math.round(lc.min)} min, corrigée${lc.fixed ? ` sur ${lc.fixed} temps` : ''}.`);
          renderList(); renderChips();
        }
      }
    },
    _apply() { // droite recalculée sur toute la séance, puis correction des temps déjà enregistrés
      const c = this.chkRes, good = this.chk.filter(x => Math.abs(x[2] - c.r) <= 3 * Math.max(0.3, c.mad));
      this.sf.pts = this.sf.pts.concat(good.map(x => [x[0], x[1], this.sf.seg])); // même segment : l'écart est traité comme une dérive
      const nf = this.sf.fit(); S.fit = nf;
      let fixed = 0;
      for (const res of S.results) if (res.gen === S.syncGen && res.raw != null) {
        const tau = (res.raw - nf.h0) * (P / nf.b);
        res.T = tau - res.n * CC.GRID - res.ath * MS_PER_M; res.fixed = true; fixed++;
      }
      store.set('results', S.results);
      S.lastCheck = { r: c.r, min: c.min, fixed };
    },
    status() {
      const f = S.fit;
      if (!f) return this.sf.cand !== null || this.sf.pts.length ? 'anchor' : 'wait';
      if (this.mode === 'watch') return 'ok';
      if ((f.n >= 15 && f.err30 <= 4 && f.resid <= 0.6) || (f.n >= 40 && f.resid <= 1)) return 'ok';
      return 'progress';
    },
    progress() {
      const f = S.fit; if (!f || f.n < 2) return this.sf.cand !== null ? 0.05 : 0;
      if (this.status() === 'ok') return 1;
      return Math.min(0.97, Math.max(f.n / 40, Math.min(f.n / 15, isFinite(f.err30) ? Math.max(0.1, Math.min(1, 4 / f.err30)) : 0.1)));
    },
  };

  // ---------------- calibration caméra : 3 claquements sur la ligne, téléphone en place ----------------
  const Clap = {
    active: false, vals: [], pending: [], timer: null, N: 3,
    start() {
      this.active = true; this.vals = []; this.pending = []; S.D = null; S.Dspread = null;
      Cam.config({ dir: 0, cooldownMs: 700, clearMs: 250, band: null }); if (Cam.det) Cam.det.armed = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this._poll(), 100); renderRun(); renderChips();
    },
    stop() { this.active = false; if (this.timer) clearInterval(this.timer); this.timer = null; applyGateConfig(); renderRun(); renderChips(); },
    onGate(ev) { this.pending.push(ev.t); },
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
          S.D = CC.median(best) + D_CLAP_M * MS_PER_M; S.Dspread = spread; S.camRestartsAtClap = Cam.restarts;
          this.stop(); Audio.beep(2);
          showBig('Prêt', S.role === 'finish' ? 'Calibré. Le temps s\'affichera ici à ton passage.' : 'Calibré. Arme la cellule.', 'Caméra calibrée');
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
      if (S.s0 == null) return;
      const t = now(), lead = Math.max(15, S.settings.lead) * 1000;
      const n = Math.ceil((t + lead - S.s0) / CC.GRID), sPerf = S.s0 + n * CC.GRID;
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
      if (Math.abs(r - S.R) > 2) { S.warnings.add('drift-audio'); S.lastRgoDiff = r - S.R; renderBanners(); }
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
    if (!S.fit) { flashNote('Passage détecté, mais la synchro manque.'); return; }
    const D = S.D != null ? S.D : 0;
    const raw = ev.t - D + D_SYNC_M * MS_PER_M;
    const tau = (raw - S.fit.h0) * (P / S.fit.b);
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
    if (S.s0 == null || S.R == null) { flashNote('Départ détecté, mais la synchro manque.'); return; }
    const tau = CC.tauStart(ev.t, S.s0, S.D != null ? S.D : 0, S.R, D_SELF_M);
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
    if (S.role === 'finish') {
      const st = Listen.status();
      chips.push(S.fit && st === 'ok' ? ['ok', 'Synchro ±' + fmt.ms1(Math.max(0.1, S.fit.err30)) + ' ms'] : S.fit ? ['warn', 'Synchro en cours'] : ['bad', 'Pas de synchro']);
    } else chips.push(Emit.active ? ['warn', Emit.checking ? 'Contrôle en cours' : 'Synchro en cours'] : S.s0 != null ? ['ok', 'Synchro faite'] : ['bad', 'Pas de synchro']);
    if (needCalib()) chips.push(S.D != null ? ['ok', 'Caméra calibrée'] : ['warn', 'Caméra à calibrer']);
    chips.push([Cam.fps >= 50 ? 'ok' : Cam.fps >= 24 ? '' : 'bad', Math.round(Cam.fps) + ' i/s']);
    c.replaceChildren(...chips.map(([k, t]) => mk('span', 'chip ' + k, t)));
  }
  function renderBanners() {
    const b = $('#banners'), items = [];
    if (S.warnings.has('clock')) items.push(['bad', 'Horloge interrompue (mise en veille ou appli quittée) : remets les téléphones côte à côte, Réglages → Refaire la synchro.']);
    if (S.warnings.has('audio')) items.push(['bad', 'Le son a été interrompu : remets les téléphones côte à côte, Réglages → Refaire la synchro.']);
    if (S.warnings.has('camera')) items.push(['bad', 'La caméra s\'est arrêtée : recharge la page puis refais la synchro.']);
    if (S.warnings.has('late')) items.push(['bad', 'Le bip est parti en retard (téléphone surchargé) : ce départ n\'est pas fiable.']);
    if (S.warnings.has('drift-audio')) items.push(['', `Le dernier bip de départ est parti avec ${fmt.ms1(Math.abs(S.lastRgoDiff || 0))} ms d'écart : ce temps peut être faussé d'autant. Fais un contrôle de synchro.`]);
    if (S.D != null && Cam.restarts > (S.camRestartsAtClap || 0)) items.push(['', 'La caméra a redémarré : Réglages → Recalibrer la caméra.']);
    b.replaceChildren(...items.map(([k, t]) => mk('div', 'banner ' + k, t)));
  }
  function kv(el, pairs) { el.replaceChildren(...pairs.map(([k, v]) => { const d = mk('div'); d.append(mk('dt', null, k), mk('dd', null, v)); return d; })); }
  function renderPrep() {
    if (S.screen !== 'prep') return;
    const btns = $('#pairBtns'); btns.replaceChildren();
    const btn = (label, cls, fn) => { const b = mk('button', 'btn ' + cls, label); b.onclick = fn; btns.append(b); return b; };
    let title, help, prog, pairs, state = '';
    if (S.role === 'start') {
      if (!Emit.active) {
        title = 'En attente de l\'Arrivée'; prog = 0; state = 'wait';
        help = 'Pose ce téléphone à 10 cm de l\'autre, volume à fond, et ouvre « Arrivée » dessus. La synchro démarre toute seule.';
        btn('Lancer les bips moi-même', 'ghost', () => Emit.start());
      } else {
        title = 'Synchronisation…'; state = 'run';
        prog = Math.min(0.95, (now() - Emit.startedAt) / 30000);
        help = 'Ne bouge pas les téléphones. Ça s\'arrête tout seul quand l\'Arrivée a fini (environ 30 s).';
        btn('Arrêter', 'ghost', () => { Emit.stop(); renderPrep(); });
      }
      pairs = [['Bips émis', String(Emit.count)], ['Latence son', S.R != null ? fmt.ms1(S.R) + ' ms' : '—']];
    } else {
      const st = Listen.status(), f = S.fit;
      prog = Listen.progress();
      if (st === 'wait') { title = 'En attente du Départ'; state = 'wait'; help = 'Pose ce téléphone à 10 cm de l\'autre, volume à fond, et ouvre « Départ » dessus. La synchro démarre toute seule.'; }
      else if (st === 'ok') { title = 'Synchro OK'; state = 'ok'; help = 'Passage à l\'écran piste…'; }
      else { title = 'Synchronisation…'; state = 'run'; help = 'Ne bouge pas les téléphones (environ 30 s).'; }
      pairs = [['Bips reçus', f ? String(f.n) : '0'], ['Précision 30 min', f && f.n >= 8 && isFinite(f.err30) ? '±' + fmt.ms1(f.err30) + ' ms' : '—']];
      btn('Recommencer', 'ghost', () => Listen.start());
    }
    $('#pairTitle').textContent = title; $('#pairHelp').textContent = help;
    $('#pairBar').style.width = Math.round(prog * 100) + '%';
    $('#scrPrep').dataset.state = state;
    kv($('#syncKv'), pairs);
    renderChips();
  }
  function renderCountdown() {
    if (S.screen !== 'run' || S.role !== 'start' || S.mode !== 'bip') return;
    const p = Go.p, b = $('#big');
    if (!p) return;
    const left = p.sPerf - now();
    if (left > 0) { b.textContent = fmt.clock(left).replace(/,\d$/, ''); b.className = 'big num ' + (left < 2600 ? 'go' : ''); $('#bigSub').textContent = left > p.sPerf - p.tMarks ? 'Place-toi. « À vos marques » arrive.' : left > p.sPerf - p.tSet ? 'À vos marques' : 'Prêts'; }
    else { b.textContent = 'Parti'; b.className = 'big go'; $('#bigSub').textContent = 'Le temps s\'affiche sur l\'Arrivée.'; }
  }
  const CLAP_HELP = 'Téléphone posé à sa place. À 30–50 cm de l\'objectif, tiens la main gauche immobile juste à gauche de la ligne rouge et frappe-la avec la main droite qui arrive de la droite. Un bip confirme chaque claquement.';
  function renderRun() {
    if (S.screen !== 'run') return;
    $('#modeBip').setAttribute('aria-pressed', S.mode === 'bip'); $('#modeCell').setAttribute('aria-pressed', S.mode === 'cell');
    if (needCalib() && S.D == null && !Clap.active) { Clap.start(); return; }
    if (!needCalib() && Clap.active) { Clap.stop(); return; }
    const ctl = $('#ctl'); ctl.replaceChildren();
    const camRun = $('#camRun');
    $('#calibHelp').hidden = true;
    if (Clap.active) {
      camRun.hidden = false;
      Cam.mount(camRun, S.role === 'finish' ? 'Pose le téléphone à son emplacement, ligne rouge sur la ligne d\'arrivée.' : 'Pose le téléphone à son emplacement, ligne rouge 50 cm devant ta ligne de départ.');
      showBig(Math.min(Clap.N, Clap.vals.length) + '/' + Clap.N, 'Claque 3 fois des mains sur la ligne rouge', 'Calibration caméra', Clap.vals.length ? '' : 'dim');
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
        b.disabled = S.s0 == null || Emit.active;
        ctl.append(b);
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
      // contrôle de synchro : un bouton, téléphones côte à côte
      const row = mk('div', 'check-row');
      if (Emit.active && Emit.checking) {
        row.append(mk('span', 'note', 'Contrôle en cours : téléphones côte à côte. S\'arrête tout seul.'));
        const st = mk('button', 'btn ghost', 'Arrêter'); st.onclick = () => { Emit.stop(); renderRun(); }; row.append(st);
      } else if (!Emit.active) {
        const cb = mk('button', 'btn ghost', 'Contrôler la synchro'); cb.disabled = S.s0 == null || !!Go.p;
        cb.onclick = () => { Emit.resume(); renderRun(); };
        row.append(cb, mk('span', 'note', 'En fin de séance, téléphones côte à côte : corrige les temps de l\'Arrivée.'));
      }
      ctl.append(row);
    } else {
      camRun.hidden = false;
      Cam.mount(camRun, 'Ligne rouge sur ta ligne d\'arrivée.');
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
    if (S.role === 'finish' && S.fit) tau = (now() - S.fit.h0) * (P / S.fit.b);
    if (S.role === 'start' && S.s0 != null) tau = now() - S.s0;
    $('#commonClock').textContent = tau == null ? '—' : fmt.clock(tau);
    const ri = $('#runInfo');
    if (S.role === 'finish' && S.mode === 'bip' && tau != null) ri.textContent = '+' + comma(((tau % CC.GRID) / 1000).toFixed(1)) + ' s depuis la minute ronde';
    else if (S.role === 'start' && S.mode === 'bip' && tau != null && !Go.p) ri.textContent = 'prochaine minute dans ' + Math.ceil((CC.GRID - (tau % CC.GRID)) / 1000) + ' s';
    else ri.textContent = '';
  }, 100);

  // surveillance de l'horloge (mise en veille, page masquée)
  let lastGap = Date.now() - performance.now(), hiddenAt = null;
  setInterval(() => { const g = Date.now() - performance.now(); if (Math.abs(g - lastGap) > 40 && (S.s0 != null || S.fit)) { S.warnings.add('clock'); renderBanners(); } lastGap = g; }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = now();
    else { if (S.started) Wake.on(); if (hiddenAt && now() - hiddenAt > 3000 && (S.s0 != null || S.fit)) { S.warnings.add('clock'); renderBanners(); } hiddenAt = null; }
  });

  // ---------------- navigation ----------------
  function show(screen) {
    S.screen = screen;
    for (const id of ['scrHome', 'scrPrep', 'scrRun']) $('#' + id).hidden = id !== 'scr' + screen[0].toUpperCase() + screen.slice(1);
    $('#btnSettings').hidden = screen === 'home'; $('#chips').hidden = screen === 'home';
    if (screen === 'prep') { if (Clap.active) { Clap.active = false; clearInterval(Clap.timer); Clap.timer = null; applyGateConfig(); } renderPrep(); }
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
      await Audio.start(role === 'start' ? ['down', 'up', 'hello', 'ok', 'gun'] : ['down', 'up', 'hello', 'ok']);
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
    Audio.onDet = (d) => role === 'start' ? Emit.onDet(d) : Listen.onDet(d);
    Cam.onEvent = onGate;
    show('prep');
    if (role === 'finish') Listen.start();
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
    if (S.role === 'finish') { show('prep'); Listen.start(); } else { Emit.stop(); show('prep'); }
    renderBanners();
  };
  $('#btnRecalib').onclick = () => { dlg.close(); S.D = null; if (S.screen === 'run') Clap.start(); };
  $('#btnClear').onclick = () => { $('#clearConfirm').hidden = false; };
  $('#btnClearNo').onclick = () => { $('#clearConfirm').hidden = true; };
  $('#btnClearYes').onclick = () => { S.results = []; store.set('results', []); $('#clearConfirm').hidden = true; renderList(); };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadCtl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => { });
    // nouvelle version installée : on recharge tout de suite si aucune séance n'est en cours
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtl && !S.started) location.reload(); });
  }
  window.ChronoApp = { S, Audio, Cam, Emit, Listen, Clap, Go, Pair, VERSION, enterCode, show };
})();
