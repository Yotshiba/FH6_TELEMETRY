// Synthesised driving audio: engine note, turbo whistle, tyre squeal, kerb rumble, beep, blow-off.
//
// Pure mapping functions (telemetry -> synth parameters) are exported and unit-tested on their own.
// `SoundEngine` wraps a Web Audio graph but never touches a browser global at import time: the
// AudioContext is created by an injected `createContext()` so the whole thing runs under Node tests.

const TC = 0.05;                 // setTargetAtTime time constant (s): smooth, click-free parameter changes
const BEEP_MIN_GAP_S = 0.25;
const BLOW_MIN_GAP_S = 0.3;
const SHIFT_DIP_S = 0.09;        // engine "torque cut" dip after a gear change
const SHIFT_DIP_GAIN = 0.55;
const STOP_RAMP_S = 0.03;        // time constant used to fade everything out in stop()
const STOP_WAIT_MS = 160;        // let that fade finish before suspending the context
const NOISE_SECONDS = 2;
const SUB_MIN_HZ = 10;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0);

// ---------------------------------------------------------------------------
// Mapping functions
// ---------------------------------------------------------------------------

/**
 * Firing frequency of a 4-stroke engine: rpm/60 * cylinders/2, clamped to an audible [20, 900] Hz.
 * @param {number} rpm
 * @param {number} [cylinders] defaults to 4 when missing / not a positive number
 * @returns {number} Hz
 */
export function engineFreq(rpm, cylinders) {
  const r = Math.max(0, num(rpm));
  const c = typeof cylinders === 'number' && Number.isFinite(cylinders) && cylinders > 0 ? cylinders : 4;
  return clamp((r / 60) * (c / 2), 20, 900);
}

/**
 * Engine loudness 0..1: quiet idle floor, louder with rpm, loudest on throttle at high rpm.
 * @param {number} throttle01 0..1
 * @param {number} rpmRatio rpm / maxRpm, 0..1
 * @param {number} [master=1] 0..1 multiplier
 */
export function engineGain(throttle01, rpmRatio, master = 1) {
  const t = clamp01(throttle01);
  const r = clamp01(rpmRatio);
  const m = typeof master === 'number' && Number.isFinite(master) ? clamp01(master) : 1;
  const g = 0.10 + 0.22 * r + 0.68 * t * (0.35 + 0.65 * r);
  return clamp01(g) * m;
}

/**
 * Engine low-pass cutoff in Hz, 400..4500 (exponential), opens with rpm and throttle.
 * @param {number} rpmRatio 0..1
 * @param {number} throttle01 0..1
 */
export function engineCutoff(rpmRatio, throttle01) {
  const open = clamp01(0.6 * clamp01(rpmRatio) + 0.4 * clamp01(throttle01));
  return 400 * Math.pow(4500 / 400, open);
}

/**
 * Turbo whistle loudness: 0 at <= 0.1 bar, rising to 0.35 at >= 1.5 bar on full throttle.
 * @param {number} boostBar
 * @param {number} throttle01 0..1
 */
export function turboGain(boostBar, throttle01) {
  const b = num(boostBar);
  if (b <= 0.1) return 0;
  return 0.35 * clamp01((b - 0.1) / 1.4) * (0.3 + 0.7 * clamp01(throttle01));
}

/**
 * Turbo whistle band-pass centre frequency, 1800..6000 Hz, rising with boost and rpm.
 * @param {number} boostBar
 * @param {number} rpmRatio 0..1
 */
export function turboFreq(boostBar, rpmRatio) {
  return 1800 + 3000 * clamp01(num(boostBar) / 2) + 1200 * clamp01(rpmRatio);
}

/**
 * Tyre squeal loudness: 0 up to a combined slip of 0.9, smooth rise to 0.5 at >= 2.0.
 * @param {number} combinedSlip max of the four tyres' TireCombinedSlip
 */
export function squealGain(combinedSlip) {
  const s = clamp01((num(combinedSlip) - 0.9) / 1.1);
  return 0.5 * s * s * (3 - 2 * s);
}

/**
 * Tyre squeal band-pass centre frequency, 900..2200 Hz, rising with slip and speed.
 * @param {number} combinedSlip
 * @param {number} speedKmh
 */
export function squealFreq(combinedSlip, speedKmh) {
  const s = clamp01((num(combinedSlip) - 0.5) / 2.0);
  const v = clamp01(num(speedKmh) / 250);
  return 900 + 1300 * clamp01(0.65 * s + 0.35 * v);
}

/**
 * Number of wheels on a rumble strip: popcount of bits 0..3 of WheelFlags (puddle bits 4..7 ignored).
 * @param {number} flagsBits
 * @returns {number} 0..4
 */
export function rumbleRate(flagsBits) {
  const b = Math.trunc(num(flagsBits));
  if (!(b >= 0)) return 0;
  let n = 0;
  for (let i = 0; i < 4; i++) if (b & (1 << i)) n++;
  return n;
}

/** Kerb rumble loudness for `wheels` (0..4) wheels on the strip. */
export function rumbleGain(wheels) {
  const n = clamp(Math.trunc(num(wheels)), 0, 4);
  return [0, 0.10, 0.16, 0.21, 0.25][n];
}

/** Kerb rumble oscillator frequency, 24..110 Hz, rising with speed. */
export function rumbleFreq(speedKmh) {
  return clamp(24 + Math.max(0, num(speedKmh)) * 0.35, 24, 110);
}

/**
 * Fill `out` with deterministic white noise in [-1, 1) (xorshift32), so audio is reproducible.
 * @param {Float32Array|number[]} out
 * @param {number} [seed]
 */
export function fillWhiteNoise(out, seed = 0x9e3779b9) {
  let x = (seed | 0) || 1;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = (x >>> 0) / 2147483648 - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default browser plumbing (only evaluated when called)
// ---------------------------------------------------------------------------

/** Create an AudioContext from the browser globals, or throw a clear Error when there is none. */
export function defaultCreateContext() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') throw new Error('Web Audio API is not available in this environment');
  return new Ctor({ latencyHint: 'interactive' });
}

const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GAIN_NODE = { engine: 'engineGain', turbo: 'turboGain', squeal: 'squealGain', rumble: 'rumbleGain' };

// ---------------------------------------------------------------------------
// SoundEngine
// ---------------------------------------------------------------------------

/**
 * Procedural car audio on a small Web Audio graph (no AudioWorklet).
 *
 * Graph:  3 oscillators (saw f, square 2f, sine f/2) -> mix gains -> shared low-pass -> engine gain -> master
 *         noise -> band-pass -> turbo gain -> master
 *         noise -> band-pass -> squeal gain -> master
 *         square osc -> low-pass -> rumble gain -> master          master -> destination
 * One-shot `beep()` / `blowOff()` create and discard their own tiny node chains.
 */
export class SoundEngine {
  /**
   * @param {object} [options]
   * @param {() => object} [options.createContext] returns an AudioContext-like object (default: browser AudioContext)
   * @param {number} [options.master=0.6] master volume 0..1
   * @param {(ms:number) => Promise<void>} [options.delay] used by stop() to let the fade-out finish (tests inject an instant one)
   */
  constructor(options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    this._createContext = typeof o.createContext === 'function' ? o.createContext : defaultCreateContext;
    this._delay = typeof o.delay === 'function' ? o.delay : defaultDelay;
    /** master volume 0..1 */
    this.master = typeof o.master === 'number' && Number.isFinite(o.master) ? clamp01(o.master) : 0.6;
    /** per-feature switches; see setEnabled() */
    this.enabled = { engine: true, turbo: true, squeal: true, rumble: true, beep: true, blowOff: true };
    /** which features were built successfully (false after a build/runtime failure) */
    this.available = { engine: false, turbo: false, squeal: false, rumble: false, beep: false, blowOff: false };
    /** {feature, message} for every feature that had to be disabled; feature is 'context' when the context itself failed */
    this.errors = [];
    /** the AudioContext-like object once start() has run */
    this.ctx = null;
    /** built node handles (debug / tests): master, noise, osc[3], mix[3], lowpass, engineGain, turbo*, squeal*, rumble* */
    this.nodes = null;
    this._running = false;
    this._startPromise = null;
    this._gen = 0;
    this._gear = null;
    this._shiftAt = -Infinity;
    this._lastBeep = -Infinity;
    this._lastBlow = -Infinity;
    this._blowCount = 0;
  }

  /** true between a successful start() and stop() */
  get running() { return this._running; }

  /**
   * Create / resume the context and build the graph (once). Must be called from a user gesture in browsers.
   * Never rejects.
   * @returns {Promise<boolean>} true when audio is running (some features may still be unavailable, see `errors`)
   */
  start() {
    if (!this._startPromise) {
      this._startPromise = this._start().finally(() => { this._startPromise = null; });
    }
    return this._startPromise;
  }

  async _start() {
    const gen = ++this._gen;
    try {
      if (this.ctx && this.ctx.state === 'closed') { this.ctx = null; this.nodes = null; }
      if (!this.ctx) {
        const ctx = this._createContext();
        if (!ctx || typeof ctx !== 'object') throw new Error('createContext() did not return an audio context');
        this.ctx = ctx;
      }
      const ctx = this.ctx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume();
      if (gen !== this._gen) return false;                 // stop() (or a newer start) overtook us
      if (!this.nodes) this._build();
      this._running = true;
      this._set(this.nodes.master.gain, this.master);
      return true;
    } catch (e) {
      this.errors.push({ feature: 'context', message: errMessage(e) });
      return false;
    }
  }

  _build() {
    const ctx = this.ctx;
    this.errors.length = 0;
    for (const k of Object.keys(this.available)) this.available[k] = false;
    const master = ctx.createGain();
    master.gain.value = this.master;
    master.connect(ctx.destination);
    const nodes = { master, noise: null, noiseSeconds: NOISE_SECONDS };
    this.nodes = nodes;

    try {
      nodes.noise = this._makeNoise(ctx);
      nodes.noiseSeconds = nodes.noise.duration > 0 ? nodes.noise.duration : NOISE_SECONDS;
    } catch (e) {
      this._fail('noise', e, false);
    }

    this._buildFeature('engine', () => {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass'; lowpass.Q.value = 0.9; lowpass.frequency.value = 400;
      const engineGainNode = ctx.createGain();
      engineGainNode.gain.value = 0;
      const osc = [];
      const mix = [];
      for (const [type, level] of [['sawtooth', 0.45], ['square', 0.14], ['sine', 0.5]]) {
        const o = ctx.createOscillator();
        o.type = type; o.frequency.value = 40;
        const m = ctx.createGain();
        m.gain.value = level;
        osc.push(o); mix.push(m);
      }
      for (let i = 0; i < osc.length; i++) { osc[i].connect(mix[i]); mix[i].connect(lowpass); }
      lowpass.connect(engineGainNode);
      engineGainNode.connect(master);                      // audible path completes last
      for (const o of osc) o.start();
      return { osc, mix, lowpass, engineGain: engineGainNode };
    });

    const noisePath = (name, freq, q, offsetFraction) => this._buildFeature(name, () => {
      if (!nodes.noise) throw new Error('noise buffer unavailable');
      const src = ctx.createBufferSource();
      src.buffer = nodes.noise; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(0, nodes.noiseSeconds * offsetFraction);
      return { [`${name}Src`]: src, [`${name}Filter`]: bp, [`${name}Gain`]: g };
    });
    noisePath('turbo', 3000, 8, 0);
    noisePath('squeal', 1400, 6, 0.5);

    this._buildFeature('rumble', () => {
      const osc = ctx.createOscillator();
      osc.type = 'square'; osc.frequency.value = 30;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 140; lp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(lp); lp.connect(g); g.connect(master);
      osc.start();
      return { rumbleOsc: osc, rumbleFilter: lp, rumbleGain: g };
    });

    this.available.beep = typeof ctx.createOscillator === 'function' && typeof ctx.createGain === 'function';
    this.available.blowOff = !!nodes.noise && typeof ctx.createBufferSource === 'function'
      && typeof ctx.createBiquadFilter === 'function' && typeof ctx.createGain === 'function';
  }

  _makeNoise(ctx) {
    const rate = typeof ctx.sampleRate === 'number' && ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    const buf = ctx.createBuffer(1, Math.max(1, Math.round(rate * NOISE_SECONDS)), rate);
    fillWhiteNoise(buf.getChannelData(0));
    return buf;
  }

  _buildFeature(feature, build) {
    try {
      Object.assign(this.nodes, build());
      this.available[feature] = true;
    } catch (e) {
      this._fail(feature, e, true);
    }
  }

  _fail(feature, e, mark = true) {
    if (mark && feature in this.available) this.available[feature] = false;
    this.errors.push({ feature, message: errMessage(e) });
  }

  _try(feature, fn) {
    try { fn(); } catch (e) { this._fail(feature, e); }
  }

  _set(param, value) {
    if (!param || !Number.isFinite(value)) return;
    param.setTargetAtTime(value, this.ctx.currentTime, TC);
  }

  /**
   * Fade everything out, then suspend the context (or close it with `{close: true}`; a later start()
   * then builds a fresh graph). update()/beep()/blowOff() become no-ops immediately.
   * @param {{close?: boolean}} [options]
   */
  async stop(options = {}) {
    this._gen++;
    this._running = false;
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes) return;
    try {
      for (const key of ['engineGain', 'turboGain', 'squealGain', 'rumbleGain']) {
        if (nodes[key]) nodes[key].gain.setTargetAtTime(0, ctx.currentTime, STOP_RAMP_S);
      }
      nodes.master.gain.setTargetAtTime(0, ctx.currentTime, STOP_RAMP_S);
      await this._delay(STOP_WAIT_MS);
      if (this._running || this.ctx !== ctx) return;       // restarted while fading
      if (options && options.close && typeof ctx.close === 'function') {
        await ctx.close();
        if (this.ctx === ctx) { this.ctx = null; this.nodes = null; }
      } else if (typeof ctx.suspend === 'function') {
        await ctx.suspend();
      }
    } catch (e) {
      this.errors.push({ feature: 'context', message: errMessage(e) });
    }
  }

  /** @param {number} v master volume 0..1 */
  setMaster(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    this.master = clamp01(v);
    if (this._running && this.nodes) this._set(this.nodes.master.gain, this.master);
  }

  /**
   * Switch features on/off. Keys: engine, turbo, squeal, rumble (looping sounds) and beep, blowOff (one-shots).
   * Missing keys keep their value; switching a looping sound off fades its gain to 0 immediately.
   * @param {{engine?: boolean, turbo?: boolean, squeal?: boolean, rumble?: boolean, beep?: boolean, blowOff?: boolean}} flags
   */
  setEnabled(flags) {
    if (!flags || typeof flags !== 'object') return;
    for (const key of Object.keys(this.enabled)) {
      if (!(key in flags)) continue;
      const on = !!flags[key];
      const was = this.enabled[key];
      this.enabled[key] = on;
      if (!on && was && this.nodes && this.ctx && GAIN_NODE[key]) {
        const node = this.nodes[GAIN_NODE[key]];
        if (node) this._set(node.gain, 0);
      }
    }
  }

  /**
   * Drive the synth from telemetry. Call as often as you like (it is cheap); parameters glide with
   * setTargetAtTime. No-op until start() succeeded and after stop().
   * @param {{rpm:number, maxRpm:number, throttle:number, boost:number, combinedSlip:number, speedKmh:number,
   *          cylinders:number, rumbleBits:number, gear:number}} state throttle is 0..100, boost in bar
   * @param {number} [nowSeconds] caller clock for the gear-change dip (defaults to ctx.currentTime)
   */
  update(state, nowSeconds) {
    if (!this._running || !this.nodes || !state || typeof state !== 'object') return;
    const nd = this.nodes;
    const now = typeof nowSeconds === 'number' && Number.isFinite(nowSeconds) ? nowSeconds : this.ctx.currentTime;
    const rpm = Math.max(0, num(state.rpm));
    const maxRpm = num(state.maxRpm);
    const ratio = maxRpm > 0 ? clamp01(rpm / maxRpm) : 0;
    const thr = clamp01(num(state.throttle) / 100);
    const speed = num(state.speedKmh);

    const gear = typeof state.gear === 'number' && Number.isFinite(state.gear) ? state.gear : null;
    if (gear !== null) {
      if (this._gear !== null && gear !== this._gear) this._shiftAt = now;
      this._gear = gear;
    }
    const dip = now >= this._shiftAt && now - this._shiftAt < SHIFT_DIP_S;

    if (this.enabled.engine && this.available.engine) {
      this._try('engine', () => {
        const f = engineFreq(rpm, state.cylinders);
        this._set(nd.osc[0].frequency, f);
        this._set(nd.osc[1].frequency, f * 2);
        this._set(nd.osc[2].frequency, Math.max(f / 2, SUB_MIN_HZ));
        this._set(nd.lowpass.frequency, engineCutoff(ratio, thr));
        let g = rpm > 1 ? engineGain(thr, ratio, 1) : 0;   // engine off (menus, pause): silence
        if (dip) g *= SHIFT_DIP_GAIN;
        this._set(nd.engineGain.gain, g);
      });
    }
    if (this.enabled.turbo && this.available.turbo) {
      this._try('turbo', () => {
        const boost = num(state.boost);
        this._set(nd.turboFilter.frequency, turboFreq(boost, ratio));
        this._set(nd.turboGain.gain, turboGain(boost, thr));
      });
    }
    if (this.enabled.squeal && this.available.squeal) {
      this._try('squeal', () => {
        const slip = num(state.combinedSlip);
        this._set(nd.squealFilter.frequency, squealFreq(slip, speed));
        this._set(nd.squealGain.gain, squealGain(slip));
      });
    }
    if (this.enabled.rumble && this.available.rumble) {
      this._try('rumble', () => {
        this._set(nd.rumbleOsc.frequency, rumbleFreq(speed));
        this._set(nd.rumbleGain.gain, rumbleGain(rumbleRate(state.rumbleBits)));
      });
    }
  }

  /**
   * Short 1.2 kHz sine blip (80 ms, enveloped), rate-limited to one per 0.25 s.
   * @param {number} [nowSeconds] caller clock used for the rate limit (defaults to ctx.currentTime)
   * @returns {boolean} true when a beep was played
   */
  beep(nowSeconds) {
    if (!this._running || !this.nodes || !this.enabled.beep || !this.available.beep) return false;
    const ctx = this.ctx;
    const now = typeof nowSeconds === 'number' && Number.isFinite(nowSeconds) ? nowSeconds : ctx.currentTime;
    if (now >= this._lastBeep && now - this._lastBeep < BEEP_MIN_GAP_S) return false;
    this._lastBeep = now;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.4, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(g); g.connect(this.nodes.master);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (_) { /* already gone */ } };
      osc.start(t); osc.stop(t + 0.09);
      return true;
    } catch (e) {
      this._fail('beep', e);
      return false;
    }
  }

  /**
   * Turbo blow-off "pssh": ~200 ms burst of band-passed noise sweeping down. Rate-limited to one per 0.3 s.
   * @param {number} [nowSeconds] caller clock used for the rate limit (defaults to ctx.currentTime)
   * @returns {boolean} true when a burst was played
   */
  blowOff(nowSeconds) {
    if (!this._running || !this.nodes || !this.enabled.blowOff || !this.available.blowOff) return false;
    const ctx = this.ctx;
    const now = typeof nowSeconds === 'number' && Number.isFinite(nowSeconds) ? nowSeconds : ctx.currentTime;
    if (now >= this._lastBlow && now - this._lastBlow < BLOW_MIN_GAP_S) return false;
    this._lastBlow = now;
    try {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.nodes.noise; src.loop = false;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.value = 3200;
      bp.frequency.setValueAtTime(3200, t);
      bp.frequency.exponentialRampToValueAtTime(1400, t + 0.2);
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.55, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      src.connect(bp); bp.connect(g); g.connect(this.nodes.master);
      src.onended = () => { try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch (_) { /* already gone */ } };
      src.start(t, (this._blowCount++ % 4) * 0.4);
      src.stop(t + 0.21);
      return true;
    } catch (e) {
      this._fail('blowOff', e);
      return false;
    }
  }
}

function errMessage(e) {
  return e && e.message ? String(e.message) : String(e);
}

// ---------------------------------------------------------------------------
// Blow-off detection
// ---------------------------------------------------------------------------

/**
 * Detects a throttle lift under boost: throttle falls from > 60 to < 15 within 0.25 s while boost > 0.5 bar.
 * Fires at most once per second.
 */
export class BlowOffDetector {
  constructor() { this.reset(); }

  reset() {
    this._highAt = -Infinity;
    this._lastFire = -Infinity;
  }

  /**
   * @param {number} throttle 0..100
   * @param {number} boost bar
   * @param {number} nowSeconds monotonic caller clock
   * @returns {boolean} true on the sample where the lift is recognised
   */
  update(throttle, boost, nowSeconds) {
    if (![throttle, boost, nowSeconds].every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    const now = nowSeconds;
    if (now < this._highAt) this._highAt = -Infinity;      // clock went backwards: forget the old peak
    if (now < this._lastFire) this._lastFire = -Infinity;
    if (throttle > 60) this._highAt = now;
    if (throttle < 15 && now - this._highAt <= 0.25 && boost > 0.5 && now - this._lastFire >= 1) {
      this._lastFire = now;
      this._highAt = -Infinity;
      return true;
    }
    return false;
  }
}
