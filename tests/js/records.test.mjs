import test from 'node:test';
import assert from 'node:assert/strict';
import { Records, GTrail, SPEED_MILESTONES } from '../../fh6_telemetry/web/static/records.js';

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

/** Feeds race-on rows on a running game clock. */
class Driver {
  constructor(Cls = Records, opts) {
    this.t = new Cls({ F }, opts);
    this.ts = 5000;
    this.events = [];
  }
  step(o = {}, dt = 13) {
    this.ts += dt;
    this.t.feed(row({ IsRaceOn: 1, TimestampMS: this.ts, ...o }));
    if (this.t.drain) this.events.push(...this.t.drain());
  }
  ofType(type) { return this.events.filter((e) => e.type === type); }
}

// ---- Records: maxima ------------------------------------------------------------------------------------------

test('tracks the maxima of every field, from race-on rows only', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 120, CurrentEngineRpm: 6000, EngineMaxRpm: 8000, AccelGX: -1.4, AccelGZ: 0.5, PowerHp: 300, BoostBar: 1.2 });
  d.step({ SpeedKmh: 180, CurrentEngineRpm: 7000, EngineMaxRpm: 8000, AccelGX: 0.9, AccelGZ: -1.8, PowerHp: 450, BoostBar: 0.8 });
  d.step({ SpeedKmh: 160, CurrentEngineRpm: 5000, EngineMaxRpm: 8000, AccelGX: 0.1, AccelGZ: 1.1, PowerHp: 200, BoostBar: -0.4 });
  // paused rows with huge values must not count
  d.t.feed(row({ IsRaceOn: 0, TimestampMS: d.ts + 13, SpeedKmh: 999, CurrentEngineRpm: 99999, AccelGX: 9, AccelGZ: 9, PowerHp: 9999 }));
  const s = d.t.state;
  assert.equal(s.topSpeedKmh, 180);
  assert.equal(s.maxRpm, 7000);
  assert.equal(s.maxLatG, 1.4);
  assert.equal(s.maxBrakeG, 1.8);
  assert.equal(s.maxAccelG, 1.1);
  assert.equal(s.maxPowerHp, 450);
  assert.equal(s.maxBoostBar, 1.2);
});

test('starts at zero and brake/accel g never go negative', () => {
  const d = new Driver();
  assert.deepEqual(d.t.state, {
    topSpeedKmh: 0, maxRpm: 0, maxLatG: 0, maxBrakeG: 0, maxAccelG: 0, maxPowerHp: 0, maxBoostBar: 0, odometerM: 0, driveTimeS: 0,
  });
  d.step({ AccelGZ: 0.7 });
  d.step({ AccelGZ: 0.2 });
  assert.equal(d.t.state.maxBrakeG, 0);
  assert.equal(d.t.state.maxAccelG, 0.7);
  d.t.reset();
  d.step({ AccelGZ: -0.9 });
  assert.equal(d.t.state.maxAccelG, 0);
  assert.equal(d.t.state.maxBrakeG, 0.9);
});

test('odometer and drive time integrate speed over valid dt only', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 36 });                 // first row: nothing to integrate
  for (let i = 0; i < 100; i++) d.step({ SpeedKmh: 36 }, 10);   // 1 s at 10 m/s
  near(d.t.state.odometerM, 10, 1e-9);
  near(d.t.state.driveTimeS, 1, 1e-9);

  d.step({ SpeedKmh: 36 }, 251);            // gap: skipped
  d.step({ SpeedKmh: 36 }, 0);              // equal timestamp: skipped
  d.step({ SpeedKmh: 36 }, -5000);          // backwards: skipped
  near(d.t.state.odometerM, 10, 1e-9);
  near(d.t.state.driveTimeS, 1, 1e-9);
  d.step({ SpeedKmh: 36 }, 250);            // 250 ms is still valid
  near(d.t.state.odometerM, 12.5, 1e-9);
  near(d.t.state.driveTimeS, 1.25, 1e-9);
});

test('odometer uses the trapezoid of the two speeds', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 0 });
  d.step({ SpeedKmh: 72 }, 100);            // mean 10 m/s over 0.1 s
  near(d.t.state.odometerM, 1, 1e-9);
});

test('a paused row breaks the integration across the pause', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 36 });
  d.step({ SpeedKmh: 36 }, 100);
  const before = d.t.state.odometerM;
  d.t.feed(row({ IsRaceOn: 0, TimestampMS: d.ts + 50 }));
  d.step({ SpeedKmh: 36 }, 100);            // first row after the pause: no previous row to integrate from
  assert.equal(d.t.state.odometerM, before);
  d.step({ SpeedKmh: 36 }, 100);
  near(d.t.state.odometerM, before + 1, 1e-9);
});

// ---- Records: events ------------------------------------------------------------------------------------------

test('speed milestones fire once each, in order, and are re-armed by reset()', () => {
  const d = new Driver();
  for (let v = 0; v <= 360; v += 5) d.step({ SpeedKmh: v });
  assert.deepEqual(d.ofType('speed_milestone').map((e) => e.kmh), [100, 150, 200, 250, 300, 350]);
  assert.deepEqual(SPEED_MILESTONES, [100, 150, 200, 250, 300, 350]);
  d.step({ SpeedKmh: 100 });
  d.step({ SpeedKmh: 400 });
  assert.equal(d.ofType('speed_milestone').length, 6);
  d.t.reset();
  d.events.length = 0;
  d.step({ SpeedKmh: 160 });
  assert.deepEqual(d.ofType('speed_milestone').map((e) => e.kmh), [100, 150]);
});

test('a milestone needs the speed to reach it, 99.9 is not enough', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 99.9 });
  assert.equal(d.ofType('speed_milestone').length, 0);
  d.step({ SpeedKmh: 100 });
  assert.equal(d.ofType('speed_milestone').length, 1);
});

test('paused rows never trigger milestones', () => {
  const d = new Driver();
  d.t.feed(row({ IsRaceOn: 0, TimestampMS: 1, SpeedKmh: 300 }));
  assert.deepEqual(d.t.drain(), []);
});

test('redline: 98 % of max rpm, at most once per 10 s of game time', () => {
  const d = new Driver();
  d.step({ CurrentEngineRpm: 7839, EngineMaxRpm: 8000 });
  assert.equal(d.ofType('redline').length, 0);
  d.step({ CurrentEngineRpm: 7840, EngineMaxRpm: 8000 });
  assert.equal(d.ofType('redline').length, 1);
  assert.deepEqual(d.ofType('redline')[0], { type: 'redline' });
  for (let i = 0; i < 500; i++) d.step({ CurrentEngineRpm: 8000, EngineMaxRpm: 8000 }, 10);    // 5 s more
  assert.equal(d.ofType('redline').length, 1);
  d.step({ CurrentEngineRpm: 8000, EngineMaxRpm: 8000 }, 4990);   // 9.99 s after the first
  assert.equal(d.ofType('redline').length, 1);
  d.step({ CurrentEngineRpm: 8000, EngineMaxRpm: 8000 }, 20);
  assert.equal(d.ofType('redline').length, 2);
});

test('redline needs a positive max rpm and survives a backwards clock', () => {
  const d = new Driver();
  d.step({ CurrentEngineRpm: 5000, EngineMaxRpm: 0 });
  assert.equal(d.ofType('redline').length, 0);
  d.step({ CurrentEngineRpm: 8000, EngineMaxRpm: 8000 });
  assert.equal(d.ofType('redline').length, 1);
  d.step({ CurrentEngineRpm: 8000, EngineMaxRpm: 8000 }, -4000);   // new session: the clock restarted
  assert.equal(d.ofType('redline').length, 2);
});

test('record: first sample never emits; >= 1 % and >= 2 s gate later ones', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 100 });
  assert.equal(d.ofType('record').length, 0);
  d.step({ SpeedKmh: 100.9 }, 5000);               // < 1 %
  assert.equal(d.ofType('record').length, 0);
  d.step({ SpeedKmh: 101 }, 5000);                 // exactly 1 %
  assert.deepEqual(d.ofType('record'), [{ type: 'record', key: 'topSpeedKmh', value: 101, previous: 100 }]);
  d.step({ SpeedKmh: 110 }, 1999);                 // improvement but too soon
  assert.equal(d.ofType('record').length, 1);
  d.step({ SpeedKmh: 110 }, 1);                    // 2000 ms since the last record: allowed
  assert.deepEqual(d.ofType('record')[1], { type: 'record', key: 'topSpeedKmh', value: 110, previous: 101 });
});

test('record: a continuous climb gives a record about every 2 s, not none', () => {
  const d = new Driver();
  let v = 20;
  for (let i = 0; i < 1000; i++) d.step({ SpeedKmh: (v += 0.1) });    // 13 s, +0.1 km/h per row
  const recs = d.ofType('record');
  assert.ok(recs.length >= 4 && recs.length <= 7, `got ${recs.length}`);
  for (let i = 1; i < recs.length; i++) assert.equal(recs[i].previous, recs[i - 1].value);
});

test('record: per-key throttle and the lateral/brake/accel keys', () => {
  const d = new Driver();
  d.step({ AccelGX: 1.0, AccelGZ: -1.0 });
  d.step({ AccelGX: -1.5, AccelGZ: 0.6 }, 3000);
  const recs = d.ofType('record');
  assert.deepEqual(recs, [{ type: 'record', key: 'maxLatG', value: 1.5, previous: 1 }]);
  // maxAccelG's first positive sample is the baseline: no event
  d.step({ AccelGZ: 0.603 }, 3000);
  assert.equal(d.ofType('record').length, 1);
  d.step({ AccelGZ: 0.7 }, 3000);
  assert.deepEqual(d.ofType('record')[1], { type: 'record', key: 'maxAccelG', value: 0.7, previous: 0.6 });
  d.step({ AccelGZ: -1.2 }, 3000);
  assert.deepEqual(d.ofType('record')[2], { type: 'record', key: 'maxBrakeG', value: 1.2, previous: 1 });
});

test('record: the very first race-on sample is never a record, even after a pause', () => {
  const d = new Driver();
  d.t.feed(row({ IsRaceOn: 0, TimestampMS: 10, SpeedKmh: 200 }));
  d.step({ SpeedKmh: 150 });
  assert.equal(d.ofType('record').length, 0);
});

test('record: a zero first sample does not turn the first movement into a record', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 0 });
  d.step({ SpeedKmh: 0.4 }, 5000);                // first positive value only seeds the baseline
  assert.equal(d.ofType('record').length, 0);
  d.step({ SpeedKmh: 0.5 }, 5000);
  assert.deepEqual(d.ofType('record'), [{ type: 'record', key: 'topSpeedKmh', value: 0.5, previous: 0.4 }]);
});

test('record floors suppress trivial records only', () => {
  const d = new Driver(Records, { recordFloors: { topSpeedKmh: 50 } });
  d.step({ SpeedKmh: 10 });
  d.step({ SpeedKmh: 30 }, 5000);
  d.step({ SpeedKmh: 60 }, 5000);                 // first value above the floor seeds the baseline
  assert.equal(d.ofType('record').length, 0);
  d.step({ SpeedKmh: 70 }, 5000);
  assert.equal(d.ofType('record').length, 1);
  assert.equal(d.t.state.topSpeedKmh, 70);
});

// ---- Records: robustness ----------------------------------------------------------------------------------------

test('malformed rows and missing columns are ignored without throwing', () => {
  const d = new Driver();
  for (const bad of [null, undefined, 0, 'abc', [], [1], {}, row({ IsRaceOn: NaN }), row({ IsRaceOn: 1, TimestampMS: NaN, SpeedKmh: 500 })]) {
    assert.doesNotThrow(() => d.t.feed(bad));
  }
  assert.equal(d.t.state.topSpeedKmh, 0);
  const r = new Records({ F: { IsRaceOn: 0, TimestampMS: 1 } });
  assert.doesNotThrow(() => r.feed([1, 100]));
  assert.doesNotThrow(() => r.feed([1, 200]));
  assert.equal(r.state.topSpeedKmh, 0);
  assert.doesNotThrow(() => new Records(undefined).feed([1, 2]));
});

test('NaN and negative speed never become records', () => {
  const d = new Driver();
  d.step({ SpeedKmh: NaN, AccelGX: NaN, CurrentEngineRpm: NaN, PowerHp: NaN });
  d.step({ SpeedKmh: -30 });
  assert.equal(d.t.state.topSpeedKmh, 0);
  assert.equal(d.t.state.maxLatG, 0);
  d.step({ SpeedKmh: 50 });
  assert.equal(d.t.state.topSpeedKmh, 50);
});

test('state is a snapshot and drain clears the queue', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 120 });
  const s = d.t.state;
  s.topSpeedKmh = 5;
  assert.equal(d.t.state.topSpeedKmh, 120);
  assert.deepEqual(d.t.drain(), []);               // Driver already drained
  d.t.feed(row({ IsRaceOn: 1, TimestampMS: d.ts + 13, SpeedKmh: 130 }));      // a record, no milestone
  assert.equal(d.t.drain().length, 1);
  assert.deepEqual(d.t.drain(), []);
});

test('reset clears records, events and integration state', () => {
  const d = new Driver();
  d.step({ SpeedKmh: 120, AccelGX: 1 });
  d.step({ SpeedKmh: 120, AccelGX: 1 }, 100);
  d.t.feed(row({ IsRaceOn: 1, TimestampMS: d.ts + 13, SpeedKmh: 200 }));
  d.t.reset();
  assert.deepEqual(d.t.drain(), []);
  assert.equal(d.t.state.topSpeedKmh, 0);
  assert.equal(d.t.state.odometerM, 0);
  d.step({ SpeedKmh: 120 });
  assert.equal(d.t.state.odometerM, 0);
});

test('the event queue is capped', () => {
  const t = new Records({ F }, { maxEvents: 3 });
  for (let i = 0; i < 20; i++) t.feed(row({ IsRaceOn: 1, TimestampMS: i * 20000, CurrentEngineRpm: 8000, EngineMaxRpm: 8000 }));
  assert.equal(t.drain().length, 3);
});

// ---- GTrail ---------------------------------------------------------------------------------------------------

test('GTrail keeps the newest `size` points, oldest first', () => {
  const d = new Driver(GTrail, { size: 4 });
  for (let i = 1; i <= 6; i++) d.step({ AccelGX: i * 0.1, AccelGZ: -i * 0.2 });
  const p = d.t.points();
  assert.equal(p.n, 4);
  assert.equal(p.x.length, 4);
  assert.deepEqual(Array.from(p.x), [3, 4, 5, 6].map((i) => Math.fround(i * 0.1)));
  assert.deepEqual(Array.from(p.y), [3, 4, 5, 6].map((i) => Math.fround(-i * 0.2)));
  assert.ok(p.x instanceof Float32Array);
});

test('GTrail default size is 150 and a partly filled trail reports n', () => {
  const d = new Driver(GTrail);
  for (let i = 0; i < 10; i++) d.step({ AccelGX: 0.5, AccelGZ: 0.25 });
  assert.equal(d.t.points().n, 10);
  assert.equal(d.t.n, 10);
  for (let i = 0; i < 400; i++) d.step({ AccelGX: 0.5, AccelGZ: 0.25 });
  assert.equal(d.t.points().n, 150);
  assert.deepEqual(d.t.last, { x: 0.5, y: 0.25 });
});

test('GTrail only takes race-on rows with finite g', () => {
  const d = new Driver(GTrail, { size: 10 });
  d.step({ AccelGX: 0.5, AccelGZ: 0.5 });
  d.t.feed(row({ IsRaceOn: 0, TimestampMS: 1, AccelGX: 9, AccelGZ: 9 }));
  d.step({ AccelGX: NaN, AccelGZ: 1 });
  d.t.feed(null);
  d.t.feed([1, 2]);
  assert.equal(d.t.points().n, 1);
  assert.equal(d.t.peaks.right, 0.5);
  assert.equal(new GTrail({ F: {} }).points().n, 0);
  assert.equal(new GTrail().last, null);
});

test('GTrail peaks are session maxima per direction (positive magnitudes)', () => {
  const d = new Driver(GTrail, { size: 3 });
  d.step({ AccelGX: -1.2, AccelGZ: 0.4 });
  d.step({ AccelGX: 0.8, AccelGZ: -1.6 });
  for (let i = 0; i < 10; i++) d.step({ AccelGX: 0, AccelGZ: 0 });       // the big values scroll off the trail
  assert.deepEqual(d.t.peaks, { left: 1.2, right: 0.8, accel: 0.4, brake: 1.6 });
  d.t.resetPeaks();
  assert.deepEqual(d.t.peaks, { left: 0, right: 0, accel: 0, brake: 0 });
  assert.equal(d.t.points().n, 3);
});

test('GTrail peaks decay toward what is still on the trail', () => {
  const d = new Driver(GTrail, { size: 50, decayPerSec: 1 });
  d.step({ AccelGX: 1.0, AccelGZ: 0 });
  for (let i = 0; i < 49; i++) d.step({ AccelGX: 0.2, AccelGZ: 0 }, 10);
  // the 1.0 g sample is still on the trail, so the peak must not move
  assert.equal(d.t.peaks.right, 1.0);
  for (let i = 0; i < 20; i++) d.step({ AccelGX: 0.2, AccelGZ: 0 }, 10);   // 1.0 scrolled off
  near(d.t.peaks.right, 1.0 - 0.01 * 20, 1e-9, '20 rows of 0.01 g after it scrolled off');
  for (let i = 0; i < 200; i++) d.step({ AccelGX: 0.2, AccelGZ: 0 }, 10);   // 2 more seconds
  near(d.t.peaks.right, 0.2, 1e-9, 'floor = largest value still on the trail');
});

test('GTrail decay works for every direction and floors at the trail maximum', () => {
  const d = new Driver(GTrail, { size: 20, decayPerSec: 2 });
  d.step({ AccelGX: -1.5, AccelGZ: 1.2 }, 10);
  d.step({ AccelGX: 1.0, AccelGZ: -0.8 }, 10);
  for (let i = 0; i < 20; i++) d.step({ AccelGX: 0.1, AccelGZ: 0.05 }, 10);     // both big samples scroll off
  const p = d.t.peaks;
  // 2 g/s * 0.01 s = 0.02 g per row; the big samples left the trail at the 19th (first) and 20th (second) rows
  assert.ok(p.left < 1.5 && p.right < 1.0 && p.accel < 1.2 && p.brake < 0.8, JSON.stringify(p));
  for (let i = 0; i < 200; i++) d.step({ AccelGX: 0.1, AccelGZ: 0.05 }, 10);
  const q = d.t.peaks;
  near(q.left, 0, 1e-12, 'left');                    // nothing on the trail pushes left
  near(q.right, 0.1, 1e-12, 'right');
  near(q.accel, 0.05, 1e-12, 'accel');
  near(q.brake, 0, 1e-12, 'brake');
});

test('GTrail decay does not eat into a peak that is still on the trail (longitudinal too)', () => {
  const d = new Driver(GTrail, { size: 30, decayPerSec: 5 });
  d.step({ AccelGX: -0.5, AccelGZ: 0.9 }, 10);
  d.step({ AccelGX: 0, AccelGZ: -0.7 }, 10);
  for (let i = 0; i < 20; i++) d.step({ AccelGX: 0, AccelGZ: 0.05 }, 10);
  assert.deepEqual(d.t.peaks, { left: 0.5, right: 0, accel: 0.9, brake: 0.7 });
});

test('GTrail decay ignores invalid dt, and is off by default', () => {
  const a = new Driver(GTrail, { size: 5, decayPerSec: 10 });
  a.step({ AccelGX: 1 });
  for (let i = 0; i < 5; i++) a.step({ AccelGX: 0 }, 400);       // gaps: no decay
  assert.equal(a.t.peaks.right, 1);
  const b = new Driver(GTrail, { size: 2 });
  b.step({ AccelGX: 1 });
  for (let i = 0; i < 50; i++) b.step({ AccelGX: 0 }, 100);
  assert.equal(b.t.peaks.right, 1);
});

test('GTrail reset empties everything; options are sanitised', () => {
  const d = new Driver(GTrail, { size: -5, decayPerSec: NaN });
  d.step({ AccelGX: 1, AccelGZ: 1 });
  assert.equal(d.t.points().n, 1);
  d.t.reset();
  assert.deepEqual(d.t.points(), { x: new Float32Array(0), y: new Float32Array(0), n: 0 });
  assert.equal(d.t.peaks.right, 0);
  assert.equal(d.t.last, null);
  const e = new GTrail({ F }, { size: 2.9 });
  for (let i = 0; i < 5; i++) e.feed(row({ IsRaceOn: 1, AccelGX: i }));
  assert.equal(e.points().n, 2);
});
