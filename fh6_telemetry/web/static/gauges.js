// Canvas drawing primitives shared by the Cockpit / Lab / Car views.
// Pure drawing: callers own the state, smoothing and layout.  Colours come from theme.js.

import { colors, mix, withAlpha } from './theme.js';

const TAU = Math.PI * 2;
const START = Math.PI * 0.75;          // 135°: bottom-left
const SWEEP = Math.PI * 1.5;           // 270° dial

/** Frame-rate independent smoothing toward a target (rate ~ 1/seconds). */
export function smooth(current, target, dt, rate = 18) {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) * rate));
}

/** Prepare a canvas for CSS-pixel drawing; returns {w,h,dpr} (call each frame, cheap). */
export function fitCanvas(canvas, ctx) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(20, Math.floor(r.width)), h = Math.max(20, Math.floor(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * A 270° analog dial.
 * @param {object} o  {cx, cy, r, min, max, value, major, minorPerMajor=5, label:(v)=>string,
 *                     bands:[{from,to,color}], caption, captionSub, ticksColor}
 */
export function drawDial(ctx, o) {
  const c = colors();
  const { cx, cy, r, min, max, value } = o;
  const span = max - min || 1;
  const ang = (v) => START + SWEEP * Math.max(0, Math.min(1, (v - min) / span));

  // face
  const g = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r);
  g.addColorStop(0, c.panel); g.addColorStop(1, c.panel2);
  ctx.save();
  ctx.shadowColor = c.glow; ctx.shadowBlur = r * 0.12;
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.lineWidth = Math.max(1.5, r * 0.025);
  ctx.strokeStyle = c.border;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();

  // colour bands (redline etc.)
  for (const b of o.bands || []) {
    ctx.strokeStyle = b.color; ctx.lineWidth = r * 0.055; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.9, ang(b.from), ang(b.to)); ctx.stroke();
  }

  // glowing progress arc
  const a1 = ang(value);
  ctx.save();
  ctx.strokeStyle = o.arcColor || c.accent; ctx.lineWidth = r * 0.03; ctx.lineCap = 'round';
  ctx.shadowColor = o.arcColor || c.accent; ctx.shadowBlur = r * 0.1;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.96, START, Math.max(START + 0.001, a1)); ctx.stroke();
  ctx.restore();

  // ticks + labels
  const major = o.major || span / 10;
  const per = o.minorPerMajor || 5;
  ctx.fillStyle = c.bright; ctx.strokeStyle = o.ticksColor || c.dim;
  ctx.font = `700 ${Math.round(r * 0.115)}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let v = min; v <= max + 1e-6; v += major / per) {
    const isMajor = Math.abs(((v - min) / major) % 1) < 1e-6 || Math.abs(((v - min) / major) % 1 - 1) < 1e-6;
    const a = ang(v);
    const r0 = r * (isMajor ? 0.78 : 0.82), r1 = r * 0.88;
    ctx.lineWidth = isMajor ? Math.max(2, r * 0.025) : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
    if (isMajor && o.label) ctx.fillText(o.label(v), cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64);
  }

  // needle
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(a1);
  ctx.shadowColor = c.needle; ctx.shadowBlur = r * 0.08;
  ctx.fillStyle = c.needle;
  ctx.beginPath();
  ctx.moveTo(-r * 0.14, -r * 0.018); ctx.lineTo(r * 0.86, -r * 0.006);
  ctx.lineTo(r * 0.86, r * 0.006); ctx.lineTo(-r * 0.14, r * 0.018);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // hub
  const hub = ctx.createRadialGradient(cx - r * 0.02, cy - r * 0.02, 1, cx, cy, r * 0.09);
  hub.addColorStop(0, c.bright); hub.addColorStop(1, c.dimmer);
  ctx.fillStyle = hub; ctx.beginPath(); ctx.arc(cx, cy, r * 0.075, 0, TAU); ctx.fill();

  if (o.caption) {
    ctx.fillStyle = c.dim; ctx.font = `600 ${Math.round(r * 0.09)}px system-ui, sans-serif`;
    ctx.fillText(o.caption, cx, cy + r * 0.52);
  }
}

/** Row of shift-light LEDs. level = shiftLevel() result; ts for the flash blink. */
export function drawShiftLights(ctx, x, y, w, h, level, ts) {
  const c = colors();
  const n = level.zones.length;
  const gap = w * 0.012;
  const d = Math.min(h, (w - gap * (n - 1)) / n);
  const total = d * n + gap * (n - 1);
  const x0 = x + (w - total) / 2, cy = y + h / 2;
  const blinkOn = !level.flashing || Math.floor(ts / 70) % 2 === 0;
  const pal = { g: c.green, y: c.amber, r: c.red, b: c.blue };
  for (let i = 0; i < n; i++) {
    const cx = x0 + i * (d + gap) + d / 2;
    const lit = level.flashing ? blinkOn : i < level.lit;
    ctx.save();
    if (lit) { ctx.shadowColor = pal[level.zones[i]]; ctx.shadowBlur = d * 0.9; }
    ctx.fillStyle = lit ? pal[level.zones[i]] : c.ledOff;
    ctx.beginPath(); ctx.arc(cx, cy, d * 0.42, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

/** Steering wheel rotated by `angle` radians. */
export function drawWheel(ctx, cx, cy, r, angle) {
  const c = colors();
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = r * 0.12; ctx.shadowOffsetY = r * 0.04;
  // rim
  ctx.strokeStyle = mix(c.panel2, '#000000', 0.15); ctx.lineWidth = r * 0.2;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.88, 0, TAU); ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = c.dimmer; ctx.lineWidth = r * 0.17;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.88, 0, TAU); ctx.stroke();
  ctx.strokeStyle = withAlpha(c.bright, 0.18); ctx.lineWidth = r * 0.03;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.93, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
  // 12 o'clock marker
  ctx.fillStyle = c.accent;
  ctx.shadowColor = c.accent; ctx.shadowBlur = r * 0.1;
  ctx.fillRect(-r * 0.035, -r * 0.99, r * 0.07, r * 0.2);
  ctx.shadowColor = 'transparent';
  // spokes (left, right, bottom)
  ctx.strokeStyle = c.dimmer; ctx.lineWidth = r * 0.12; ctx.lineCap = 'round';
  for (const a of [Math.PI, 0, Math.PI / 2]) {
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2);
    ctx.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); ctx.stroke();
  }
  // hub
  const g = ctx.createRadialGradient(-r * 0.05, -r * 0.05, 1, 0, 0, r * 0.28);
  g.addColorStop(0, c.panel); g.addColorStop(1, c.panel2);
  ctx.fillStyle = g; ctx.strokeStyle = c.accent; ctx.lineWidth = r * 0.025;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.26, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.restore();
}

/** Vertical pedal bar with a rounded fill. */
export function drawPedal(ctx, x, y, w, h, frac, color, label) {
  const c = colors();
  ctx.fillStyle = c.panel2; roundRect(ctx, x, y, w, h, w * 0.25); ctx.fill();
  ctx.strokeStyle = c.border; ctx.lineWidth = 1.5; roundRect(ctx, x, y, w, h, w * 0.25); ctx.stroke();
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0.005) {
    ctx.save();
    roundRect(ctx, x, y, w, h, w * 0.25); ctx.clip();
    ctx.shadowColor = color; ctx.shadowBlur = w * 0.5;
    ctx.fillStyle = color;
    ctx.fillRect(x, y + h * (1 - f), w, h * f);
    ctx.restore();
  }
  if (label) {
    ctx.fillStyle = c.dim; ctx.font = `700 ${Math.max(9, Math.round(w * 0.32))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, x + w / 2, y + h + 4);
  }
}

/** Artificial horizon: pitch/roll in radians. */
export function drawHorizon(ctx, cx, cy, r, pitch, roll) {
  const c = colors();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
  ctx.translate(cx, cy); ctx.rotate(-roll);
  const off = Math.max(-r, Math.min(r, pitch * r * 3.2));
  ctx.fillStyle = mix(c.blue, c.panel2, 0.55); ctx.fillRect(-r * 2, -r * 2 + off, r * 4, r * 2);
  ctx.fillStyle = mix('#8a5a2b', c.panel2, 0.45); ctx.fillRect(-r * 2, off, r * 4, r * 2);
  ctx.strokeStyle = c.bright; ctx.lineWidth = Math.max(1, r * 0.02);
  ctx.beginPath(); ctx.moveTo(-r, off); ctx.lineTo(r, off); ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(c.bright, 0.55);
  for (const d of [-0.3, -0.15, 0.15, 0.3]) {
    const y = off + d * r * 3.2 * 0.5;
    ctx.beginPath(); ctx.moveTo(-r * 0.22, y); ctx.lineTo(r * 0.22, y); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = c.border; ctx.lineWidth = Math.max(2, r * 0.04);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  // fixed aircraft symbol
  ctx.strokeStyle = c.amber; ctx.lineWidth = Math.max(2, r * 0.05); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx - r * 0.5, cy); ctx.lineTo(cx - r * 0.18, cy); ctx.lineTo(cx - r * 0.18, cy + r * 0.1);
  ctx.moveTo(cx + r * 0.5, cy); ctx.lineTo(cx + r * 0.18, cy); ctx.lineTo(cx + r * 0.18, cy + r * 0.1);
  ctx.stroke();
  ctx.fillStyle = c.amber; ctx.beginPath(); ctx.arc(cx, cy, r * 0.03, 0, TAU); ctx.fill();
}

/** Compass ring with the heading (yaw) at the top. */
export function drawCompass(ctx, cx, cy, r, yaw) {
  const c = colors();
  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = c.border; ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  ctx.rotate(-yaw);
  ctx.font = `700 ${Math.round(r * 0.28)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const names = ['N', 'E', 'S', 'W'];           // world +Z is "north" on the map
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    ctx.fillStyle = i === 0 ? c.red : c.dim;
    ctx.fillText(names[i], Math.sin(a) * r * 0.68, -Math.cos(a) * r * 0.68);
  }
  ctx.strokeStyle = c.dimmer; ctx.lineWidth = 1;
  for (let i = 0; i < 36; i++) {
    const a = i * Math.PI / 18, l = i % 9 === 0 ? 0.14 : 0.07;
    ctx.beginPath(); ctx.moveTo(Math.sin(a) * r * (1 - l), -Math.cos(a) * r * (1 - l)); ctx.lineTo(Math.sin(a) * r, -Math.cos(a) * r); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = c.accent;
  ctx.beginPath(); ctx.moveTo(cx, cy - r * 1.02); ctx.lineTo(cx - r * 0.09, cy - r * 0.8); ctx.lineTo(cx + r * 0.09, cy - r * 0.8); ctx.closePath(); ctx.fill();
}
