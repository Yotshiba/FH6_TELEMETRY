// The dashboard views.  Each view builds its DOM once and exposes update(), which only
// touches the DOM for values that actually changed.

import { LineChart } from './charts.js';
import { barColor, contrastText, fixed, fmtTime, signed, tempColor } from './format.js';
import { conv, label } from './units.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const MPH_PER_KMH = 0.621371;

// ---- tiny DOM helpers -----------------------------------------------------------

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const setText = (n, s) => { if (n._t !== s) { n._t = s; n.textContent = s; } };
const setCss = (n, prop, v) => {
  const c = n._c || (n._c = {});
  if (c[prop] !== v) { c[prop] = v; n.style[prop] = v; }
};
const setCls = (n, name, on) => { if (n._k === undefined) n._k = {}; if (n._k[name] !== on) { n._k[name] = on; n.classList.toggle(name, on); } };

function card(title, ...children) {
  const c = h('section', 'card');
  if (title) c.appendChild(h('h3', null, title));
  for (const ch of children) c.appendChild(ch);
  return c;
}

/** Label/value rows.  rows: [label, getter() -> string] */
function kv(rows) {
  const el = h('div', 'kv');
  const items = rows.map(([label, get]) => {
    const v = h('span', 'v', '--');
    el.append(h('span', 'k', label), v);
    return [v, get];
  });
  return { el, update() { for (const [v, get] of items) setText(v, get()); } };
}

/** Progress-bar rows.  items: {label, get(), max, danger, invert} */
function bars(items) {
  const el = h('div', 'bars');
  const rows = items.map((it) => {
    const row = h('div', 'bar');
    const name = h('span', 'n', it.label), track = h('div', 't'), fill = h('div', 'f'), txt = h('span', 'x', '0.000');
    track.appendChild(fill);
    row.append(name, track, txt);
    el.appendChild(row);
    return { it, fill, txt };
  });
  return {
    el,
    update() {
      for (const { it, fill, txt } of rows) {
        const v = it.get();
        const clamped = Math.max(0, Math.min(Number.isFinite(v) ? v : 0, it.max));
        setCss(fill, 'width', (clamped / it.max * 100).toFixed(1) + '%');
        setCss(fill, 'background', barColor(Math.abs(v), it.danger, it.invert));
        setText(txt, it.fmt ? it.fmt(v) : Math.abs(v) < 10 ? signed(v, 3) : fixed(v, 1));
      }
    },
  };
}

function chartCard(store, charts, id, extra = '') {
  const def = store.hello.charts.find((c) => c.id === id);
  const box = h('div', 'chart');
  const el = h('section', 'card chart-card ' + extra);
  el.appendChild(box);
  const chart = new LineChart(box, def, store);
  charts.push(chart);
  return el;
}

function hero(store, settings) {
  const n = h('div', 'n', '0'), unit = h('div', 'u', 'km/h'), mph = h('div', 'm', '0 mph');
  const speed = h('div', 'speed'); speed.append(n, unit, mph);
  const g = h('div', 'gear'); const gl = h('small', null, 'GEAR');
  const gnode = document.createTextNode('N'); g.append(gnode, gl);
  const el = h('div', 'hero'); el.append(speed, g);
  return {
    el,
    update() {
      const kmh = store.f('SpeedKmh');
      const u = settings.get('units');
      setText(n, fixed(conv.speed(kmh, u), 0));
      setText(unit, label.speed(u));
      setText(mph, u.speed === 'kmh' ? fixed(kmh * MPH_PER_KMH, 0) + ' mph' : fixed(kmh, 0) + ' km/h');
      if (gnode.data !== store.gear) gnode.data = store.gear;
    },
  };
}

function banner(store) {
  const el = h('div', 'banner', '⬤  NO SIGNAL');
  return {
    el,
    update() {
      const live = store.signal && store.last;
      const on = live && store.f('IsRaceOn');
      setText(el, live ? (on ? '⬤  RACE ON' : '⬤  PAUSED') : '⬤  NO SIGNAL');
      setCls(el, 'on', !!on);
      setCls(el, 'nosig', !live);
    },
  };
}

// ---- view factory ------------------------------------------------------------------

export function buildViews(store, settings) {
  const H = store.hello, lab = H.lab, ui = H.ui;
  const F = (k) => store.f(k), S = (k) => store.s(k);
  const lookup = (map, code, fallback) => map[String(code)] ?? fallback;

  const inputBars = (withSteer) => {
    const list = ui.inputs.map((b) => ({
      label: b.label, max: b.max, danger: b.danger, invert: !!b.invert,
      get: () => (b.slow ? S(b.key) : F(b.key)),
    }));
    if (withSteer) {
      list.splice(4, 0, { label: 'Steer', max: 100, danger: 80, invert: false, get: () => Math.abs(F('SteerPct')) });
    }
    return bars(list);
  };

  const steerLabel = () => {
    const el = h('div', 'steer', '─  STRAIGHT  ─');
    return {
      el,
      update() {
        const p = F('SteerPct');
        let cls = '', txt = '─  STRAIGHT  ─';
        if (p < -ui.steerDeadPct) { cls = 'left'; txt = `◄  LEFT  ${fixed(Math.abs(p), 0)}%`; }
        else if (p > ui.steerDeadPct) { cls = 'right'; txt = `RIGHT  ${fixed(p, 0)}%  ►`; }
        setText(el, txt); setCls(el, 'left', cls === 'left'); setCls(el, 'right', cls === 'right');
      },
    };
  };

  const rpmText = () => {
    const rpm = F('CurrentEngineRpm'), max = F('EngineMaxRpm') || 1;
    return `${fixed(rpm, 0)}  (${fixed(rpm / max * 100, 0)}%)`;
  };

  const views = [];
  const make = (id, title, color, build) => {
    const root = h('div', 'view v-' + id);   // v- prefix: ids like "tyres" are also CSS classes
    root.dataset.view = id;
    const charts = [], parts = [];
    build(root, charts, parts);
    views.push({ id, title, color, el: root, charts, update() { for (const p of parts) p.update(); } });
  };

  // ---- Dash (compact; landscape phones / tablets) ----------------------------------
  make('dash', 'Dash', '#44CCFF', (root, charts, parts) => {
    const hr = hero(store, settings), ib = bars([
      { label: 'RPM', max: 1, danger: 0.9, invert: false, fmt: (v) => fixed(v * 100, 0) + '%',
        get: () => F('CurrentEngineRpm') / (F('EngineMaxRpm') || 1) },
      { label: 'Throttle', max: 100, danger: 90, invert: false, get: () => F('AccelPct') },
      { label: 'Brake', max: 100, danger: 90, invert: false, get: () => F('BrakePct') },
    ]);
    const rpm = h('div', 'mono', ''); rpm.style.cssText = 'text-align:center;margin:4px 0 6px;font-size:13px;color:#ffdd44';
    const sl = steerLabel();
    const tyres = h('div', 'tyres'); tyres.style.gridTemplateColumns = 'repeat(2, 1fr)';
    const temps = WHEELS.map((w) => {
      const t = h('div', 'temp', '--'); t.title = w; tyres.appendChild(t); return [w, t];
    });
    const bn = banner(store);
    const grid = h('div', 'grid');
    grid.append(
      card(null, bn.el, hr.el),
      card('Engine & pedals', rpm, ib.el, sl.el),
      card('Tyre temperature', tyres),
      chartCard(store, charts, 'engine_rpm'),
      chartCard(store, charts, 'inputs_throttle_brake'),
      chartCard(store, charts, 'motion_speed'),
    );
    root.appendChild(grid);
    parts.push(bn, hr, ib, sl, {
      update() {
        setText(rpm, rpmText());
        for (const [w, t] of temps) {
          const v = F('TireTemp' + w), bg = tempColor(ui.temp, v);
          setText(t, `${w}  ${fixed(conv.temp(v, settings.get('units')), 0)}°`); setCss(t, 'background', bg); setCss(t, 'color', contrastText(bg));
        }
      },
    });
  });

  // ---- Race Status -------------------------------------------------------------------
  make('race', 'Race Status', '#CC88FF', (root, charts, parts) => {
    const bn = banner(store), hr = hero(store, settings);
    const lap = kv([
      ['Lap:', () => String(S('LapNumber'))], ['Position:', () => String(S('RacePosition'))],
      ['Race Time:', () => fmtTime(S('CurrentRaceTimeMs'))], ['Best Lap:', () => fmtTime(S('BestLapMs'))],
      ['Last Lap:', () => fmtTime(S('LastLapMs'))],
    ]);
    const eng = kv([['RPM:', rpmText], ['Max RPM:', () => fixed(F('EngineMaxRpm'), 0)]]);
    const car = kv([
      ['Class:', () => lookup(lab.cls, S('CarClass'), '?')], ['PI:', () => String(S('CarPerformanceIndex'))],
      ['Drivetrain:', () => lookup(lab.drv, S('DrivetrainType'), '?')], ['Cylinders:', () => String(S('NumCylinders'))],
    ]);
    const status = kv([['Boost:', () => { const u = settings.get('units'); return fixed(conv.pressure(F('BoostBar'), u), u.pressure === 'psi' ? 2 : 3) + ' ' + label.pressure(u); }], ['Fuel:', () => fixed(F('FuelPct'), 1) + '%']]);
    const grid = h('div', 'grid');
    grid.append(card(null, bn.el, hr.el), card('Lap & race', lap.el), card('Engine', eng.el),
                card('Car', car.el), card('Status', status.el));
    root.appendChild(grid);
    parts.push(bn, hr, lap, eng, car, status);
  });

  // ---- Car & Lap ---------------------------------------------------------------------
  make('car', 'Car & Lap', '#44CCFF', (root, charts, parts) => {
    const car = kv([
      ['Class:', () => lookup(lab.cls, S('CarClass'), '?')], ['PI:', () => String(S('CarPerformanceIndex'))],
      ['Drivetrain:', () => lookup(lab.drv, S('DrivetrainType'), '?')], ['Cylinders:', () => String(S('NumCylinders'))],
      ['Car Group:', () => lookup(lab.grp, S('CarGroup'), '#' + S('CarGroup'))],
      ['Smash Mass:', () => fixed(S('SmashableMass'), 0) + ' kg'],
    ]);
    const lap = kv([
      ['Best Lap:', () => fmtTime(S('BestLapMs'))], ['Last Lap:', () => fmtTime(S('LastLapMs'))],
      ['Current Lap:', () => fmtTime(S('CurrentLapMs'))], ['Race Time:', () => fmtTime(S('CurrentRaceTimeMs'))],
      ['Distance:', () => { const u = settings.get('units'); return fixed(conv.dist(S('DistanceTraveled'), u), 2) + ' ' + label.dist(u); }],
    ]);
    const ib = inputBars(true);
    const extras = kv([
      ['Smash ΔVel:', () => fixed(S('SmashableVelDiff'), 2) + ' m/s'],
      ['Drive Line:', () => signed(S('NormalizedDrivingLine'), 0)],
      ['AI Brake Δ:', () => signed(S('NormalizedAIBrakeDifference'), 0)],
    ]);
    const grid = h('div', 'grid');
    grid.append(card('Car info', car.el), card('Lap & race times', lap.el), card('Inputs', ib.el), card('FH6 extras', extras.el));
    root.appendChild(grid);
    parts.push(car, lap, ib, extras);
  });

  // ---- Tyres -------------------------------------------------------------------------
  make('tyres', 'Tyres', '#FF4444', (root, charts, parts) => {
    const wrap = h('div', 'tyres');
    const cards = WHEELS.map((w, i) => {
      const hd = h('div', 'hd'); const name = h('span', 'w', w); name.style.color = ui.wheel[w];
      const rumble = h('span', 'badge rumble', 'RUMBLE'), puddle = h('span', 'badge puddle', 'PUDDLE');
      hd.append(name, h('span', 'sp'), rumble, puddle);
      const temp = h('div', 'temp', '--.- °C');
      const bs = bars(ui.bars.map((b) => ({
        label: b.label, max: b.max, danger: b.danger, invert: false,
        get: () => (b.key === 'SuspNorm' ? F('SuspNorm' + w) : S(b.key + w)),
      })));
      const rows = kv([['Susp (m):', () => fixed(S('SuspTravelM' + w), 4) + ' m'], ['Wheel spd:', () => fixed(S('WheelRotSpeed' + w), 1) + ' rad/s']]);
      const el = h('section', 'card tyre'); el.append(hd, temp, bs.el, rows.el); wrap.appendChild(el);
      return {
        update() {
          const t = F('TireTemp' + w), bg = tempColor(ui.temp, t), flags = S('WheelFlags');
          const u = settings.get('units'); setText(temp, fixed(conv.temp(t, u), 1) + ' ' + label.temp(u)); setCss(temp, 'background', bg); setCss(temp, 'color', contrastText(bg));
          setCls(rumble, 'on', !!(flags & (1 << i))); setCls(puddle, 'on', !!(flags & (1 << (4 + i))));
          bs.update(); rows.update();
        },
      };
    });
    const grid = h('div', 'grid');
    const tcard = chartCard(store, charts, 'tyre_temp', 'span-2');
    grid.append(wrap, tcard);
    wrap.style.gridColumn = '1 / -1';
    root.appendChild(grid);
    parts.push(...cards);
  });

  // ---- Engine ------------------------------------------------------------------------
  make('engine', 'Engine', '#FFDD44', (root, charts, parts) => {
    const strip = h('div', 'strip');
    const defs = [
      ['RPM', '#FFDD44', () => fixed(F('CurrentEngineRpm'), 0)], ['MAX RPM', '#FF4444', () => fixed(F('EngineMaxRpm'), 0)],
      ['POWER', '#44CCFF', () => { const u = settings.get('units'); return [fixed(conv.power(F('PowerHp'), u), 1), label.power(u)]; }],
      ['TORQUE', '#FF9900', () => { const u = settings.get('units'); return [fixed(conv.torque(F('Torque'), u), 1), label.torque(u)]; }],
      ['BOOST', '#44FF88', () => { const u = settings.get('units'); return [fixed(conv.pressure(F('BoostBar'), u), u.pressure === 'psi' ? 2 : 3), label.pressure(u)]; }], ['FUEL', '#FFAA44', () => fixed(F('FuelPct'), 1) + '%'],
      ['GEAR', '#FFFFFF', () => store.gear],
    ];
    const stats = defs.map(([label, color, get]) => {
      const s = h('div', 'stat'), n = h('div', 'n'), v = h('span', 'v', '--'), un = h('span', 'u'), l = h('div', 'l', label);
      n.style.color = color; n.append(v, un); s.append(n, l); strip.appendChild(s); return [v, un, get];
    });
    const grid = h('div', 'grid');
    grid.append(card(null, strip), chartCard(store, charts, 'engine_rpm'), chartCard(store, charts, 'engine_power_torque'));
    grid.firstChild.classList.add('span-2');
    root.appendChild(grid);
    parts.push({ update() {
      for (const [v, un, get] of stats) { const r = get(); setText(v, Array.isArray(r) ? r[0] : r); setText(un, Array.isArray(r) ? r[1] : ''); }
    } });
  });

  // ---- Inputs ------------------------------------------------------------------------
  make('inputs', 'Inputs', '#22BB44', (root, charts, parts) => {
    const ib = bars(ui.inputs.map((b) => ({
      label: b.label, max: b.max, danger: b.danger, invert: !!b.invert, get: () => (b.slow ? S(b.key) : F(b.key)),
    })));
    const steerBar = bars([{ label: 'Steer (abs)', max: 100, danger: 80, invert: false, get: () => Math.abs(F('SteerPct')) }]);
    const sl = steerLabel();
    const grid = h('div', 'grid');
    grid.append(card('Inputs', ib.el), card('Steering', steerBar.el, sl.el), chartCard(store, charts, 'inputs_throttle_brake', 'span-2'));
    root.appendChild(grid);
    parts.push(ib, steerBar, sl);
  });

  // ---- Motion ------------------------------------------------------------------------
  make('motion', 'Motion', '#FF9900', (root, charts, parts) => {
    const hr = hero(store, settings);
    const trio = (label, keys, fmt) => keys.map((k, i) => [label + ' ' + 'XYZ'[i] + ':', () => fmt(S(k))]);
    const vel = kv(trio('Vel', ['VelocityX', 'VelocityY', 'VelocityZ'], (v) => signed(v, 2)));
    const acc = kv(trio('Acc', ['AccelGX', 'AccelGY', 'AccelGZ'], (v) => signed(v, 3)));
    const ang = kv(trio('AngVel', ['AngularVelocityX', 'AngularVelocityY', 'AngularVelocityZ'], (v) => signed(v, 3)));
    const ori = kv([['Yaw:', () => signed(S('Yaw'), 4)], ['Pitch:', () => signed(S('Pitch'), 4)], ['Roll:', () => signed(S('Roll'), 4)]]);
    const pos = kv(trio('Pos', ['PositionX', 'PositionY', 'PositionZ'], (v) => fixed(v, 1)));
    const grid = h('div', 'grid');
    grid.append(card(null, hr.el), card('Velocity (m/s)', vel.el), card('Acceleration (g)', acc.el),
                card('Angular vel (rad/s)', ang.el), card('Orientation (rad)', ori.el), card('Position (m)', pos.el),
                chartCard(store, charts, 'motion_suspension'), chartCard(store, charts, 'motion_speed'));
    root.appendChild(grid);
    parts.push(hr, vel, acc, ang, ori, pos);
  });

  return views;
}
