// Cockpit widgets: one drawing function per entry of cockpit_layout.js WIDGET_TYPES.
//
// Every function is draw(S, r): `S` is the shared per-frame state built by view_cockpit.js (canvas context, theme
// colours, units, smoothed values, the store and analytics) and `r` the widget's pixel rectangle {x, y, w, h}.
// A widget draws only inside its rectangle and must cope with missing data (no lap yet, no timeline, tiny size).

import { contrastText, fmtTime, tempColor } from './format.js';
import { drawCompass, drawDial, drawPedal, drawShiftLights, drawWheel, roundRect } from './gauges.js';
import { withAlpha } from './theme.js';
import { columnRuns } from './view_timeline.js';
import { conv, fmt, label } from './units.js';

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function inset(r, k = 0.06) {
  const dx = r.w * k, dy = r.h * k;
  return { x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy };
}

/** The biggest circle that fits the rectangle. */
function circle(r) {
  const d = Math.min(r.w, r.h);
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, r: (d / 2) * 0.98 };
}

function text(g, s, x, y, size, color, weight = 700, align = 'center', base = 'middle') {
  g.fillStyle = color; g.font = `${weight} ${Math.max(6, Math.round(size))}px system-ui, sans-serif`;
  g.textAlign = align; g.textBaseline = base; g.fillText(s, x, y);
}

/** Largest font size (<= maxH) at which `str` still fits maxW. */
function fitText(g, str, maxW, maxH, weight = 800) {
  let size = Math.max(6, maxH);
  g.font = `${weight} ${Math.round(size)}px system-ui, sans-serif`;
  const w = g.measureText(str).width;
  if (w > maxW && w > 0) size = Math.max(6, size * maxW / w);
  return Math.round(size);
}

/** A faint rounded tile behind data read-outs. */
function panel(S, r) {
  const { g, c } = S;
  g.fillStyle = withAlpha(c.panel, 0.55); roundRect(g, r.x, r.y, r.w, r.h, Math.min(10, r.h * 0.25)); g.fill();
  g.strokeStyle = withAlpha(c.border, 0.8); g.lineWidth = 1; roundRect(g, r.x, r.y, r.w, r.h, Math.min(10, r.h * 0.25)); g.stroke();
}

function bar(S, x, y, w, h, frac, color) {
  const { g, c } = S;
  g.fillStyle = c.panel2; roundRect(g, x, y, w, h, h / 2); g.fill();
  const f = clamp01(frac);
  if (f > 0.003) { g.fillStyle = color; roundRect(g, x, y, Math.max(h, w * f), h, h / 2); g.fill(); }
}

function pedal(S, r, frac, color, name) {
  const pw = Math.min(r.w * 0.9, r.h * 0.4);
  if (pw < 4) return;
  const labelH = Math.max(9, Math.round(pw * 0.32)) + 6;
  const bh = r.h - labelH;
  if (bh < 8) return;
  drawPedal(S.g, r.x + (r.w - pw) / 2, r.y, pw, bh, frac, color, pw >= 14 ? name : '');
}

export const WIDGET_DRAW = {
  speedo(S, r) {
    const { g, c, u } = S;
    const { cx, cy, r: rad } = circle(r);
    if (rad < 14) return;
    const kmhUnits = u.speed === 'kmh';
    // (clamped: the dial draws one tick per step, so a garbage packet must not ask for millions)
    const max = Math.min(1000, Math.max(kmhUnits ? 360 : 240, Math.ceil((S.speed + 1) / 20) * 20));
    drawDial(g, {
      cx, cy, r: rad, min: 0, max, value: S.speed, major: kmhUnits ? 40 : 20, minorPerMajor: 4,
      label: (v) => String(Math.round(v)), caption: label.speed(u), arcColor: c.accent,
    });
    text(g, fmt.speed(S.kmh, u, 0), cx, cy + rad * 0.2, rad * 0.42, c.bright, 800);
  },

  tacho(S, r) {
    const { g, c } = S;
    const { cx, cy, r: rad } = circle(r);
    if (rad < 14) return;
    const rpmMax = Math.min(30000, Math.max(8000, Math.ceil(S.maxRpm / 1000) * 1000));
    drawDial(g, {
      cx, cy, r: rad, min: 0, max: rpmMax, value: S.rpmS, major: 1000, minorPerMajor: 4,
      label: (v) => String(v / 1000),
      bands: [{ from: S.maxRpm * 0.82, to: S.maxRpm * 0.92, color: c.amber }, { from: S.maxRpm * 0.92, to: rpmMax, color: c.red }],
      caption: '× 1000 rpm', arcColor: S.rpmS > S.maxRpm * 0.92 ? c.red : c.accent,
    });
    text(g, String(Math.round(S.rpm)), cx, cy + rad * 0.2, rad * 0.3, c.bright, 800);
  },

  speed_digital(S, r) {
    const { g, c, u } = S;
    const rr = inset(r);
    const num = fmt.speed(S.kmh, u, 0);
    const size = fitText(g, num, rr.w * 0.97, rr.h * 0.74);
    text(g, num, rr.x + rr.w / 2, rr.y + rr.h * 0.42, size, c.accent, 800);
    text(g, label.speed(u), rr.x + rr.w / 2, rr.y + rr.h * 0.9, Math.max(9, Math.min(rr.h * 0.2, size * 0.3)), c.dim, 700);
  },

  rpm_digital(S, r) {
    const { g, c } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const num = String(Math.round(S.rpm));
    const size = fitText(g, num, rr.w * 0.9, rr.h * 0.55);
    const ratio = clamp01(S.rpm / (S.maxRpm || 8000));
    text(g, num, rr.x + rr.w / 2, rr.y + rr.h * 0.36, size, ratio > 0.92 ? c.red : c.bright, 800);
    bar(S, rr.x, rr.y + rr.h * 0.72, rr.w, Math.max(4, rr.h * 0.14), ratio, ratio > 0.92 ? c.red : ratio > 0.82 ? c.amber : c.accent);
  },

  gear(S, r) {
    const { g, c } = S;
    const rr = inset(r, 0.04);
    const showCaption = rr.h >= 56;
    const dh = showCaption ? rr.h * 0.82 : rr.h;
    const size = fitText(g, S.gear, rr.w * 0.95, dh);
    text(g, S.gear, rr.x + rr.w / 2, rr.y + dh * 0.5, size, S.level.flashing ? c.blue : c.yellow, 800);
    if (showCaption) text(g, 'GEAR', rr.x + rr.w / 2, rr.y + rr.h * 0.93, Math.max(9, rr.h * 0.09), c.dim, 700);
  },

  shift_lights(S, r) {
    drawShiftLights(S.g, r.x, r.y, r.w, r.h, S.level, S.ts);
  },

  wheel(S, r) {
    const { cx, cy, r: rad } = circle(r);
    if (rad < 8) return;
    drawWheel(S.g, cx, cy, rad * 0.95, S.wheel);
  },

  brake(S, r) { pedal(S, r, S.brk, S.c.red, 'BRK'); },
  throttle(S, r) { pedal(S, r, S.thr, S.c.green, 'THR'); },
  clutch(S, r) { pedal(S, r, S.clu, S.c.blue, 'CLT'); },

  fuel(S, r) {
    const { g, c, store } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const pct = Number.isFinite(store.f('FuelPct')) ? store.f('FuelPct') : 0;
    const f = clamp01(pct / 100);
    const color = f <= 0.15 ? c.red : f <= 0.3 ? c.amber : c.green;
    const line = `FUEL ${Math.round(pct)}%`;
    const size = fitText(g, line, rr.w * 0.95, rr.h * 0.5, 700);
    text(g, line, rr.x + rr.w / 2, rr.y + rr.h * 0.3, size, f <= 0.15 ? c.red : c.dim, 700);
    bar(S, rr.x, rr.y + rr.h * 0.62, rr.w, Math.max(4, rr.h * 0.22), f, color);
  },

  boost(S, r) {
    const { g, c, u, store } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const bar_ = store.f('BoostBar');
    const line = `BOOST ${fmt.pressure(bar_, u)} ${label.pressure(u)}`;
    const size = fitText(g, line, rr.w * 0.95, rr.h * 0.5, 700);
    text(g, line, rr.x + rr.w / 2, rr.y + rr.h * 0.3, size, c.dim, 700);
    bar(S, rr.x, rr.y + rr.h * 0.62, rr.w, Math.max(4, rr.h * 0.22), clamp01(bar_ / 2.5), c.accent);
  },

  power(S, r) {
    const { g, c, u, store } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const p = `${fmt.power(store.f('PowerHp'), u)} ${label.power(u)}`;
    const t = `${fmt.torque(store.f('Torque'), u)} ${label.torque(u)}`;
    if (rr.h >= 34) {
      const size = fitText(g, p, rr.w * 0.95, rr.h * 0.42);
      text(g, p, rr.x + rr.w / 2, rr.y + rr.h * 0.28, size, c.bright, 800);
      text(g, t, rr.x + rr.w / 2, rr.y + rr.h * 0.74, fitText(g, t, rr.w * 0.95, rr.h * 0.34, 700), c.dim, 700);
    } else {
      const both = `${p}  ·  ${t}`;
      text(g, both, rr.x + rr.w / 2, rr.y + rr.h / 2, fitText(g, both, rr.w * 0.97, rr.h * 0.7, 700), c.bright, 700);
    }
  },

  tyres(S, r) {
    const { g, c, u, store } = S;
    const bands = store.hello && store.hello.ui ? store.hello.ui.temp : [[999, c.red]];
    const gap = Math.min(r.w, r.h) * 0.04;
    const tw = (r.w - gap) / 2, th = (r.h - gap) / 2;
    const names = ['FL', 'FR', 'RL', 'RR'];
    names.forEach((n, i) => {
      const x = r.x + (i % 2) * (tw + gap), y = r.y + Math.floor(i / 2) * (th + gap);
      const t = store.f('TireTemp' + n);
      const bg = tempColor(bands, t);
      g.fillStyle = bg; roundRect(g, x, y, tw, th, Math.min(8, th * 0.2)); g.fill();
      const fg = contrastText(bg);
      const val = `${Math.round(conv.temp(t, u))}${label.temp(u)}`;
      text(g, val, x + tw / 2, y + th * 0.56, fitText(g, val, tw * 0.9, th * 0.42), fg, 800);
      text(g, n, x + tw * 0.08, y + th * 0.08, Math.max(8, th * 0.18), withAlpha(fg, 0.75), 700, 'left', 'top');
    });
  },

  delta(S, r) {
    const { g, c, analytics } = S;
    const rr = inset(r);
    const d = analytics && analytics.lap ? analytics.lap.state : null;
    const valid = !!(d && d.valid);
    const str = valid ? fmt.delta(S.delta) : '—';
    const color = !valid ? c.dimmer : S.delta <= 0 ? c.green : c.red;
    const showCaption = rr.h >= 34;
    const size = fitText(g, str, rr.w * 0.95, showCaption ? rr.h * 0.66 : rr.h * 0.9);
    text(g, str, rr.x + rr.w / 2, rr.y + (showCaption ? rr.h * 0.38 : rr.h / 2), size, color, 800);
    if (showCaption) text(g, 'Δ BEST', rr.x + rr.w / 2, rr.y + rr.h * 0.86, Math.max(9, rr.h * 0.16), c.dim, 700);
  },

  laptime(S, r) {
    const { g, c, store } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const cur = fmtTime(store.s('CurrentLapMs'));
    text(g, cur, rr.x + rr.w / 2, rr.y + rr.h * 0.3, fitText(g, cur, rr.w * 0.95, rr.h * 0.46), c.bright, 800);
    if (rr.h >= 36) {
      const sub = `LAST ${fmtTime(store.s('LastLapMs'))}   BEST ${fmtTime(store.s('BestLapMs'))}`;
      text(g, sub, rr.x + rr.w / 2, rr.y + rr.h * 0.76, fitText(g, sub, rr.w * 0.97, rr.h * 0.2, 700), c.dim, 700);
    }
  },

  gforce(S, r) {
    const { g, c } = S;
    const { cx, cy, r: rad } = circle(r);
    if (rad < 10) return;
    const R = rad * 0.92, scale = 1.5;                       // the outer ring is 1.5 g
    g.fillStyle = withAlpha(c.panel, 0.55); g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
    g.strokeStyle = withAlpha(c.chartGrid, 1); g.lineWidth = 1;
    for (const k of [0.5, 1, 1.5]) { g.beginPath(); g.arc(cx, cy, R * k / scale, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    const lat = Math.max(-scale, Math.min(scale, S.latG)), lon = Math.max(-scale, Math.min(scale, S.longG));
    const bx = cx + lat / scale * R, by = cy - lon / scale * R;
    g.save(); g.fillStyle = c.accent; g.shadowColor = c.accent; g.shadowBlur = rad * 0.15;
    g.beginPath(); g.arc(bx, by, Math.max(3, rad * 0.09), 0, Math.PI * 2); g.fill(); g.restore();
    if (rad >= 30) text(g, `${Math.hypot(S.latG, S.longG).toFixed(2)} g`, cx, cy + R * 0.62, rad * 0.18, c.dim, 700);
  },

  compass(S, r) {
    const { cx, cy, r: rad } = circle(r);
    if (rad < 10) return;
    drawCompass(S.g, cx, cy, rad * 0.9, S.store.f('Yaw'));
  },

  speed_trace(S, r) {
    const { g, c, store, u } = S;
    panel(S, r);
    const rr = inset(r, 0.06);
    text(g, `SPEED · 20 s`, rr.x + 4, rr.y + 2, Math.max(8, Math.min(11, rr.h * 0.16)), c.chartTitle, 700, 'left', 'top');
    const tl = store.timeline;
    if (!tl || tl.length < 2) return;
    const t1 = tl.latestTime();
    const cols = Math.max(8, Math.floor(rr.w));
    const d = tl.window('SpeedKmh', t1 - 20, t1, cols);
    let peak = 100;
    for (let i = 0; i < cols; i++) if (d.max[i] > peak) peak = d.max[i];
    const top = rr.y + Math.min(14, rr.h * 0.2), hgt = rr.y + rr.h - top;
    const runs = columnRuns(d, Math.max(2, Math.ceil(0.25 / (20 / cols))));
    const xOf = (i) => rr.x + (i + 0.5) * (rr.w / cols);
    const yOf = (i) => top + hgt - ((d.min[i] + d.max[i]) / 2) / (peak * 1.05) * hgt;
    g.fillStyle = withAlpha(c.accent, 0.2); g.strokeStyle = c.accent; g.lineWidth = 1.6; g.lineJoin = 'round';
    for (const [i0, i1] of runs) {
      g.beginPath(); g.moveTo(xOf(i0), top + hgt);
      for (let i = i0; i <= i1; i++) if (Number.isFinite(d.min[i])) g.lineTo(xOf(i), yOf(i));
      g.lineTo(xOf(i1), top + hgt); g.closePath(); g.fill();
    }
    g.beginPath();
    for (const [i0, i1] of runs) {
      g.moveTo(xOf(i0), yOf(i0));
      for (let i = i0 + 1; i <= i1; i++) if (Number.isFinite(d.min[i])) g.lineTo(xOf(i), yOf(i));
    }
    g.stroke();
    if (rr.h >= 40) text(g, `${Math.round(conv.speed(peak, u))}`, rr.x + rr.w - 4, rr.y + 2, Math.max(8, Math.min(11, rr.h * 0.16)), c.chartText, 600, 'right', 'top');
  },

  drift(S, r) {
    const { g, c, analytics } = S;
    panel(S, r);
    const rr = inset(r, 0.08);
    const d = analytics && analytics.drift ? analytics.drift.state : null;
    const score = d ? Math.round(d.score) : 0;
    const active = !!(d && d.active);
    const num = score.toLocaleString();
    const size = fitText(g, num, rr.w * 0.62, rr.h * 0.5);
    text(g, num, rr.x + rr.w * 0.36, rr.y + rr.h * 0.42, size, active ? c.accent : c.dim, 800);
    if (d) text(g, `×${d.mult.toFixed(d.mult % 1 ? 1 : 0)}`, rr.x + rr.w * 0.86, rr.y + rr.h * 0.42, Math.min(rr.h * 0.4, rr.w * 0.18), d.mult >= 3 ? c.amber : c.dim, 800);
    text(g, 'DRIFT', rr.x + rr.w / 2, rr.y + rr.h * 0.86, Math.max(8, rr.h * 0.16), c.dim, 700);
  },
};
