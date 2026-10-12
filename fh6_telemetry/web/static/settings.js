// Persisted user settings (localStorage, defensively): theme, units, sound, FX, shift lights…
// Everything is validated on load, so a hand-edited / old / corrupt value can't break the page.

import { emit } from './bus.js';
import { sanitizeLayout } from './cockpit_layout.js';
import { DEFAULT_SHIFT } from './shift.js';
import { defaultUnits, normalizeUnits } from './units.js';

const KEY = 'fh6.settings.v1';

export const THEMES = [
  { id: 'neon', name: 'Neon', a: '#44ccff', b: '#1a1a2e' },
  { id: 'carbon', name: 'Carbon', a: '#ff7a1a', b: '#1b1d20' },
  { id: 'amber', name: 'Retro CRT', a: '#ffb000', b: '#120c00' },
  { id: 'synthwave', name: 'Synthwave', a: '#ff2e97', b: '#2a0a4a' },
  { id: 'daylight', name: 'Daylight', a: '#0b63d1', b: '#eef1f6' },
  { id: 'stealth', name: 'Stealth', a: '#ff3030', b: '#0b0000' },
];
const HIDDEN_THEMES = ['hyperdrive'];

export function defaults() {
  return {
    v: 1,
    theme: 'neon',
    units: defaultUnits(),
    sound: { master: 0.6, engine: true, turbo: true, squeal: true, rumble: true, beep: true },
    soundOn: false,
    voice: false,
    haptics: false,
    fx: { speedlines: true, vignette: true, shake: false, confetti: true },
    shift: { ...DEFAULT_SHIFT },
    mirror: false,
    keepAwake: true,                 // a dash that goes to sleep is no dash
    cockpit: { landscape: null, portrait: null },   // custom cockpit layouts (null = the factory one)
  };
}

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Merge an untrusted object over the defaults, validating every field. */
export function sanitize(raw) {
  const d = defaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  const themeOk = [...THEMES.map((t) => t.id), ...HIDDEN_THEMES].includes(r.theme);
  const s = r.sound && typeof r.sound === 'object' ? r.sound : {};
  const f = r.fx && typeof r.fx === 'object' ? r.fx : {};
  const sh = r.shift && typeof r.shift === 'object' ? r.shift : {};
  const out = {
    v: 1,
    theme: themeOk ? r.theme : d.theme,
    units: normalizeUnits(r.units),
    sound: {
      master: num(s.master, d.sound.master, 0, 1),
      engine: bool(s.engine, d.sound.engine), turbo: bool(s.turbo, d.sound.turbo),
      squeal: bool(s.squeal, d.sound.squeal), rumble: bool(s.rumble, d.sound.rumble),
      beep: bool(s.beep, d.sound.beep),
    },
    soundOn: false,                       // audio always starts muted: browsers need a tap anyway
    voice: bool(r.voice, d.voice),
    haptics: bool(r.haptics, d.haptics),
    fx: {
      speedlines: bool(f.speedlines, d.fx.speedlines), vignette: bool(f.vignette, d.fx.vignette),
      shake: bool(f.shake, d.fx.shake), confetti: bool(f.confetti, d.fx.confetti),
    },
    shift: {
      leds: Math.round(num(sh.leds, d.shift.leds, 5, 30)),
      start: num(sh.start, d.shift.start, 0.3, 0.95),
      yellow: num(sh.yellow, d.shift.yellow, 0.3, 0.98),
      red: num(sh.red, d.shift.red, 0.4, 1.0),
      flash: num(sh.flash, d.shift.flash, 0.5, 1.1),
      beep: num(sh.beep, d.shift.beep, 0.5, 1.1),
    },
    mirror: bool(r.mirror, d.mirror),
    keepAwake: bool(r.keepAwake, d.keepAwake),
    cockpit: {
      landscape: sanitizeLayout(r.cockpit && r.cockpit.landscape, 'landscape'),
      portrait: sanitizeLayout(r.cockpit && r.cockpit.portrait, 'portrait'),
    },
  };
  return out;
}

function safeStorage() {
  try { const s = globalThis.localStorage; s.getItem('x'); return s; } catch { return null; }
}

export class Settings {
  constructor(storage = safeStorage()) {
    this.storage = storage;
    this.data = this.load();
  }

  load() {
    try {
      const raw = this.storage && this.storage.getItem(KEY);
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch { return defaults(); }
  }

  save() {
    // soundOn is runtime-only (audio needs a tap after every load), so it is never stored as on
    try { if (this.storage) this.storage.setItem(KEY, JSON.stringify({ ...this.data, soundOn: false })); } catch { /* quota / private mode */ }
  }

  /** get('fx.speedlines') */
  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  /** set('fx.speedlines', false) — validates, persists and announces the change. */
  set(path, value) {
    const keys = path.split('.');
    if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return false;
    const draft = JSON.parse(JSON.stringify(this.data));
    let o = draft;
    for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') return false; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = value;
    const snd = this.data.soundOn;
    this.data = sanitize(draft);
    this.data.soundOn = path === 'soundOn' ? !!value : snd;   // runtime-only: kept across other changes, never stored as on
    this.save();
    emit('settings', { path, value: this.get(path), settings: this.data });
    return true;
  }

  /** The Konami hyperdrive theme isn't offered in the list; it is set directly. */
  setTheme(id) { return this.set('theme', id); }

  reset() { const snd = this.data.soundOn; this.data = defaults(); this.data.soundOn = snd; this.save(); emit('settings', { path: '*', value: null, settings: this.data }); }
}
