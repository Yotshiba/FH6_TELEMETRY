import test from 'node:test';
import assert from 'node:assert/strict';
import { PerfMeter, MPH60_KMH, QUARTER_MILE_M } from '../../fh6_telemetry/web/static/perf.js';

const KEYS = [
  'IsRaceOn', 'CurrentEngineRpm', 'EngineMaxRpm', 'SpeedKmh', 'PowerHp', 'Torque', 'BoostBar', 'FuelPct', 'Gear',
  'AccelPct', 'BrakePct', 'ClutchPct', 'HandBrakePct', 'SteerPct',
  'TireTempFL', 'TireTempFR', 'TireTempRL', 'TireTempRR',
  'SuspNormFL', 'SuspNormFR', 'SuspNormRL', 'SuspNormRR',
  'TimestampMS', 'AccelGX', 'AccelGZ', 'SideslipDeg', 'Pitch', 'Roll', 'Yaw', 'PositionX', 'PositionZ',
];
const F = Object.fromEntries(KEYS.map((k, i) => [k, i]));
const row = (o) => {
  const r = new Array(KEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[F[k]] = v;
  return r;
};

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +- ${tol}, got ${a}`);

/** Feeds rows with a running game clock and collects every event. */
class Driver {
  constructor(opts) {
    this.m = new PerfMeter({ F }, opts);
    this.ts = 100000;
    this.events = [];
  }
  /** One row `dt` ms after the previous one. */
  step(speed, extra = {}, dt = 13) {
    this.ts += dt;
    this.m.feed(row({ IsRaceOn: 1, SpeedKmh: speed, TimestampMS: this.ts, ...extra }));
    this.events.push(...this.m.drain());
  }
  /** Stand still for `ms` milliseconds in 10 ms rows. */
  stand(ms, speed = 0) {
    for (let t = 0; t < ms; t += 10) this.step(speed, {}, 10);
  }
  /** Constant acceleration `a` m/s2 from a standstill, 13 ms rows, until `kmh` is reached. Returns row count. */
  accel(a, kmh) {
    let n = 0;
    for (;;) {
      n++;
      const v = a * (n * 0.013) * 3.6;
      this.step(v, { AccelPct: 100 });
      if (v >= kmh) return n;
    }
  }
  /** Constant braking `b` m/s2 from `v0` km/h down to a standstill, brake pedal at `pct`. */
  brake(v0, b, pct = 100, extra = {}) {
    for (let n = 1; ; n++) {
      const v = v0 - b * (n * 0.013) * 3.6;
      if (v <= 0) { this.step(0, { BrakePct: pct, ...extra }); return; }
      this.step(v, { BrakePct: pct, ...extra });
    }
  }
  types() { return this.events.map((e) => e.type); }
}

// ---- arming -------------------------------------------------------------------------------------------------

test('arms after 0.4 s below 1.5 km/h and not before', () => {
  const d = new Driver();
  d.step(0, {}, 10);                        // first stopped row starts the streak
  assert.equal(d.m.state.phase, 'idle');
  for (let i = 0; i < 39; i++) d.step(0, {}, 10);   // 390 ms
  assert.equal(d.m.state.phase, 'idle');
  d.step(0, {}, 10);                        // 400 ms
  assert.equal(d.m.state.phase, 'armed');
});

test('1.5 km/h is not stopped; 1.49 is', () => {
  const d = new Driver();
  d.stand(2000, 1.5);
  assert.equal(d.m.state.phase, 'idle');
  let k = 0;
  while (d.m.state.phase === 'idle' && k < 100) { d.step(1.49, {}, 10); k++; }
  assert.equal(d.m.state.phase, 'armed');
  assert.equal(k, 41);                       // streak starts on row 1, 400 ms later on row 41
});

test('a movement blip restarts the stopped streak', () => {
  const d = new Driver();
  d.stand(300);
  d.step(1.6, {}, 10);
  d.stand(300);
  assert.equal(d.m.state.phase, 'idle');
  d.stand(200);
  assert.equal(d.m.state.phase, 'armed');
});

test('driving at speed never arms', () => {
  const d = new Driver();
  d.stand(3000, 80);
  assert.equal(d.m.state.phase, 'idle');
  assert.deepEqual(d.events, []);
});

// ---- standing start -----------------------------------------------------------------------------------------

test('constant acceleration gives interpolated 60 mph / 100 / 200 / 100-200 / quarter mile', () => {
  const d = new Driver();
  d.stand(500);
  assert.equal(d.m.state.phase, 'armed');
  const a = 8;
  d.accel(a, 330);
  const s = d.m.state;
  assert.equal(s.phase, 'running');

  // The clock starts on the first row above 1.0 km/h: n = 3 (a * 0.039 s * 3.6 = 1.12 km/h).
  const tStart = 3 * 0.013;
  const v0 = a * tStart;
  near(s.results.t60mph, MPH60_KMH / 3.6 / a - tStart, 1e-6, 't60mph');
  near(s.results.t100, 100 / 3.6 / a - tStart, 1e-6, 't100');
  near(s.results.t200, 200 / 3.6 / a - tStart, 1e-6, 't200');
  near(s.results.t100to200, 100 / 3.6 / a, 1e-6, 't100to200');
  const vq = Math.sqrt(v0 * v0 + 2 * a * QUARTER_MILE_M);
  near(s.results.qmile.time, (vq - v0) / a, 2e-4, 'qmile time');
  near(s.results.qmile.trapKmh, vq * 3.6, 0.05, 'trap speed');

  const types = d.types();
  assert.equal(types[0], 'perf_start');
  assert.deepEqual(d.events.filter((e) => e.type === 'perf').map((e) => e.key),
    ['t60mph', 't100', 't200', 't100to200', 'qmile']);
  assert.equal(types.filter((t) => t === 'perf_start').length, 1);
});

test('each result is set once per run and perf events carry the value', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 210);
  const perf = d.events.filter((e) => e.type === 'perf');
  assert.equal(perf.length, new Set(perf.map((e) => e.key)).size);
  for (const e of perf) assert.deepEqual(e.value, d.m.state.results[e.key]);
  const before = perf.length;
  // keep going: nothing may be re-emitted
  for (let i = 0; i < 100; i++) d.step(210 + i * 0.1);
  assert.equal(d.events.filter((e) => e.type === 'perf').length, before);
});

test('live state tracks time, speed, distance and peak while running', () => {
  const d = new Driver();
  d.stand(500);
  const n = d.accel(8, 50);
  const live = d.m.state.live;
  assert.equal(d.m.state.phase, 'running');
  near(live.t, (n - 3) * 0.013, 1e-9);
  near(live.speedKmh, 8 * n * 0.013 * 3.6, 1e-9);
  near(live.peakKmh, live.speedKmh, 1e-9);
  const v = live.speedKmh / 3.6;
  const v0 = 8 * 3 * 0.013;
  near(live.distM, (v * v - v0 * v0) / 16, 1e-6);
});

test('run starts exactly at the first row above 1.0 km/h with t = 0, distance 0', () => {
  const d = new Driver();
  d.stand(500);
  d.step(0.9);
  assert.equal(d.m.state.phase, 'armed');
  d.step(1.0);                       // not strictly above 1.0
  assert.equal(d.m.state.phase, 'armed');
  d.step(1.01);
  assert.equal(d.m.state.phase, 'running');
  assert.equal(d.m.state.live.t, 0);
  assert.equal(d.m.state.live.distM, 0);
  assert.deepEqual(d.events.map((e) => e.type), ['perf_start']);
});

test('run ends when speed falls 12 km/h below the peak; results stay', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 120);
  const peak = d.m.state.live.peakKmh;
  d.step(peak - 11.9);
  assert.equal(d.m.state.phase, 'running');
  d.step(peak - 12);
  assert.equal(d.m.state.phase, 'done');
  const end = d.events.find((e) => e.type === 'perf_end');
  assert.deepEqual(end, { type: 'perf_end', peakKmh: peak });
  assert.ok(d.m.state.results.t100 > 0);
  assert.equal(d.m.state.results.t200, null);
  // further rows do not change the finished run
  const t100 = d.m.state.results.t100;
  d.step(peak - 40);
  assert.equal(d.m.state.results.t100, t100);
  assert.equal(d.m.state.live.peakKmh, peak);
});

test('peak follows speed up; a drop is measured from the highest value', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 60);
  d.step(100);
  d.step(90);
  assert.equal(d.m.state.phase, 'running');
  d.step(87.9);
  assert.equal(d.m.state.phase, 'done');
  assert.equal(d.events.find((e) => e.type === 'perf_end').peakKmh, 100);
});

test('a run longer than 90 s ends', () => {
  const d = new Driver();
  d.stand(500);
  // 0.1 km/h per 200 ms row. The clock starts on the 11th row; t = 90.000 s is not yet over the limit.
  let n = 0;
  while (d.m.state.phase !== 'running') d.step(0.1 * ++n, {}, 200);
  for (let i = 0; i < 450; i++) d.step(0.1 * ++n, {}, 200);
  assert.equal(d.m.state.phase, 'running');
  near(d.m.state.live.t, 90, 1e-9);
  d.step(0.1 * ++n, {}, 200);
  assert.equal(d.m.state.phase, 'done');
  assert.equal(d.events.filter((e) => e.type === 'perf_end').length, 1);
});

test('after done the meter re-arms once stopped and a new run clears the old results', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 120);
  d.brake(120, 10);
  assert.equal(d.m.state.phase, 'done');
  assert.ok(d.m.state.results.t100 > 0);
  d.stand(300);
  assert.equal(d.m.state.phase, 'done');
  d.stand(200);
  assert.equal(d.m.state.phase, 'armed');
  assert.ok(d.m.state.results.t100 > 0, 'results survive re-arming');
  d.events.length = 0;
  d.step(2);
  assert.equal(d.m.state.phase, 'running');
  assert.equal(d.m.state.results.t100, null);
  assert.equal(d.m.state.results.t60mph, null);
  assert.equal(d.m.state.results.qmile, null);
  assert.deepEqual(d.types(), ['perf_start']);
});

test('slow creep that never launches is dropped as "creep" and re-arms', () => {
  const d = new Driver();
  d.stand(500);
  d.step(1.2);
  d.step(2);
  assert.equal(d.m.state.phase, 'running');
  d.step(0.5);
  assert.equal(d.m.state.phase, 'idle');
  assert.deepEqual(d.events.map((e) => (e.reason ? e.reason : e.type)), ['perf_start', 'creep']);
  d.stand(500, 0);
  assert.equal(d.m.state.phase, 'armed');
});

// ---- pauses, gaps, malformed input ---------------------------------------------------------------------------

test('IsRaceOn=0 aborts a running test and the next run starts clean', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 110);
  d.events.length = 0;
  d.m.feed(row({ IsRaceOn: 0, SpeedKmh: 110, TimestampMS: d.ts + 13 }));
  assert.equal(d.m.state.phase, 'idle');
  assert.deepEqual(d.m.drain(), [{ type: 'perf_abort', reason: 'paused' }]);
  assert.deepEqual(d.m.state.live, { t: 0, speedKmh: 0, distM: 0, peakKmh: 0 });
  // partial results measured before the abort are kept
  assert.ok(d.m.state.results.t100 > 0);
});

test('paused rows are ignored when idle and break arming continuity', () => {
  const d = new Driver();
  d.stand(300);
  d.m.feed(row({ IsRaceOn: 0, SpeedKmh: 0, TimestampMS: d.ts + 10 }));
  d.ts += 10;
  d.stand(300);
  assert.equal(d.m.state.phase, 'idle');
  d.stand(200);
  assert.equal(d.m.state.phase, 'armed');
});

test('pause while armed drops back to idle', () => {
  const d = new Driver();
  d.stand(500);
  assert.equal(d.m.state.phase, 'armed');
  d.m.feed(row({ IsRaceOn: 0 }));
  assert.equal(d.m.state.phase, 'idle');
});

test('paused rows do not integrate a gap into the run', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 60);
  d.m.feed(row({ IsRaceOn: 0 }));
  assert.deepEqual(d.m.drain(), [{ type: 'perf_abort', reason: 'paused' }]);
  d.events.length = 0;
  // resume at a high speed: nothing is armed, so no run and no crash
  d.step(60);
  d.step(70);
  assert.equal(d.m.state.phase, 'idle');
  assert.deepEqual(d.events, []);
});

for (const [name, dt] of [['gap over 250 ms', 251], ['timestamp going backwards', -5000]]) {
  test(`${name} aborts a running test`, () => {
    const d = new Driver();
    d.stand(500);
    d.accel(8, 110);
    d.events.length = 0;
    d.step(112, {}, dt);
    assert.deepEqual(d.events, [{ type: 'perf_abort', reason: 'gap' }]);
    assert.equal(d.m.state.phase, 'idle');
    // integration restarted: the aborted run does not leak into the next one
    d.stand(500);
    assert.equal(d.m.state.phase, 'armed');
    d.step(2);
    assert.equal(d.m.state.results.t100, null);
    assert.equal(d.m.state.live.t, 0);
  });
}

test('equal timestamps (quantised game clock) are a zero step, not a gap', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 30);
  d.events.length = 0;
  const t = d.m.state.live.t;
  const dist = d.m.state.live.distM;
  d.step(30.5, {}, 0);
  d.step(31, {}, 0);
  assert.deepEqual(d.events, []);
  assert.equal(d.m.state.phase, 'running');
  assert.equal(d.m.state.live.t, t);
  assert.equal(d.m.state.live.distM, dist);
  d.step(32, {}, 13);
  assert.ok(d.m.state.live.t > t);
});

test('an armed meter ignores a "launch" whose first moving row is already fast (teleport / respawn)', () => {
  const d = new Driver();
  d.stand(500);
  assert.equal(d.m.state.phase, 'armed');
  d.step(65);
  d.step(66);
  d.step(70);
  assert.equal(d.m.state.phase, 'idle');
  assert.deepEqual(d.events, []);
  assert.equal(d.m.state.results.t100, null);
  d.stand(500);                                    // stopping again re-arms normally
  assert.equal(d.m.state.phase, 'armed');
});

test('250 ms spacing is still valid', () => {
  const d = new Driver();
  d.stand(500);
  d.step(2);
  d.step(20, {}, 250);
  assert.equal(d.m.state.phase, 'running');
  near(d.m.state.live.t, 0.25, 1e-9);
});

test('a repeated timestamp while idle is simply skipped', () => {
  const d = new Driver();
  d.stand(300);
  d.step(0, {}, 0);
  d.stand(100);
  assert.equal(d.m.state.phase, 'idle');     // 390 ms of stillness so far: the duplicate added nothing
  d.stand(20);
  assert.equal(d.m.state.phase, 'armed');
});

test('malformed rows are ignored without throwing', () => {
  const d = new Driver();
  d.stand(500);
  for (const bad of [null, undefined, 5, 'x', [], [1], {}, row({ IsRaceOn: 1, SpeedKmh: NaN, TimestampMS: 5 }),
    row({ IsRaceOn: 1, SpeedKmh: 10, TimestampMS: NaN }), row({ IsRaceOn: NaN }), row({ IsRaceOn: 1, SpeedKmh: -4, TimestampMS: 9 })]) {
    assert.doesNotThrow(() => d.m.feed(bad));
  }
  assert.equal(d.m.state.phase, 'armed');
  assert.deepEqual(d.m.drain(), []);
});

test('a meter built with missing columns never throws and stays idle', () => {
  const m = new PerfMeter({ F: { IsRaceOn: 0 } });
  assert.doesNotThrow(() => m.feed([1, 2, 3]));
  assert.equal(m.state.phase, 'idle');
  const m2 = new PerfMeter(undefined);
  assert.doesNotThrow(() => m2.feed(row({ IsRaceOn: 1 })));
  assert.equal(m2.state.phase, 'idle');
});

test('without a BrakePct column the acceleration side still works and braking never starts', () => {
  const F2 = { ...F };
  delete F2.BrakePct;
  const m = new PerfMeter({ F: F2 });
  let ts = 0;
  const feed = (v) => { ts += 13; m.feed(row({ IsRaceOn: 1, SpeedKmh: v, TimestampMS: ts, BrakePct: 100 })); };
  for (let i = 0; i < 60; i++) feed(0);
  feed(5);
  assert.equal(m.state.phase, 'running');
  for (let v = 120; v > 0; v -= 5) feed(v);
  assert.equal(m.state.results.brake100, null);
});

test('state is a snapshot: mutating it does not affect the meter', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 110);
  const s = d.m.state;
  s.results.t100 = 99;
  s.live.t = 99;
  s.phase = 'x';
  assert.notEqual(d.m.state.results.t100, 99);
  assert.notEqual(d.m.state.live.t, 99);
  assert.equal(d.m.state.phase, 'running');
});

test('drain returns the queue and clears it; reset clears everything', () => {
  const d = new Driver();
  d.stand(500);
  d.step(5);
  assert.deepEqual(d.m.drain(), []);        // Driver.step already drained
  d.m.feed(row({ IsRaceOn: 1, SpeedKmh: 0, TimestampMS: d.ts + 50 }));
  d.m.feed(row({ IsRaceOn: 0 }));
  assert.equal(d.m.drain().length, 1);
  assert.deepEqual(d.m.drain(), []);

  d.stand(500);
  d.accel(8, 110);
  d.m.reset();
  assert.equal(d.m.state.phase, 'idle');
  assert.equal(d.m.state.results.t100, null);
  assert.deepEqual(d.m.drain(), []);
});

test('the event queue is capped', () => {
  const m = new PerfMeter({ F }, { maxEvents: 5 });
  let ts = 0;
  for (let k = 0; k < 20; k++) {
    for (let i = 0; i < 50; i++) m.feed(row({ IsRaceOn: 1, SpeedKmh: 0, TimestampMS: (ts += 10) }));
    m.feed(row({ IsRaceOn: 1, SpeedKmh: 3, TimestampMS: (ts += 10) }));
    m.feed(row({ IsRaceOn: 1, SpeedKmh: 0.2, TimestampMS: (ts += 10) }));   // creep abort
  }
  const ev = m.drain();
  assert.equal(ev.length, 5);
  assert.equal(m.state.phase, 'idle');
});

// ---- braking ------------------------------------------------------------------------------------------------

test('braking from 150 km/h measures 100 km/h and 60 mph stopping distance and time', () => {
  const d = new Driver();
  d.stand(100, 150);
  d.brake(150, 10);
  const r = d.m.state.results;
  const stop = (v0Kmh) => {
    const v = v0Kmh / 3.6;
    const vs = 1.0 / 3.6;
    return { dist: (v * v - vs * vs) / 20, time: (v - vs) / 10 };
  };
  near(r.brake100.dist, stop(100).dist, 2e-3, 'brake100 dist');
  near(r.brake100.time, stop(100).time, 2e-3, 'brake100 time');
  near(r.brake60mph.dist, stop(MPH60_KMH).dist, 2e-3, 'brake60 dist');
  near(r.brake60mph.time, stop(MPH60_KMH).time, 2e-3, 'brake60 time');
  const perf = d.events.filter((e) => e.type === 'perf');
  assert.deepEqual(perf.map((e) => e.key), ['brake100', 'brake60mph']);
  assert.deepEqual(perf[0].value, r.brake100);
  assert.deepEqual(d.m.state.brake, { active: false, distM: 0, timeS: 0, target: null });
});

test('live braking state grows while active and targets the oldest measurement', () => {
  const d = new Driver();
  d.stand(100, 150);
  let prev = 0;
  let seen = false;
  for (let n = 1; ; n++) {
    const v = 150 - 10 * 3.6 * n * 0.013;
    if (v < 40) break;
    d.step(v, { BrakePct: 90 });
    const b = d.m.state.brake;
    if (v < 100) {
      seen = true;
      assert.equal(b.active, true);
      assert.equal(b.target, 'brake100');
      assert.ok(b.distM >= prev);
      prev = b.distM;
    } else {
      assert.equal(b.active, false);
    }
  }
  assert.ok(seen);
  assert.ok(prev > 5);
});

test('the braking measurement does not start with a light pedal at the crossing', () => {
  const d = new Driver();
  d.stand(100, 150);
  d.brake(150, 10, 39.9);
  assert.equal(d.m.state.results.brake100, null);
  assert.equal(d.m.state.results.brake60mph, null);
  assert.deepEqual(d.events, []);
});

test('pedal exactly 40 starts the measurement', () => {
  const d = new Driver();
  d.stand(100, 150);
  d.brake(150, 10, 40);
  assert.ok(d.m.state.results.brake100);
});

test('a braking test must start from a downward crossing, not from standing below 100', () => {
  const d = new Driver();
  d.stand(100, 99);
  d.stand(100, 50);
  d.brake(50, 10, 100);
  assert.equal(d.m.state.results.brake100, null);
});

test('releasing the pedal for more than 0.8 s cancels the braking test', () => {
  const d = new Driver();
  d.stand(100, 150);
  let n = 0;
  const v = () => 150 - 10 * 3.6 * (++n) * 0.013;
  while (d.m.state.brake.active === false) d.step(v(), { BrakePct: 100 });
  d.events.length = 0;
  // 0.8 s exactly is tolerated, more is not
  let cancelled = null;
  for (let i = 0; i < 100 && !cancelled; i++) {
    d.step(v(), { BrakePct: 5 });
    cancelled = d.events.find((e) => e.reason === 'brake-cancel');
  }
  assert.ok(cancelled);
  assert.equal(cancelled.cause, 'no-brake');
  assert.ok(cancelled.test === 'brake100' || cancelled.test === 'brake60mph');
  assert.equal(d.m.state.brake.active, false);
  assert.equal(d.m.state.results.brake100, null);
});

test('a short release does not cancel and the test still completes', () => {
  const d = new Driver();
  d.stand(100, 150);
  let n = 0;
  const v = () => 150 - 10 * 3.6 * (++n) * 0.013;
  while (d.m.state.brake.active === false) d.step(v(), { BrakePct: 100 });
  for (let i = 0; i < 30; i++) d.step(v(), { BrakePct: 0 });       // 390 ms
  for (let i = 0; i < 20; i++) d.step(v(), { BrakePct: 100 });
  for (let i = 0; i < 40; i++) d.step(v(), { BrakePct: 5 });       // 520 ms
  while (true) {
    const x = v();
    if (x <= 0) { d.step(0, { BrakePct: 100 }); break; }
    d.step(x, { BrakePct: 100 });
  }
  assert.ok(d.m.state.results.brake100);
  assert.equal(d.events.filter((e) => e.reason === 'brake-cancel').length, 0);
});

test('braking low-pedal timing: more than 0.8 s, measured in game time', () => {
  const d = new Driver();
  d.stand(100, 150);
  let n = 0;
  const v = () => 150 - 5 * 3.6 * (++n) * 0.013;
  while (d.m.state.brake.active === false) d.step(v(), { BrakePct: 100 });
  d.events.length = 0;
  d.step(v(), { BrakePct: 0 }, 100);            // streak starts at this row
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);
  d.step(v(), { BrakePct: 0 }, 100);            // 700 ms into the streak
  assert.equal(d.events.length, 0);
  d.step(v(), { BrakePct: 0 }, 100);            // 800 ms: not "more than"
  assert.equal(d.events.length, 0);
  d.step(v(), { BrakePct: 0 }, 100);            // 900 ms
  // the 60 mph test never started: the pedal was already released at its crossing
  const c = d.events.filter((e) => e.reason === 'brake-cancel');
  assert.deepEqual(c.map((e) => e.test), ['brake100']);
});

test('speed rising more than 3 km/h above the minimum cancels the braking test', () => {
  const d = new Driver();
  d.stand(100, 150);
  d.brake(150, 10, 100, {});                    // finishes: results exist
  const first = d.m.state.results.brake100;
  assert.ok(first);

  const e = new Driver();
  e.stand(100, 150);
  let v = 150;
  while (v > 60) { v -= 0.4; e.step(v, { BrakePct: 100 }); }
  assert.equal(e.m.state.brake.active, true);
  e.events.length = 0;
  e.step(v + 2.9, { BrakePct: 100 });
  assert.equal(e.m.state.brake.active, true);
  e.step(v + 3.01, { BrakePct: 100 });
  const c = e.events.filter((x) => x.reason === 'brake-cancel');
  assert.equal(c.length, 2);
  assert.ok(c.every((x) => x.cause === 'speed-rise'));
  assert.equal(e.m.state.brake.active, false);
  // can start again after a new downward crossing
  e.step(120, { BrakePct: 100 });
  for (let x = 119; x > 0; x -= 1) e.step(x, { BrakePct: 100 });
  e.step(0, { BrakePct: 100 });
  assert.ok(e.m.state.results.brake100);
});

test('a time gap or pause cancels the braking test, it completes only for continuous data', () => {
  for (const mode of ['gap', 'paused']) {
    const d = new Driver();
    d.stand(100, 150);
    let v = 150;
    while (v > 80) { v -= 0.4; d.step(v, { BrakePct: 100 }); }
    assert.equal(d.m.state.brake.active, true);
    d.events.length = 0;
    if (mode === 'gap') d.step(v - 1, { BrakePct: 100 }, 400);
    else { d.m.feed(row({ IsRaceOn: 0 })); d.events.push(...d.m.drain()); }
    const c = d.events.filter((x) => x.reason === 'brake-cancel');
    assert.equal(c.length, 2, mode);
    assert.ok(c.every((x) => x.cause === mode));
    assert.equal(d.m.state.results.brake100, null);
  }
});

test('braking right after a standing-start run: both tests are independent', () => {
  const d = new Driver();
  d.stand(500);
  d.accel(8, 150);
  d.brake(150, 10);
  const r = d.m.state.results;
  assert.ok(r.t100 > 0);
  assert.ok(r.brake100.dist > 30);
  assert.ok(r.brake60mph.dist > 30);
  assert.equal(d.m.state.phase, 'done');
  assert.equal(d.events.filter((e) => e.type === 'perf_end').length, 1);
});

test('a new braking test replaces the earlier result; a new run does not clear braking results', () => {
  const d = new Driver();
  d.stand(100, 150);
  d.brake(150, 10);
  const first = d.m.state.results.brake100;
  d.stand(500);
  d.accel(8, 120);
  assert.deepEqual(d.m.state.results.brake100, first);
  d.brake(120, 7);
  const second = d.m.state.results.brake100;
  assert.ok(second.dist > first.dist);
});

test('one big row that straddles several thresholds sets them in order', () => {
  const d = new Driver();
  d.stand(500);
  d.step(2);
  d.step(120, {}, 100);
  d.step(220, {}, 100);
  const keys = d.events.filter((e) => e.type === 'perf').map((e) => e.key);
  assert.deepEqual(keys, ['t60mph', 't100', 't200', 't100to200']);
  const r = d.m.state.results;
  assert.ok(r.t60mph < r.t100 && r.t100 < r.t200);
  near(r.t100to200, r.t200 - r.t100, 1e-12);
});
