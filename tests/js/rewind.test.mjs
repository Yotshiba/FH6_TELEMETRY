import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../../fh6_telemetry/web/static/timeline.js';
import { axisTicks, columnRuns, snapWindow } from '../../fh6_telemetry/web/static/view_timeline.js';

const KEYS = ['IsRaceOn', 'SpeedKmh', 'TimestampMS'];

/** A timeline of `seconds` of rows at the game's real cadence: ~75 Hz with the clock quantised to 15.625 ms. */
function makeTimeline(seconds, { skip } = {}) {
  const tl = new Timeline({ keys: KEYS });
  let ts = 100000;
  for (let i = 0; i < seconds * 75; i++) {
    ts += 13.333;
    const q = Math.floor(ts / 15.625) * 15.625;
    const t = (i * 13.333) / 1000;
    if (skip && t >= skip[0] && t < skip[1]) continue;
    tl.push([1, 50 + 100 * Math.sin(t), q]);
  }
  return tl;
}

const COLS = 730;

test('fine zoom (10 s over 730 px): empty pixel columns do not chop the line into dots', () => {
  const tl = makeTimeline(14);
  const latest = tl.latestTime();
  const { t0, t1, bw } = snapWindow(latest, 10, COLS);
  const d = tl.window('SpeedKmh', t0, t1, COLS);
  const filled = [...d.min].filter(Number.isFinite).length;
  assert.ok(filled < COLS * 0.95, `there really are empty columns (${filled}/${COLS}) - that is what used to break the line`);
  assert.ok(filled > COLS * 0.5);
  const maxSkip = Math.max(2, Math.ceil(0.25 / bw));
  const runs = columnRuns(d, maxSkip);
  assert.equal(runs.length, 1, `one continuous run, got ${runs.length}`);
  assert.ok(runs[0][1] - runs[0][0] > COLS * 0.95);
});

test('a real hole in the data (a pause) still splits the line, and only there', () => {
  const tl = makeTimeline(14, { skip: [5, 6.5] });                // 1.5 s without rows
  const { t0, t1, bw } = snapWindow(tl.latestTime(), 10, COLS);
  const runs = columnRuns(tl.window('SpeedKmh', t0, t1, COLS), Math.max(2, Math.ceil(0.25 / bw)));
  assert.equal(runs.length, 2);
  const holeCols = (runs[1][0] - runs[0][1]) * bw;
  assert.ok(holeCols > 1.3 && holeCols < 1.7, `gap of ${holeCols.toFixed(2)} s`);
});

test('coarse zoom (5 min): every column has rows, one run', () => {
  const tl = makeTimeline(60);
  const { t0, t1, bw } = snapWindow(tl.latestTime(), 300, COLS);
  const runs = columnRuns(tl.window('SpeedKmh', t0, t1, COLS), Math.max(2, Math.ceil(0.25 / bw)));
  assert.equal(runs.length, 1);
});

test('columnRuns: empty, single points, tolerance, and runs are inclusive non-empty bounds', () => {
  const mk = (arr) => ({ min: Float32Array.from(arr), max: Float32Array.from(arr) });
  assert.deepEqual(columnRuns(mk([NaN, NaN]), 2), []);
  assert.deepEqual(columnRuns(mk([]), 2), []);
  assert.deepEqual(columnRuns(mk([NaN, 1, NaN, NaN, 2, NaN]), 2), [[1, 4]]);       // 2 empty columns tolerated
  assert.deepEqual(columnRuns(mk([1, NaN, NaN, NaN, 2]), 2), [[0, 0], [4, 4]]);    // 3 are not
  assert.deepEqual(columnRuns(mk([3]), 2), [[0, 0]]);
});

test('snapWindow: columns sit on a fixed time grid, so a row keeps its column while the window scrolls', () => {
  const win = 10, n = COLS;
  const bw = win / n;
  const rows = [3.1234, 5.55, 7.777, 9.9999];
  for (const r of rows) {
    const ids = new Set();
    for (let end = 9.9; end < 12; end += 0.0167) {                // every frame of two seconds of live scrolling
      const { t0 } = snapWindow(end, win, n);
      if (r < t0 || r > t0 + win) continue;
      ids.add(Math.round(Math.floor((r - t0) / bw) + t0 / bw));    // absolute column index of the row
    }
    assert.equal(ids.size, 1, `row ${r} hopped between columns: ${[...ids]}`);
  }
  const s = snapWindow(123.456, 30, 800);
  assert.ok(s.t1 <= 123.456 && 123.456 - s.t1 < s.bw + 1e-9, 'snaps down by less than one column');
  assert.ok(Math.abs(s.t1 - s.t0 - 30) < 1e-9);
});

test('axisTicks are relative to NOW: right when live and when scrubbed back', () => {
  assert.deepEqual(axisTicks(100, 70, 100, 10), [0, -10, -20, -30].map((v) => v + 0));
  const back = axisTicks(100, 60, 90, 10);                       // looking at 60..90 s while the data goes to 100 s
  assert.deepEqual(back, [-10, -20, -30, -40]);                    // never labelled "now"
  assert.deepEqual(axisTicks(100, 99.2, 100, 0.5), [0, -0.5]);
  // the snapped window can end a hair before the newest sample: "now" must still be labelled
  assert.deepEqual(axisTicks(100, 70, 99.99, 10, 0.02), [0, -10, -20, -30]);
  assert.deepEqual(axisTicks(100, 70, 99.99, 10, 0), [-10, -20, -30]);
  assert.deepEqual(axisTicks(10, 0, 10, 0), []);                   // a degenerate step cannot loop forever
  assert.ok(axisTicks(1e6, 0, 1e6, 0.001).length <= 60);
});
