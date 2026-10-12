// Cockpit: analog speedo + tacho, F1-style shift lights, a steering wheel that turns,
// pedals, a big gear read-out and the live lap delta.  One canvas, two layouts.

import { colors } from './theme.js';
import { drawDial, drawPedal, drawShiftLights, drawWheel, fitCanvas, smooth } from './gauges.js';
import { shiftLevel } from './shift.js';
import { conv, fmt, label } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function buildCockpit(ctx) {
  const { store, settings, analytics, actions } = ctx;
  const root = h('div', 'view v-cockpit');
  const canvas = h('canvas', 'cockpit-canvas');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');

  // floating controls
  const ctl = h('div', 'cockpit-ctl');
  const bSound = h('button', 'chip', '🔇 Sound'); bSound.title = 'Engine sound (needs a tap)';
  const bMirror = h('button', 'chip', '🪞 HUD'); bMirror.title = 'Mirror the cockpit for a windshield HUD';
  bSound.addEventListener('click', () => actions.toggleSound());
  bMirror.addEventListener('click', () => settings.set('mirror', !settings.get('mirror')));
  ctl.append(bSound, bMirror);
  root.appendChild(ctl);

  const st = { speed: 0, rpm: 0, wheel: 0, thr: 0, brk: 0, clu: 0, delta: 0 };

  function update(dt, ts) {
    const c = colors();
    const u = settings.get('units');
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    root.classList.toggle('mirror', !!settings.get('mirror'));
    const snd = !!settings.get('soundOn');
    if (bSound._on !== snd) { bSound._on = snd; bSound.textContent = snd ? '🔊 Sound' : '🔇 Sound'; bSound.classList.toggle('on', snd); }
    bMirror.classList.toggle('on', !!settings.get('mirror'));

    // ---- data (smoothed so needles glide) -----------------------------------------------------
    const kmh = store.f('SpeedKmh');
    const rpm = store.f('CurrentEngineRpm');
    const maxRpm = store.f('EngineMaxRpm') || 8000;
    st.speed = smooth(st.speed, conv.speed(kmh, u), dt, 14);
    st.rpm = smooth(st.rpm, rpm, dt, 22);
    st.wheel = smooth(st.wheel, store.f('SteerPct') / 100 * 2.0, dt, 25);
    st.thr = smooth(st.thr, store.f('AccelPct') / 100, dt, 30);
    st.brk = smooth(st.brk, store.f('BrakePct') / 100, dt, 30);
    st.clu = smooth(st.clu, store.f('ClutchPct') / 100, dt, 30);
    const level = shiftLevel(rpm, maxRpm, settings.get('shift'));

    // ---- layout ---------------------------------------------------------------------------------------
    const portrait = w / H < 1.05;
    const kmhUnits = u.speed === 'kmh';
    // (clamped: the dial draws one tick per step, so a garbage packet must not ask for millions)
    const speedMax = Math.min(1000, Math.max(kmhUnits ? 360 : 240, Math.ceil((st.speed + 1) / 20) * 20));
    const rpmMax = Math.min(30000, Math.max(8000, Math.ceil(maxRpm / 1000) * 1000));
    const speedDial = (cx, cy, r) => drawDial(g, {
      cx, cy, r, min: 0, max: speedMax, value: st.speed, major: kmhUnits ? 40 : 20, minorPerMajor: 4,
      label: (v) => String(Math.round(v)),
      caption: label.speed(u), arcColor: c.accent,
    });
    const tachDial = (cx, cy, r) => drawDial(g, {
      cx, cy, r, min: 0, max: rpmMax, value: st.rpm, major: 1000, minorPerMajor: 4,
      label: (v) => String(v / 1000),
      bands: [{ from: maxRpm * 0.82, to: maxRpm * 0.92, color: c.amber }, { from: maxRpm * 0.92, to: rpmMax, color: c.red }],
      caption: '× 1000 rpm', arcColor: st.rpm > maxRpm * 0.92 ? c.red : c.accent,
    });

    const gear = store.gear || 'N';
    const text = (s, x, y, size, color, weight = 700, align = 'center', base = 'middle') => {
      g.fillStyle = color; g.font = `${weight} ${Math.round(size)}px system-ui, sans-serif`;
      g.textAlign = align; g.textBaseline = base; g.fillText(s, x, y);
    };
    const infoUnder = (cx, y, size, parts) => {
      let line = parts.join('   ·   ');
      text(line, cx, y, size, c.dim, 600);
    };
    const fuel = store.f('FuelPct');
    const boostBar = store.f('BoostBar');
    const power = store.f('PowerHp');

    drawShiftLights(g, w * 0.06, H * 0.02, w * 0.88, H * (portrait ? 0.05 : 0.075), level, ts);

    if (!portrait) {
      const gapMin = H * 0.27;
      const r = Math.min(H * 0.355, (w - gapMin - w * 0.04) / 4);
      const cy = H * 0.5;
      const cxs = w * 0.02 + r, cxt = w - w * 0.02 - r;
      speedDial(cxs, cy, r);
      tachDial(cxt, cy, r);
      text(fmt.speed(kmh, u, 0), cxs, cy + r * 0.2, r * 0.42, c.bright, 800);
      text(Math.round(rpm).toString(), cxt, cy + r * 0.2, r * 0.3, c.bright, 800);
      infoUnder(cxs, H * 0.955, H * 0.032, [`FUEL ${Math.round(fuel)}%`]);
      infoUnder(cxt, H * 0.955, H * 0.032, [`BOOST ${conv.pressure(boostBar, u).toFixed(u.pressure === 'psi' ? 1 : 2)} ${label.pressure(u)}`, `${Math.round(conv.power(power, u))} ${label.power(u)}`]);
      // centre column: delta, gear, wheel, pedals
      const mx = w / 2;
      const d = analytics && analytics.lap ? analytics.lap.state : null;
      if (d && d.valid) {
        st.delta = smooth(st.delta, d.deltaS, dt, 8);
        text(fmt.delta(st.delta), mx, H * 0.17, H * 0.07, st.delta <= 0 ? c.green : c.red, 800);
        text('Δ BEST', mx, H * 0.225, H * 0.026, c.dim, 700);
      }
      text(gear, mx, H * 0.40, H * 0.27, level.flashing ? c.blue : c.yellow, 800);
      text('GEAR', mx, H * 0.565, H * 0.026, c.dim, 700);
      const wr = Math.min(H * 0.14, (w - 2 * (cxs + r)) * 0.42);
      const wy = H * 0.76;
      drawWheel(g, mx, wy, wr, st.wheel);
      const pw = Math.max(10, wr * 0.22), ph = H * 0.2, py = H * 0.62;
      drawPedal(g, mx - wr * 1.5 - pw, py, pw, ph, st.brk, c.red, 'BRK');
      drawPedal(g, mx + wr * 1.5, py, pw, ph, st.thr, c.green, 'THR');
    } else {
      const r = Math.min(w * 0.46, H * 0.21);
      tachDial(w / 2, H * 0.25, r);
      text(gear, w / 2, H * 0.25 - r * 0.06, r * 0.6, level.flashing ? c.blue : c.yellow, 800);
      text(Math.round(rpm).toString(), w / 2, H * 0.25 + r * 0.34, r * 0.15, c.dim, 700);   // above the "× 1000 rpm" caption (0.52 r)
      // speed row
      text(fmt.speed(kmh, u, 0), w * 0.3, H * 0.5, Math.min(w * 0.24, H * 0.1), c.accent, 800);
      text(label.speed(u), w * 0.3, H * 0.555, H * 0.022, c.dim, 700);
      const d = analytics && analytics.lap ? analytics.lap.state : null;
      if (d && d.valid) {
        st.delta = smooth(st.delta, d.deltaS, dt, 8);
        text(fmt.delta(st.delta), w * 0.7, H * 0.5, H * 0.055, st.delta <= 0 ? c.green : c.red, 800);
        text('Δ BEST', w * 0.7, H * 0.55, H * 0.02, c.dim, 700);
      } else {
        text(`${Math.round(fuel)}%`, w * 0.7, H * 0.5, H * 0.05, c.dim, 800);
        text('FUEL', w * 0.7, H * 0.55, H * 0.02, c.dim, 700);
      }
      const wr = Math.min(w * 0.22, H * 0.13);
      drawWheel(g, w / 2, H * 0.74, wr, st.wheel);
      const pw = Math.max(12, w * 0.07), ph = H * 0.16, py = H * 0.69;
      drawPedal(g, w * 0.5 - wr * 1.6 - pw, py, pw, ph, st.brk, c.red, 'BRK');
      drawPedal(g, w * 0.5 + wr * 1.6, py, pw, ph, st.thr, c.green, 'THR');
      infoUnder(w / 2, H * 0.915, H * 0.022, [`BOOST ${conv.pressure(boostBar, u).toFixed(1)} ${label.pressure(u)}`, `${Math.round(conv.power(power, u))} ${label.power(u)}`]);
    }
  }

  return { id: 'cockpit', title: 'Cockpit', color: '#ff4d6d', el: root, charts: [], animated: true, update };
}
