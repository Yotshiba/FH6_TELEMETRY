// Smoke tests for the canvas views: build each one against a stub DOM + the server's real "hello" payload
// (tests/js/hello.json, regenerate with tools/dump_hello_fixture.py), feed it a few seconds of plausible rows and
// call update() every frame.  A view that throws at runtime but still parses (a swallowed '+', a wrong field name,
// a null deref on the first frame) cannot hide from this.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../../fh6_telemetry/web/static/store.js';
import { Settings } from '../../fh6_telemetry/web/static/settings.js';
import { Lifetime } from '../../fh6_telemetry/web/static/lifetime.js';
import { Analytics } from '../../fh6_telemetry/web/static/analytics.js';
import { gearLabel } from '../../fh6_telemetry/web/static/format.js';
import { buildCockpit } from '../../fh6_telemetry/web/static/view_cockpit.js';
import { buildMap } from '../../fh6_telemetry/web/static/view_map.js';
import { buildLab } from '../../fh6_telemetry/web/static/view_lab.js';
import { buildCar } from '../../fh6_telemetry/web/static/view_car.js';
import { buildTimeline } from '../../fh6_telemetry/web/static/view_timeline.js';
import { buildViews } from '../../fh6_telemetry/web/static/views.js';

const HELLO = JSON.parse(readFileSync(new URL('./hello.json', import.meta.url), 'utf-8'));

// ---- a very small DOM -----------------------------------------------------------------------------------------------

const ctx2d = () => {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
};

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.className = ''; this.dataset = {}; this.attrs = {};
    this.textContent = ''; this.width = 300; this.height = 150; this._g = null;
    const css = {};
    this.style = new Proxy(css, {
      get: (t, k) => (k === 'setProperty' ? (n, v) => { t[n] = v; } : t[k] ?? ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  }
  get classList() {
    const read = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s) => { this.className = [...s].join(' '); };
    return {
      add: (...c) => { const s = read(); c.forEach((x) => s.add(x)); write(s); },
      remove: (...c) => { const s = read(); c.forEach((x) => s.delete(x)); write(s); },
      toggle: (c, force) => { const s = read(); const on = force === undefined ? !s.has(c) : !!force; if (on) s.add(c); else s.delete(c); write(s); return on; },
      contains: (c) => read().has(c),
    };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { this.children.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.children.push(n)); }
  remove() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, ev = {}) { (this.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, pointerId: 1, pointerType: 'mouse', ...ev })); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  getContext() { return (this._g ||= ctx2d()); }
  getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 }; }
  setPointerCapture() {}
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find && c.find(pred); if (r) return r; } return null; }
}

function installDom() {
  globalThis.document = { createElement: (t) => new El(t), createTextNode: (t) => { const e = new El('#text'); e.textContent = String(t); return e; }, documentElement: new El('html'), body: new El('body'), hidden: false, addEventListener() {} };
  globalThis.window = { devicePixelRatio: 1, innerWidth: 800, innerHeight: 450, addEventListener() {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Path2D = class { moveTo() {} lineTo() {} arc() {} closePath() {} rect() {} };
}
function removeDom() { for (const k of ['document', 'window', 'getComputedStyle', 'Path2D', 'ResizeObserver']) delete globalThis[k]; }

// ---- an app-like fixture -------------------------------------------------------------------------------------------------

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

function setup() {
  const store = new Store();
  const settings = new Settings(memoryStorage());
  const lifetime = new Lifetime(memoryStorage(), () => 0);
  store.setHello(HELLO);
  const analytics = new Analytics(store, lifetime, settings);
  const actions = { toggleSound() {}, exportCsv() {}, shareCard() {}, clearMap() {} };
  store.signal = true;
  return { store, settings, lifetime, analytics, actions, fx: null };
}

const fastRow = (store, i, over = {}) => {
  const t = i / 75;
  const o = {
    IsRaceOn: 1, SpeedKmh: 60 + 80 * Math.abs(Math.sin(t / 3)), CurrentEngineRpm: 3500 + 2500 * Math.abs(Math.sin(t)), EngineMaxRpm: 8000,
    Gear: 3, AccelPct: 60 + 40 * Math.sin(t), BrakePct: Math.max(0, 40 * Math.sin(t / 2)), SteerPct: 50 * Math.sin(t / 2),
    TimestampMS: Math.floor(i * 13.33), AccelGX: 1.1 * Math.sin(t), AccelGZ: 0.6 * Math.cos(t), SideslipDeg: 25 * Math.sin(t / 2),
    Pitch: 0.05 * Math.sin(t), Roll: 0.08 * Math.sin(t / 2), Yaw: t / 4, PositionX: 400 * Math.sin(t / 8), PositionZ: 400 * Math.cos(t / 8),
    TireTempFL: 95, TireTempFR: 96, TireTempRL: 108, TireTempRR: 109, SuspNormFL: 0.5, SuspNormFR: 0.4, SuspNormRL: 0.6, SuspNormRR: 0.5,
    PowerHp: 300, BoostBar: 1.2, FuelPct: 70, ...over,
  };
  const r = new Array(store.hello.F.length).fill(0);
  for (const [k, v] of Object.entries(o)) if (store.F[k] !== undefined) r[store.F[k]] = v;
  return r;
};
const slowRow = (store, i) => {
  const o = { LapNumber: 1 + Math.floor(i / 900), CurrentLapMs: (i % 900) * 13, DistanceTraveled: i * 0.4, NumCylinders: 6, WheelFlags: 0,
    TireCombinedSlipFL: 0.4, TireCombinedSlipFR: 0.5, TireCombinedSlipRL: 1.2, TireCombinedSlipRR: 0.9, AccelGY: 0.1 };
  const r = new Array(store.hello.S.length).fill(0);
  for (const [k, v] of Object.entries(o)) if (store.S[k] !== undefined) r[store.S[k]] = v;
  return r;
};

/** Feed `frames` frames (one row each, a slow snapshot every 7th) and update the view after each. */
function drive(app, view, frames, { rowOver, units } = {}) {
  const { store } = app;
  if (units) app.settings.set('units', units);
  for (let i = 0; i < frames; i++) {
    store.pushRows([fastRow(store, i, rowOver ? rowOver(i) : {})]);
    if (i % 7 === 0) store.pushSlow(slowRow(store, i));
    store.seq = i;
    store.gear = gearLabel(store.hello.lab, store.f('Gear'), store.gear);
    view.update(1 / 60, i * 16.7);
  }
}

const BUILDERS = { cockpit: buildCockpit, map: buildMap, lab: buildLab, chassis: buildCar, timeline: buildTimeline };
const IMPERIAL = { speed: 'mph', temp: 'f', pressure: 'psi', power: 'kw', torque: 'lbft', dist: 'mi' };

for (const [name, build] of Object.entries(BUILDERS)) {
  test(`${name}: builds and survives a few seconds of rows in metric and imperial units`, () => {
    installDom();
    try {
      const app = setup();
      const view = build(app);
      assert.equal(typeof view.update, 'function');
      assert.ok(view.id && view.title && view.el);
      assert.doesNotThrow(() => drive(app, view, 400));
      assert.doesNotThrow(() => drive(app, view, 200, { units: IMPERIAL }));
      app.store.signal = false;                                   // link dropped: still renders
      assert.doesNotThrow(() => view.update(1 / 60, 99999));
    } finally { removeDom(); }
  });
}

test('rewind: tapping the timeline shows a readout with speed, rpm and the gear label', () => {
  installDom();
  try {
    const app = setup();
    const view = buildTimeline(app);
    drive(app, view, 300);
    const canvas = view.el.find((c) => c.tag === 'canvas');
    const readout = view.el.find((c) => c.className === 'tl-readout');
    assert.ok(canvas && readout);
    canvas.fire('pointerdown', { clientX: 780 });   // near 'now': the 30 s window holds only a few seconds of rows
    assert.doesNotThrow(() => view.update(1 / 60, 20000));
    assert.match(readout.textContent, /km\/h/);
    assert.match(readout.textContent, /rpm/);
    assert.ok(readout.textContent.includes(`gear ${HELLO.lab.gear['3']} `), readout.textContent);   // code 3 -> its label, not the raw code
    assert.doesNotMatch(readout.textContent, /undefined|NaN/);
    // dragging back keeps working; marks are dropped when the history is wiped
    canvas.fire('pointermove', { clientX: 700 });
    assert.doesNotThrow(() => view.update(1 / 60, 20100));
    const mark = view.el.find((c) => c.tag === 'button' && /Mark/.test(c.textContent));
    mark.fire('click');
    app.store.clearHistory();
    assert.doesNotThrow(() => view.update(1 / 60, 20200));
  } finally { removeDom(); }
});

test('map: controls, drag/pinch handlers and garbage coordinates', () => {
  installDom();
  try {
    const app = setup();
    const view = buildMap(app);
    drive(app, view, 200);
    const canvas = view.el.find((c) => c.tag === 'canvas');
    for (const b of view.el.children.find((c) => c.className === 'map-ctl').children) b.fire('click');
    canvas.fire('pointerdown', { clientX: 100, clientY: 100 });
    canvas.fire('pointermove', { clientX: 140, clientY: 130 });
    canvas.fire('pointerup', {});
    canvas.fire('wheel', { deltaY: -120 });
    assert.doesNotThrow(() => drive(app, view, 50, { rowOver: () => ({ PositionX: 1e19, PositionZ: -1e19 }) }));
    assert.doesNotThrow(() => view.update(1 / 60, 1));
  } finally { removeDom(); }
});

test('cockpit and lab survive absurd values (garbage packets) without hanging', () => {
  installDom();
  try {
    for (const build of [buildCockpit, buildLab, buildCar]) {
      const app = setup();
      const view = build(app);
      const t0 = Date.now();
      drive(app, view, 30, { rowOver: () => ({ SpeedKmh: 1e12, EngineMaxRpm: 1e12, CurrentEngineRpm: 1e12, AccelGX: 1e30, AccelGZ: -1e30, PositionX: 1e30 }) });
      assert.ok(Date.now() - t0 < 5000, 'finished promptly');
    }
  } finally { removeDom(); }
});

/** Every text the stub DOM holds, depth-first. */
function allText(el, out = []) {
  if (el.textContent) out.push(el.textContent);
  for (const c of el.children) allText(c, out);
  return out;
}

test('classic views (race, car, tyres, engine, inputs, motion, dash): update + chart draw with plain-text read-outs', () => {
  installDom();
  try {
    const app = setup();
    const views = buildViews(app.store, app.settings);
    assert.ok(views.length >= 7, `built ${views.length} classic views`);
    for (const units of [undefined, IMPERIAL]) {
      for (let i = 0; i < 120; i++) {
        app.store.pushRows([fastRow(app.store, i)]);
        if (i % 7 === 0) app.store.pushSlow(slowRow(app.store, i));
        app.store.seq = i;
        app.store.gear = gearLabel(app.store.hello.lab, app.store.f('Gear'), app.store.gear);
        if (i === 60 && units) app.settings.set('units', units);
        for (const v of views) {
          assert.doesNotThrow(() => { v.update(0.016, i * 16); for (const c of v.charts) c.draw(true); }, v.id);
        }
      }
    }
    for (const v of views) {
      for (const t of allText(v.el)) {
        assert.doesNotMatch(t, /\[object|undefined|NaN/, `${v.id}: "${t}"`);
        assert.doesNotMatch(t, /\d,(bar|psi|kW|hp|PS|Nm|lb-ft)/, `${v.id}: array rendered as text "${t}"`);
      }
    }
  } finally { removeDom(); }
});
