// Shared stub DOM + app-like fixture for the view tests (see views_smoke.test.mjs, cockpit_editor.test.mjs).
// Not a test file itself: node --test only runs *.test.mjs.

import { readFileSync } from 'node:fs';
import { Store } from '../../../fh6_telemetry/web/static/store.js';
import { Settings } from '../../../fh6_telemetry/web/static/settings.js';
import { Lifetime } from '../../../fh6_telemetry/web/static/lifetime.js';
import { Analytics } from '../../../fh6_telemetry/web/static/analytics.js';

export const HELLO = JSON.parse(readFileSync(new URL('../hello.json', import.meta.url), 'utf-8'));
export const IMPERIAL = { speed: 'mph', temp: 'f', pressure: 'psi', power: 'kw', torque: 'lbft', dist: 'mi' };

// ---- a very small DOM -----------------------------------------------------------------------------------------------

export const ctx2d = () => {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return (...a) => { if (t.__rec) t.__rec.push([k, ...a]); return { addColorStop() {} }; };
      return (...a) => { if (t.__rec) t.__rec.push([k, ...a]); };      // optional call recording: ctx.__rec = []
    },
    set(t, k, v) { t[k] = v; return true; },
  });
};

export class El {
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
  getBoundingClientRect() { const r = this.rect || { width: 800, height: 450 }; return { width: r.width, height: r.height, left: 0, top: 0, right: r.width, bottom: r.height }; }
  setPointerCapture() {}
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find && c.find(pred); if (r) return r; } return null; }
}

export function installDom() {
  globalThis.document = { createElement: (t) => new El(t), createTextNode: (t) => { const e = new El('#text'); e.textContent = String(t); return e; }, documentElement: new El('html'), body: new El('body'), hidden: false, addEventListener() {} };
  globalThis.window = {
    devicePixelRatio: 1, innerWidth: 800, innerHeight: 450, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Path2D = class { moveTo() {} lineTo() {} arc() {} closePath() {} rect() {} };
}
export function removeDom() { for (const k of ['document', 'window', 'getComputedStyle', 'Path2D', 'ResizeObserver']) delete globalThis[k]; }

// ---- an app-like fixture -------------------------------------------------------------------------------------------------

export const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

export function setup() {
  const store = new Store();
  const settings = new Settings(memoryStorage());
  const lifetime = new Lifetime(memoryStorage(), () => 0);
  store.setHello(HELLO);
  const analytics = new Analytics(store, lifetime, settings);
  const actions = { toggleSound() {}, exportCsv() {}, shareCard() {}, clearMap() {} };
  store.signal = true;
  return { store, settings, lifetime, analytics, actions, fx: null };
}

export const fastRow = (store, i, over = {}) => {
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
export const slowRow = (store, i) => {
  const o = { LapNumber: 1 + Math.floor(i / 900), CurrentLapMs: (i % 900) * 13, DistanceTraveled: i * 0.4, NumCylinders: 6, WheelFlags: 0,
    TireCombinedSlipFL: 0.4, TireCombinedSlipFR: 0.5, TireCombinedSlipRL: 1.2, TireCombinedSlipRR: 0.9, AccelGY: 0.1 };
  const r = new Array(store.hello.S.length).fill(0);
  for (const [k, v] of Object.entries(o)) if (store.S[k] !== undefined) r[store.S[k]] = v;
  return r;
};

/** Feed `frames` frames (one row each, a slow snapshot every 7th) and update the view after each. */
export function drive(app, view, frames, { rowOver, units } = {}) {
  const { store } = app;
  if (units) app.settings.set('units', units);
  for (let i = 0; i < frames; i++) {
    store.pushRows([fastRow(store, i, rowOver ? rowOver(i) : {})]);
    if (i % 7 === 0) store.pushSlow(slowRow(store, i));
    store.seq = i;
    view.update(1 / 60, i * 16.7);
  }
}

/** Dispatch an event to the handlers registered with window.addEventListener (keyboard shortcuts ...). */
export function fireWindow(type, ev = {}) {
  for (const fn of globalThis.window.listeners[type] || []) fn({ preventDefault() {}, ...ev });
}
