// Lab: automatic performance timers (0-60 / 0-100 / 0-200 / ¼ mile / braking), a G-G traction
// circle, a drift combo scorer, airtime, records, a horizon + compass, and the trophy room.

import { ACHIEVEMENTS } from './achievements.js';
import { fixed, signed } from './format.js';
import { drawCompass, drawHorizon, fitCanvas } from './gauges.js';
import { colors, mix, withAlpha } from './theme.js';
import { conv, fmt, label } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const setText = (n, s) => { if (n._t !== s) { n._t = s; n.textContent = s; } };
const setCls = (n, name, on) => { if (n._k === undefined) n._k = {}; if (n._k[name] !== on) { n._k[name] = on; n.classList.toggle(name, on); } };
const setCss = (n, p, v) => { const c = n._c || (n._c = {}); if (c[p] !== v) { c[p] = v; n.style[p] = v; } };

function card(title, ...children) {
  const c = h('section', 'card');
  if (title) c.appendChild(h('h3', null, title));
  for (const ch of children) c.appendChild(ch);
  return c;
}

const PERF_TILES = [
  { key: 't60mph', title: '0–60 mph', fmt: (v) => `${v.toFixed(2)} s` },
  { key: 't100', title: '0–100 km/h', fmt: (v) => `${v.toFixed(2)} s` },
  { key: 't200', title: '0–200 km/h', fmt: (v) => `${v.toFixed(2)} s` },
  { key: 't100to200', title: '100–200 km/h', fmt: (v) => `${v.toFixed(2)} s` },
  { key: 'qmile', title: '¼ mile', fmt: (v) => `${v.time.toFixed(2)} s`, sub: (v, u) => `${Math.round(conv.speed(v.trapKmh, u))} ${label.speed(u)} trap`, bestOf: (v) => v.time },
  { key: 'brake100', title: '100–0 km/h', fmt: (v) => `${v.dist.toFixed(1)} m`, sub: (v) => `${v.time.toFixed(2)} s`, bestOf: (v) => v.dist },
  { key: 'brake60mph', title: '60–0 mph', fmt: (v) => `${v.dist.toFixed(1)} m`, sub: (v) => `${v.time.toFixed(2)} s`, bestOf: (v) => v.dist },
];

export function buildLab(ctx) {
  const { store, settings, analytics: A } = ctx;
  const root = h('div', 'view v-lab');
  const grid = h('div', 'grid lab-grid');
  root.appendChild(grid);

  // ---- performance meter -----------------------------------------------------------------------------------------
  const perfStatus = h('div', 'perf-status', 'Stop the car to arm the timers');
  const perfLive = h('div', 'perf-live', '');
  const tiles = new Map();
  const tileWrap = h('div', 'perf-tiles');
  for (const t of PERF_TILES) {
    const el = h('div', 'perf-tile');
    const title = h('div', 'pt-title', t.title), val = h('div', 'pt-val', '—'), sub = h('div', 'pt-sub', ''), best = h('div', 'pt-best', '');
    el.append(title, val, sub, best);
    tileWrap.appendChild(el);
    tiles.set(t.key, { el, val, sub, best, last: null });
  }
  const perfCard = card('Performance meter', perfStatus, perfLive, tileWrap);
  perfCard.classList.add('span-2');

  // ---- G-G circle ------------------------------------------------------------------------------------------------------
  const ggCanvas = h('canvas', 'gg-canvas');
  const ggCard = card('G-force circle', ggCanvas);
  ggCard.classList.add('canvas-card');
  const ggCtx = ggCanvas.getContext('2d');

  // ---- drift -----------------------------------------------------------------------------------------------------------------
  const driftScore = h('div', 'big-num', '0');
  const driftMult = h('span', 'mult', '×1');
  const driftAngle = h('div', 'sub-num', '0°');
  const driftBar = h('div', 'chain-bar'); const driftFill = h('div', 'chain-fill'); driftBar.appendChild(driftFill);
  const driftRows = h('div', 'kv');
  const dBest = h('span', 'v', '0'), dBank = h('span', 'v', '0'), dAng = h('span', 'v', '0°');
  driftRows.append(h('span', 'k', 'Best chain:'), dBest, h('span', 'k', 'Banked total:'), dBank, h('span', 'k', 'Max angle:'), dAng);
  const scoreRow = h('div', 'score-row'); scoreRow.append(driftScore, driftMult);
  const driftCard = card('Drift', scoreRow, driftAngle, driftBar, driftRows);

  // ---- air --------------------------------------------------------------------------------------------------------------------------
  const airNow = h('div', 'big-num', '—');
  const airRows = h('div', 'kv');
  const aLast = h('span', 'v', '—'), aLong = h('span', 'v', '—'), aCount = h('span', 'v', '0');
  airRows.append(h('span', 'k', 'Last jump:'), aLast, h('span', 'k', 'Longest:'), aLong, h('span', 'k', 'Jumps:'), aCount);
  const airCard = card('Airtime', airNow, airRows);

  // ---- records ------------------------------------------------------------------------------------------------------------------------
  const recTable = h('div', 'rec-table');
  recTable.append(h('span', 'rh', ''), h('span', 'rh', 'Session'), h('span', 'rh', 'Lifetime'));
  const recRows = [
    ['Top speed', (s, u) => `${Math.round(conv.speed(s.topSpeedKmh, u))} ${label.speed(u)}`, 'topSpeedKmh'],
    ['Max RPM', (s) => String(Math.round(s.maxRpm)), 'maxRpm'],
    ['Max lateral', (s) => `${s.maxLatG.toFixed(2)} g`, 'maxLatG'],
    ['Max braking', (s) => `${s.maxBrakeG.toFixed(2)} g`, 'maxBrakeG'],
    ['Max accel', (s) => `${s.maxAccelG.toFixed(2)} g`, 'maxAccelG'],
    ['Peak power', (s, u) => `${Math.round(conv.power(s.maxPowerHp, u))} ${label.power(u)}`, 'maxPowerHp'],
    ['Distance', (s, u) => `${conv.dist(s.odometerM, u).toFixed(1)} ${label.dist(u)}`, 'odometerM'],
  ].map(([name, f, key]) => {
    const a = h('span', 'rk', name), b = h('span', 'rv', '—'), c = h('span', 'rv dim', '—');
    recTable.append(a, b, c);
    return { f, key, b, c };
  });
  const recCard = card('Records', recTable);

  // ---- attitude ------------------------------------------------------------------------------------------------------------------------------
  const attCanvas = h('canvas', 'att-canvas');
  const attCard = card('Attitude · heading', attCanvas);
  attCard.classList.add('canvas-card');
  const attCtx = attCanvas.getContext('2d');

  // ---- trophy room -----------------------------------------------------------------------------------------------------------------------------------
  const trophyTitle = h('div', 'trophy-prog', '');
  const trophies = h('div', 'trophies');
  const badgeEls = new Map();
  for (const a of ACHIEVEMENTS) {
    const b = h('div', `trophy trophy-${a.rarity}`, a.icon);
    b.title = `${a.title} — ${a.desc}`;
    b.addEventListener('click', () => { import('./bus.js').then(({ emit }) => emit('toast', { icon: a.icon, title: a.title, text: a.desc, rarity: A && A.achievements.isUnlocked(a.id) ? a.rarity : 'common', ms: 2800 })); });
    trophies.appendChild(b); badgeEls.set(a.id, b);
  }
  const trophyCard = card('Trophy room', trophyTitle, trophies);
  trophyCard.classList.add('span-2');

  grid.append(perfCard, ggCard, driftCard, airCard, recCard, attCard, trophyCard);

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  const att = { pitch: 0, roll: 0, yaw: 0 };

  function update(dt, ts) {
    if (!A) return;
    const u = settings.get('units');
    const c = colors();

    // performance meter
    const p = A.perf.state;
    const phase = p.phase;
    setText(perfStatus, phase === 'running' ? 'GO!' : phase === 'armed' ? 'READY — launch the car!' : phase === 'done' ? 'Run complete — stop to re-arm' : 'Stop the car to arm the timers');
    setCls(perfStatus, 'go', phase === 'running'); setCls(perfStatus, 'ready', phase === 'armed');
    const live = p.live;
    setText(perfLive, phase === 'running' && live ? `${live.t.toFixed(2)} s   ·   ${Math.round(conv.speed(live.speedKmh, u))} ${label.speed(u)}   ·   ${fmt.distShort(live.distM, u)}` : (p.brake && p.brake.active ? `braking… ${fmt.distShort(p.brake.distM, u)}  ${p.brake.timeS.toFixed(2)} s` : ''));
    const bests = (ctx.lifetime && ctx.lifetime.best) || {};
    for (const t of PERF_TILES) {
      const el = tiles.get(t.key), v = p.results[t.key];
      const key = v === undefined || v === null ? '' : JSON.stringify(v);
      if (el.last !== key) {
        el.last = key;
        if (key) { el.el.classList.add('pop'); setTimeout(() => el.el.classList.remove('pop'), 1200); }
      }
      setText(el.val, v ? t.fmt(v) : '—');
      setText(el.sub, v && t.sub ? t.sub(v, u) : '');
      setCls(el.el, 'has', !!v);
      const b = bests[t.key];
      setText(el.best, b !== undefined && b !== null ? `best ${t.fmt(typeof b === 'object' ? b : b)}` : '');
    }

    // G-G
    drawGG(ggCtx, ggCanvas, c);

    // drift
    const d = A.drift.state;
    setText(driftScore, Math.round(d.score).toLocaleString());
    setText(driftMult, `×${d.mult.toFixed(d.mult % 1 ? 1 : 0)}`);
    setCls(driftMult, 'hot', d.mult >= 3);
    setText(driftAngle, `${d.active ? Math.abs(d.angleDeg).toFixed(0) : '0'}°  sideslip`);
    const chain = d.active ? Math.max(0, 1 - (d.gapS || 0) / 1.2) : 0;     // full while scoring, drains during the 1.2 s grace gap
    setCss(driftFill, 'width', (chain * 100).toFixed(0) + '%');
    setCls(driftCard, 'active', d.active);
    setText(dBest, Math.round(d.best).toLocaleString()); setText(dBank, Math.round(d.banked).toLocaleString());
    setText(dAng, `${Math.max(d.sessionBestAngle || 0, d.maxAngleDeg || 0).toFixed(0)}°`);   // session best (the per-chain value is 0 between drifts)

    // air
    const a = A.air.state;
    setText(airNow, a.active ? `${a.tS.toFixed(2)} s` : '—');
    setCls(airCard, 'active', a.active);
    setText(aLast, a.last ? `${a.last.durationS.toFixed(2)} s · ${fmt.distShort(a.last.distM, u)} · ${a.last.heightM.toFixed(1)} m` : '—');
    setText(aLong, a.longestS ? `${a.longestS.toFixed(2)} s` : '—');
    setText(aCount, String(a.count));

    // records
    const r = A.records.state, life = (ctx.lifetime && ctx.lifetime.records) || {};
    for (const row of recRows) {
      setText(row.b, row.f(r, u));
      setText(row.c, life[row.key] !== undefined ? row.f({ ...zeroRec, ...life }, u) : '—');
    }

    // attitude + compass
    att.pitch += (store.f('Pitch') - att.pitch) * (1 - Math.exp(-dt * 14));
    att.roll += (store.f('Roll') - att.roll) * (1 - Math.exp(-dt * 14));
    att.yaw = store.f('Yaw');
    const { w, h: H } = fitCanvas(attCanvas, attCtx);
    attCtx.clearRect(0, 0, w, H);
    const rr = Math.min(w * 0.23, H * 0.4);
    drawHorizon(attCtx, w * 0.27, H / 2, rr, att.pitch, att.roll);
    drawCompass(attCtx, w * 0.73, H / 2, rr, att.yaw);
    attCtx.fillStyle = c.chartText; attCtx.font = '600 11px system-ui, sans-serif'; attCtx.textAlign = 'center';
    attCtx.fillText(`pitch ${(att.pitch * 57.3).toFixed(1)}°  roll ${(att.roll * 57.3).toFixed(1)}°`, w * 0.27, H / 2 + rr + 16);
    attCtx.fillText(`heading ${((att.yaw * 57.3 + 360) % 360).toFixed(0)}°`, w * 0.73, H / 2 + rr + 16);

    // trophies
    const pr = A.achievements.progress();
    setText(trophyTitle, `${pr.unlocked} / ${pr.total} unlocked — tap a badge`);
    for (const ac of ACHIEVEMENTS) setCls(badgeEls.get(ac.id), 'locked', !A.achievements.isUnlocked(ac.id));
  }

  const zeroRec = { topSpeedKmh: 0, maxRpm: 0, maxLatG: 0, maxBrakeG: 0, maxAccelG: 0, maxPowerHp: 0, odometerM: 0 };

  function drawGG(g, canvas, c) {
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    const cx = w / 2, cy = H / 2 - 6;
    const size = Math.min(w, H - 22);
    const pk = A.gtrail.peaks;
    const range = Math.min(12, Math.max(1.5, Math.ceil(Math.max(pk.left, pk.right, pk.accel, pk.brake) * 2 + 0.01) / 2));   // clamped: a garbage g must not turn the ring loop into millions of arcs
    const s = (size / 2 - 14) / range;
    g.lineWidth = 1; g.strokeStyle = c.chartGrid; g.fillStyle = c.chartText; g.font = '10px system-ui, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'bottom';
    for (let k = 0.5; k <= range + 1e-6; k += 0.5) {
      g.beginPath(); g.arc(cx, cy, k * s, 0, Math.PI * 2); g.stroke();
      g.fillText(`${k.toFixed(1)}`, cx + k * s * 0.707 + 2, cy - k * s * 0.707);
    }
    g.beginPath(); g.moveTo(cx - range * s, cy); g.lineTo(cx + range * s, cy); g.moveTo(cx, cy - range * s); g.lineTo(cx, cy + range * s); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = c.dim; g.font = '600 10px system-ui, sans-serif';
    g.fillText('ACCEL', cx, cy - range * s - 7); g.fillText('BRAKE', cx, cy + range * s + 8);
    // trail
    const tr = A.gtrail.points();
    for (let i = 0; i < tr.n; i++) {
      const f = (i + 1) / tr.n;
      g.fillStyle = withAlpha(c.accent, 0.08 + 0.6 * f * f);
      g.beginPath(); g.arc(cx + tr.x[i] * s, cy - tr.y[i] * s, 1.5 + 2.5 * f, 0, Math.PI * 2); g.fill();
    }
    // peaks
    g.fillStyle = c.amber;
    for (const [x, y] of [[pk.right, 0], [-pk.left, 0], [0, pk.accel], [0, -pk.brake]]) {
      g.beginPath(); g.arc(cx + x * s, cy - y * s, 3, 0, Math.PI * 2); g.fill();
    }
    // current
    const lat = store.f('AccelGX'), lon = store.f('AccelGZ');
    const mag = Math.hypot(lat, lon);
    const col = mag > 1.2 ? c.red : mag > 0.7 ? c.amber : c.green;
    g.save(); g.shadowColor = col; g.shadowBlur = 14; g.fillStyle = col;
    g.beginPath(); g.arc(cx + lat * s, cy - lon * s, 7, 0, Math.PI * 2); g.fill(); g.restore();
    g.fillStyle = c.bright; g.font = '700 12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(`LAT ${signed(lat, 2)} g    LONG ${signed(lon, 2)} g    ${mag.toFixed(2)} g`, cx, H - 6);
  }

  return { id: 'lab', title: 'Lab', color: '#ffdd44', el: root, charts: [], animated: true, update };
}
