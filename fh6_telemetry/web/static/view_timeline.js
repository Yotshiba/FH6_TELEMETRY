// Rewind: a scrub-able, zoom-able full-rate timeline (the last ~5 minutes) in four strips.
// Drag to look back, wheel / pinch / buttons to zoom, tap for a crosshair readout, ★ to mark a moment.

import { gearLabel, niceStep } from './format.js';
import { fitCanvas, roundRect } from './gauges.js';
import { colors, withAlpha } from './theme.js';
import { conv, label } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const PAD = { l: 52, r: 10, t: 6, b: 22 };
const WINDOWS = [10, 30, 60, 300];

/**
 * Runs of connected columns in a decimated series.
 *
 * `d.min / d.max` hold one value pair per pixel column; a column with no row is NaN. At fine zoom there is about
 * one row per column, so empty columns between real ones are NORMAL (the rows are 13-16 ms apart) and must not
 * break the line: only more than `maxSkip` empty columns in a row (a pause, a dropped link) start a new run.
 * @returns {Array<[number, number]>} [first, last] column index of every run (both non-empty)
 */
export function columnRuns(d, maxSkip) {
  const runs = [];
  let start = -1, last = -1;
  for (let i = 0; i < d.min.length; i++) {
    if (!Number.isFinite(d.min[i])) continue;
    if (start >= 0 && i - last - 1 > maxSkip) { runs.push([start, last]); start = -1; }   // more than maxSkip EMPTY columns between
    if (start < 0) start = i;
    last = i;
  }
  if (start >= 0) runs.push([start, last]);
  return runs;
}

/**
 * The window to draw: `n` pixel columns of `win` seconds each, ending on a multiple of the column width at or
 * before `endT`. Anchoring the columns to a fixed time grid (instead of to the moving window start) keeps every
 * column's rows the same from frame to frame, so the trace scrolls smoothly instead of shimmering.
 */
export function snapWindow(endT, win, n) {
  const bw = win / n;
  const t1 = Math.floor(endT / bw) * bw;
  return { t0: t1 - win, t1, bw };
}

/**
 * Time-axis ticks (seconds relative to NOW, <= 0) that fall inside [t0, t1]. `slack` widens the right end: the
 * snapped window ends up to one column before the newest sample, and "now" must still get its label.
 */
export function axisTicks(latest, t0, t1, step, slack = 0) {
  const out = [];
  if (!(step > 0)) return out;
  for (let k = Math.ceil((latest - t1 - slack) / step - 1e-9); out.length < 60; k++) {
    const rel = -k * step;
    if (latest + rel < t0 - 1e-9) break;
    out.push(rel);
  }
  return out;
}

const GAP_S = 0.25;                                  // a hole longer than this in the rows is a real gap, not a thin spot

export function buildTimeline(ctx) {
  const { store, settings, actions } = ctx;
  const root = h('div', 'view v-timeline');
  const bar = h('div', 'tl-bar');
  const canvas = h('canvas', 'tl-canvas');
  const readout = h('div', 'tl-readout', 'Tap or drag on the timeline');
  root.append(bar, readout, canvas);
  const g = canvas.getContext('2d');

  const S = { win: 30, live: true, endT: 0, cursor: null, marks: [], gen: store.gen, auto: [] };
  const winBtns = WINDOWS.map((s) => {
    const b = h('button', 'chip', s >= 60 ? `${s / 60} min` : `${s} s`);
    b.addEventListener('click', () => { S.win = s; });
    bar.appendChild(b); return b;
  });
  const bLive = h('button', 'chip on', '● Live'); bLive.addEventListener('click', () => { S.live = true; });
  const bMark = h('button', 'chip', '★ Mark'); bMark.title = 'Mark this moment';
  bMark.addEventListener('click', () => {
    const tl = store.timeline;
    if (!tl || !tl.length) return;
    S.marks.push(S.cursor ?? tl.latestTime());
    if (S.marks.length > 60) S.marks.shift();
  });
  const bClear = h('button', 'chip', 'Clear ★'); bClear.addEventListener('click', () => { S.marks.length = 0; });
  const bCsv = h('button', 'chip', '⬇ CSV'); bCsv.title = 'Download the recorded timeline as CSV';
  bCsv.addEventListener('click', () => actions.exportCsv());
  bar.append(bLive, bMark, bClear, bCsv);

  // ---- strips -----------------------------------------------------------------------------------------
  const strips = (u, c) => {
    const spd = conv.speed(1, u);
    return [
      { title: `Speed (${label.speed(u)})`, lines: [{ key: 'SpeedKmh', color: c.accent, mul: spd, fill: true }], lo: 0, auto: true },
      { title: 'RPM', lines: [{ key: 'CurrentEngineRpm', color: c.yellow, mul: 1 }], lo: 0, hiKey: 'EngineMaxRpm', hiMul: 1.05 },
      { title: 'Throttle / Brake (%)', lines: [{ key: 'AccelPct', color: c.green, mul: 1, fill: true }, { key: 'BrakePct', color: c.red, mul: 1, fill: true }], lo: 0, hi: 100 },
      { title: 'Steering % (line) · lateral g ×50 (amber)', lines: [{ key: 'SteerPct', color: c.accent, mul: 1 }, { key: 'AccelGX', color: c.amber, mul: 50 }], lo: -100, hi: 100 },
    ];
  };

  let geo = null;                                  // layout of the last draw (for pointer maths)

  function pointerT(e) {
    if (!geo) return null;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    return geo.t0 + (x - geo.left) / geo.pw * (geo.t1 - geo.t0);
  }
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, endT: geo ? geo.t1 : 0, moved: false };
    S.cursor = pointerT(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag && geo) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        const tl = store.timeline;
        const latest = tl ? tl.latestTime() : 0;
        const first = tl ? tl.earliestTime() : 0;
        const end = drag.endT - dx / geo.pw * S.win;
        S.live = end >= latest - 0.05;               // dragging back to the newest sample re-engages live
        // never scroll into the void: keep at least a quarter of the window on recorded data
        S.endT = Math.max(Math.min(latest, end), Math.min(latest, first + S.win * 0.25));
      }
    }
    S.cursor = pointerT(e);
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  // a finger has no hover: keep the tapped crosshair / read-out after it lifts
  canvas.addEventListener('pointerleave', (e) => { if (!drag && e.pointerType !== 'touch') S.cursor = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.win = Math.max(4, Math.min(600, S.win * Math.exp(e.deltaY * 0.0015))); }, { passive: false });

  const setReadout = (t) => { if (readout._t !== t) { readout._t = t; readout.textContent = t; } };

  function update() {
    if (S.gen !== store.gen) {                       // the history was wiped: marks / cursor refer to a dead clock
      S.gen = store.gen; S.marks.length = 0; S.cursor = null; S.live = true; drag = null;
    }
    const c = colors();
    const u = settings.get('units');
    const tl = store.timeline;
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    WINDOWS.forEach((s, i) => winBtns[i].classList.toggle('on', Math.abs(S.win - s) < 0.5));
    bLive.classList.toggle('on', S.live);
    bClear.style.display = S.marks.length ? '' : 'none';
    if (!tl || tl.length < 2) {
      g.fillStyle = c.dim; g.font = '600 14px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('Waiting for data… drive something!', w / 2, H / 2);
      return;
    }
    const latest = tl.latestTime();
    if (S.live) S.endT = latest;
    S.endT = Math.min(S.endT, latest);
    const left = PAD.l, pw = w - PAD.l - PAD.r;
    const cols = Math.max(8, Math.floor(pw));
    const { t0, t1, bw } = snapWindow(S.endT, S.win, cols);
    geo = { t0, t1, left, pw };
    const ticks = axisTicks(latest, t0, t1, niceStep(S.win / 6), S.live ? bw * 1.5 : 0);
    const xAt = (t) => left + (t - t0) / S.win * pw;
    const list = strips(u, c);
    const gap = 8;
    const sh = (H - PAD.t - PAD.b - gap * (list.length - 1)) / list.length;

    list.forEach((strip, si) => {
      const y0 = PAD.t + si * (sh + gap);
      // data + range
      const data = strip.lines.map((l) => tl.window(l.key, t0, t1, cols));
      let lo = strip.lo, hi = strip.hi;
      if (strip.hiKey) { const idx = tl.valueAtTime(strip.hiKey, t1); hi = (idx || 8000) * strip.hiMul; }
      if (strip.auto) {
        let m = 0;
        for (const d of data) for (let k = 0; k < d.max.length; k++) if (d.max[k] > m) m = d.max[k];
        let want = Math.max(60, niceStep((m * strip.lines[0].mul) / 4) * 4);
        want = Math.max(want, m * strip.lines[0].mul * 1.05);
        // grow at once, shrink slowly: the scale must not twitch every time a peak scrolls out of the window
        const cur = S.auto[si];
        hi = cur === undefined || want >= cur ? want : cur + (want - cur) * 0.08;
        if (Math.abs(hi - want) < want * 0.01) hi = want;
        S.auto[si] = hi;
      }
      const span = hi - lo || 1;
      const yOf = (v) => y0 + sh - (v - lo) / span * sh;

      g.fillStyle = withAlpha(c.panel, 0.55); roundRect(g, left, y0, pw, sh, 6); g.fill();
      // grid + labels
      g.strokeStyle = c.chartGrid; g.fillStyle = c.chartText; g.lineWidth = 1;
      g.font = '10px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
      const step = niceStep(span / 3);
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        g.beginPath(); g.moveTo(left, y); g.lineTo(left + pw, y); g.stroke();
        g.fillText(String(Math.round(v)), left - 5, y);
      }
      g.beginPath();                                 // faint time grid (the same ticks as the axis below)
      for (const rel of ticks) { const x = Math.round(xAt(latest + rel)) + 0.5; if (x > left && x < left + pw) { g.moveTo(x, y0); g.lineTo(x, y0 + sh); } }
      g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1;
      g.fillStyle = c.chartTitle; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = '600 10px system-ui, sans-serif';
      g.fillText(strip.title, left + 6, y0 + 4);

      // lines
      g.save(); g.beginPath(); g.rect(left, y0, pw, sh); g.clip();
      const maxSkip = Math.max(2, Math.ceil(GAP_S / bw));
      const colW = pw / cols;
      strip.lines.forEach((line, li) => {
        const d = data[li];
        const runs = columnRuns(d, maxSkip);
        const xOf = (i) => left + (i + 0.5) * colW;
        const yMid = (i) => yOf((d.min[i] + d.max[i]) / 2 * line.mul);
        g.strokeStyle = line.color; g.fillStyle = withAlpha(line.color, 0.2); g.lineJoin = 'round';
        // area under the trace, one polygon per run (a gap must not be bridged by the fill either)
        if (line.fill) {
          const base = yOf(Math.max(lo, 0));
          for (const [i0, i1] of runs) {
            g.beginPath(); g.moveTo(xOf(i0), base);
            for (let i = i0; i <= i1; i++) if (Number.isFinite(d.min[i])) g.lineTo(xOf(i), yMid(i));
            g.lineTo(xOf(i1), base); g.closePath(); g.fill();
          }
        }
        // envelope bars: spikes inside a column survive the decimation (on the pixel centre: crisp)
        g.beginPath();
        for (const [i0, i1] of runs) {
          for (let i = i0; i <= i1; i++) {
            if (!Number.isFinite(d.min[i]) || d.max[i] === d.min[i]) continue;
            const x = Math.floor(xOf(i)) + 0.5;
            g.moveTo(x, yOf(d.min[i] * line.mul)); g.lineTo(x, yOf(d.max[i] * line.mul));
          }
        }
        g.globalAlpha = 0.55; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1;
        // the trace itself: through every non-empty column of a run
        g.lineWidth = 1.6; g.beginPath();
        for (const [i0, i1] of runs) {
          g.moveTo(xOf(i0), yMid(i0));
          if (i1 === i0) g.lineTo(xOf(i0) + 0.01, yMid(i0));           // a lone point still shows
          for (let i = i0 + 1; i <= i1; i++) if (Number.isFinite(d.min[i])) g.lineTo(xOf(i), yMid(i));
        }
        g.stroke();
      });
      g.restore();
    });

    // time axis: seconds before NOW (so it reads correctly when scrubbed back as well)
    g.fillStyle = c.chartText; g.font = '10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
    const fracDigits = niceStep(S.win / 6) < 1 ? 1 : 0;
    for (const rel of ticks) {
      const x = xAt(latest + rel);
      if (x < left - 2 || x > left + pw + 2) continue;
      g.fillText(rel === 0 ? 'now' : `${rel.toFixed(fracDigits)}s`, Math.min(left + pw - 8, Math.max(left + 10, x)), H - PAD.b + 5);
    }

    // marks
    for (const m of S.marks) {
      if (m < t0 || m > t1) continue;
      const x = left + (m - t0) / (t1 - t0) * pw;
      g.strokeStyle = c.yellow; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke(); g.setLineDash([]);
      g.fillStyle = c.yellow; g.font = '12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('★', x, PAD.t - 2);
    }

    // crosshair + readout
    if (S.cursor !== null && S.cursor >= t0 && S.cursor <= t1) {
      const x = left + (S.cursor - t0) / (t1 - t0) * pw;
      g.strokeStyle = c.bright; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x + 0.5, PAD.t); g.lineTo(x + 0.5, H - PAD.b); g.stroke();
      const v = (k) => tl.valueAtTime(k, S.cursor);
      const f = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '–');
      const rel = S.cursor - latest;
      // gear comes from the nearest sample: gear codes are not interpolated
      const code = tl.get(tl.indexAtTime(S.cursor), 'Gear');
      const lab = store.hello && store.hello.lab;
      const gear = !lab ? '–' : code === (lab.neutral ? lab.neutral.code : 11) ? 'N' : gearLabel(lab, code, '–');
      setReadout(
        `${rel >= -0.05 ? 'now' : rel.toFixed(1) + ' s'}   ` +
        `${f(conv.speed(v('SpeedKmh'), u))} ${label.speed(u)}   ${f(v('CurrentEngineRpm'))} rpm   gear ${gear}   ` +
        `thr ${f(v('AccelPct'))}%  brk ${f(v('BrakePct'))}%   steer ${f(v('SteerPct'))}%   lat ${f(v('AccelGX'), 2)} g  long ${f(v('AccelGZ'), 2)} g`);
    } else {
      setReadout(S.live ? 'Live · drag to look back, wheel/buttons to zoom, tap for a readout' : `Looking back ${(latest - t1).toFixed(1)} s · press ● Live to return`);
    }
  }

  return { id: 'timeline', title: 'Rewind', color: '#b197fc', el: root, charts: [], animated: true, update };
}
