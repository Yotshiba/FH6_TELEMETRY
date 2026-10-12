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

export function buildTimeline(ctx) {
  const { store, settings, actions } = ctx;
  const root = h('div', 'view v-timeline');
  const bar = h('div', 'tl-bar');
  const canvas = h('canvas', 'tl-canvas');
  const readout = h('div', 'tl-readout', 'Tap or drag on the timeline');
  root.append(bar, readout, canvas);
  const g = canvas.getContext('2d');

  const S = { win: 30, live: true, endT: 0, cursor: null, marks: [], gen: store.gen };
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
    const t1 = S.endT, t0 = t1 - S.win;
    const left = PAD.l, pw = w - PAD.l - PAD.r;
    geo = { t0, t1, left, pw };
    const list = strips(u, c);
    const gap = 8;
    const sh = (H - PAD.t - PAD.b - gap * (list.length - 1)) / list.length;

    list.forEach((strip, si) => {
      const y0 = PAD.t + si * (sh + gap);
      // data + range
      const data = strip.lines.map((l) => tl.window(l.key, t0, t1, Math.max(8, Math.floor(pw))));
      let lo = strip.lo, hi = strip.hi;
      if (strip.hiKey) { const idx = tl.valueAtTime(strip.hiKey, t1); hi = (idx || 8000) * strip.hiMul; }
      if (strip.auto) {
        let m = 0;
        data.forEach((d, i) => { for (let k = 0; k < d.max.length; k++) if (d.max[k] > m) m = d.max[k]; m *= 1; });
        hi = Math.max(60, niceStep((m * strip.lines[0].mul) / 4) * 4 * 1.0);
        hi = Math.max(hi, m * strip.lines[0].mul * 1.05);
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
      g.fillStyle = c.chartTitle; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = '600 10px system-ui, sans-serif';
      g.fillText(strip.title, left + 6, y0 + 4);

      // lines
      g.save(); g.beginPath(); g.rect(left, y0, pw, sh); g.clip();
      strip.lines.forEach((line, li) => {
        const d = data[li], n = d.min.length;
        const xOf = (i) => left + (i + 0.5) / n * pw;
        g.strokeStyle = line.color; g.fillStyle = withAlpha(line.color, 0.2); g.lineWidth = 1.6; g.lineJoin = 'round';
        // envelope bars (spikes survive decimation)
        g.beginPath();
        for (let i = 0; i < n; i++) if (Number.isFinite(d.min[i])) { const x = xOf(i); g.moveTo(x, yOf(d.min[i] * line.mul)); g.lineTo(x, yOf(d.max[i] * line.mul)); }
        g.globalAlpha = 0.55; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1; g.lineWidth = 1.6;
        // mid line
        g.beginPath();
        let started = false, firstX = null, lastX = null;
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(d.min[i])) { started = false; continue; }
          const x = xOf(i), y = yOf((d.min[i] + d.max[i]) / 2 * line.mul);
          if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
          if (firstX === null) firstX = x;
          lastX = x;
        }
        g.stroke();
        if (line.fill && firstX !== null) {
          // close the area along the baseline between the first and last REAL points (data may
          // not fill the whole window, e.g. right after a reload)
          const base = yOf(Math.max(lo, 0));
          g.lineTo(lastX, base); g.lineTo(firstX, base); g.closePath(); g.fill();
        }
      });
      g.restore();
    });

    // time axis
    g.fillStyle = c.chartText; g.font = '10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
    const tstep = niceStep(S.win / 6);
    for (let t = Math.ceil((t0 - t1) / tstep) * tstep; t <= 0.0001; t += tstep) {
      const x = left + (t + S.win) / S.win * pw;
      g.fillText(t === 0 ? 'now' : `${Math.round(t)}s`, x, H - PAD.b + 5);
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
      const gear = store.hello ? gearLabel(store.hello.lab, tl.get(tl.indexAtTime(S.cursor), 'Gear'), '–') : '–';
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
