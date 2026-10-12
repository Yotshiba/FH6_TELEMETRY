import test from 'node:test';
import assert from 'node:assert/strict';
import { AirTracker } from '../../fh6_telemetry/web/static/air.js';

const KEYS = [
  'IsRaceOn', 'CurrentEngineRpm', 'EngineMaxRpm', 'SpeedKmh', 'PowerHp', 'Torque', 'BoostBar', 'FuelPct',
  'Gear', 'AccelPct', 'BrakePct', 'ClutchPct', 'HandBrakePct', 'SteerPct',
  'TireTempFL', 'TireTempFR', 'TireTempRL', 'TireTempRR',
  'SuspNormFL', 'SuspNormFR', 'SuspNormRL', 'SuspNormRR',
  'TimestampMS', 'AccelGX', 'AccelGZ', 'SideslipDeg', 'Pitch', 'Roll', 'Yaw', 'PositionX', 'PositionZ',
];
const F = Object.fromEntries(KEYS.map((k, i) => [k, i]));

function row(o) {
  const r = new Array(KEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[F[k]] = v;
  return r;
}

const susp = (v, speed = 100) => ({
  SuspNormFL: v, SuspNormFR: v, SuspNormRL: v, SuspNormRR: v, SpeedKmh: speed,
});
const GROUND = susp(0.5);
const AIR = susp(0.01);

function sim(tr, t0 = 1000, step = 10) {
  const s = {
    t: t0,
    tick(o) { s.t += step; tr.feed(row({ IsRaceOn: 1, TimestampMS: s.t, ...o })); },
    hold(o, ms) { for (let n = 0; n < Math.round(ms / step); n++) s.tick(o); },
  };
  return s;
}

/** ground, `airMs` of air, then ground again. The first landing row is exactly airMs after take-off. */
function jump(s, airMs, air = AIR) {
  s.hold(GROUND, 50);
  s.hold(air, airMs);
  s.hold(GROUND, 30);
}

const types = (evs) => evs.map((e) => e.type);
const mk = (opts) => new AirTracker({ F, S: {} }, opts);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('a 1 s jump at 100 km/h: duration, distance, height, events', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 1000);
  const evs = tr.drain();
  assert.deepEqual(types(evs), ['air_start', 'air_end']);
  assert.equal(evs[0].speedKmh, 100);
  const e = evs[1];
  assert.equal(e.durationS, 1);
  near(e.distM, 100 / 3.6);
  near(e.heightM, 1.225);
  assert.equal(e.speedKmh, 100);
  assert.equal(e.landKmh, 100);
  assert.deepEqual(tr.state, {
    active: false, tS: 0, longestS: 1, count: 1, totalS: 1,
    last: { durationS: 1, distM: e.distM, heightM: e.heightM, speedKmh: 100 },
  });
});

test('height grows with the square of duration (1.225 * t^2)', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 2000);
  const e = tr.drain().find((x) => x.type === 'air_end');
  near(e.heightM, 1.225 * 4);
  assert.equal(e.durationS, 2);
});

test('airborne needs 3 consecutive extended rows; air_start fires on the third', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  s.tick(AIR);
  s.tick(AIR);
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), []);
  s.tick(AIR);
  assert.equal(tr.state.active, true);
  assert.deepEqual(tr.drain(), [{ type: 'air_start', speedKmh: 100 }]);
  assert.equal(tr.state.tS, 0.02);                      // counted from the FIRST of the three rows
  s.hold(AIR, 100);
  assert.equal(tr.state.tS, 0.12);
});

test('two extended rows then ground is not a flight', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  s.hold(AIR, 20);
  s.hold(GROUND, 200);
  s.hold(AIR, 20);
  s.hold(GROUND, 200);
  assert.deepEqual(tr.drain(), []);
  assert.equal(tr.state.count, 0);
});

test('the air time counts from the first extended row, landing time is the first compressed row', () => {
  const tr = mk();
  const s = sim(tr, 2000);
  s.hold(GROUND, 20);
  const takeoff = s.t + 10;
  s.hold(AIR, 700);
  const touchdown = s.t + 10;
  s.hold(GROUND, 20);
  const e = tr.drain().find((x) => x.type === 'air_end');
  assert.equal(e.durationS, (touchdown - takeoff) / 1000);
  assert.equal(e.durationS, 0.7);
});

test('landing needs 2 consecutive compressed rows; a single-row blip does not land', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  s.hold(AIR, 500);
  s.tick(GROUND);                                       // blip
  s.hold(AIR, 500);
  assert.equal(tr.state.active, true);
  tr.drain();
  s.hold(GROUND, 30);
  const e = tr.drain().find((x) => x.type === 'air_end');
  assert.equal(e.durationS, 1.01);                      // blip row was part of the flight
});

test('a landing candidate cancelled by an extended row keeps the flight going', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  s.hold(AIR, 400);
  s.tick(GROUND);
  s.tick(AIR);
  s.tick(GROUND);
  s.tick(AIR);
  assert.equal(tr.state.active, true);
  s.hold(GROUND, 20);
  assert.equal(tr.state.active, false);
});

test('extension threshold: < 0.04 counts as air, exactly 0.04 does not', () => {
  const a = mk();
  const sa = sim(a);
  sa.hold(susp(0.0399), 100);
  assert.equal(a.state.active, true);
  const b = mk();
  const sb = sim(b);
  sb.hold(susp(0.04), 100);
  assert.equal(b.state.active, false);
});

test('landing threshold: > 0.04 lands, exactly 0.04 neither lands nor counts', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  s.hold(AIR, 500);
  s.tick(susp(0.5));
  s.tick(susp(0.04));                                   // not > 0.04: breaks the landing streak
  s.tick(susp(0.5));
  assert.equal(tr.state.active, true);
  s.tick(susp(0.0401));
  assert.equal(tr.state.active, false);
});

test('one compressed wheel is enough to deny air (max of the four is used)', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold({ ...susp(0.0), SuspNormRR: 0.3 }, 500);
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), []);
});

test('speed gate: rows under 15 km/h never start a flight, 15 km/h does', () => {
  const slow = mk();
  sim(slow).hold(susp(0.0, 14.9), 500);
  assert.equal(slow.state.active, false);
  const ok = mk();
  sim(ok).hold(susp(0.0, 15), 500);
  assert.equal(ok.state.active, true);
});

test('a slow row in the middle of the candidate streak restarts it', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(AIR, 20);
  s.tick(susp(0.0, 5));
  s.hold(AIR, 20);
  assert.equal(tr.state.active, false);
  s.tick(AIR);
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.tS, 0.02);
});

test('speed falling below 15 km/h while already airborne does not end the flight', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(AIR, 100);
  s.hold(susp(0.0, 2), 400);
  assert.equal(tr.state.active, true);
});

test('flights shorter than 0.25 s are discarded (air_start without air_end)', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 240);
  assert.deepEqual(types(tr.drain()), ['air_start']);
  assert.equal(tr.state.count, 0);
  assert.equal(tr.state.last, null);
  assert.equal(tr.state.longestS, 0);
  assert.equal(tr.state.totalS, 0);
  assert.equal(tr.state.active, false);
});

test('a flight of exactly 0.25 s counts', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 250);
  const evs = tr.drain();
  assert.deepEqual(types(evs), ['air_start', 'air_end']);
  assert.equal(evs[1].durationS, 0.25);
  assert.equal(tr.state.count, 1);
});

test('count, totalS, longestS and last accumulate over jumps and ignore short ones', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 500);
  jump(s, 100);                                         // too short
  jump(s, 1500);
  jump(s, 800);
  assert.equal(tr.state.count, 3);
  assert.equal(tr.state.totalS, 2.8);
  assert.equal(tr.state.longestS, 1.5);
  assert.equal(tr.state.last.durationS, 0.8);
  near(tr.state.last.heightM, 1.225 * 0.64);
  assert.deepEqual(types(tr.drain()).filter((t) => t === 'air_end').length, 3);
});

test('distance integrates a changing speed (linear 100 -> 60 km/h over 1 s = 80 km/h average)', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(GROUND, 50);
  for (let i = 0; i <= 100; i++) {                      // rows at t0 .. t0+1000, last one is the landing row
    const v = 100 - 0.4 * i;
    s.tick(i < 100 ? susp(0.0, v) : susp(0.5, v));
  }
  s.tick(susp(0.5, 60));
  const e = tr.drain().find((x) => x.type === 'air_end');
  assert.equal(e.durationS, 1);
  near(e.distM, 80 / 3.6, 1e-6);
  assert.equal(e.speedKmh, 100);                        // take-off speed
  near(e.landKmh, 60, 1e-9);                            // speed at the first compressed row
});

test('noisy 75 Hz timestamps: duration comes from the timestamps, not the row count', () => {
  const tr = mk();
  let t = 10000;
  const feed = (o) => tr.feed(row({ IsRaceOn: 1, TimestampMS: t, ...o }));
  let n = 0;
  const adv = () => { t += n++ % 2 ? 14 : 13; };
  for (let i = 0; i < 5; i++) { feed(GROUND); adv(); }
  const takeoff = t;
  for (let i = 0; i < 60; i++) { feed(AIR); adv(); }
  const landing = t;
  feed(GROUND); adv(); feed(GROUND);
  const e = tr.drain().find((x) => x.type === 'air_end');
  assert.equal(e.durationS, (landing - takeoff) / 1000);
});

test('a timestamp jump during the flight cancels it without events (and the row can be a new candidate)', () => {
  for (const jumpBy of [300, -50, -100000]) {
    const tr = mk();
    const s = sim(tr);
    s.hold(AIR, 500);
    tr.drain();
    assert.equal(tr.state.active, true);
    tr.feed(row({ IsRaceOn: 1, TimestampMS: s.t + jumpBy, ...AIR }));
    assert.equal(tr.state.active, false, `jump ${jumpBy}`);
    assert.deepEqual(tr.drain(), []);
    s.t = s.t + jumpBy;                                 // keep simulating from the new clock
    s.tick(AIR);
    s.tick(AIR);
    assert.equal(tr.state.active, true, `re-armed after ${jumpBy}`);
    assert.equal(tr.state.tS, 0.02);
    s.hold(GROUND, 30);
    assert.equal(tr.state.count, 0);                    // 0.03 s: too short
  }
});

test('equal timestamps are a zero step, not a gap (the game clock ticks every ~15.6 ms, rows come every ~13 ms)', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(AIR, 200);
  tr.drain();
  assert.equal(tr.state.active, true);
  const t0 = s.t;
  tr.feed(row({ IsRaceOn: 1, TimestampMS: t0, ...AIR }));        // duplicate stamp
  assert.equal(tr.state.active, true);
  assert.deepEqual(tr.drain(), []);
  // a realistic stretch: rows every 13.3 ms with stamps quantised to a 15.625 ms tick
  for (let i = 1; i <= 75; i++) {
    const real = t0 + i * 13.333;
    tr.feed(row({ IsRaceOn: 1, TimestampMS: Math.floor(real / 15.625) * 15.625, ...AIR }));
  }
  assert.equal(tr.state.active, true);                          // never cancelled by duplicates
  const t = tr.state.tS;
  assert.ok(t > 0.9 && t < 1.3, `air time ${t}`);                // ~1 s of flight plus the first 0.2 s
});

test('a step of exactly 250 ms is not a discontinuity', () => {
  const tr = mk();
  const s = sim(tr, 1000, 250);
  s.hold(AIR, 1000);                                    // 4 rows, 250 ms apart
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.tS, 0.75);
});

test('a discontinuity inside the candidate streak resets it', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(AIR);
  s.tick(AIR);
  s.t += 1000;
  s.tick(AIR);
  assert.equal(tr.state.active, false);
  s.tick(AIR);
  s.tick(AIR);
  assert.equal(tr.state.active, true);
});

test('IsRaceOn = 0 cancels a flight in progress silently; the clock restarts after it', () => {
  const tr = mk();
  const s = sim(tr, 900000);
  s.hold(AIR, 500);
  tr.drain();
  tr.feed(row({ IsRaceOn: 0, TimestampMS: s.t + 10, ...AIR }));
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), []);
  for (let i = 0; i < 40; i++) tr.feed(row({ IsRaceOn: 0, TimestampMS: 5 + i, ...AIR }));
  assert.deepEqual(tr.drain(), []);
  assert.equal(tr.state.count, 0);
  const s2 = sim(tr, 100);                              // new session, smaller timestamps
  s2.hold(AIR, 300);
  s2.hold(GROUND, 30);
  const evs = tr.drain();
  assert.deepEqual(types(evs), ['air_start', 'air_end']);
  assert.equal(evs[1].durationS, 0.3);
});

test('IsRaceOn = 0 inside the candidate streak resets it', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(AIR);
  s.tick(AIR);
  tr.feed(row({ IsRaceOn: 0, TimestampMS: s.t + 10, ...AIR }));
  s.t += 10;
  s.tick(AIR);
  assert.equal(tr.state.active, false);
});

test('malformed rows are ignored: no throw, no state change, streak continues', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold(AIR, 20);
  const bad = [
    null, undefined, 7, 'x', {}, [], [0, 0, 0],
    row({ IsRaceOn: 1, TimestampMS: NaN, ...AIR }),
    row({ IsRaceOn: 1, TimestampMS: s.t + 10, ...AIR, SuspNormFL: NaN }),
    row({ IsRaceOn: 1, TimestampMS: s.t + 10, ...AIR, SpeedKmh: undefined }),
    row({ IsRaceOn: NaN, TimestampMS: s.t + 10, ...AIR }),
    row({ IsRaceOn: 1, TimestampMS: s.t + 10, ...AIR, SuspNormRR: Infinity }),
  ];
  for (const b of bad) assert.doesNotThrow(() => tr.feed(b));
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), []);
  s.tick(AIR);                                          // 3rd valid extended row
  assert.equal(tr.state.active, true);
});

test('missing keys in F: everything is ignored, nothing throws', () => {
  for (const maps of [undefined, null, {}, { F: {} }, { F: { SpeedKmh: 3, TimestampMS: 22 } }]) {
    const tr = new AirTracker(maps);
    assert.doesNotThrow(() => tr.feed(row({ IsRaceOn: 1, TimestampMS: 1, ...AIR })));
    assert.equal(tr.state.active, false);
    assert.deepEqual(tr.drain(), []);
  }
});

test('IsRaceOn missing from F is treated as always racing', () => {
  const F2 = { ...F };
  delete F2.IsRaceOn;
  const tr = new AirTracker({ F: F2, S: {} });
  sim(tr).hold(AIR, 100);
  assert.equal(tr.state.active, true);
});

test('drain returns pending events once; state is a fresh object', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 400);
  assert.equal(tr.drain().length, 2);
  assert.deepEqual(tr.drain(), []);
  const st = tr.state;
  st.count = 99;
  st.last.durationS = 99;
  assert.equal(tr.state.count, 1);
  assert.equal(tr.state.last.durationS, 0.4);
  assert.notEqual(tr.state, tr.state);
});

test('reset forgets a flight in progress, the totals and pending events', () => {
  const tr = mk();
  const s = sim(tr);
  jump(s, 600);
  s.hold(AIR, 300);
  tr.reset();
  assert.deepEqual(tr.drain(), []);
  assert.deepEqual(tr.state, { active: false, tS: 0, last: null, longestS: 0, count: 0, totalS: 0 });
  const s2 = sim(tr, 5);                                // earlier clock after reset is not a discontinuity problem
  s2.hold(AIR, 300);
  s2.hold(GROUND, 30);
  assert.equal(tr.state.count, 1);
});

test('options override the detection rules', () => {
  const tr = mk({ airRows: 5, landRows: 3, minAirS: 0.1, minSpeedKmh: 50, extendThresh: 0.1 });
  const s = sim(tr);
  s.hold(susp(0.09, 49), 200);
  assert.equal(tr.state.active, false);                 // too slow
  s.hold(susp(0.09, 60), 40);
  assert.equal(tr.state.active, false);                 // only 4 rows
  s.tick(susp(0.09, 60));
  assert.equal(tr.state.active, true);
  s.hold(susp(0.09, 60), 100);
  s.hold(GROUND, 20);
  assert.equal(tr.state.active, true);                  // needs 3 landing rows
  s.tick(GROUND);
  assert.equal(tr.state.active, false);
  assert.equal(tr.state.count, 1);
});

test('the event queue is bounded if nobody drains it', () => {
  const tr = mk();
  const s = sim(tr);
  for (let i = 0; i < 1500; i++) jump(s, 300);
  assert.ok(tr.drain().length <= 512);
  assert.equal(tr.state.count, 1500);
});
