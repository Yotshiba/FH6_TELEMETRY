import test from 'node:test';
import assert from 'node:assert/strict';
import {
  engineFreq, engineGain, engineCutoff, turboGain, turboFreq, squealGain, squealFreq,
  rumbleRate, rumbleGain, rumbleFreq, fillWhiteNoise, defaultCreateContext,
  SoundEngine, BlowOffDetector,
} from '../../fh6_telemetry/web/static/audio.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------------

class FakeParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setTargetAtTime(v, t, tc) { this.calls.push({ fn: 'setTargetAtTime', v, t, tc }); }
  setValueAtTime(v, t) { this.calls.push({ fn: 'setValueAtTime', v, t }); }
  linearRampToValueAtTime(v, t) { this.calls.push({ fn: 'linearRampToValueAtTime', v, t }); }
  exponentialRampToValueAtTime(v, t) { this.calls.push({ fn: 'exponentialRampToValueAtTime', v, t }); }
  get targets() { return this.calls.filter((c) => c.fn === 'setTargetAtTime'); }
  get last() { const c = this.targets; return c.length ? c[c.length - 1].v : undefined; }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind;
    this.connections = []; this.startCalls = []; this.stopCalls = []; this.disconnects = 0;
  }
  connect(dest) { this.connections.push(dest); return dest; }
  disconnect() { this.disconnects++; }
  start(...a) { this.startCalls.push(a); }
  stop(...a) { this.stopCalls.push(a); }
}

class FakeAudioContext {
  constructor({ state = 'suspended', sampleRate = 1000, resumeGate = null } = {}) {
    this.currentTime = 0;
    this.state = state;
    this.sampleRate = sampleRate;
    this.destination = new FakeNode(this, 'destination');
    this.nodes = [];
    this.resumeCalls = 0; this.suspendCalls = 0; this.closeCalls = 0;
    this.resumeGate = resumeGate;
  }
  _make(kind, init) { const n = new FakeNode(this, kind); init(n); this.nodes.push(n); return n; }
  of(kind) { return this.nodes.filter((n) => n.kind === kind); }
  createGain() { return this._make('gain', (n) => { n.gain = new FakeParam(1); }); }
  createOscillator() {
    return this._make('osc', (n) => { n.type = 'sine'; n.frequency = new FakeParam(440); });
  }
  createBiquadFilter() {
    return this._make('filter', (n) => {
      n.type = 'lowpass'; n.frequency = new FakeParam(350); n.Q = new FakeParam(1);
    });
  }
  createBufferSource() { return this._make('source', (n) => { n.buffer = null; n.loop = false; }); }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  async resume() { this.resumeCalls++; if (this.resumeGate) await this.resumeGate; this.state = 'running'; }
  async suspend() { this.suspendCalls++; this.state = 'suspended'; }
  async close() { this.closeCalls++; this.state = 'closed'; }
}

const instantDelay = async () => {};

function makeEngine(opts = {}, ctxOpts = {}) {
  const made = [];
  const engine = new SoundEngine({
    createContext: () => { const c = new FakeAudioContext(ctxOpts); made.push(c); return c; },
    delay: instantDelay,
    ...opts,
  });
  return { engine, made };
}

const STATE = {
  rpm: 6000, maxRpm: 8000, throttle: 80, boost: 1.2, combinedSlip: 1.5,
  speedKmh: 120, cylinders: 6, rumbleBits: 0b0101, gear: 3,
};

// ---------------------------------------------------------------------------
// Mapping functions
// ---------------------------------------------------------------------------

test('engineFreq follows rpm/60 * cylinders/2', () => {
  near(engineFreq(3000, 4), 100);
  near(engineFreq(6000, 8), 400);
  near(engineFreq(6000, 6), 300);
  near(engineFreq(6000, 2), 100);
});

test('engineFreq defaults to 4 cylinders when missing or invalid', () => {
  const ref = engineFreq(3000, 4);
  for (const bad of [undefined, null, 0, -3, NaN, Infinity, '8', {}]) assert.equal(engineFreq(3000, bad), ref);
});

test('engineFreq clamps to 20..900 Hz and survives bad rpm', () => {
  assert.equal(engineFreq(0, 4), 20);
  assert.equal(engineFreq(-500, 4), 20);
  assert.equal(engineFreq(NaN, 4), 20);
  assert.equal(engineFreq(undefined, 4), 20);
  assert.equal(engineFreq(20000, 12), 900);
  assert.equal(engineFreq(1e12, 4), 900);
});

test('engineGain: idle floor, monotonic, bounded, scaled by master', () => {
  const idle = engineGain(0, 0.15, 1);
  assert.ok(idle > 0.05 && idle < 0.2, `idle floor ${idle}`);
  assert.ok(engineGain(0, 0, 1) > 0, 'never fully silent at idle');
  near(engineGain(1, 1, 1), 1);
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) { const g = engineGain(t, 0.5, 1); assert.ok(g >= prev); prev = g; }
  prev = -1;
  for (let r = 0; r <= 1.0001; r += 0.1) { const g = engineGain(0.5, r, 1); assert.ok(g >= prev); prev = g; }
  near(engineGain(0.7, 0.6, 0.5), engineGain(0.7, 0.6, 1) * 0.5);
  assert.equal(engineGain(1, 1, 0), 0);
  near(engineGain(0.7, 0.6), engineGain(0.7, 0.6, 1), 1e-12);   // master defaults to 1
  for (const v of [NaN, -5, 5, undefined, Infinity]) {
    const g = engineGain(v, v, v);
    assert.ok(g >= 0 && g <= 1 && Number.isFinite(g), `bounded for ${v}`);
  }
});

test('engineCutoff opens from 400 to 4500 Hz with rpm and throttle', () => {
  near(engineCutoff(0, 0), 400);
  near(engineCutoff(1, 1), 4500);
  assert.ok(engineCutoff(0.5, 0) < engineCutoff(0.8, 0));
  assert.ok(engineCutoff(0.5, 0.2) < engineCutoff(0.5, 0.9));
  assert.ok(engineCutoff(-1, -1) >= 400 - 1e-9);
  assert.ok(engineCutoff(9, 9) <= 4500 + 1e-9);
  assert.equal(engineCutoff(NaN, NaN), 400);
});

test('turboGain: silent at/below 0.1 bar, rises to about 0.35', () => {
  for (const b of [0.1, 0.05, 0, -0.8, NaN, undefined]) assert.equal(turboGain(b, 1), 0);
  assert.ok(turboGain(0.2, 1) > 0);
  near(turboGain(1.5, 1), 0.35);
  near(turboGain(5, 1), 0.35);
  assert.ok(turboGain(0.6, 1) < turboGain(1.0, 1));
  assert.ok(turboGain(1.2, 0.2) < turboGain(1.2, 1), 'less throttle, quieter');
  assert.ok(turboGain(1.2, 0) > 0, 'residual whistle off throttle');
});

test('turboFreq stays within 1800..6000 and rises with boost and rpm', () => {
  near(turboFreq(0, 0), 1800);
  near(turboFreq(2, 1), 6000);
  assert.ok(turboFreq(0.5, 0.5) < turboFreq(1.5, 0.5));
  assert.ok(turboFreq(1, 0.2) < turboFreq(1, 0.9));
  assert.ok(turboFreq(-2, -1) >= 1800 && turboFreq(99, 99) <= 6000);
});

test('squealGain: 0 below 0.9, about 0.5 from 2.0, monotonic', () => {
  for (const s of [0, 0.5, 0.9, -1, NaN, undefined]) assert.equal(squealGain(s), 0);
  near(squealGain(2.0), 0.5);
  near(squealGain(7), 0.5);
  near(squealGain(1.45), 0.25);
  let prev = -1;
  for (let s = 0.8; s <= 2.2; s += 0.05) { const g = squealGain(s); assert.ok(g >= prev); prev = g; }
  assert.ok(squealGain(0.95) > 0);
});

test('squealFreq spans 900..2200 Hz and rises with slip and speed', () => {
  near(squealFreq(0, 0), 900);
  near(squealFreq(2.5, 250), 2200);
  near(squealFreq(99, 9999), 2200);
  assert.ok(squealFreq(1.0, 100) < squealFreq(1.8, 100));
  assert.ok(squealFreq(1.5, 40) < squealFreq(1.5, 200));
  assert.equal(squealFreq(NaN, NaN), 900);
});

test('rumbleRate counts rumble bits 0..3 only', () => {
  assert.equal(rumbleRate(0), 0);
  assert.equal(rumbleRate(0b0001), 1);
  assert.equal(rumbleRate(0b0101), 2);
  assert.equal(rumbleRate(0b0111), 3);
  assert.equal(rumbleRate(0b1111), 4);
  assert.equal(rumbleRate(0b11110000), 0, 'puddle bits ignored');
  assert.equal(rumbleRate(0b10100011), 2);
  assert.equal(rumbleRate(3.9), 2, 'fractions truncated');
  for (const bad of [NaN, undefined, null, -1, '3', Infinity]) assert.equal(rumbleRate(bad), 0);
});

test('rumbleGain / rumbleFreq are bounded', () => {
  assert.equal(rumbleGain(0), 0);
  assert.ok(rumbleGain(1) > 0 && rumbleGain(1) < rumbleGain(2) && rumbleGain(2) < rumbleGain(3) && rumbleGain(3) < rumbleGain(4));
  assert.equal(rumbleGain(99), rumbleGain(4));
  assert.equal(rumbleGain(-2), 0);
  assert.equal(rumbleFreq(0), 24);
  assert.equal(rumbleFreq(1000), 110);
  assert.ok(rumbleFreq(60) < rumbleFreq(160));
});

test('fillWhiteNoise is deterministic, bounded and roughly zero-mean', () => {
  const a = fillWhiteNoise(new Float32Array(4096));
  const b = fillWhiteNoise(new Float32Array(4096));
  assert.deepEqual(a, b);
  let sum = 0;
  for (const v of a) { assert.ok(v >= -1 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / a.length) < 0.1);
  assert.notDeepEqual(a, fillWhiteNoise(new Float32Array(4096), 12345));
  assert.equal(new Set(a).size > 4000, true, 'not a short repeating cycle');
});

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

test('defaultCreateContext throws a clear error without Web Audio and uses globals when present', () => {
  const saved = { a: globalThis.AudioContext, w: globalThis.webkitAudioContext };
  try {
    delete globalThis.AudioContext; delete globalThis.webkitAudioContext;
    assert.throws(() => defaultCreateContext(), /Web Audio API is not available/);
    globalThis.webkitAudioContext = class { constructor() { this.tag = 'webkit'; } };
    assert.equal(defaultCreateContext().tag, 'webkit');
    globalThis.AudioContext = class { constructor() { this.tag = 'std'; } };
    assert.equal(defaultCreateContext().tag, 'std');
  } finally {
    if (saved.a === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved.a;
    if (saved.w === undefined) delete globalThis.webkitAudioContext; else globalThis.webkitAudioContext = saved.w;
  }
});

test('a SoundEngine with no Web Audio reports failure instead of throwing', async () => {
  const saved = { a: globalThis.AudioContext, w: globalThis.webkitAudioContext };
  try {
    delete globalThis.AudioContext; delete globalThis.webkitAudioContext;
    const engine = new SoundEngine();
    assert.equal(await engine.start(), false);
    assert.equal(engine.errors[0].feature, 'context');
    assert.match(engine.errors[0].message, /Web Audio API/);
    engine.update(STATE, 0);                 // still a no-op
    assert.equal(engine.beep(0), false);
  } finally {
    if (saved.a !== undefined) globalThis.AudioContext = saved.a;
    if (saved.w !== undefined) globalThis.webkitAudioContext = saved.w;
  }
});

// ---------------------------------------------------------------------------
// SoundEngine graph
// ---------------------------------------------------------------------------

test('constructing and updating before start() touches nothing', () => {
  let calls = 0;
  const engine = new SoundEngine({ createContext: () => { calls++; return new FakeAudioContext(); } });
  engine.update(STATE, 1);
  engine.setMaster(0.2);
  engine.setEnabled({ engine: false });
  assert.equal(engine.beep(1), false);
  assert.equal(engine.blowOff(1), false);
  assert.equal(calls, 0);
  assert.equal(engine.running, false);
  assert.equal(engine.master, 0.2);
});

test('start() builds the documented graph exactly once', async () => {
  const { engine, made } = makeEngine();
  assert.equal(await engine.start(), true);
  assert.equal(made.length, 1);
  const ctx = made[0];
  assert.equal(ctx.resumeCalls, 1, 'resumed a suspended context');
  assert.equal(engine.running, true);
  assert.deepEqual(engine.errors, []);

  const n = engine.nodes;
  assert.deepEqual(n.osc.map((o) => o.type), ['sawtooth', 'square', 'sine']);
  assert.ok(n.mix[0].gain.value > n.mix[1].gain.value, 'square sits lower in the mix than the saw');
  assert.equal(n.lowpass.type, 'lowpass');
  assert.equal(n.master.gain.value, 0.6);

  // engine path: osc -> mix -> shared low-pass -> engine gain -> master -> destination
  n.osc.forEach((o, i) => {
    assert.deepEqual(o.connections, [n.mix[i]]);
    assert.deepEqual(n.mix[i].connections, [n.lowpass]);
  });
  assert.deepEqual(n.lowpass.connections, [n.engineGain]);
  assert.deepEqual(n.engineGain.connections, [n.master]);
  assert.deepEqual(n.master.connections, [ctx.destination]);

  // noise paths
  assert.equal(n.turboFilter.type, 'bandpass');
  assert.deepEqual(n.turboSrc.connections, [n.turboFilter]);
  assert.deepEqual(n.turboFilter.connections, [n.turboGain]);
  assert.deepEqual(n.turboGain.connections, [n.master]);
  assert.equal(n.turboSrc.loop, true);
  assert.equal(n.squealFilter.type, 'bandpass');
  assert.deepEqual(n.squealSrc.connections, [n.squealFilter]);
  assert.deepEqual(n.squealFilter.connections, [n.squealGain]);
  assert.deepEqual(n.squealGain.connections, [n.master]);
  assert.equal(n.squealSrc.loop, true);
  assert.equal(n.turboSrc.buffer, n.noise);
  assert.equal(n.squealSrc.buffer, n.noise);
  assert.notEqual(n.squealSrc.startCalls[0][1], n.turboSrc.startCalls[0][1], 'noise paths decorrelated by offset');

  // rumble path
  assert.deepEqual(n.rumbleOsc.connections, [n.rumbleFilter]);
  assert.deepEqual(n.rumbleFilter.connections, [n.rumbleGain]);
  assert.deepEqual(n.rumbleGain.connections, [n.master]);

  // every loud path starts silent
  for (const g of [n.engineGain, n.turboGain, n.squealGain, n.rumbleGain]) assert.equal(g.gain.value, 0);

  // counts: 3 engine oscillators + rumble; 2 noise sources; 4 filters; 3 mix + 4 path + master gains
  assert.equal(ctx.of('osc').length, 4);
  assert.equal(ctx.of('source').length, 2);
  assert.equal(ctx.of('filter').length, 4);
  assert.equal(ctx.of('gain').length, 8);
  for (const s of [...ctx.of('osc'), ...ctx.of('source')]) assert.equal(s.startCalls.length, 1);

  // noise buffer is real noise, 2 seconds long
  assert.equal(n.noise.length, 2000);
  assert.ok(n.noise.getChannelData(0).some((v) => v !== 0));

  assert.deepEqual(engine.available, { engine: true, turbo: true, squeal: true, rumble: true, beep: true, blowOff: true });
});

test('start() twice (and concurrently) is safe and builds once', async () => {
  const { engine, made } = makeEngine();
  const [a, b] = await Promise.all([engine.start(), engine.start()]);
  assert.equal(a, true); assert.equal(b, true);
  assert.equal(await engine.start(), true);
  assert.equal(made.length, 1);
  const ctx = made[0];
  assert.equal(ctx.of('osc').length, 4);
  assert.equal(ctx.of('gain').length, 8);
  for (const s of [...ctx.of('osc'), ...ctx.of('source')]) assert.equal(s.startCalls.length, 1);
});

test('start() does not resume an already running context', async () => {
  const { engine, made } = makeEngine({}, { state: 'running' });
  await engine.start();
  assert.equal(made[0].resumeCalls, 0);
});

test('master option is honoured and setMaster clamps and glides', async () => {
  const { engine, made } = makeEngine({ master: 0.25 });
  await engine.start();
  assert.equal(engine.nodes.master.gain.value, 0.25);
  engine.setMaster(0.8);
  assert.equal(engine.nodes.master.gain.last, 0.8);
  engine.setMaster(7);
  assert.equal(engine.nodes.master.gain.last, 1);
  engine.setMaster(-1);
  assert.equal(engine.nodes.master.gain.last, 0);
  engine.setMaster(NaN);
  assert.equal(engine.master, 0, 'invalid master ignored');
  made[0].currentTime = 2;
  engine.setMaster(0.5);
  const call = engine.nodes.master.gain.targets.at(-1);
  assert.deepEqual([call.v, call.t, call.tc], [0.5, 2, 0.05]);
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

test('update() drives frequencies and gains from the mapping functions', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  const ctx = made[0];
  ctx.currentTime = 3.25;
  engine.update(STATE, 10);
  const n = engine.nodes;
  const ratio = 6000 / 8000;
  const thr = 0.8;
  const f = engineFreq(6000, 6);
  near(n.osc[0].frequency.last, f);
  near(n.osc[1].frequency.last, f * 2);
  near(n.osc[2].frequency.last, f / 2);
  near(n.lowpass.frequency.last, engineCutoff(ratio, thr));
  near(n.engineGain.gain.last, engineGain(thr, ratio, 1));
  near(n.turboGain.gain.last, turboGain(1.2, thr));
  near(n.turboFilter.frequency.last, turboFreq(1.2, ratio));
  near(n.squealGain.gain.last, squealGain(1.5));
  near(n.squealFilter.frequency.last, squealFreq(1.5, 120));
  near(n.rumbleGain.gain.last, rumbleGain(2));
  near(n.rumbleOsc.frequency.last, rumbleFreq(120));

  // smoothing: every value goes through setTargetAtTime(value, ctx.currentTime, 0.05)
  const call = n.osc[0].frequency.targets.at(-1);
  assert.equal(call.t, 3.25);
  assert.equal(call.tc, 0.05);

  // a second update with different telemetry overwrites the targets
  engine.update({ ...STATE, rpm: 7600, throttle: 0, boost: 0, combinedSlip: 0.2, rumbleBits: 0 }, 10.1);
  near(n.osc[0].frequency.last, engineFreq(7600, 6));
  near(n.engineGain.gain.last, engineGain(0, 7600 / 8000, 1));
  assert.equal(n.turboGain.gain.last, 0);
  assert.equal(n.squealGain.gain.last, 0);
  assert.equal(n.rumbleGain.gain.last, 0);
});

test('engine falls silent when rpm is zero (menus / pause)', async () => {
  const { engine } = makeEngine();
  await engine.start();
  engine.update({ ...STATE, rpm: 0, throttle: 0 }, 1);
  assert.equal(engine.nodes.engineGain.gain.last, 0);
  assert.equal(engine.nodes.osc[0].frequency.last, 20);
});

test('update() without maxRpm or cylinders still produces sane values', async () => {
  const { engine } = makeEngine();
  await engine.start();
  engine.update({ rpm: 3000, throttle: 50 }, 1);
  const n = engine.nodes;
  near(n.osc[0].frequency.last, engineFreq(3000, 4));
  near(n.lowpass.frequency.last, engineCutoff(0, 0.5));
});

test('update() ignores garbage and never passes a non-finite value to an AudioParam', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  for (const bad of [null, undefined, 5, 'x', [], {}]) engine.update(bad, 1);
  engine.update({ rpm: NaN, maxRpm: NaN, throttle: NaN, boost: Infinity, combinedSlip: -Infinity,
    speedKmh: NaN, cylinders: NaN, rumbleBits: NaN, gear: NaN }, NaN);
  engine.update({ rpm: 'fast', throttle: '50' }, undefined);
  for (const node of made[0].nodes) {
    for (const p of [node.gain, node.frequency, node.Q]) {
      if (!p) continue;
      for (const c of p.calls) assert.ok(Number.isFinite(c.v), `finite ${c.fn} value ${c.v}`);
    }
  }
  assert.deepEqual(engine.errors, []);
});

test('disabling features zeroes their gains and stops update() raising them', async () => {
  const { engine } = makeEngine();
  await engine.start();
  const n = engine.nodes;
  engine.update(STATE, 1);
  assert.ok(n.engineGain.gain.last > 0 && n.turboGain.gain.last > 0 && n.squealGain.gain.last > 0 && n.rumbleGain.gain.last > 0);

  engine.setEnabled({ engine: false });
  assert.equal(n.engineGain.gain.last, 0);
  assert.ok(n.turboGain.gain.last > 0, 'other features untouched');
  engine.update(STATE, 1.1);
  assert.equal(n.engineGain.gain.last, 0, 'update does not revive a disabled feature');

  engine.setEnabled({ turbo: false, squeal: false, rumble: false });
  assert.equal(n.turboGain.gain.last, 0);
  assert.equal(n.squealGain.gain.last, 0);
  assert.equal(n.rumbleGain.gain.last, 0);
  engine.update(STATE, 1.2);
  for (const g of [n.engineGain, n.turboGain, n.squealGain, n.rumbleGain]) assert.equal(g.gain.last, 0);

  engine.setEnabled({ engine: true });
  engine.update(STATE, 1.3);
  assert.ok(n.engineGain.gain.last > 0, 'engine back');
  assert.equal(n.turboGain.gain.last, 0, 'still-disabled features stay off');
});

test('setEnabled is tolerant: partial objects, junk, and calls before start()', async () => {
  const { engine } = makeEngine();
  engine.setEnabled({ engine: false });
  engine.setEnabled(null);
  engine.setEnabled('nope');
  engine.setEnabled({ unknown: true });
  assert.equal(engine.enabled.engine, false);
  assert.equal(engine.enabled.turbo, true);
  await engine.start();
  engine.update(STATE, 1);
  assert.equal(engine.nodes.engineGain.gain.last, undefined, 'never driven while disabled');
  assert.ok(engine.nodes.turboGain.gain.last > 0);
});

test('a gear change briefly dips the engine gain', async () => {
  const { engine } = makeEngine();
  await engine.start();
  const g = engine.nodes.engineGain.gain;
  const base = engineGain(0.8, 0.75, 1);
  engine.update({ ...STATE, gear: 3 }, 10);
  near(g.last, base);                                   // first sample: no previous gear, no dip
  engine.update({ ...STATE, gear: 4 }, 10.02);
  near(g.last, base * 0.55);
  engine.update({ ...STATE, gear: 4 }, 10.05);
  near(g.last, base * 0.55);                            // still inside the 90 ms window
  engine.update({ ...STATE, gear: 4 }, 10.2);
  near(g.last, base);                                   // recovered
  engine.update({ ...STATE, gear: 4 }, 10.3);
  near(g.last, base);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a missing node type disables only the features that need it', async () => {
  const { engine } = makeEngine({ createContext: () => {
    const c = new FakeAudioContext();
    c.createBiquadFilter = undefined;                    // no filters at all
    return c;
  } });
  assert.equal(await engine.start(), true);
  const feats = engine.errors.map((e) => e.feature).sort();
  assert.deepEqual(feats, ['engine', 'rumble', 'squeal', 'turbo']);
  for (const e of engine.errors) assert.match(e.message, /createBiquadFilter/);
  assert.equal(engine.available.engine, false);
  assert.equal(engine.available.beep, true);
  assert.equal(engine.available.blowOff, false, 'blow-off needs a filter');
  engine.update(STATE, 1);                               // must not throw
  assert.equal(engine.beep(1), true, 'beep only needs oscillator + gain');
  assert.equal(engine.blowOff(1), false);
});

test('a missing createBuffer disables noise features but keeps tonal ones', async () => {
  const { engine } = makeEngine({ createContext: () => {
    const c = new FakeAudioContext();
    c.createBuffer = undefined;
    return c;
  } });
  assert.equal(await engine.start(), true);
  const feats = engine.errors.map((e) => e.feature).sort();
  assert.deepEqual(feats, ['noise', 'squeal', 'turbo']);
  assert.equal(engine.available.engine, true);
  assert.equal(engine.available.rumble, true);
  assert.equal(engine.available.turbo, false);
  assert.equal(engine.available.blowOff, false);
  engine.update(STATE, 1);
  assert.ok(engine.nodes.engineGain.gain.last > 0);
});

test('a source that throws on start() disables that feature and records the reason', async () => {
  const { engine } = makeEngine({ createContext: () => {
    const c = new FakeAudioContext();
    const orig = c.createBufferSource.bind(c);
    c.createBufferSource = () => { const s = orig(); s.start = () => { throw new Error('boom'); }; return s; };
    return c;
  } });
  await engine.start();
  assert.deepEqual(engine.errors.map((e) => e.feature).sort(), ['squeal', 'turbo']);
  assert.ok(engine.errors.every((e) => e.message === 'boom'));
  assert.equal(engine.available.turbo, false);
  assert.equal(engine.available.engine, true);
});

test('a runtime exception while updating disables just that feature', async () => {
  const { engine } = makeEngine();
  await engine.start();
  engine.nodes.turboGain.gain.setTargetAtTime = () => { throw new Error('param exploded'); };
  engine.update(STATE, 1);
  assert.equal(engine.available.turbo, false);
  assert.deepEqual(engine.errors, [{ feature: 'turbo', message: 'param exploded' }]);
  assert.ok(engine.nodes.engineGain.gain.last > 0, 'engine unaffected');
  engine.update(STATE, 1.1);                             // does not keep retrying the broken feature
  assert.equal(engine.errors.length, 1);
});

test('start() reports failure when the context cannot be created, and can be retried', async () => {
  let attempts = 0;
  const engine = new SoundEngine({
    createContext: () => { attempts++; if (attempts === 1) throw new Error('no audio device'); return new FakeAudioContext(); },
    delay: instantDelay,
  });
  assert.equal(await engine.start(), false);
  assert.deepEqual(engine.errors, [{ feature: 'context', message: 'no audio device' }]);
  assert.equal(engine.running, false);
  engine.update(STATE, 1);
  assert.equal(await engine.start(), true);
  assert.equal(engine.running, true);
  assert.deepEqual(engine.errors, [], 'a clean rebuild clears the stale error');
});

test('start() reports failure when resume() is rejected, and retries on the same context', async () => {
  const ctx = new FakeAudioContext();
  let fail = true;
  ctx.resume = async function () { if (fail) throw new Error('autoplay blocked'); this.state = 'running'; };
  const engine = new SoundEngine({ createContext: () => ctx, delay: instantDelay });
  assert.equal(await engine.start(), false);
  assert.equal(engine.nodes, null);
  fail = false;
  assert.equal(await engine.start(), true);
  assert.equal(ctx.of('osc').length, 4);
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test('stop() fades to zero, suspends, and makes update a no-op; start() resumes', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  const ctx = made[0];
  const n = engine.nodes;
  engine.update(STATE, 1);
  await engine.stop();
  for (const g of [n.engineGain, n.turboGain, n.squealGain, n.rumbleGain, n.master]) assert.equal(g.gain.last, 0);
  assert.equal(ctx.suspendCalls, 1);
  assert.equal(ctx.closeCalls, 0);
  assert.equal(engine.running, false);
  const before = n.osc[0].frequency.calls.length;
  engine.update(STATE, 2);
  assert.equal(n.osc[0].frequency.calls.length, before, 'no-op while stopped');
  assert.equal(engine.beep(2), false);
  assert.equal(engine.blowOff(2), false);

  assert.equal(await engine.start(), true);
  assert.equal(made.length, 1, 'same context and graph reused');
  assert.equal(ctx.of('osc').length, 4);
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(n.master.gain.last, 0.6, 'master restored');
  engine.update(STATE, 3);
  assert.ok(n.engineGain.gain.last > 0);
});

test('stop({close:true}) closes the context and a later start() rebuilds', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  await engine.stop({ close: true });
  assert.equal(made[0].closeCalls, 1);
  assert.equal(engine.ctx, null);
  assert.equal(await engine.start(), true);
  assert.equal(made.length, 2);
  assert.equal(made[1].of('osc').length, 4);
});

test('stop() before start() and double stop() are harmless', async () => {
  const { engine, made } = makeEngine();
  await engine.stop();
  await engine.start();
  await engine.stop();
  await engine.stop();
  assert.equal(made[0].suspendCalls, 2);
});

test('stop() while start() is still resuming wins', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { engine, made } = makeEngine({}, { resumeGate: gate });
  const starting = engine.start();
  const stopping = engine.stop();
  release();
  assert.equal(await starting, false);
  await stopping;
  assert.equal(engine.running, false);
  assert.equal(made[0].nodes.length, 0, 'no graph built for a cancelled start');
});

test('start() during the fade-out of stop() keeps the engine running', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { engine, made } = makeEngine({ delay: () => gate });
  await engine.start();
  const stopping = engine.stop();
  assert.equal(await engine.start(), true);
  release();
  await stopping;
  assert.equal(made[0].suspendCalls, 0, 'not suspended because we restarted');
  assert.equal(engine.running, true);
});

// ---------------------------------------------------------------------------
// beep / blowOff
// ---------------------------------------------------------------------------

test('beep() plays an 80 ms 1.2 kHz sine blip through the master', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  const ctx = made[0];
  ctx.currentTime = 5;
  const before = ctx.of('osc').length;
  assert.equal(engine.beep(100), true);
  const osc = ctx.of('osc').at(-1);
  assert.equal(ctx.of('osc').length, before + 1);
  assert.equal(osc.type, 'sine');
  assert.equal(osc.frequency.value, 1200);
  const g = osc.connections[0];
  assert.deepEqual(g.connections, [engine.nodes.master]);
  assert.deepEqual(osc.startCalls, [[5]]);
  near(osc.stopCalls[0][0], 5.09);
  const env = g.gain.calls;
  assert.equal(env[0].fn, 'setValueAtTime');
  assert.ok(env.some((c) => c.fn === 'linearRampToValueAtTime' && c.v > 0.1 && c.t < 5.02), 'quick attack');
  assert.ok(env.some((c) => c.fn === 'exponentialRampToValueAtTime' && c.v < 0.01 && Math.abs(c.t - 5.08) < 1e-9), '80 ms decay');
  osc.onended();
  assert.equal(osc.disconnects, 1);
  assert.equal(g.disconnects, 1);
});

test('beep() is rate limited to one per 0.25 s', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  const count = () => made[0].of('osc').length;
  const base = count();
  assert.equal(engine.beep(1.0), true);
  assert.equal(engine.beep(1.1), false);
  assert.equal(engine.beep(1.249), false);
  assert.equal(engine.beep(1.25), true);
  assert.equal(engine.beep(1.3), false);
  assert.equal(engine.beep(2.0), true);
  assert.equal(count(), base + 3);
  assert.equal(engine.beep(0.5), true, 'clock went backwards: allowed again');
  assert.equal(engine.beep(0.6), false);
});

test('beep() falls back to ctx.currentTime and respects setEnabled({beep:false})', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  made[0].currentTime = 10;
  assert.equal(engine.beep(), true);
  made[0].currentTime = 10.1;
  assert.equal(engine.beep(), false);
  made[0].currentTime = 10.3;
  engine.setEnabled({ beep: false });
  assert.equal(engine.beep(), false);
  engine.setEnabled({ beep: true });
  assert.equal(engine.beep(), true);
});

test('beep() that throws is swallowed and disables itself', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  made[0].createOscillator = () => { throw new Error('no osc'); };
  assert.equal(engine.beep(1), false);
  assert.deepEqual(engine.errors, [{ feature: 'beep', message: 'no osc' }]);
  assert.equal(engine.beep(5), false);
  assert.equal(engine.errors.length, 1);
});

test('blowOff() emits a ~200 ms filtered noise burst and is rate limited', async () => {
  const { engine, made } = makeEngine();
  await engine.start();
  const ctx = made[0];
  ctx.currentTime = 2;
  const sources = ctx.of('source').length;
  assert.equal(engine.blowOff(50), true);
  const src = ctx.of('source').at(-1);
  assert.equal(ctx.of('source').length, sources + 1);
  assert.equal(src.buffer, engine.nodes.noise);
  assert.equal(src.loop, false);
  const bp = src.connections[0];
  assert.equal(bp.type, 'bandpass');
  const g = bp.connections[0];
  assert.deepEqual(g.connections, [engine.nodes.master]);
  assert.equal(src.startCalls[0][0], 2);
  const dur = src.stopCalls[0][0] - 2;
  assert.ok(dur > 0.18 && dur < 0.26, `burst length ${dur}`);
  assert.ok(src.startCalls[0][1] + dur <= engine.nodes.noise.duration, 'offset stays inside the buffer');
  src.onended();
  assert.equal(src.disconnects, 1);

  assert.equal(engine.blowOff(50.1), false);
  assert.equal(engine.blowOff(50.35), true);
  assert.notEqual(ctx.of('source').at(-1).startCalls[0][1], src.startCalls[0][1], 'varied noise offset');
  engine.setEnabled({ blowOff: false });
  assert.equal(engine.blowOff(60), false);
});

// ---------------------------------------------------------------------------
// BlowOffDetector
// ---------------------------------------------------------------------------

test('BlowOffDetector fires on a fast lift under boost', () => {
  const d = new BlowOffDetector();
  assert.equal(d.update(100, 1.2, 0), false);
  assert.equal(d.update(90, 1.2, 0.05), false);
  assert.equal(d.update(40, 1.1, 0.1), false);
  assert.equal(d.update(10, 1.0, 0.15), true);
});

test('BlowOffDetector needs the drop to complete within 0.25 s', () => {
  const d = new BlowOffDetector();
  d.update(100, 1.2, 0);
  d.update(50, 1.2, 0.2);
  assert.equal(d.update(5, 1.2, 0.26), false, 'last high sample was 0.26 s ago');
  const e = new BlowOffDetector();
  e.update(100, 1.2, 0);
  assert.equal(e.update(5, 1.2, 0.25), true, 'exactly 0.25 s still counts');
});

test('BlowOffDetector needs boost above 0.5 bar', () => {
  const d = new BlowOffDetector();
  d.update(100, 0.5, 0);
  assert.equal(d.update(0, 0.5, 0.1), false);
  d.update(100, 0.51, 1);
  assert.equal(d.update(0, 0.51, 1.1), true);
  const e = new BlowOffDetector();
  e.update(100, -0.4, 0);
  assert.equal(e.update(0, -0.4, 0.1), false);
});

test('BlowOffDetector thresholds are strict: > 60 start, < 15 end', () => {
  const d = new BlowOffDetector();
  d.update(60, 1, 0);
  assert.equal(d.update(0, 1, 0.1), false, '60 is not high enough');
  d.update(61, 1, 1);
  assert.equal(d.update(15, 1, 1.1), false, '15 is not low enough');
  assert.equal(d.update(14.9, 1, 1.12), true);
});

test('BlowOffDetector ignores a lift that did not start from a high throttle', () => {
  const d = new BlowOffDetector();
  d.update(50, 1, 0);
  d.update(30, 1, 0.05);
  assert.equal(d.update(0, 1, 0.1), false);
  assert.equal(new BlowOffDetector().update(0, 1, 5), false, 'idle with boost and nothing before');
});

test('BlowOffDetector fires once per lift, with a 1 s refractory period', () => {
  const d = new BlowOffDetector();
  d.update(100, 1, 0);
  assert.equal(d.update(0, 1, 0.1), true);
  assert.equal(d.update(0, 1, 0.12), false, 'staying off the throttle does not re-fire');
  d.update(100, 1, 0.3);
  assert.equal(d.update(0, 1, 0.4), false, 'second lift inside the 1 s refractory period');
  d.update(100, 1, 1.0);
  assert.equal(d.update(0, 1, 1.09), false, 'still < 1 s after the first blow-off (fired at 0.1)');
  d.update(100, 1, 1.15);
  assert.equal(d.update(0, 1, 1.2), true, 're-armed');
  d.update(100, 1, 2.3);
  assert.equal(d.update(0, 1, 2.35), true, 'and again');
});

test('BlowOffDetector survives garbage, backwards clocks and reset()', () => {
  const d = new BlowOffDetector();
  for (const args of [[NaN, 1, 0], [100, NaN, 0], [100, 1, NaN], [undefined, undefined, undefined], ['100', 1, 0]]) {
    assert.equal(d.update(...args), false);
  }
  d.update(100, 1, 50);
  assert.equal(d.update(0, 1, 10), false, 'clock restarted: stale peak forgotten');
  d.update(100, 1, 10.5);
  assert.equal(d.update(0, 1, 10.6), true);
  d.reset();
  d.update(100, 1, 10.65);
  assert.equal(d.update(0, 1, 10.7), true, 'reset clears the refractory period');
});
