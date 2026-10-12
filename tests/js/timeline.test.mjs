import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../../fh6_telemetry/web/static/timeline.js';

const KEYS = ['TimestampMS', 'SpeedKmh', 'CurrentEngineRpm', 'Gear'];

/** Row from a key->value object (default 0), in KEYS order. */
const mk = (o = {}) => KEYS.map((k) => (k in o ? o[k] : 0));
const row = (ms, speed = 0, rpm = 0, gear = 0) => [ms, speed, rpm, gear];

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

/** 100 Hz-ish constant 13 ms rows: speed = index. */
function filled(n, opts = {}, startMs = 1000) {
  const tl = new Timeline({ keys: KEYS, ...opts });
  for (let i = 0; i < n; i++) tl.push(row(startMs + 13 * i, i, 1000 + i, i % 6));
  return tl;
}

function assertMonotonic(tl) {
  for (let i = 1; i < tl.length; i++) {
    assert.ok(tl.timeAt(i) >= tl.timeAt(i - 1), `time went backwards at ${i}`);
  }
}

// --- construction / empty behaviour ----------------------------------------------------------------

test('defaults and accessors', () => {
  const tl = new Timeline({ keys: KEYS });
  assert.equal(tl.capacity, 22500);
  assert.equal(tl.length, 0);
  assert.deepEqual([...tl.keys], KEYS);
  assert.ok(tl.has('Gear'));
  assert.ok(!tl.has('Nope'));
  assert.ok(!tl.has('__proto__'));
  assert.ok(!tl.has('constructor'));
});

test('empty timeline answers safely', () => {
  const tl = new Timeline({ keys: KEYS });
  assert.ok(Number.isNaN(tl.latestTime()));
  assert.ok(Number.isNaN(tl.earliestTime()));
  assert.equal(tl.indexAtTime(0), -1);
  assert.equal(tl.valueAtTime('SpeedKmh', 0), null);
  assert.equal(tl.row(0), null);
  assert.ok(Number.isNaN(tl.get(0, 'SpeedKmh')));
  assert.ok(Number.isNaN(tl.timeAt(0)));
  assert.deepEqual(tl.segments, []);
  assert.deepEqual(tl.stats('SpeedKmh', 0, 10), { min: NaN, max: NaN, mean: NaN, count: 0 });
  const w = tl.window('SpeedKmh', 0, 1, 4);
  assert.equal(w.n, 0);
  assert.equal(w.min.length, 4);
  assert.ok([...w.min, ...w.max].every(Number.isNaN));
  assert.equal(tl.toCSV(), 'time_s,TimestampMS,SpeedKmh,CurrentEngineRpm,Gear\n');
});

test('constructor tolerates bad options', () => {
  for (const bad of [undefined, null, 5, 'x', {}, { keys: 'abc' }, { keys: null }]) {
    const tl = new Timeline(bad);
    assert.equal(tl.length, 0);
    assert.deepEqual([...tl.keys], []);
    assert.deepEqual(tl.segments, []);
    assert.equal(tl.toCSV(), 'time_s\n');
  }
  for (const cap of [0, -3, NaN, 'abc', undefined, Infinity]) {
    assert.equal(new Timeline({ keys: KEYS, capacity: cap }).capacity, 22500, String(cap));
  }
  assert.equal(new Timeline({ keys: KEYS, capacity: 7.9 }).capacity, 7);
  assert.equal(new Timeline({ keys: KEYS, capacity: 1 }).capacity, 1);
});

// --- push / get / row ----------------------------------------------------------------------------------

test('push ignores non-arrays and rows without a finite timestamp', () => {
  const tl = new Timeline({ keys: KEYS });
  for (const bad of [null, undefined, 5, 'abc', {}, { 0: 1, length: 4 }, new DataView(new ArrayBuffer(8)), []]) {
    assert.equal(tl.push(bad), false);
  }
  for (const ms of [NaN, Infinity, -Infinity, undefined, null, '1000', {}]) {
    assert.equal(tl.push([ms, 1, 2, 3]), false);
  }
  assert.equal(tl.length, 0);
  assert.equal(tl.push(row(1000, 1, 2, 3)), true);
  assert.equal(tl.length, 1);
});

test('push accepts typed-array rows', () => {
  const tl = new Timeline({ keys: KEYS });
  assert.equal(tl.push(new Float64Array([1000, 50, 3000, 2])), true);
  assert.deepEqual(tl.row(0), [1000, 50, 3000, 2]);
});

test('short rows and non-numeric cells are stored as NaN', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push([1000, 10]);
  tl.push([1013, 'x', null, undefined]);
  assert.equal(tl.get(0, 'SpeedKmh'), 10);
  assert.ok(Number.isNaN(tl.get(0, 'CurrentEngineRpm')));
  assert.ok(Number.isNaN(tl.get(0, 'Gear')));
  assert.ok(Number.isNaN(tl.get(1, 'SpeedKmh')));
  assert.ok(Number.isNaN(tl.get(1, 'Gear')));
  assert.equal(tl.get(1, 'TimestampMS'), 1013);
});

test('get / row / timeAt basics', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(5000, 100.5, 7000, 3));
  tl.push(row(5013, 101.5, 7100, 3));
  tl.push(row(5026, 102.5, 7200, 4));
  assert.equal(tl.length, 3);
  assert.equal(tl.get(0, 'SpeedKmh'), 100.5);
  assert.equal(tl.get(2, 'Gear'), 4);
  assert.equal(tl.get(1, 'TimestampMS'), 5013);
  assert.deepEqual(tl.row(1), [5013, 101.5, 7100, 3]);
  assert.equal(tl.timeAt(0), 0);
  near(tl.timeAt(1), 0.013);
  near(tl.timeAt(2), 0.026);
  near(tl.latestTime(), 0.026);
  assert.equal(tl.earliestTime(), 0);
  // row() is a copy
  const r = tl.row(0);
  r[1] = -1;
  assert.equal(tl.get(0, 'SpeedKmh'), 100.5);
});

test('unknown keys and bad indices never throw', () => {
  const tl = filled(5);
  assert.ok(Number.isNaN(tl.get(0, 'Nope')));
  assert.ok(Number.isNaN(tl.get(0, undefined)));
  assert.ok(Number.isNaN(tl.get(0, '__proto__')));
  for (const i of [-1, 5, 1.5, NaN, undefined, '1', null, Infinity]) {
    assert.ok(Number.isNaN(tl.get(i, 'SpeedKmh')), String(i));
    assert.equal(tl.row(i), null, String(i));
    assert.ok(Number.isNaN(tl.timeAt(i)), String(i));
    assert.equal(tl.segmentAt(i), -1, String(i));
  }
  assert.equal(tl.valueAtTime('Nope', 0.01), null);
  assert.deepEqual(tl.stats('Nope', 0, 1), { min: NaN, max: NaN, mean: NaN, count: 0 });
  const w = tl.window('Nope', 0, 1, 3);
  assert.equal(w.n, 0);
  assert.equal(w.min.length, 3);
  assert.equal(tl.toCSV({ keys: ['Nope'] }), 'time_s\n'.concat('0\n', '0.013\n', '0.026\n', '0.039\n', '0.052\n'));
});

test('exact 32-bit timestamps survive (not stored as float32)', () => {
  const big = 4_294_000_001;                         // not representable in float32
  assert.notEqual(Math.fround(big), big);
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(big, 1));
  tl.push(row(big + 13, 2));
  tl.push(row(big + 26, 3));
  assert.equal(tl.get(0, 'TimestampMS'), big);
  assert.equal(tl.get(2, 'TimestampMS'), big + 26);
  assert.deepEqual(tl.row(1), [big + 13, 2, 0, 0]);
  near(tl.timeAt(2), 0.026);                          // relative time keeps full precision
  assert.ok(tl.toCSV().includes(`,${big + 26},`));
});

test('pushMany counts stored rows', () => {
  const tl = new Timeline({ keys: KEYS });
  assert.equal(tl.pushMany([row(1000), 'bad', row(1013), null]), 2);
  assert.equal(tl.pushMany(undefined), 0);
  assert.equal(tl.length, 2);
});

// --- ring behaviour ---------------------------------------------------------------------------------------

test('ring wraps: oldest rows are overwritten, logical order preserved', () => {
  const tl = new Timeline({ keys: KEYS, capacity: 5 });
  for (let i = 0; i < 12; i++) tl.push(row(1000 + 13 * i, i));
  assert.equal(tl.length, 5);
  assert.equal(tl.capacity, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => tl.get(i, 'SpeedKmh')), [7, 8, 9, 10, 11]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => tl.get(i, 'TimestampMS')), [1091, 1104, 1117, 1130, 1143]);
  near(tl.earliestTime(), 0.091);
  near(tl.latestTime(), 0.143);
  assert.ok(Number.isNaN(tl.get(5, 'SpeedKmh')));
  assertMonotonic(tl);
  tl.push(row(1156, 12));
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => tl.get(i, 'SpeedKmh')), [8, 9, 10, 11, 12]);
});

test('capacity 1 and exact-fill boundaries', () => {
  const one = new Timeline({ keys: KEYS, capacity: 1 });
  one.push(row(1000, 1));
  one.push(row(1013, 2));
  assert.equal(one.length, 1);
  assert.equal(one.get(0, 'SpeedKmh'), 2);
  near(one.latestTime(), 0.013);
  assert.equal(one.indexAtTime(-5), 0);
  assert.equal(one.valueAtTime('SpeedKmh', 0.013), 2);
  assert.equal(one.valueAtTime('SpeedKmh', 0.0), null);

  const tl = new Timeline({ keys: KEYS, capacity: 4 });
  for (let i = 0; i < 4; i++) tl.push(row(1000 + i, i));
  assert.deepEqual([0, 1, 2, 3].map((i) => tl.get(i, 'SpeedKmh')), [0, 1, 2, 3]);
  tl.push(row(1004, 4));
  assert.deepEqual([0, 1, 2, 3].map((i) => tl.get(i, 'SpeedKmh')), [1, 2, 3, 4]);
});

test('clear resets data, segments and the time origin', () => {
  const tl = new Timeline({ keys: KEYS, capacity: 5 });
  for (let i = 0; i < 8; i++) tl.push(row(1000 + 13 * i, i));
  tl.push(row(10, 99));                               // backwards -> segment 1
  assert.equal(tl.segments.length, 2);
  tl.clear();
  assert.equal(tl.length, 0);
  assert.deepEqual(tl.segments, []);
  assert.ok(Number.isNaN(tl.latestTime()));
  tl.push(row(777_000, 5));
  tl.push(row(777_013, 6));
  assert.equal(tl.timeAt(0), 0);
  near(tl.timeAt(1), 0.013);
  assert.deepEqual(tl.segments.map((s) => s.id), [0]);
});

// --- discontinuities / segments ----------------------------------------------------------------------------

test('a timestamp going backwards starts a new segment; time stays monotonic', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(50_000, 1));
  tl.push(row(50_013, 2));
  tl.push(row(50_026, 3));
  tl.push(row(1_000, 4));                             // new session
  tl.push(row(1_013, 5));
  tl.push(row(1_026, 6));
  assert.equal(tl.length, 6);
  assertMonotonic(tl);
  near(tl.timeAt(2), 0.026);
  near(tl.timeAt(3), 0.026 + 0.013);                  // gap of exactly one frame
  near(tl.timeAt(4), 0.026 + 0.013 + 0.013);
  near(tl.timeAt(5), 0.026 + 0.013 + 0.026);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => tl.segmentAt(i)), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(tl.segments.map(({ id, start, end }) => ({ id, start, end })), [
    { id: 0, start: 0, end: 2 }, { id: 1, start: 3, end: 5 },
  ]);
  const [a, b] = tl.segments;
  near(a.t0, 0); near(a.t1, 0.026); near(b.t0, 0.039); near(b.t1, 0.065);
  // raw timestamps are preserved
  assert.equal(tl.get(3, 'TimestampMS'), 1_000);
});

test('a forward jump of more than 2 s starts a new segment (2000 ms exactly does not)', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1_000));
  tl.push(row(3_000));                                // +2000: still the same segment
  assert.equal(tl.segments.length, 1);
  near(tl.timeAt(1), 2.0);
  tl.push(row(5_001));                                // +2001: new segment
  assert.equal(tl.segments.length, 2);
  near(tl.timeAt(2), 2.0 + 0.013);
  tl.push(row(5_014));
  near(tl.timeAt(3), 2.0 + 0.026);
  assertMonotonic(tl);
});

test('equal timestamps are kept, same time, no new segment', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1000, 1));
  tl.push(row(1013, 2));
  tl.push(row(1013, 3));
  tl.push(row(1013, 4));
  tl.push(row(1026, 5));
  assert.equal(tl.length, 5);
  assert.equal(tl.segments.length, 1);
  assert.equal(tl.timeAt(1), tl.timeAt(3));
  assertMonotonic(tl);
  assert.equal(tl.get(2, 'SpeedKmh'), 3);
});

test('many discontinuities keep time monotonic and ids consecutive', () => {
  const rand = rng(7);
  const tl = new Timeline({ keys: KEYS, capacity: 400 });
  let ms = 100_000;
  for (let i = 0; i < 2000; i++) {
    const r = rand();
    if (r < 0.02) ms -= 1 + Math.floor(rand() * 90_000);
    else if (r < 0.04) ms += 2001 + Math.floor(rand() * 10_000);
    else if (r < 0.1) ms += 0;
    else ms += 8 + Math.floor(rand() * 10);
    tl.push(row(ms, i));
  }
  assert.equal(tl.length, 400);
  assertMonotonic(tl);
  const segs = tl.segments;
  assert.ok(segs.length > 3);
  let next = 0;
  for (const s of segs) {
    assert.ok(s.start === next && s.end >= s.start);
    assert.equal(tl.segmentAt(s.start), s.id);
    assert.equal(tl.segmentAt(s.end), s.id);
    assert.equal(s.t0, tl.timeAt(s.start));
    assert.equal(s.t1, tl.timeAt(s.end));
    next = s.end + 1;
  }
  assert.equal(next, tl.length);
  for (let k = 1; k < segs.length; k++) assert.equal(segs[k].id, segs[k - 1].id + 1);
});

test('segments survive ring eviction (oldest one gets truncated, then dropped)', () => {
  const tl = new Timeline({ keys: KEYS, capacity: 6 });
  [0, 13, 26, 39].forEach((ms, i) => tl.push(row(100_000 + ms, i)));   // seg 0: 4 rows
  [0, 13, 26].forEach((ms, i) => tl.push(row(1_000 + ms, 10 + i)));    // seg 1: 3 rows -> evicts 1
  assert.equal(tl.length, 6);
  assert.deepEqual(tl.segments.map(({ id, start, end }) => [id, start, end]), [[0, 0, 2], [1, 3, 5]]);
  tl.push(row(1_039, 13));
  tl.push(row(1_052, 14));
  tl.push(row(1_065, 15));                                               // seg 0 fully evicted
  assert.deepEqual(tl.segments.map(({ id, start, end }) => [id, start, end]), [[1, 0, 5]]);
  assertMonotonic(tl);
});

test('no time column: rows are accepted with a synthetic ~75 Hz clock', () => {
  const tl = new Timeline({ keys: ['a', 'b'] });
  assert.equal(tl.push([1, 2]), true);
  assert.equal(tl.push([3, 4]), true);
  assert.equal(tl.length, 2);
  near(tl.timeAt(1), 1 / 75, 1e-12);
  assert.equal(tl.get(1, 'b'), 4);
  assert.deepEqual(tl.segments.length, 1);
});

test('custom timeKey, jumpMs and gapS', () => {
  const tl = new Timeline({ keys: ['x', 'clock'], timeKey: 'clock', jumpMs: 100, gapS: 0.5 });
  tl.push([1, 0]);
  tl.push([2, 50]);
  tl.push([3, 200]);                                   // +150 > 100 -> new segment, 0.5 s gap
  assert.equal(tl.segments.length, 2);
  near(tl.timeAt(1), 0.05);
  near(tl.timeAt(2), 0.55);
  assert.equal(tl.get(2, 'clock'), 200);
});

// --- indexAtTime -------------------------------------------------------------------------------------------

test('indexAtTime: nearest, clamped, ties go to the earlier row', () => {
  const tl = filled(10);                               // times 0, .013, ... .117
  assert.equal(tl.indexAtTime(0), 0);
  assert.equal(tl.indexAtTime(-100), 0);
  assert.equal(tl.indexAtTime(-Infinity), 0);
  assert.equal(tl.indexAtTime(100), 9);
  assert.equal(tl.indexAtTime(Infinity), 9);
  assert.equal(tl.indexAtTime(0.013), 1);
  assert.equal(tl.indexAtTime(0.0129), 1);
  assert.equal(tl.indexAtTime(0.0061), 0);
  assert.equal(tl.indexAtTime(0.0069), 1);
  assert.equal(tl.indexAtTime(0.0065), 0);              // exact midpoint of 0 and 0.013 -> earlier
  assert.equal(tl.indexAtTime(NaN), -1);
  assert.equal(tl.indexAtTime(undefined), -1);
  assert.equal(tl.indexAtTime('0.01'), -1);
});

test('indexAtTime works across wrap-around and agrees with brute force', () => {
  const rand = rng(11);
  const tl = new Timeline({ keys: KEYS, capacity: 64 });
  let ms = 5000;
  for (let i = 0; i < 200; i++) { ms += 5 + Math.floor(rand() * 20); tl.push(row(ms, i)); }
  for (let k = 0; k < 300; k++) {
    const t = tl.earliestTime() - 0.05 + rand() * (tl.latestTime() - tl.earliestTime() + 0.1);
    let best = 0;
    for (let i = 1; i < tl.length; i++) {
      if (Math.abs(tl.timeAt(i) - t) < Math.abs(tl.timeAt(best) - t)) best = i;   // strict: ties keep earlier
    }
    assert.equal(tl.indexAtTime(t), best, `t=${t}`);
  }
});

test('indexAtTime with duplicate timestamps returns one of the duplicates', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1000)); tl.push(row(1013)); tl.push(row(1013)); tl.push(row(1013)); tl.push(row(1026));
  const i = tl.indexAtTime(0.013);
  assert.ok(i >= 1 && i <= 3);
  assert.equal(tl.timeAt(i), tl.timeAt(1));
});

test('indexRange', () => {
  const tl = filled(10);
  assert.deepEqual(tl.indexRange(0.013, 0.039), { i0: 1, i1: 3 });
  assert.deepEqual(tl.indexRange(0.039, 0.013), { i0: 1, i1: 3 });
  assert.deepEqual(tl.indexRange(0.014, 0.038), { i0: 2, i1: 2 });
  assert.deepEqual(tl.indexRange(0.014, 0.0145), { i0: -1, i1: -1 });
  assert.deepEqual(tl.indexRange(-5, 100), { i0: 0, i1: 9 });
  assert.deepEqual(tl.indexRange(5, 6), { i0: -1, i1: -1 });
  assert.deepEqual(tl.indexRange(NaN, 1), { i0: -1, i1: -1 });
});

// --- window (min/max decimation) ----------------------------------------------------------------------------

/** Brute-force reference built only from the public per-row accessors. */
function refWindow(tl, key, t0, t1, px) {
  if (t0 > t1) [t0, t1] = [t1, t0];
  const min = new Float32Array(px).fill(NaN);
  const max = new Float32Array(px).fill(NaN);
  let n = 0;
  for (let i = 0; i < tl.length; i++) {
    const t = tl.timeAt(i);
    if (t < t0 || t > t1) continue;
    n++;
    const v = tl.get(i, key);
    if (!Number.isFinite(v)) continue;
    let c = t1 > t0 ? Math.floor((t - t0) / (t1 - t0) * px) : 0;
    c = Math.min(Math.max(c, 0), px - 1);
    if (Number.isNaN(min[c]) || v < min[c]) min[c] = v;
    if (Number.isNaN(max[c]) || v > max[c]) max[c] = v;
  }
  return { min, max, n };
}

function randomTimeline(seed, rows, capacity, opts = {}) {
  const rand = rng(seed);
  const tl = new Timeline({ keys: KEYS, capacity });
  let ms = 1_000_000;
  for (let i = 0; i < rows; i++) {
    const r = rand();
    if (opts.breaks && r < 0.01) ms -= 1 + Math.floor(rand() * 500_000);
    else if (opts.breaks && r < 0.02) ms += 2500;
    else ms += 6 + Math.floor(rand() * 14);
    const nan = opts.nan && rand() < 0.05;
    tl.push(row(ms, nan ? NaN : rand() * 300 - 50, rand() * 9000, Math.floor(rand() * 7)));
  }
  return tl;
}

test('window matches a brute-force reference on random data (with wrap, segments and NaN)', () => {
  for (const [seed, rows, cap] of [[1, 150, 500], [2, 900, 500], [3, 1234, 300], [4, 5000, 777]]) {
    const tl = randomTimeline(seed, rows, cap, { breaks: true, nan: true });
    const rand = rng(seed * 101);
    for (const key of ['SpeedKmh', 'CurrentEngineRpm', 'Gear']) {
      for (let k = 0; k < 40; k++) {
        const lo = tl.earliestTime(), hi = tl.latestTime();
        let a = lo - 0.2 + rand() * (hi - lo + 0.4);
        let b = lo - 0.2 + rand() * (hi - lo + 0.4);
        if (k % 7 === 0) [a, b] = [lo, hi];                       // whole buffer, edges exact
        const px = [1, 2, 3, 17, 64, 333, 1000][k % 7];
        const got = tl.window(key, a, b, px);
        const ref = refWindow(tl, key, a, b, px);
        assert.equal(got.n, ref.n, `n seed=${seed} key=${key} k=${k}`);
        assert.equal(got.min.length, px);
        assert.equal(got.max.length, px);
        assert.deepEqual(got.min, ref.min, `min seed=${seed} key=${key} k=${k}`);
        assert.deepEqual(got.max, ref.max, `max seed=${seed} key=${key} k=${k}`);
      }
    }
  }
});

test('window: every sample is in the column covering its time; globals are preserved', () => {
  const tl = randomTimeline(21, 3000, 3000, {});
  const t0 = tl.timeAt(100), t1 = tl.timeAt(2500), px = 250;
  const w = tl.window('SpeedKmh', t0, t1, px);
  let gMin = Infinity, gMax = -Infinity;
  for (let i = 100; i <= 2500; i++) {
    const v = tl.get(i, 'SpeedKmh');
    gMin = Math.min(gMin, v); gMax = Math.max(gMax, v);
    const c = Math.min(px - 1, Math.floor((tl.timeAt(i) - t0) / (t1 - t0) * px));
    assert.ok(w.min[c] <= v && v <= w.max[c], `sample ${i} outside its column ${c}`);
  }
  assert.equal(Math.min(...w.min.filter((x) => !Number.isNaN(x))), gMin);
  assert.equal(Math.max(...w.max.filter((x) => !Number.isNaN(x))), gMax);
  assert.equal(w.n, 2401);
  assert.equal(w.i0, 100);
  assert.equal(w.i1, 2500);
});

test('window includes the first and last point of the window', () => {
  const tl = filled(100);                                          // speed = index, t = 0.013 * i
  const t0 = tl.timeAt(10), t1 = tl.timeAt(60);
  const w = tl.window('SpeedKmh', t0, t1, 10);
  assert.equal(w.min[0], 10);                                      // first point -> first column
  assert.equal(w.max[9], 60);                                      // t == t1 clamped into the last column
  assert.equal(w.n, 51);
  assert.equal(w.i0, 10);
  assert.equal(w.i1, 60);
  // a single pixel holds everything
  const one = tl.window('SpeedKmh', t0, t1, 1);
  assert.equal(one.min[0], 10);
  assert.equal(one.max[0], 60);
});

test('window: empty columns are NaN, sparse data leaves gaps', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(0, 1)); tl.push(row(1000, 2)); tl.push(row(2000, 3));      // t = 0, 1, 2
  const w = tl.window('SpeedKmh', 0, 2, 8);
  assert.equal(w.min[0], 1);
  assert.equal(w.min[4], 2);
  assert.equal(w.min[7], 3);
  assert.equal(w.max[7], 3);
  for (const c of [1, 2, 3, 5, 6]) {
    assert.ok(Number.isNaN(w.min[c]) && Number.isNaN(w.max[c]), `col ${c}`);
  }
});

test('window: degenerate and out-of-range arguments', () => {
  const tl = filled(50);
  // zero-width window on an exact sample
  const z = tl.window('SpeedKmh', tl.timeAt(7), tl.timeAt(7), 5);
  assert.equal(z.n, 1);
  assert.equal(z.min[0], 7);
  assert.equal(z.max[0], 7);
  // swapped bounds behave like sorted bounds
  const a = tl.window('SpeedKmh', 0.5, 0.1, 6);
  const b = tl.window('SpeedKmh', 0.1, 0.5, 6);
  assert.deepEqual(a.min, b.min);
  assert.deepEqual(a.max, b.max);
  assert.equal(a.n, b.n);
  // entirely outside the data
  for (const [x, y] of [[-10, -5], [100, 200], [0.0141, 0.0142]]) {
    const w = tl.window('SpeedKmh', x, y, 4);
    assert.equal(w.n, 0);
    assert.ok([...w.min, ...w.max].every(Number.isNaN));
  }
  // wider than the data
  const wide = tl.window('SpeedKmh', -100, 100, 4);
  assert.equal(wide.n, 50);
  // bad times / pixels
  for (const [x, y] of [[NaN, 1], [0, NaN], [undefined, 1], ['0', '1']]) {
    assert.equal(tl.window('SpeedKmh', x, y, 4).n, 0);
  }
  for (const px of [0, -4, NaN, undefined, 'x', null]) {
    const w = tl.window('SpeedKmh', 0, 1, px);
    assert.equal(w.min.length, 0);
    assert.equal(w.max.length, 0);
    assert.equal(w.n, 0);
  }
  assert.equal(tl.window('SpeedKmh', 0, 1, 12.9).min.length, 12);
  assert.equal(tl.window('SpeedKmh', 0, 1, 1e9).min.length, 65536);
});

test('window skips NaN and infinite values but still counts the rows in n', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(0, 5)); tl.push(row(13, NaN)); tl.push(row(26, Infinity)); tl.push(row(39, -Infinity)); tl.push(row(52, 9));
  const w = tl.window('SpeedKmh', 0, 0.052, 2);
  assert.equal(w.n, 5);
  assert.deepEqual([...w.min], [5, 9]);
  assert.deepEqual([...w.max], [5, 9]);
});

test('window on the time column reports float32-narrowed ms', () => {
  const tl = filled(10, {}, 1000);
  const w = tl.window('TimestampMS', 0, 0.117, 1);
  assert.equal(w.min[0], 1000);
  assert.equal(w.max[0], 1117);
});

test('window cost is O(points + pixels), not O(points * pixels)', () => {
  const tl = randomTimeline(5, 22500, 22500, {});
  const t0 = tl.earliestTime(), t1 = tl.latestTime();
  const start = process.hrtime.bigint();
  let n = 0;
  for (let k = 0; k < 100; k++) n += tl.window('SpeedKmh', t0, t1, 4000).n;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(n, 100 * 22500);
  // an O(points * pixels) implementation needs ~9e9 steps here; linear needs ~3e6
  assert.ok(ms < 3000, `100 full-window decimations took ${ms.toFixed(0)} ms`);
});

// --- valueAtTime --------------------------------------------------------------------------------------------------

test('valueAtTime interpolates linearly between samples', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1000, 10, 1000)); tl.push(row(1100, 20, 2000)); tl.push(row(1300, 60, 4000));
  assert.equal(tl.valueAtTime('SpeedKmh', 0), 10);                     // exact sample
  assert.equal(tl.valueAtTime('SpeedKmh', 0.1), 20);
  assert.equal(tl.valueAtTime('SpeedKmh', 0.3), 60);                   // exactly the last sample
  near(tl.valueAtTime('SpeedKmh', 0.05), 15);
  near(tl.valueAtTime('SpeedKmh', 0.2), 40);
  near(tl.valueAtTime('CurrentEngineRpm', 0.25), 3500);
  near(tl.valueAtTime('TimestampMS', 0.05), 1050);
});

test('valueAtTime is null outside the data and for bad input', () => {
  const tl = filled(10);
  assert.equal(tl.valueAtTime('SpeedKmh', -0.001), null);
  assert.equal(tl.valueAtTime('SpeedKmh', 0.1171), null);
  assert.equal(tl.valueAtTime('SpeedKmh', NaN), null);
  assert.equal(tl.valueAtTime('SpeedKmh', Infinity), null);
  assert.equal(tl.valueAtTime('SpeedKmh', '0.05'), null);
  assert.equal(tl.valueAtTime('SpeedKmh', undefined), null);
});

test('valueAtTime on a wrapped ring uses the retained span only', () => {
  const tl = new Timeline({ keys: KEYS, capacity: 5 });
  for (let i = 0; i < 12; i++) tl.push(row(1000 + 100 * i, i));        // keeps i = 7..11 -> t = 0.7 .. 1.1
  assert.equal(tl.valueAtTime('SpeedKmh', 0.65), null);
  near(tl.valueAtTime('SpeedKmh', 0.75), 7.5);
  near(tl.valueAtTime('SpeedKmh', 1.05), 10.5);
  assert.equal(tl.valueAtTime('SpeedKmh', 1.1), 11);
});

test('valueAtTime does not blend across a segment boundary', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(100_000, 10)); tl.push(row(100_100, 20));                  // seg 0, t = 0, 0.1
  tl.push(row(500, 900)); tl.push(row(600, 1000));                       // seg 1, t = 0.113, 0.213
  near(tl.timeAt(2), 0.113);
  assert.equal(tl.valueAtTime('SpeedKmh', 0.1), 20);
  assert.equal(tl.valueAtTime('SpeedKmh', 0.105), 20);                   // nearer to the seg-0 sample
  assert.equal(tl.valueAtTime('SpeedKmh', 0.109), 900);                  // nearer to the seg-1 sample
  near(tl.valueAtTime('SpeedKmh', 0.163), 950);                          // inside seg 1: normal interpolation
});

test('valueAtTime with duplicate timestamps and NaN cells', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1000, 1)); tl.push(row(1100, 2)); tl.push(row(1100, 3)); tl.push(row(1200, NaN)); tl.push(row(1300, 5));
  assert.equal(tl.valueAtTime('SpeedKmh', 0.1), 3);                      // last of the duplicates
  near(tl.valueAtTime('SpeedKmh', 0.05), 1.5);
  assert.ok(Number.isNaN(tl.valueAtTime('SpeedKmh', 0.15)));             // neighbour is NaN
  assert.ok(Number.isNaN(tl.valueAtTime('SpeedKmh', 0.25)));
  assert.ok(Number.isNaN(tl.valueAtTime('SpeedKmh', 0.2)));
  assert.equal(tl.valueAtTime('SpeedKmh', 0.3), 5);
});

// --- CSV --------------------------------------------------------------------------------------------------------------

function parseCsv(text) {
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'CSV must end with a newline');
  const header = lines.shift().split(',');
  const rows = lines.map((l) => l.split(',').map((c) => (c === '' ? NaN : Number(c))));
  return { header, rows };
}

test('toCSV header and row count', () => {
  const tl = filled(5);
  const { header, rows } = parseCsv(tl.toCSV());
  assert.deepEqual(header, ['time_s', ...KEYS]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === 5));
});

test('toCSV round trip reproduces times, exact ms and the stored float32 values', () => {
  const rand = rng(99);
  const tl = new Timeline({ keys: KEYS, capacity: 120 });
  let ms = 4_294_000_000;
  for (let i = 0; i < 300; i++) {
    ms += i === 200 ? -3_000_000 : 8 + Math.floor(rand() * 12);          // includes a new segment
    const speed = Math.round(rand() * 3000) / 10;
    tl.push(row(ms, rand() < 0.1 ? NaN : speed, rand() * 9000, i % 7 - 1));
  }
  assert.ok(tl.segments.length >= 1);
  const { header, rows } = parseCsv(tl.toCSV());
  assert.equal(rows.length, tl.length);
  for (let i = 0; i < tl.length; i++) {
    near(rows[i][0], tl.timeAt(i), 5e-7);
    header.slice(1).forEach((k, c) => {
      const want = tl.get(i, k);
      const got = rows[i][c + 1];
      if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${k}@${i}`);
      else if (k === 'TimestampMS') assert.equal(got, want, `${k}@${i}`);          // exact integer ms
      else assert.equal(Math.fround(got), want, `${k}@${i}`);                      // reads back as the same float32
    });
  }
});

test('toCSV prints compact numbers', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(1000, 0.1, 6543.21, -1));
  tl.push(row(1013, 123.456, 0.001, 3));
  tl.push(row(1026, -0.0, 8000, 0));
  const lines = tl.toCSV().trimEnd().split('\n');
  assert.equal(lines[1], '0,1000,0.1,6543.21,-1');
  assert.equal(lines[2], '0.013,1013,123.456,0.001,3');
  assert.equal(lines[3], '0.026,1026,0,8000,0');
});

test('toCSV from / to are inclusive indices and are clamped', () => {
  const tl = filled(10);
  const speeds = (csv) => parseCsv(csv).rows.map((r) => r[2]);
  assert.deepEqual(speeds(tl.toCSV({ from: 2, to: 4 })), [2, 3, 4]);
  assert.deepEqual(speeds(tl.toCSV({ from: 8 })), [8, 9]);
  assert.deepEqual(speeds(tl.toCSV({ to: 1 })), [0, 1]);
  assert.deepEqual(speeds(tl.toCSV({ from: -5, to: 99 })), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(speeds(tl.toCSV({ from: 5, to: 5 })), [5]);
  assert.deepEqual(speeds(tl.toCSV({ from: 6, to: 3 })), []);
  assert.deepEqual(speeds(tl.toCSV({ from: 20 })), []);
  assert.deepEqual(speeds(tl.toCSV({ from: 2.9, to: 4.9 })), [2, 3, 4]);
  assert.deepEqual(speeds(tl.toCSV({ from: NaN, to: undefined })), speeds(tl.toCSV()));
  assert.deepEqual(speeds(tl.toCSV(null)), speeds(tl.toCSV()));
});

test('toCSV key subset keeps the order asked for and skips unknown keys', () => {
  const tl = filled(3);
  const csv = tl.toCSV({ keys: ['Gear', 'Nope', 'SpeedKmh'] });
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'time_s,Gear,SpeedKmh');
  assert.equal(lines[2], '0.013,1,1');
  assert.equal(lines.length, 4);
});

test('toCSV over a wrapped ring, using from/to on logical indices', () => {
  const tl = filled(23, { capacity: 10 });                      // keeps rows 13..22
  const { rows } = parseCsv(tl.toCSV({ from: 1, to: 3 }));
  assert.deepEqual(rows.map((r) => r[2]), [14, 15, 16]);
  assert.deepEqual(rows.map((r) => r[1]), [1000 + 13 * 14, 1000 + 13 * 15, 1000 + 13 * 16]);
});

test('toCSV quotes odd column names', () => {
  const tl = new Timeline({ keys: ['TimestampMS', 'a,b', 'say "hi"'] });
  tl.push([1000, 1, 2]);
  assert.equal(tl.toCSV().split('\n')[0], 'time_s,TimestampMS,"a,b","say ""hi"""');
});

// --- stats --------------------------------------------------------------------------------------------------------------

test('stats over a time span', () => {
  const tl = filled(11);                                           // speed = 0..10, t = 0.013 i
  const s = tl.stats('SpeedKmh', tl.timeAt(2), tl.timeAt(6));
  assert.deepEqual(s, { min: 2, max: 6, mean: 4, count: 5 });
  assert.deepEqual(tl.stats('SpeedKmh', tl.timeAt(6), tl.timeAt(2)), s);       // either order
  assert.deepEqual(tl.stats('SpeedKmh', -9, 99), { min: 0, max: 10, mean: 5, count: 11 });
  assert.deepEqual(tl.stats('SpeedKmh', 0.0141, 0.0142), { min: NaN, max: NaN, mean: NaN, count: 0 });
  assert.deepEqual(tl.stats('SpeedKmh', 50, 60), { min: NaN, max: NaN, mean: NaN, count: 0 });
  assert.deepEqual(tl.stats('SpeedKmh', NaN, 1), { min: NaN, max: NaN, mean: NaN, count: 0 });
});

test('stats skips NaN and infinite cells', () => {
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(0, 4)); tl.push(row(13, NaN)); tl.push(row(26, 8)); tl.push(row(39, Infinity)); tl.push(row(52, -2));
  assert.deepEqual(tl.stats('SpeedKmh', 0, 1), { min: -2, max: 8, mean: 10 / 3, count: 3 });
  const allNaN = new Timeline({ keys: KEYS });
  allNaN.push(row(0, NaN)); allNaN.push(row(13, NaN));
  assert.deepEqual(allNaN.stats('SpeedKmh', 0, 1), { min: NaN, max: NaN, mean: NaN, count: 0 });
});

test('stats on a wrapped ring matches a brute-force pass', () => {
  const tl = randomTimeline(31, 2500, 900, { breaks: true, nan: true });
  const rand = rng(77);
  for (let k = 0; k < 40; k++) {
    const lo = tl.earliestTime(), hi = tl.latestTime();
    const a = lo + rand() * (hi - lo), b = a + rand() * 5;
    let min = Infinity, max = -Infinity, sum = 0, count = 0;
    for (let i = 0; i < tl.length; i++) {
      const t = tl.timeAt(i);
      const v = tl.get(i, 'SpeedKmh');
      if (t >= a && t <= b && Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); sum += v; count++; }
    }
    const s = tl.stats('SpeedKmh', a, b);
    assert.equal(s.count, count);
    if (count) {
      assert.equal(s.min, min);
      assert.equal(s.max, max);
      near(s.mean, sum / count, 1e-9);
    } else {
      assert.ok(Number.isNaN(s.mean));
    }
  }
});

test('stats of the time column uses exact ms', () => {
  const big = 4_294_000_001;
  const tl = new Timeline({ keys: KEYS });
  tl.push(row(big)); tl.push(row(big + 10)); tl.push(row(big + 20));
  assert.deepEqual(tl.stats('TimestampMS', 0, 1), { min: big, max: big + 20, mean: big + 10, count: 3 });
});
