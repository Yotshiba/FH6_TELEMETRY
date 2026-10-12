// Small canvas line chart (no dependencies, works offline).
//
// One chart = one entry of hello.charts: lines read their history from the store's
// rings; the Y range comes from the server ("rg" events: the same RangeSmoother the
// desktop app uses) except for fixed charts, so every viewer sees the same calm axis.

import { niceStep } from './format.js';
import { colors } from './theme.js';
import { chartTransform } from './units.js';

let unitsProvider = () => null;
/** The app tells charts where to read the user's unit choices. */
export function setChartUnits(fn) { unitsProvider = fn; }

const PAD = { l: 46, r: 8, t: 6, b: 6 };

export class LineChart {
  constructor(container, def, store) {
    this.def = def; this.store = store;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.w = 0; this.h = 0; this.dpr = 1;
    this.dirty = true;
    this._drawnVersion = -1; this._drawnRange = '';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.container = container;
    this.resize();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(40, Math.floor(r.width)), h = Math.max(40, Math.floor(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.dirty = true;
  }

  /** The unit transform (identity functions + label) for the user's current units. */
  tf() {
    const u = unitsProvider();
    return u ? chartTransform(this.def.id, u) : { unit: null, fns: [] };
  }

  /** [lo, hi] for the Y axis, in the user's units */
  range() {
    const [lo, hi] = this.metricRange();
    const fns = this.tf().fns;
    if (!fns.length) return [lo, hi];
    const vals = fns.flatMap((f) => [f(lo), f(hi)]);
    return [Math.min(...vals), Math.max(...vals)];
  }

  /** [lo, hi] in the units the server sends */
  metricRange() {
    const y = this.def.y || {};
    if (y.fixed) { const p = (y.fixed[1] - y.fixed[0]) * 0.05; return [y.fixed[0] - p, y.fixed[1] + p]; }
    const srv = this.store.ranges[this.def.id];
    if (srv) return srv;
    // Before the first "rg": derive a provisional range from the data.
    let lo = Infinity, hi = -Infinity;
    for (const l of this.def.lines) {
      const ring = this.store.rings.get(l.k);
      if (ring && ring.count) { lo = Math.min(lo, ring.min()); hi = Math.max(hi, ring.max()); }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (y.floor) { lo = Math.min(lo, y.floor[0]); hi = Math.max(hi, y.floor[1]); }
    if (y.min !== undefined) lo = Math.max(lo, y.min);
    if (hi - lo < 1) hi = lo + 1;
    const pad = (hi - lo) * 0.1;
    return [y.min !== undefined ? Math.max(y.min, lo - pad) : lo - pad, hi + pad];
  }

  /** Redraw if anything changed (data, range or size). */
  draw(force = false) {
    const [lo, hi] = this.range();
    const key = lo + ':' + hi;
    if (!force && !this.dirty && this._drawnVersion === this.store.version && this._drawnRange === key) return;
    this._drawnVersion = this.store.version; this._drawnRange = key; this.dirty = false;

    const { ctx, w, h, dpr, def } = this;
    const theme = colors();
    const tf = this.tf();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
    if (pw < 10 || ph < 10) return;
    const span = hi - lo || 1;
    const yOf = (v) => PAD.t + (hi - v) / span * ph;

    // grid + labels
    const step = niceStep(span / 4);
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 1; ctx.strokeStyle = theme.chartGrid; ctx.fillStyle = theme.chartText;
    // (bounded: a garbage range such as 1e20 would make `t += step` never advance)
    for (let t = Math.ceil(lo / step) * step, guard = 0; t <= hi + 1e-9 && guard < 24; t += step, guard++) {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
      ctx.fillText(t.toFixed(decimals), PAD.l - 5, y);
    }

    // lines (newest sample on the right edge, like the desktop chart)
    const n = this.store.hello ? this.store.hello.hist : 300;
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t, pw, ph); ctx.clip();
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    def.lines.forEach((l, li) => {
      const ring = this.store.rings.get(l.k);
      if (!ring || ring.count < 2) return;
      const fn = tf.fns[li] || ((v) => v);
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      const first = n - ring.count;
      for (let i = 0; i < ring.count; i++) {
        const x = PAD.l + (first + i) / (n - 1) * pw;
        const y = yOf(fn(ring.at(i)));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.restore();

    // title + legend
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = theme.chartTitle; ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(`${def.title} (${tf.unit ?? def.unit})`, PAD.l + 8, PAD.t + 4);
    let x = PAD.l + 8; const ly = PAD.t + 20;
    ctx.font = '11px system-ui, sans-serif';
    for (const l of def.lines) {
      ctx.fillStyle = l.color; ctx.fillRect(x, ly + 4, 14, 3);
      ctx.fillStyle = theme.bright; ctx.fillText(l.label, x + 18, ly);
      x += 18 + ctx.measureText(l.label).width + 12;
    }
  }

  destroy() { this.ro.disconnect(); this.canvas.remove(); }
}
