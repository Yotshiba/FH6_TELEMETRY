import test from 'node:test';
import assert from 'node:assert/strict';
import { LapDelta } from '../../fh6_telemetry/web/static/lap.js';

// A subset of the slow table in a deliberately scrambled order (the tracker must use the maps, not positions).
const SKEYS = [
  'TireSlipRatioFL', 'WheelFlags', 'RacePosition', 'DistanceTraveled', 'LastLapMs', 'CurrentRaceTimeMs',
  'CurrentLapMs', 'BestLapMs', 'LapNumber', 'CarClass', 'BoostPsi',
];
const S = Object.fromEntries(SKEYS.map((k, i) => [k, i]));
const slowRow = (o) => {
  const r = new Array(SKEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) if (k in S) r[S[k]] = v;
  return r;
};

/**
 * Constant-speed laps. Each lap is {length (m), speed (m/s)}. Returns the snapshots (with the lap index) and the
 * lap segments. Snapshots arrive every `step` ms starting at `phase`.
 */
function simulate(laps, { phase = 0, step = 100, startLap = 1, startDist = 0 } = {}) {
  const segs = [];
  let g = 0;
  let d = startDist;
  laps.forEach((l, i) => {
    const T = (l.length / l.speed) * 1000;
    segs.push({ lap: startLap + i, g0: g, g1: g + T, d0: d, speed: l.speed, T });
    g += T;
    d += l.length;
  });
  const snaps = [];
  for (let t = phase; t < g; t += step) {
    const i = segs.findIndex((x) => t >= x.g0 && t < x.g1);
    const s = segs[i];
    const cur = Math.round(t - s.g0);
    snaps.push({
      i,
      LapNumber: s.lap,
      CurrentLapMs: cur,
      DistanceTraveled: s.d0 + (s.speed * cur) / 1000,
      LastLapMs: i > 0 ? segs[i - 1].T : 0,
      BestLapMs: i > 0 ? Math.min(...segs.slice(0, i).map((x) => x.T)) : 0,
      x: (s.speed * cur) / 1000,          // true distance into the lap
    });
  }
  return { snaps, segs };
}

/** Feed snapshots and return [{snap, state}] plus every event. */
function run(snaps, tracker = new LapDelta({ S })) {
  const out = [];
  const events = [];
  for (const sn of snaps) {
    tracker.feedSlow(slowRow(sn));
    events.push(...tracker.drain());
    out.push({ sn, st: tracker.state });
  }
  return { tracker, out, events };
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +- ${tol}, got ${a}`);

const LAPS = [
  { length: 1000, speed: 50 },      // 20 s
  { length: 1000, speed: 62.5 },    // 16 s
  { length: 1000, speed: 40 },      // 25 s
  { length: 1000, speed: 80 },      // 12.5 s
  { length: 1000, speed: 50 },      // 20 s (never completes: nothing follows it)
];

// ---- delta ------------------------------------------------------------------------------------------------------

test('initial state before any snapshot', () => {
  const t = new LapDelta({ S });
  assert.deepEqual(t.state, { valid: false, deltaS: 0, refLapMs: 0, lapNumber: 0, progress: 0 });
  assert.deepEqual(t.drain(), []);
});

test('delta against the best lap, lap after lap (snapshots exactly on the line)', () => {
  const { snaps } = simulate(LAPS);
  const { out, events } = run(snaps);

  assert.deepEqual(events, [
    { type: 'lap', number: 1, timeMs: 20000, best: true },
    { type: 'lap', number: 2, timeMs: 16000, best: true },
    { type: 'lap', number: 3, timeMs: 25000, best: false },
    { type: 'lap', number: 4, timeMs: 12500, best: true },
  ]);

  // reference lap per lap driven: lap 2 is measured against lap 1, laps 3 and 4 against lap 2, lap 5 against lap 4
  const refs = [0, 20000, 16000, 16000, 12500];
  for (const { sn, st } of out) {
    assert.equal(st.lapNumber, sn.LapNumber);
    assert.equal(st.refLapMs, refs[sn.i], `refLapMs in lap ${sn.i + 1}`);
    if (sn.i === 0) { assert.equal(st.valid, false); assert.equal(st.deltaS, 0); continue; }
    if (sn.x < 10) continue;
    assert.equal(st.valid, true, `valid at lap ${sn.i + 1} x=${sn.x}`);
    const refSpeed = 1000 / (refs[sn.i] / 1000);                       // the reference lap's constant speed
    near(st.deltaS, sn.CurrentLapMs / 1000 - sn.x / refSpeed, 0.02, `lap ${sn.i + 1} x=${sn.x}`);
  }
});

test('delta is negative when ahead of the reference and positive when behind', () => {
  const { snaps } = simulate(LAPS.slice(0, 3));
  const { out } = run(snaps);
  const mid = (i) => out.find((o) => o.sn.i === i && o.sn.x >= 500);
  assert.ok(mid(1).st.deltaS < -1.9 && mid(1).st.deltaS > -2.1, `lap 2 ahead: ${mid(1).st.deltaS}`);     // 8 s -> 10 s per 500 m
  assert.ok(mid(2).st.deltaS > 0, 'lap 3 behind lap 2');
});

test('snapshots that miss the line by a random phase still give a delta within a few hundredths', () => {
  for (const phase of [13, 37, 50, 77, 99]) {
    const { snaps } = simulate(LAPS.slice(0, 3), { phase });
    const { out } = run(snaps);
    for (const { sn, st } of out) {
      if (sn.i !== 1 || sn.x < 20) continue;
      assert.equal(st.valid, true);
      const expected = sn.CurrentLapMs / 1000 - sn.x / 50;              // reference: lap 1 at 50 m/s
      // the very first lap is anchored at its first snapshot, so allow that offset (<= 0.1 s * 50 m/s / 50 m/s)
      near(st.deltaS, expected, 0.12, `phase ${phase} x=${sn.x}`);
    }
  }
});

test('after lap 2 the reference is lap 2; its own interpolated crossing keeps lap 3 tight', () => {
  // the reference of lap 3 (lap 2 at 62.5 m/s) was anchored by an interpolated crossing, so the error is small
  const { snaps } = simulate(LAPS.slice(0, 3), { phase: 37 });
  const { out } = run(snaps);
  for (const { sn, st } of out) {
    if (sn.i !== 2 || sn.x < 20) continue;
    const expected = sn.CurrentLapMs / 1000 - sn.x / 62.5;
    near(st.deltaS, expected, 0.03, `x=${sn.x}`);
  }
});

test('equal laps give a delta of about zero', () => {
  const same = [1, 2, 3].map(() => ({ length: 1200, speed: 40 }));
  const { out } = run(simulate(same).snaps);
  for (const { sn, st } of out) if (sn.i > 0 && sn.x > 10) near(st.deltaS, 0, 0.01);
});

test('progress runs 0..1 along the reference lap and is 0 without one', () => {
  const { out } = run(simulate(LAPS.slice(0, 3)).snaps);
  for (const { sn, st } of out) {
    if (sn.i === 0) { assert.equal(st.progress, 0); continue; }
    near(st.progress, Math.min(1, sn.x / 1000), 0.01);
  }
});

test('a slower lap or an equal lap does not replace the reference', () => {
  const laps = [
    { length: 1000, speed: 50 }, { length: 1000, speed: 40 }, { length: 1000, speed: 50 }, { length: 1000, speed: 50 },
  ];
  const { out, events } = run(simulate(laps).snaps);
  assert.deepEqual(events.map((e) => e.best), [true, false, false]);
  assert.equal(out[out.length - 1].st.refLapMs, 20000);
});

test('delta is valid from LapNumber 1 on only; lap 0 never is', () => {
  const { out, events } = run(simulate(LAPS.slice(0, 3), { startLap: 0 }).snaps);
  assert.equal(events[0].number, 0);
  for (const { sn, st } of out) {
    if (sn.LapNumber === 0) assert.equal(st.valid, false);
    if (sn.LapNumber === 1 && sn.x > 10) assert.equal(st.valid, true);
  }
});

test('the delta needs more than 1 m into the lap', () => {
  const { snaps } = simulate(LAPS.slice(0, 1));
  const t = new LapDelta({ S });
  for (const sn of snaps) t.feedSlow(slowRow(sn));
  const next = (cur, x) => t.feedSlow(slowRow({ LapNumber: 2, CurrentLapMs: cur, DistanceTraveled: 1000 + x, LastLapMs: 20000, BestLapMs: 20000 }));
  next(0, 0);
  assert.equal(t.state.valid, false);
  next(10, 0.5);
  assert.equal(t.state.valid, false);
  next(20, 1);
  assert.equal(t.state.valid, false);
  next(30, 1.5);
  assert.equal(t.state.valid, true);
});

test('the lap start is interpolated between the snapshots around the line', () => {
  // 50 m/s, 1000 m laps, snapshots every 100 ms; lap 1 is sampled on the 100 ms grid (last one at 19.9 s) but lap 2
  // is sampled 50 ms off the grid (first one at 20.05 s, 2.5 m past the line).
  const t = new LapDelta({ S });
  for (let k = 0; k < 200; k++) t.feedSlow(slowRow({ LapNumber: 1, CurrentLapMs: k * 100, DistanceTraveled: 5 * k }));
  const states = [];
  for (let k = 0; k < 100; k++) {
    t.feedSlow(slowRow({
      LapNumber: 2, CurrentLapMs: 50 + k * 100, DistanceTraveled: 1002.5 + 5 * k, LastLapMs: 20000, BestLapMs: 20000,
    }));
    states.push(t.state);
  }
  // Anchoring lap 2 at its first snapshot instead of the interpolated line would read +0.05 s here.
  for (const st of states) { assert.equal(st.valid, true); near(st.deltaS, 0, 0.01); }
});

// ---- when it must not be valid ------------------------------------------------------------------------------------

test('free roam (distance stuck at 0) is never valid and records no reference', () => {
  const snaps = [];
  for (let i = 0; i < 400; i++) {
    snaps.push({ LapNumber: 1 + Math.floor(i / 100), CurrentLapMs: (i % 100) * 100, DistanceTraveled: 0, LastLapMs: i >= 100 ? 9900 : 0 });
  }
  const { out, events } = run(snaps);
  assert.ok(out.every(({ st }) => st.valid === false && st.deltaS === 0 && st.refLapMs === 0));
  assert.equal(events.length, 3);                       // the laps still complete
  assert.ok(events.every((e) => e.timeMs === 9900));
});

test('joined mid-lap: that lap is reported but is no reference; the next full lap becomes one', () => {
  const { snaps } = simulate([
    { length: 1000, speed: 50 }, { length: 1000, speed: 62.5 }, { length: 1000, speed: 40 }, { length: 1000, speed: 50 },
  ]);
  const late = snaps.filter((s) => s.i > 0 || s.CurrentLapMs >= 8000);     // first snapshot is 8 s into lap 1
  const { out, events } = run(late);
  assert.deepEqual(events.map((e) => [e.number, e.timeMs]), [[1, 20000], [2, 16000], [3, 25000]]);
  for (const { sn, st } of out) {
    if (sn.i <= 1) assert.equal(st.valid, false, `lap ${sn.i + 1}`);
    if (sn.i === 2 && sn.x > 10) {
      assert.equal(st.valid, true);
      assert.equal(st.refLapMs, 16000);
    }
  }
});

test('a lap that is not seen from its start is not valid even if a reference exists', () => {
  // laps 1-2 complete normally, then the stream skips the start of lap 3 (cur jumps past 2 s without crossing info)
  const { snaps } = simulate(LAPS.slice(0, 4));
  const t = new LapDelta({ S });
  for (const sn of snaps.filter((s) => s.i < 2)) t.feedSlow(slowRow(sn));
  t.drain();
  const l3 = snaps.filter((s) => s.i === 2);
  // lap 3 starts with LastLapMs 0 (unknown crossing) and a late first snapshot
  t.feedSlow(slowRow({ ...l3[40], LastLapMs: 0 }));
  assert.equal(t.state.valid, false);
  t.feedSlow(slowRow({ ...l3[60], LastLapMs: 0 }));
  assert.equal(t.state.valid, false);
});

test('LastLapMs of 0 falls back to the last CurrentLapMs seen', () => {
  const { snaps } = simulate(LAPS.slice(0, 3));
  const { events, out } = run(snaps.map((s) => ({ ...s, LastLapMs: 0 })));
  assert.deepEqual(events.map((e) => e.timeMs), [19900, 15900]);
  assert.deepEqual(events.map((e) => e.best), [true, true]);
  // still usable: lap 2 is compared with lap 1
  const o = out.find((x) => x.sn.i === 1 && x.sn.x >= 500);
  assert.equal(o.st.valid, true);
  near(o.st.deltaS, -2, 0.1);
});

test('a stale LastLapMs shorter than what was actually driven is ignored', () => {
  const { snaps } = simulate(LAPS.slice(0, 2));
  const { events } = run(snaps.map((s) => (s.i === 1 ? { ...s, LastLapMs: 5000 } : s)));
  assert.equal(events[0].timeMs, 19900);
});

test('LapNumber going down is a session change: reference and current lap are dropped, events kept', () => {
  const { snaps } = simulate(LAPS.slice(0, 3));
  const t = new LapDelta({ S });
  for (const sn of snaps) t.feedSlow(slowRow(sn));
  assert.equal(t.state.refLapMs, 16000);
  t.feedSlow(slowRow({ LapNumber: 1, CurrentLapMs: 100, DistanceTraveled: 5 }));
  assert.equal(t.state.refLapMs, 0);
  assert.equal(t.state.valid, false);
  assert.equal(t.state.lapNumber, 1);
  assert.equal(t.drain().length, 2);                    // events queued before the restart survive
  // and the new session works from scratch
  const again = simulate(LAPS.slice(0, 2), { startDist: 5 });
  const { events } = run(again.snaps, t);
  assert.equal(events[0].best, true);
});

test('a distance counter reset in the middle of a lap spoils that lap only', () => {
  const { snaps } = simulate(LAPS.slice(0, 4));
  const bad = snaps.map((s) => (s.i === 2 && s.x > 400 ? { ...s, DistanceTraveled: s.x - 400 } : s));   // counter restarts
  const { out, events } = run(bad);
  assert.equal(events.length, 3);
  const during = out.filter((o) => o.sn.i === 2 && o.sn.x > 600);
  assert.ok(during.every((o) => o.st.valid === false));
  // lap 3 would have been slower anyway; make it faster and check it is still not taken as the reference
  const fast = [{ length: 1000, speed: 50 }, { length: 1000, speed: 40 }, { length: 1000, speed: 80 }, { length: 1000, speed: 50 }];
  const s2 = simulate(fast).snaps.map((s) => (s.i === 2 && s.x > 400 ? { ...s, DistanceTraveled: s.x - 400 } : s));
  const r2 = run(s2);
  assert.equal(r2.events[2].best, true);                 // the lap time is still a best time
  assert.equal(r2.out[r2.out.length - 1].st.refLapMs, 20000);   // but it never became the reference (lap 2, 25 s, is slower; lap 1 stays)
});

test('flashback inside a lap: samples after the rewind point are discarded', () => {
  const t = new LapDelta({ S });
  const states = [];
  const feed = (lap, cur, dist, last = 0, best = 0) => {
    t.feedSlow(slowRow({ LapNumber: lap, CurrentLapMs: cur, DistanceTraveled: dist, LastLapMs: last, BestLapMs: best }));
    states.push(t.state);
  };
  for (let k = 0; k < 200; k++) feed(1, k * 100, 5 * k);                         // lap 1: 50 m/s, 20 s
  const lap2 = (cur, x) => feed(2, cur, 1000 + x, 20000, 20000);
  for (let k = 0; k <= 96; k++) lap2(k * 100, 6.25 * k);                         // 62.5 m/s up to x = 600 (9.6 s)
  const before = states.length;
  for (let j = 0; j <= 50; j++) lap2(6400 + j * 100, 400 + 4 * j);               // rewind to x = 400, now at 40 m/s
  for (let j = 1; j <= 64; j++) lap2(11400 + j * 100, 600 + 6.25 * j);           // back to 62.5 m/s, lap ends at 17.8 s
  assert.ok(states.slice(before).every((st) => st.valid), 'stays valid through the rewind');

  // lap 3 at 62.5 m/s against the path that was driven the second time round (lap 2 = new reference, 17.8 s)
  const feed3 = (cur, x) => feed(3, cur, 2000 + x, 17800, 17800);
  const out = [];
  for (let k = 0; k <= 160; k++) {
    feed3(50 + k * 100, 6.25 * (50 + k * 100) / 100);
    out.push({ cur: 50 + k * 100, x: 6.25 * (50 + k * 100) / 100, st: t.state });
  }
  assert.equal(t.state.refLapMs, 17800);
  const refT = (x) => (x <= 400 ? x / 62.5 : x <= 600 ? 6.4 + (x - 400) / 40 : 11.4 + (x - 600) / 62.5) * 1000;
  for (const o of out) {
    if (o.x < 10 || o.x > 990) continue;
    assert.equal(o.st.valid, true);
    near(o.st.deltaS, (o.cur - refT(o.x)) / 1000, 0.03, `x=${o.x}`);
  }
  assert.deepEqual(t.drain().map((e) => [e.number, e.timeMs]), [[1, 20000], [2, 17800]]);
});

test('delta follows the reference slightly past its end, then gives up', () => {
  const { snaps } = simulate([{ length: 1000, speed: 50 }, { length: 1060, speed: 50 }, { length: 1000, speed: 50 }]);
  const { out } = run(snaps);
  const lap2 = out.filter((o) => o.sn.i === 1);
  const inside = lap2.filter((o) => o.sn.x > 1002 && o.sn.x < 1020);
  assert.ok(inside.length > 0);
  for (const o of inside) { assert.equal(o.st.valid, true); near(o.st.deltaS, 0, 0.05); }
  const beyond = lap2.filter((o) => o.sn.x > 1030);
  assert.ok(beyond.length > 0);
  assert.ok(beyond.every((o) => o.st.valid === false));
  assert.ok(beyond.every((o) => o.st.progress === 1));
});

test('spacing: samples closer than 5 m do not matter, sparse snapshots still interpolate', () => {
  // 1 Hz snapshots at 50 m/s are 50 m apart: coarse but linear -> still accurate for constant speed laps
  const { snaps } = simulate(LAPS.slice(0, 3), { step: 1000 });
  const { out } = run(snaps);
  for (const { sn, st } of out) {
    if (sn.i !== 1 || sn.x < 60) continue;
    assert.equal(st.valid, true);
    near(st.deltaS, sn.CurrentLapMs / 1000 - sn.x / 50, 0.15);
  }
  // 20 Hz at walking pace: 1 m steps, still fine
  const slow = simulate([{ length: 200, speed: 20 }, { length: 200, speed: 25 }, { length: 200, speed: 25 }], { step: 50 });
  const r = run(slow.snaps);
  const o = r.out.find((x) => x.sn.i === 1 && x.sn.x > 100);
  near(o.st.deltaS, o.sn.CurrentLapMs / 1000 - o.sn.x / 20, 0.1);
});

// ---- robustness ----------------------------------------------------------------------------------------------------

test('feed() is a no-op and feedSlow ignores malformed snapshots', () => {
  const t = new LapDelta({ S });
  assert.doesNotThrow(() => t.feed([1, 2, 3]));
  for (const bad of [null, undefined, 3, 'x', [], [1, 2], slowRow({ LapNumber: NaN, CurrentLapMs: 5, DistanceTraveled: 5 }),
    slowRow({ LapNumber: 1, CurrentLapMs: NaN, DistanceTraveled: 5 }), slowRow({ LapNumber: 1, CurrentLapMs: 5, DistanceTraveled: NaN }),
    slowRow({ LapNumber: -1, CurrentLapMs: 5, DistanceTraveled: 5 })]) {
    assert.doesNotThrow(() => t.feedSlow(bad));
  }
  assert.deepEqual(t.state, { valid: false, deltaS: 0, refLapMs: 0, lapNumber: 0, progress: 0 });
  assert.deepEqual(t.drain(), []);
});

test('missing columns never throw', () => {
  const t = new LapDelta({ S: { LapNumber: 0 } });
  assert.doesNotThrow(() => t.feedSlow([1, 2, 3]));
  const u = new LapDelta(undefined);
  assert.doesNotThrow(() => u.feedSlow([1, 2, 3]));
  // BestLapMs / LastLapMs are optional
  const keys = { LapNumber: 0, CurrentLapMs: 1, DistanceTraveled: 2 };
  const v = new LapDelta({ S: keys });
  const events = [];
  for (let lap = 1; lap <= 3; lap++) {
    for (let k = 0; k < 100; k++) {
      v.feedSlow([lap, k * 100, (lap - 1) * 500 + k * 5]);
      events.push(...v.drain());
    }
  }
  assert.equal(events.length, 2);
  assert.equal(v.state.valid, true);
});

test('negative CurrentLapMs is treated as 0', () => {
  const t = new LapDelta({ S });
  assert.doesNotThrow(() => t.feedSlow(slowRow({ LapNumber: 1, CurrentLapMs: -50, DistanceTraveled: 0 })));
  assert.equal(t.state.lapNumber, 1);
});

test('a skipped lap number is handled without a bogus lap event', () => {
  const { snaps } = simulate(LAPS.slice(0, 4));
  const t = new LapDelta({ S });
  for (const sn of snaps.filter((s) => s.i < 1)) t.feedSlow(slowRow(sn));
  t.drain();
  const l3 = snaps.filter((s) => s.i === 2);
  t.feedSlow(slowRow(l3[5]));                           // lap 1 -> lap 3
  assert.deepEqual(t.drain(), []);
  assert.equal(t.state.lapNumber, 3);
});

test('reset() clears the reference, the lap and the queue', () => {
  const { snaps } = simulate(LAPS.slice(0, 3));
  const t = new LapDelta({ S });
  for (const sn of snaps) t.feedSlow(slowRow(sn));
  t.reset();
  assert.deepEqual(t.state, { valid: false, deltaS: 0, refLapMs: 0, lapNumber: 0, progress: 0 });
  assert.deepEqual(t.drain(), []);
  // restarting with the same data produces the same events again
  const { events } = run(snaps, t);
  assert.equal(events.length, 2);
});

test('state is a snapshot; drain clears the queue', () => {
  const { snaps } = simulate(LAPS.slice(0, 2));
  const t = new LapDelta({ S });
  for (const sn of snaps) t.feedSlow(slowRow(sn));
  const s = t.state;
  s.valid = false;
  s.deltaS = 99;
  assert.notEqual(t.state.deltaS, 99);
  assert.equal(t.drain().length, 1);
  assert.deepEqual(t.drain(), []);
});

test('the event queue is capped', () => {
  const t = new LapDelta({ S }, { maxEvents: 2 });
  for (let lap = 1; lap <= 10; lap++) {
    for (let k = 0; k < 10; k++) t.feedSlow(slowRow({ LapNumber: lap, CurrentLapMs: k * 300, DistanceTraveled: (lap - 1) * 100 + k * 10, LastLapMs: lap > 1 ? 2700 : 0 }));   // 2.7 s laps (a lap must show >= 2 s to count)
  }
  const ev = t.drain();
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => e.number), [8, 9]);
});

test('a 0 -> 1 lap counter change is a race start, not a finished lap (stale LastLapMs gives no phantom "lap 0")', () => {
  const S = { LapNumber: 0, CurrentLapMs: 1, DistanceTraveled: 2, LastLapMs: 3, BestLapMs: 4 };
  const slow = (lap, cur, dist, last = 0, best = 0) => [lap, cur, dist, last, best];
  const m = new LapDelta({ S });
  m.feedSlow(slow(0, 0, 0));
  m.feedSlow(slow(0, 0, 0, 91000, 91000));          // free roam, but the game still reports the previous race's lap time
  m.feedSlow(slow(1, 100, 1, 91000, 91000));
  m.feedSlow(slow(1, 5000, 80, 91000, 91000));
  assert.deepEqual(m.drain(), []);
  assert.equal(m.state.lapNumber, 1);
  // ... and the first real lap still completes normally
  m.feedSlow(slow(1, 59000, 3000, 91000, 91000));
  m.feedSlow(slow(2, 200, 3010, 59500, 59500));
  const ev = m.drain();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'lap');
  assert.equal(ev[0].number, 1);
  assert.equal(ev[0].timeMs, 59500);
});
