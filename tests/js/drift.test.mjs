import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftTracker, DRIFT_MILESTONES } from '../../fh6_telemetry/web/static/drift.js';

// Fast column order from protocol.py (only the keys matter, not the exact order).
const KEYS = [
  'IsRaceOn', 'CurrentEngineRpm', 'EngineMaxRpm', 'SpeedKmh', 'PowerHp', 'Torque', 'BoostBar', 'FuelPct',
  'Gear', 'AccelPct', 'BrakePct', 'ClutchPct', 'HandBrakePct', 'SteerPct',
  'TireTempFL', 'TireTempFR', 'TireTempRL', 'TireTempRR',
  'SuspNormFL', 'SuspNormFR', 'SuspNormRL', 'SuspNormRR',
  'TimestampMS', 'AccelGX', 'AccelGZ', 'SideslipDeg', 'Pitch', 'Roll', 'Yaw', 'PositionX', 'PositionZ',
];
const F = Object.fromEntries(KEYS.map((k, i) => [k, i]));
const S = {};

/** Build a fast row from a key -> value object (everything else 0). */
function row(o) {
  const r = new Array(KEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[F[k]] = v;
  return r;
}

/** Drives a tracker with rows `step` ms apart. Every row has IsRaceOn = 1 unless overridden. */
function sim(tr, t0 = 1000, step = 10) {
  const s = {
    t: t0,
    tick(o) { s.t += step; tr.feed(row({ IsRaceOn: 1, TimestampMS: s.t, ...o })); },
    hold(o, ms) { for (let n = 0; n < Math.round(ms / step); n++) s.tick(o); },
  };
  return s;
}

const types = (evs) => evs.map((e) => e.type);
const mk = (opts) => new DriftTracker({ F, S }, opts);

const D30 = { SideslipDeg: 30, SpeedKmh: 90 };    // 270 pts/s base
const STRAIGHT = { SideslipDeg: 0, SpeedKmh: 90 };

test('does not start below the start thresholds', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold({ SideslipDeg: 11.9, SpeedKmh: 100 }, 200);
  s.hold({ SideslipDeg: 40, SpeedKmh: 39.9 }, 200);
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), []);
});

test('starts at exactly 12 deg and 40 km/h and emits drift_start once', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 12, SpeedKmh: 40 });
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.scoring, true);
  assert.equal(tr.state.score, 0);       // the start row itself scores nothing
  assert.equal(tr.state.mult, 1);
  s.hold({ SideslipDeg: 12, SpeedKmh: 40 }, 100);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
});

test('negative angles work; angleDeg keeps the sign', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: -30, SpeedKmh: 90 });
  s.hold({ SideslipDeg: -30, SpeedKmh: 90 }, 1000);
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.angleDeg, -30);
  assert.equal(tr.state.score, 270);
  assert.equal(tr.state.maxAngleDeg, 30);
});

test('score rate: 90 km/h at 30 deg is 270 pts/s, multiplier steps every drift second', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  assert.equal(tr.state.score, 270);
  assert.equal(tr.state.mult, 1.5);
  assert.equal(tr.state.driftTimeS, 1);
  assert.equal(tr.state.chainTimeS, 1);
  s.hold(D30, 1000);
  assert.equal(tr.state.score, 270 + 405);
  assert.equal(tr.state.mult, 2);
  s.hold(D30, 1000);
  assert.equal(tr.state.score, 270 + 405 + 540);
  assert.equal(tr.state.mult, 2.5);
});

test('multiplier is capped at 5', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 8000);
  assert.equal(tr.state.mult, 5);
  s.hold(D30, 4000);
  assert.equal(tr.state.mult, 5);
  assert.equal(tr.state.driftTimeS, 12);
});

test('angle is capped at 60 deg for scoring but still tracked as max angle', () => {
  const a = mk();
  const b = mk();
  const sa = sim(a);
  const sb = sim(b);
  sa.tick({ SideslipDeg: 60, SpeedKmh: 100 });
  sb.tick({ SideslipDeg: 60, SpeedKmh: 100 });
  sa.hold({ SideslipDeg: 60, SpeedKmh: 100 }, 500);
  sb.hold({ SideslipDeg: 100, SpeedKmh: 100 }, 500);
  assert.equal(a.state.score, b.state.score);
  assert.equal(a.state.score, 300);      // 600 pts/s * 0.5 s
  assert.equal(b.state.maxAngleDeg, 100);
});

test('keeps scoring down to 8 deg and 30 km/h, but 7.9 deg or 29.9 km/h is a gap', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 12, SpeedKmh: 40 });
  s.hold({ SideslipDeg: 8, SpeedKmh: 30 }, 100);
  assert.equal(tr.state.scoring, true);
  assert.equal(tr.state.score, Math.round(0.1 * 30 * 8 * 0.1));   // 10 rows * 0.24 = 2.4 -> 2
  const before = tr.state.score;
  s.hold({ SideslipDeg: 7.9, SpeedKmh: 100 }, 100);
  assert.equal(tr.state.scoring, false);
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.score, before);
  s.hold({ SideslipDeg: 20, SpeedKmh: 29.9 }, 100);
  assert.equal(tr.state.scoring, false);
  assert.equal(tr.state.score, before);
});

test('a chain is not started by a 9 deg slide (needs 12), only continued by it', () => {
  const tr = mk();
  const s = sim(tr);
  s.hold({ SideslipDeg: 9, SpeedKmh: 100 }, 500);
  assert.equal(tr.state.active, false);
});

test('gap up to 1.2 s keeps the chain and multiplier; scoring resumes afterwards', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);                                  // 270 pts, mult 1.5
  s.hold(STRAIGHT, 1200);                             // gap of exactly 1.2 s: still alive
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.scoring, false);
  assert.equal(tr.state.gapS, 1.2);
  assert.equal(tr.state.mult, 1.5);
  assert.equal(tr.state.score, 270);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  s.tick(D30);                                        // back to drifting
  assert.equal(tr.state.scoring, true);
  assert.equal(tr.state.gapS, 0);
  assert.equal(tr.state.mult, 1.5);
  s.hold(D30, 990);
  assert.equal(tr.state.driftTimeS, 2);               // the gap did not count as drift time
  assert.equal(tr.state.mult, 2);
});

test('gap longer than 1.2 s ends the chain; drift_end excludes the trailing gap', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  s.hold(STRAIGHT, 1200);
  tr.drain();
  s.tick(STRAIGHT);                                   // 1.21 s since the last scoring row
  assert.equal(tr.state.active, false);
  assert.deepEqual(tr.drain(), [
    { type: 'drift_end', score: 270, durationS: 1, maxAngleDeg: 30, mult: 1.5 },
  ]);
  assert.equal(tr.state.banked, 270);
  assert.equal(tr.state.best, 270);
  assert.equal(tr.state.score, 0);
  assert.equal(tr.state.mult, 1);
  assert.deepEqual(tr.state.last, { score: 270, durationS: 1, maxAngleDeg: 30, mult: 1.5 });
});

test('inactive state is zeroed apart from the session figures', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  s.hold(STRAIGHT, 1500);
  assert.deepEqual(tr.state, {
    active: false, scoring: false, angleDeg: 0, score: 0, mult: 1, chainTimeS: 0, driftTimeS: 0,
    maxAngleDeg: 0, banked: 270, best: 270, sessionBestAngle: 30, gapS: 0,
    last: { score: 270, durationS: 1, maxAngleDeg: 30, mult: 1.5 },
  });
});

test('chains below 50 points are discarded silently', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 12, SpeedKmh: 40 });
  s.hold({ SideslipDeg: 12, SpeedKmh: 40 }, 100);     // ~0.48 * 10 = ~5 points
  s.hold(STRAIGHT, 1500);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  assert.equal(tr.state.banked, 0);
  assert.equal(tr.state.best, 0);
  assert.equal(tr.state.last, null);
});

test('chain of just over 50 points is banked', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 20, SpeedKmh: 50 });          // 100 pts/s at mult 1
  s.hold({ SideslipDeg: 20, SpeedKmh: 50 }, 520);     // 52 pts
  s.hold(STRAIGHT, 1300);
  const evs = tr.drain();
  assert.deepEqual(types(evs), ['drift_start', 'drift_end']);
  assert.equal(evs[1].score, 52);
});

test('banked sums finished chains, best is the biggest; chains re-arm', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);                                  // 270
  s.hold(STRAIGHT, 1500);
  s.tick({ SideslipDeg: 40, SpeedKmh: 120 });         // 480 pts/s
  s.hold({ SideslipDeg: 40, SpeedKmh: 120 }, 500);    // 240
  s.hold(STRAIGHT, 1500);
  assert.equal(tr.state.banked, 510);
  assert.equal(tr.state.best, 270);
  s.tick(D30);
  s.hold(D30, 2000);                                  // 270 + 405 = 675
  s.hold(STRAIGHT, 1500);
  assert.equal(tr.state.banked, 1185);
  assert.equal(tr.state.best, 675);
  assert.equal(tr.drain().filter((e) => e.type === 'drift_end').length, 3);
});

test('sessionBestAngle is the biggest angle of any chain and survives chain end', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 25, SpeedKmh: 90 });
  s.hold({ SideslipDeg: 25, SpeedKmh: 90 }, 500);
  s.hold(STRAIGHT, 1500);
  assert.equal(tr.state.sessionBestAngle, 25);
  s.tick({ SideslipDeg: -55, SpeedKmh: 90 });
  s.hold({ SideslipDeg: -55, SpeedKmh: 90 }, 500);
  assert.equal(tr.state.sessionBestAngle, 55);
  s.hold(STRAIGHT, 1500);
  s.tick({ SideslipDeg: 15, SpeedKmh: 90 });
  s.hold({ SideslipDeg: 15, SpeedKmh: 90 }, 500);
  assert.equal(tr.state.sessionBestAngle, 55);
});

test('milestones only fire once the chain is 3 s old, then catch up in order, each once', () => {
  const tr = mk();
  const s = sim(tr);
  const hot = { SideslipDeg: 60, SpeedKmh: 200 };      // 1200 pts/s base
  s.tick(hot);
  s.hold(hot, 2990);                                   // chain 2.99 s, score ~5388
  assert.ok(tr.state.score > 5000);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  s.hold(hot, 10);                                     // chain 3.00 s
  assert.deepEqual(tr.drain().map((e) => e.score), [500, 1000, 2000, 5000]);
  assert.equal(tr.drain().length, 0);
  s.hold(hot, 5000);                                   // up to 8 s: 26400 pts
  const later = tr.drain();
  assert.ok(later.every((e) => e.type === 'drift_milestone'));
  assert.deepEqual(later.map((e) => e.score), [10000, 25000]);
  s.hold(hot, 3000);
  assert.deepEqual(tr.drain(), []);                    // nothing above 25000
});

test('a chain shorter than 3 s never emits milestones, even with a big score', () => {
  const tr = mk();
  const s = sim(tr);
  const hot = { SideslipDeg: 60, SpeedKmh: 250 };
  s.tick(hot);
  s.hold(hot, 2900);
  assert.ok(tr.state.score > 5000);
  s.hold(STRAIGHT, 1500);
  assert.deepEqual(types(tr.drain()), ['drift_start', 'drift_end']);
});

test('exposed milestone list and custom milestones', () => {
  assert.deepEqual([...DRIFT_MILESTONES], [500, 1000, 2000, 5000, 10000, 25000]);
  const tr = mk({ milestones: [300, 100] });
  const s = sim(tr);
  const hot = { SideslipDeg: 60, SpeedKmh: 200 };
  s.tick(hot);
  s.hold(hot, 3000);
  assert.deepEqual(tr.drain().filter((e) => e.type === 'drift_milestone').map((e) => e.score), [100, 300]);
});

test('timestamp jump above 250 ms ends the chain (banked) and the row can start a new one', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  tr.drain();
  s.t += 500;                                          // pause / teleport
  s.tick(D30);
  assert.deepEqual(types(tr.drain()), ['drift_end', 'drift_start']);
  assert.equal(tr.state.banked, 270);
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.score, 0);
});

test('a step of exactly 250 ms is not a discontinuity', () => {
  const tr = mk();
  const s = sim(tr, 1000, 250);
  s.tick(D30);
  s.tick(D30);
  s.tick(D30);
  assert.equal(tr.state.active, true);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  assert.equal(tr.state.driftTimeS, 0.5);
});

test('equal timestamps are a zero step (the game clock ticks every ~15.6 ms, rows come every ~13 ms)', () => {
  const exact = mk(), quant = mk();
  const se = sim(exact), sq = sim(quant);
  se.tick(D30); sq.tick(D30);
  const t0 = se.t;
  for (let i = 1; i <= 150; i++) {                              // 2 s of drifting at 75 rows/s
    const real = t0 + i * 13.333;
    exact.feed(row({ IsRaceOn: 1, TimestampMS: real, ...D30 }));
    quant.feed(row({ IsRaceOn: 1, TimestampMS: Math.floor(real / 15.625) * 15.625, ...D30 }));
  }
  assert.equal(quant.state.active, true);                       // duplicates never end the chain
  assert.equal(quant.drain().filter((e) => e.type === 'drift_end').length, 0);
  const ratio = quant.state.score / exact.state.score;
  assert.ok(ratio > 0.9 && ratio < 1.1, `quantised/exact score ${ratio}`);
});

test('backwards timestamps are discontinuities', () => {
  for (const delta of [-5, -100000]) {
    const tr = mk();
    const s = sim(tr);
    s.tick(D30);
    s.hold(D30, 1000);
    tr.drain();
    tr.feed(row({ IsRaceOn: 1, TimestampMS: s.t + delta, ...D30 }));
    assert.deepEqual(types(tr.drain()), ['drift_end', 'drift_start'], `delta ${delta}`);
    assert.equal(tr.state.banked, 270);
  }
});

test('a discontinuity discards a junk chain silently', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 12, SpeedKmh: 40 });
  s.t += 1000;
  s.tick(STRAIGHT);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  assert.equal(tr.state.active, false);
  assert.equal(tr.state.banked, 0);
});

test('IsRaceOn = 0 ends the chain and resets the clock (new session timestamps are fine)', () => {
  const tr = mk();
  const s = sim(tr, 500000);
  s.tick(D30);
  s.hold(D30, 1000);
  tr.drain();
  tr.feed(row({ IsRaceOn: 0, TimestampMS: s.t + 10, ...D30 }));
  assert.deepEqual(types(tr.drain()), ['drift_end']);
  assert.equal(tr.state.active, false);
  assert.equal(tr.state.banked, 270);
  // rows while paused do nothing
  for (let i = 0; i < 50; i++) tr.feed(row({ IsRaceOn: 0, TimestampMS: 10 + i, ...D30 }));
  assert.deepEqual(tr.drain(), []);
  // resumed with a much smaller timestamp: a plain new chain, no spurious extra end
  const s2 = sim(tr, 100);
  s2.tick(D30);
  s2.hold(D30, 500);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
  assert.equal(tr.state.score, 135);
});

test('spin-out (>120 deg) loses the chain without banking and emits drift_fail', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 2000);                                   // 675
  tr.drain();
  s.tick({ SideslipDeg: 121, SpeedKmh: 90 });
  assert.deepEqual(tr.drain(), [{ type: 'drift_fail', score: 675 }]);
  assert.equal(tr.state.active, false);
  assert.equal(tr.state.banked, 0);
  assert.equal(tr.state.best, 0);
  assert.equal(tr.state.score, 0);
  // still spinning: no new chain from >120 deg rows, and no repeated fail events
  s.hold({ SideslipDeg: -150, SpeedKmh: 90 }, 500);
  assert.deepEqual(tr.drain(), []);
});

test('exactly 120 deg is not a spin-out', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick({ SideslipDeg: 100, SpeedKmh: 90 });
  s.hold({ SideslipDeg: 120, SpeedKmh: 90 }, 500);
  assert.equal(tr.state.active, true);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
});

test('spin-out during a gap also fails the chain; a new chain can start afterwards', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  s.hold(STRAIGHT, 300);
  tr.drain();
  s.tick({ SideslipDeg: 170, SpeedKmh: 90 });
  assert.deepEqual(tr.drain(), [{ type: 'drift_fail', score: 270 }]);
  s.tick(D30);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
});

test('noisy 75 Hz timestamps (13/14 ms) integrate to the same score', () => {
  const tr = mk();
  let t = 5000;
  const feed = () => tr.feed(row({ IsRaceOn: 1, TimestampMS: t, SideslipDeg: 40, SpeedKmh: 100 }));
  feed();
  let n = 0;
  while (tr.state.driftTimeS < 3) { t += n++ % 2 ? 14 : 13; feed(); }
  // 400 pts/s: 1 s at x1 + 1 s at x1.5 + 1 s at x2 = 1800 (boundary rows can shift a few points)
  assert.ok(Math.abs(tr.state.score - 1800) < 15, `score ${tr.state.score}`);
});

test('malformed input is ignored without throwing or changing state', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 500);
  const before = tr.state;
  const bad = [
    null, undefined, 5, 'abc', {}, [], new Array(3).fill(0),
    row({ IsRaceOn: 1, TimestampMS: NaN, ...D30 }),
    row({ IsRaceOn: 1, TimestampMS: s.t + 10, SideslipDeg: NaN, SpeedKmh: 90 }),
    row({ IsRaceOn: 1, TimestampMS: s.t + 10, SideslipDeg: 30, SpeedKmh: Infinity }),
    row({ IsRaceOn: NaN, TimestampMS: s.t + 10, ...D30 }),
    row({ IsRaceOn: 1, TimestampMS: '1500', ...D30 }),
  ];
  for (const b of bad) assert.doesNotThrow(() => tr.feed(b));
  assert.deepEqual(tr.state, before);
  s.tick(D30);                                         // the next good row continues normally
  assert.equal(tr.state.active, true);
  assert.equal(tr.state.driftTimeS, 0.51);
});

test('missing keys in F: everything is ignored, nothing throws', () => {
  for (const maps of [undefined, null, {}, { F: {} }, { F: { SpeedKmh: 3 } }]) {
    const tr = new DriftTracker(maps);
    assert.doesNotThrow(() => tr.feed(row({ IsRaceOn: 1, TimestampMS: 1, ...D30 })));
    assert.equal(tr.state.active, false);
    assert.deepEqual(tr.drain(), []);
  }
});

test('IsRaceOn missing from F is treated as always racing', () => {
  const F2 = { ...F };
  delete F2.IsRaceOn;
  const tr = new DriftTracker({ F: F2, S });
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  assert.equal(tr.state.score, 270);
});

test('drain returns pending events once; state returns a fresh object', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  const a = tr.drain();
  assert.deepEqual(types(a), ['drift_start']);
  assert.deepEqual(tr.drain(), []);
  const st = tr.state;
  st.score = 123456;
  st.last = 'x';
  assert.notEqual(tr.state.score, 123456);
  assert.notEqual(tr.state, tr.state);
});

test('reset clears chain, totals, bests and pending events', () => {
  const tr = mk();
  const s = sim(tr);
  s.tick(D30);
  s.hold(D30, 1000);
  s.hold(STRAIGHT, 1500);
  s.tick(D30);
  tr.reset();
  assert.deepEqual(tr.drain(), []);
  assert.deepEqual(tr.state, {
    active: false, scoring: false, angleDeg: 0, score: 0, mult: 1, chainTimeS: 0, driftTimeS: 0,
    maxAngleDeg: 0, banked: 0, best: 0, sessionBestAngle: 0, gapS: 0, last: null,
  });
  // the clock was reset too: an old/smaller timestamp is not a discontinuity-ended phantom chain
  const s2 = sim(tr, 10);
  s2.tick(D30);
  s2.hold(D30, 100);
  assert.deepEqual(types(tr.drain()), ['drift_start']);
});

test('options override thresholds', () => {
  const tr = mk({ startAngle: 20, startSpeed: 60, gapS: 0.5 });
  const s = sim(tr);
  s.hold({ SideslipDeg: 19.9, SpeedKmh: 100 }, 100);
  s.hold({ SideslipDeg: 25, SpeedKmh: 59 }, 100);
  assert.equal(tr.state.active, false);
  s.tick({ SideslipDeg: 20, SpeedKmh: 60 });
  assert.equal(tr.state.active, true);
  s.hold(STRAIGHT, 500);
  assert.equal(tr.state.active, true);
  s.tick(STRAIGHT);
  assert.equal(tr.state.active, false);
});

test('bad option values fall back to the defaults', () => {
  const tr = mk({ startAngle: 'x', gapS: NaN, milestones: 'nope' });
  const s = sim(tr);
  s.tick({ SideslipDeg: 11.9, SpeedKmh: 100 });
  assert.equal(tr.state.active, false);
  s.tick({ SideslipDeg: 12, SpeedKmh: 100 });
  assert.equal(tr.state.active, true);
});

test('the event queue is bounded if nobody drains it', () => {
  const tr = mk();
  const s = sim(tr);
  for (let i = 0; i < 2000; i++) {
    s.tick({ SideslipDeg: 20, SpeedKmh: 60 });         // start
    s.t += 1000;                                       // discontinuity -> junk chain dropped
  }
  assert.ok(tr.drain().length <= 512);
});
