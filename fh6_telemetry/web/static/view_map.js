// Live track map: the car's path from PositionX/Z, coloured by speed, with a heading-aware
// marker.  Modes: Fit (whole trail), Follow (centred on the car, optional heading-up), Free (pan/zoom).

import { niceStep } from './format.js';
import { fitCanvas, roundRect, smooth } from './gauges.js';
import { colors, heat, withAlpha } from './theme.js';
import { fmt, label, conv } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const MIN_STEP2 = 2.5 * 2.5;      // metres² between recorded points
const BREAK_M = 80;               // a jump bigger than this starts a new trail segment (teleport)
const MAX_POINTS = 40000;
const BUCKETS = 24;

export function buildMap(ctx) {
  const { store, settings } = ctx;
  const root = h('div', 'view v-map');
  const canvas = h('canvas', 'map-canvas');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');

  // ---- trail data ----------------------------------------------------------------------------
  const T = { x: [], z: [], v: [], brk: new Set(), laps: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, vmax: 0 };
  function clearTrail() {
    T.x.length = T.z.length = T.v.length = 0; T.brk.clear(); T.laps.length = 0;
    T.minX = T.minZ = Infinity; T.maxX = T.maxZ = -Infinity; T.vmax = 0;
  }
  function thin() {                                  // keep the shape, halve the points
    const keep = (i) => i % 2 === 0 || T.brk.has(i) || T.laps.some((l) => l.i === i);
    const nx = [], nz = [], nv = [], nbrk = new Set(), map = new Map();
    for (let i = 0; i < T.x.length; i++) if (keep(i)) { map.set(i, nx.length); if (T.brk.has(i)) nbrk.add(nx.length); nx.push(T.x[i]); nz.push(T.z[i]); nv.push(T.v[i]); }
    T.laps = T.laps.map((l) => ({ ...l, i: map.get(l.i) ?? nx.length - 1 }));
    T.x = nx; T.z = nz; T.v = nv; T.brk = nbrk;
  }
  const WORLD_LIMIT = 1e7;                           // metres; anything beyond is garbage, not a place on the map
  function addPoint(x, z, v) {
    if (!(Math.abs(x) < WORLD_LIMIT && Math.abs(z) < WORLD_LIMIT && Number.isFinite(v))) return;
    const n = T.x.length;
    if (n) {
      const dx = x - T.x[n - 1], dz = z - T.z[n - 1], d2 = dx * dx + dz * dz;
      if (d2 < MIN_STEP2) return;
      if (d2 > BREAK_M * BREAK_M) T.brk.add(n);
    }
    T.x.push(x); T.z.push(z); T.v.push(v);
    T.minX = Math.min(T.minX, x); T.maxX = Math.max(T.maxX, x);
    T.minZ = Math.min(T.minZ, z); T.maxZ = Math.max(T.maxZ, z);
    T.vmax = Math.max(T.vmax, v);
    if (T.x.length > MAX_POINTS) { thin(); recomputeBounds(); }
  }
  function recomputeBounds() {
    T.minX = T.minZ = Infinity; T.maxX = T.maxZ = -Infinity;
    for (let i = 0; i < T.x.length; i++) { T.minX = Math.min(T.minX, T.x[i]); T.maxX = Math.max(T.maxX, T.x[i]); T.minZ = Math.min(T.minZ, T.z[i]); T.maxZ = Math.max(T.maxZ, T.z[i]); }
  }

  store.onRows((rows) => {
    const F = store.F;
    for (const r of rows) if (r[F.IsRaceOn]) addPoint(r[F.PositionX], r[F.PositionZ], r[F.SpeedKmh]);
  });
  let lapSeen = null;
  store.onSlow((slow) => {
    const n = slow[store.S.LapNumber];
    if (lapSeen !== null && n > lapSeen && n >= 1 && T.x.length) T.laps.push({ i: T.x.length - 1, n });
    lapSeen = n;
  });
  store.onHello((_s, reset) => { if (reset) { clearTrail(); lapSeen = null; } });

  // ---- view state -------------------------------------------------------------------------------
  const V = { mode: 'fit', scale: 0.35, cx: 0, cz: 0, headingUp: false, s: 0.1, scx: 0, scz: 0, yaw: 0, init: false };

  // controls
  const ctl = h('div', 'map-ctl');
  const mk = (txt, title, fn) => { const b = h('button', 'chip', txt); b.title = title; b.addEventListener('click', fn); ctl.appendChild(b); return b; };
  const bFit = mk('Fit', 'Show the whole trail', () => { V.mode = 'fit'; });
  const bFollow = mk('Follow', 'Centre on the car', () => { V.mode = 'follow'; });
  const bHead = mk('N ↑', 'North-up / heading-up', () => { V.headingUp = !V.headingUp; if (V.headingUp) V.mode = 'follow'; });
  mk('＋', 'Zoom in', () => zoomBy(1.4));
  mk('－', 'Zoom out', () => zoomBy(1 / 1.4));
  mk('Clear', 'Forget the trail', () => clearTrail());
  const info = h('div', 'map-info');
  root.append(ctl, info);

  function zoomBy(k) {
    if (V.mode === 'fit') { V.mode = 'free'; V.scale = V.s; V.cx = V.scx; V.cz = V.scz; }
    V.scale = Math.max(0.02, Math.min(8, V.scale * k));
  }

  // pan / pinch
  const ptrs = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = 0; });
  canvas.addEventListener('pointerup', (e) => ptrs.delete(e.pointerId));
  canvas.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomBy(d / pinch);
      pinch = d;
      return;
    }
    if (V.mode !== 'free') { V.mode = 'free'; V.scale = V.s; V.cx = V.scx; V.cz = V.scz; }
    const s = V.scale, c = Math.cos(V.yaw), sn = Math.sin(V.yaw);
    let mx = -dx / s, mz = dy / s;                              // screen drag -> world shift (north-up)
    if (V.headingUp) { const rx = mx * c + mz * sn, rz = -mx * sn + mz * c; mx = rx; mz = rz; }
    V.cx += mx; V.cz += mz;
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  function update(dt) {
    const c = colors();
    const u = settings.get('units');
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    const carX = store.f('PositionX'), carZ = store.f('PositionZ');
    const yawT = store.f('Yaw');
    // shortest-path yaw smoothing
    let dy = yawT - V.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    V.yaw += dy * (1 - Math.exp(-dt * 10));

    // ---- transform ---------------------------------------------------------------------------------------
    let tgtS, tgtX, tgtZ;
    const pad = 0.12;
    if (V.mode === 'fit' && T.x.length > 1) {
      const minX = Math.min(T.minX, carX), maxX = Math.max(T.maxX, carX), minZ = Math.min(T.minZ, carZ), maxZ = Math.max(T.maxZ, carZ);
      const bw = Math.max(40, maxX - minX), bz = Math.max(40, maxZ - minZ);
      tgtS = Math.min(w * (1 - 2 * pad) / bw, H * (1 - 2 * pad) / bz, 3);
      tgtX = (minX + maxX) / 2; tgtZ = (minZ + maxZ) / 2;
    } else if (V.mode === 'free') { tgtS = V.scale; tgtX = V.cx; tgtZ = V.cz; }
    else { tgtS = V.scale; tgtX = carX; tgtZ = carZ; }
    if (!V.init) { V.s = tgtS; V.scx = tgtX; V.scz = tgtZ; V.init = true; }
    const rate = V.mode === 'follow' ? 14 : 6;
    V.s = smooth(V.s, tgtS, dt, rate); V.scx = smooth(V.scx, tgtX, dt, rate); V.scz = smooth(V.scz, tgtZ, dt, rate);
    const s = V.s, cx = V.scx, cz = V.scz;
    const ψ = V.headingUp ? V.yaw : 0, cs = Math.cos(ψ), sn = Math.sin(ψ);
    const sx = (x, z) => { const dx = x - cx, dz = z - cz; return w / 2 + (dx * cs - dz * sn) * s; };
    const sy = (x, z) => { const dx = x - cx, dz = z - cz; return H / 2 - (dx * sn + dz * cs) * s; };

    // ---- grid / range rings ----------------------------------------------------------------------------------
    const step = niceStep(110 / s);
    g.lineWidth = 1; g.strokeStyle = c.chartGrid; g.fillStyle = c.chartText;
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    if (!V.headingUp) {
      const x0 = Math.floor((cx - w / 2 / s) / step) * step, x1 = cx + w / 2 / s;
      const z0 = Math.floor((cz - H / 2 / s) / step) * step, z1 = cz + H / 2 / s;
      const nx = Math.min(200, Math.floor((x1 - x0) / step) + 1), nz = Math.min(200, Math.floor((z1 - z0) / step) + 1);
      g.beginPath();
      // index-bounded (not `x += step`): a huge camera coordinate would make that never advance
      for (let i = 0; i < nx; i++) { const px = Math.round(sx(x0 + i * step, cz)) + 0.5; g.moveTo(px, 0); g.lineTo(px, H); }
      for (let i = 0; i < nz; i++) { const py = Math.round(sy(cx, z0 + i * step)) + 0.5; g.moveTo(0, py); g.lineTo(w, py); }
      g.stroke();
    } else {
      const cxp = sx(carX, carZ), cyp = sy(carX, carZ);
      for (let k = 1; k <= 8; k++) { g.beginPath(); g.arc(cxp, cyp, k * step * s, 0, Math.PI * 2); g.stroke(); }
    }

    // ---- trail: one path per speed bucket (so cost doesn't grow with the colours) --------------------------
    const vmax = Math.max(120, T.vmax);
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    const M = 8;                                     // cull margin: stroke half-width + round caps
    let drawn = 0, lx = 0, ly = 0, have = false;
    for (let i = 0; i < T.x.length; i++) {
      const px = sx(T.x[i], T.z[i]), py = sy(T.x[i], T.z[i]);
      if (T.brk.has(i)) have = false;
      if (have) {
        if (Math.abs(px - lx) + Math.abs(py - ly) >= 1.5) {
          // cull segments that are entirely off-canvas (a long session pans/zooms over a few % of the trail)
          if (Math.max(lx, px) >= -M && Math.min(lx, px) <= w + M && Math.max(ly, py) >= -M && Math.min(ly, py) <= H + M) {
            const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(T.v[i] / vmax * BUCKETS)));
            paths[b].moveTo(lx, ly); paths[b].lineTo(px, py);
          }
          lx = px; ly = py; drawn++;
        }
      } else { lx = px; ly = py; have = true; }
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let b = 0; b < BUCKETS; b++) {
      const col = heat((b + 0.5) / BUCKETS);
      g.strokeStyle = withAlpha(col, 0.22); g.lineWidth = 7; g.stroke(paths[b]);
    }
    for (let b = 0; b < BUCKETS; b++) {
      g.strokeStyle = heat((b + 0.5) / BUCKETS); g.lineWidth = 3; g.stroke(paths[b]);
    }

    // ---- lap flags ------------------------------------------------------------------------------------------------
    g.font = '16px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (const l of T.laps) if (l.i < T.x.length) g.fillText('🏁', sx(T.x[l.i], T.z[l.i]), sy(T.x[l.i], T.z[l.i]));

    // ---- car ------------------------------------------------------------------------------------------------------------
    const cxp = sx(carX, carZ), cyp = sy(carX, carZ);
    g.save(); g.translate(cxp, cyp); g.rotate(V.headingUp ? 0 : V.yaw);
    g.shadowColor = c.accent; g.shadowBlur = 14;
    g.fillStyle = c.bright; g.strokeStyle = c.accent; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 9); g.lineTo(0, 5); g.lineTo(-7, 9); g.closePath(); g.fill(); g.stroke();
    g.restore();

    // ---- scale bar + speed legend -----------------------------------------------------------------------------------
    const barM = step, barPx = barM * s;
    g.strokeStyle = c.bright; g.lineWidth = 2; g.fillStyle = c.bright;
    g.beginPath(); g.moveTo(14, H - 18); g.lineTo(14 + barPx, H - 18); g.moveTo(14, H - 23); g.lineTo(14, H - 13); g.moveTo(14 + barPx, H - 23); g.lineTo(14 + barPx, H - 13); g.stroke();
    g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(fmt.distShort(barM, u), 14, H - 26);
    const lw = Math.min(180, w * 0.3), lx0 = w - lw - 14, ly0 = H - 22;
    const grad = g.createLinearGradient(lx0, 0, lx0 + lw, 0);
    for (let k = 0; k <= 10; k++) grad.addColorStop(k / 10, heat(k / 10));
    g.fillStyle = grad; roundRect(g, lx0, ly0, lw, 8, 4); g.fill();
    g.fillStyle = c.chartText; g.textBaseline = 'bottom'; g.textAlign = 'left'; g.fillText('0', lx0, ly0 - 3);
    g.textAlign = 'right'; g.fillText(`${Math.round(conv.speed(vmax, u))} ${label.speed(u)}`, lx0 + lw, ly0 - 3);

    // ---- chrome state ----------------------------------------------------------------------------------------------------
    bFit.classList.toggle('on', V.mode === 'fit');
    bFollow.classList.toggle('on', V.mode === 'follow');
    bHead.classList.toggle('on', V.headingUp);
    const ht = V.headingUp ? '⬆ Heading' : 'N ↑';
    if (bHead._t !== ht) { bHead._t = ht; bHead.textContent = ht; }
    const txt = T.x.length ? `${T.x.length.toLocaleString()} pts · ${T.laps.length} lap flag${T.laps.length === 1 ? '' : 's'}` : 'Drive to draw your track';
    if (info._t !== txt) { info._t = txt; info.textContent = txt; }
  }

  return {
    id: 'map', title: 'Map', color: '#3ddc84', el: root, charts: [], animated: true, update,
    clear: clearTrail, _trail: T,
  };
}
