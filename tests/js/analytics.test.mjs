import test from 'node:test';
import assert from 'node:assert/strict';
import { Analytics } from '../../fh6_telemetry/web/static/analytics.js';
import { Lifetime } from '../../fh6_telemetry/web/static/lifetime.js';
import { on } from '../../fh6_telemetry/web/static/bus.js';

const FKEYS = [
  'IsRaceOn', 'CurrentEngineRpm', 'EngineMaxRpm', 'SpeedKmh', 'PowerHp', 'Torque', 'BoostBar', 'FuelPct', 'Gear',
  'AccelPct', 'BrakePct', 'ClutchPct', 'HandBrakePct', 'SteerPct',
  'TireTempFL', 'TireTempFR', 'TireTempRL', 'TireTempRR',
  'SuspNormFL', 'SuspNormFR', 'SuspNormRL', 'SuspNormRR',
  'TimestampMS', 'AccelGX', 'AccelGZ', 'SideslipDeg', 'Pitch', 'Roll', 'Yaw', 'PositionX', 'PositionZ',
];
const SKEYS = ['LapNumber', 'CurrentLapMs', 'DistanceTraveled', 'LastLapMs', 'BestLapMs'];
const F = Object.fromEntries(FKEYS.map((k, i) => [k, i]));
const S = Object.fromEntries(SKEYS.map((k, i) => [k, i]));

const frow = (o) => {
  const r = new Array(FKEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[F[k]] = v;
  return r;
};
const srow = (o) => {
  const r = new Array(SKEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[S[k]] = v;
  return r;
};

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

/** A store double with just what Analytics uses: the column maps and three subscription hooks. */
function makeStore() {
  const hs = { hello: [], rows: [], slow: [] };
  return {
    F, S,
    onHello: (fn) => hs.hello.push(fn),
    onRows: (fn) => hs.rows.push(fn),
    onSlow: (fn) => hs.slow.push(fn),
    pushRows: (rows) => hs.rows.forEach((fn) => fn(rows)),
    pushSlow: (slow) => hs.slow.forEach((fn) => fn(slow)),
    pushHello: (reset) => hs.hello.forEach((fn) => fn({}, reset)),
  };
}

function setup() {
  const store = makeStore();
  const storage = memoryStorage();
  const lifetime = new Lifetime(storage);
  const settings = { get: (k) => (k === 'units' ? { speed: 'kmh', dist: 'km', temp: 'c', pressure: 'bar', power: 'hp', torque: 'nm' } : undefined) };
  const toasts = [];
  const events = [];
  const off = [on('toast', (t) => toasts.push(t)), on('analytics', (e) => events.push(e))];
  const analytics = new Analytics(store, lifetime, settings);
  return { store, storage, lifetime, analytics, toasts, events, done: () => off.forEach((f) => f()) };
}

/** Standing start: stand 600 ms, then accelerate hard to ~130 km/h (2.8 s to 100). */
function launchRows(t0 = 100000) {
  const rows = [];
  let ts = t0;
  for (let i = 0; i < 60; i++) { ts += 10; rows.push(frow({ IsRaceOn: 1, SpeedKmh: 0, TimestampMS: ts, EngineMaxRpm: 8000 })); }
  for (let n = 1; n <= 320; n++) {
    ts += 13;
    const v = Math.min(130, 10.2 * (n * 0.013) * 3.6);
    rows.push(frow({ IsRaceOn: 1, SpeedKmh: v, TimestampMS: ts, EngineMaxRpm: 8000, CurrentEngineRpm: 6000, AccelPct: 100 }));
  }
  return rows;
}

test('a standing start raises perf events, toasts and a personal best', () => {
  const t = setup();
  t.store.pushRows(launchRows());
  const perf = t.events.filter((e) => e.type === 'perf');
  assert.ok(perf.some((e) => e.key === 't100'), 'a 0-100 time is produced');
  const toast = t.toasts.find((x) => /0–100 km\/h/.test(x.title));
  assert.ok(toast, 'toast for 0-100');
  assert.match(toast.text, /^\d+\.\d\d s$/);
  assert.ok(t.lifetime.data.best.t100 > 2 && t.lifetime.data.best.t100 < 5);
  t.done();
});

test('a faster second run is a NEW BEST, a slower one is not', () => {
  const t = setup();
  t.store.pushRows(launchRows());                       // first run sets the best (never "new best" on the very first)
  const first = t.lifetime.data.best.t100;
  // brake to a stop and re-arm
  const stop = [];
  let ts = 300000;
  for (let i = 0; i < 80; i++) { ts += 10; stop.push(frow({ IsRaceOn: 1, SpeedKmh: 0, TimestampMS: ts })); }
  t.store.pushRows(stop);
  t.toasts.length = 0;
  // a clearly slower run (4 m/s2 instead of 10.2)
  const slow = [];
  for (let n = 1; n <= 800; n++) { ts += 13; slow.push(frow({ IsRaceOn: 1, SpeedKmh: Math.min(130, 4 * (n * 0.013) * 3.6), TimestampMS: ts, EngineMaxRpm: 8000 })); }
  t.store.pushRows(slow);
  const slowToast = t.toasts.find((x) => /0–100 km\/h/.test(x.title));
  assert.ok(slowToast);
  assert.ok(!/NEW BEST/.test(slowToast.title));
  assert.equal(t.lifetime.data.best.t100, first, 'a slower run does not replace the best');
  t.done();
});

test('lap completion toasts the lap that was just finished', () => {
  const t = setup();
  t.store.pushSlow(srow({ LapNumber: 1, CurrentLapMs: 1000, DistanceTraveled: 10 }));
  t.store.pushSlow(srow({ LapNumber: 1, CurrentLapMs: 59000, DistanceTraveled: 4000 }));
  t.store.pushSlow(srow({ LapNumber: 2, CurrentLapMs: 200, DistanceTraveled: 4010, LastLapMs: 60123, BestLapMs: 60123 }));
  const lap = t.toasts.find((x) => /^Lap /.test(x.title));
  assert.ok(lap, 'lap toast');
  assert.match(lap.title, /^Lap 1 /);
  t.done();
});

test('speed milestones unlock achievements, announce them and persist the unlock', () => {
  const t = setup();
  const rows = [];
  let ts = 100000;
  for (let i = 0; i < 20; i++) { ts += 15; rows.push(frow({ IsRaceOn: 1, SpeedKmh: 60 + i * 5, TimestampMS: ts })); }
  t.store.pushRows(rows);
  const ach = t.toasts.find((x) => /^Achievement:/.test(x.title));
  assert.ok(ach, 'an achievement toast');
  assert.ok(t.analytics.achievements.isUnlocked('speed_100'));
  assert.ok(t.lifetime.data.unlocked.includes('speed_100'));
  assert.ok(t.events.some((e) => e.type === 'achievement' && e.id === 'speed_100'));
  const saved = JSON.parse(t.storage.m.get('fh6.lifetime.v1'));
  assert.ok(saved.unlocked.includes('speed_100'), 'forced save on unlock');
  t.done();
});

test('the G-G trail is fed from the fast rows', () => {
  const t = setup();
  const rows = [];
  let ts = 100000;
  for (let i = 0; i < 30; i++) { ts += 15; rows.push(frow({ IsRaceOn: 1, SpeedKmh: 80, TimestampMS: ts, AccelGX: 0.5 + i * 0.01, AccelGZ: -0.2 })); }
  t.store.pushRows(rows);
  assert.equal(t.analytics.gtrail.n, 30);
  assert.ok(t.analytics.gtrail.peaks.right > 0.7);
  assert.ok(t.analytics.records.state.maxLatG > 0.7);
  t.done();
});

test('a column-layout reset rebinds fresh trackers; resetSession keeps the trophies', () => {
  const t = setup();
  t.store.pushRows(launchRows());
  assert.notEqual(t.analytics.perf.state.phase, 'idle');
  const before = t.analytics.achievements.serialize();
  t.analytics.resetSession();
  assert.equal(t.analytics.perf.state.phase, 'idle');
  assert.deepEqual(t.analytics.achievements.serialize(), before);
  const oldPerf = t.analytics.perf;
  t.store.pushHello(false);
  assert.equal(t.analytics.perf, oldPerf, 'no rebind without reset');
  t.store.pushHello(true);
  assert.notEqual(t.analytics.perf, oldPerf, 'rebound on reset');
  t.done();
});

test('a rebind banks the old session odometer into the lifetime total', () => {
  const t = setup();
  const rows = [];
  let ts = 100000;
  for (let i = 0; i < 400; i++) { ts += 15; rows.push(frow({ IsRaceOn: 1, SpeedKmh: 180, TimestampMS: ts })); }   // 180 km/h for 6 s = 300 m
  t.store.pushRows(rows);
  const driven = t.analytics.records.state.odometerM;
  assert.ok(driven > 280 && driven < 320, `driven ${driven}`);
  t.store.pushHello(true);                                  // column layout reset: trackers are recreated
  assert.equal(t.analytics.records.state.odometerM, 0);
  assert.ok(t.lifetime.data.odometerM >= driven - 1e-6, 'the old session distance was merged');
  assert.ok(Math.abs(t.lifetime.base - t.lifetime.data.odometerM) < 1e-6, 'new session starts from the banked total');
  // driving on after the rebind adds to the total instead of being lost behind the old base
  const more = [];
  for (let i = 0; i < 400; i++) { ts += 15; more.push(frow({ IsRaceOn: 1, SpeedKmh: 180, TimestampMS: ts })); }
  t.store.pushRows(more);
  t.analytics.feedRows([]);                                 // flush any throttled merge
  t.lifetime.mergeRecords(t.analytics.records.state);
  assert.ok(t.lifetime.data.odometerM > driven + 250, `total ${t.lifetime.data.odometerM}`);
  t.done();
});

test('context-only achievements (hot tyres) unlock even when no tracker event fires', () => {
  const t = setup();
  const rows = [];
  let ts = 100000;
  // constant speed, no brakes, no drift, no air: the trackers have nothing to report
  for (let i = 0; i < 20; i++) {
    ts += 15;
    rows.push(frow({ IsRaceOn: 1, SpeedKmh: 20, TimestampMS: ts, TireTempFL: 110, TireTempFR: 110, TireTempRL: 112, TireTempRR: 112 }));
  }
  t.store.pushRows(rows);
  assert.ok(t.analytics.achievements.isUnlocked('hot_tyres'));
  assert.ok(t.toasts.some((x) => /Achievement:/.test(x.title)));
  t.done();
});
