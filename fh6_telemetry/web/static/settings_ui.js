// The settings drawer.  Controls are generated from small descriptors and re-synced whenever a
// setting changes (from anywhere: a cockpit button, the Konami code, another control).

import { on } from './bus.js';
import { THEMES } from './settings.js';
import { UNIT_CHOICES } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const UNIT_ROWS = [
  ['speed', 'Speed', { kmh: 'km/h', mph: 'mph' }],
  ['temp', 'Temperature', { c: '°C', f: '°F' }],
  ['pressure', 'Boost', { bar: 'bar', psi: 'psi' }],
  ['power', 'Power', { hp: 'hp', kw: 'kW', ps: 'PS' }],
  ['torque', 'Torque', { nm: 'Nm', lbft: 'lb-ft' }],
  ['dist', 'Distance', { km: 'km', mi: 'mi' }],
];

export function buildDrawer(root, ctx) {
  const { settings, actions } = ctx;
  const refreshers = [];

  const section = (title) => { const s = h('section', 'dr-sec'); s.appendChild(h('h4', null, title)); root.appendChild(s); return s; };
  const row = (sec, text, control) => { const r = h('div', 'dr-row'); r.appendChild(h('span', 'dr-lbl', text)); r.appendChild(control); sec.appendChild(r); return r; };

  const toggle = (path, text, sec, hint) => {
    const b = h('button', 'switch'); b.type = 'button'; b.setAttribute('role', 'switch');
    b.addEventListener('click', () => settings.set(path, !settings.get(path)));
    const r = row(sec, text, b);
    if (hint) r.title = hint;
    refreshers.push(() => b.setAttribute('aria-checked', String(!!settings.get(path))));
    return b;
  };
  const segmented = (sec, text, choices, get, set) => {
    const wrap = h('div', 'seg');
    const btns = Object.entries(choices).map(([val, name]) => {
      const b = h('button', null, name); b.type = 'button';
      b.addEventListener('click', () => set(val)); wrap.appendChild(b); return [val, b];
    });
    row(sec, text, wrap);
    refreshers.push(() => { for (const [val, b] of btns) b.setAttribute('aria-pressed', String(get() === val)); });
  };
  const slider = (sec, text, path, lo, hi, step, fmtv, scale = 1) => {
    const inp = h('input'); inp.type = 'range'; inp.min = lo; inp.max = hi; inp.step = step;
    const val = h('span', 'dr-val');
    inp.addEventListener('input', () => settings.set(path, Number(inp.value) / scale));
    const wrap = h('div', 'dr-slider'); wrap.append(inp, val);
    row(sec, text, wrap);
    refreshers.push(() => { const v = settings.get(path); inp.value = String(v * scale); val.textContent = fmtv(v); });
  };
  const button = (sec, text, fn, cls = '') => { const b = h('button', 'dr-btn ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); sec.appendChild(b); return b; };

  // ---- header --------------------------------------------------------------------------------------------
  const head = h('div', 'dr-head');
  head.appendChild(h('h3', null, 'Settings'));
  const close = h('button', 'dr-close', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Close settings');
  close.addEventListener('click', () => actions.closeDrawer());
  head.appendChild(close);
  root.appendChild(head);

  // ---- appearance -------------------------------------------------------------------------------------------
  const ap = section('Appearance');
  const chips = h('div', 'theme-grid');
  const chipBtns = THEMES.map((t) => {
    const b = h('button', 'theme-chip'); b.type = 'button'; b.title = t.name;
    b.style.setProperty('--a', t.a); b.style.setProperty('--b', t.b);
    b.append(h('span', 'dot'), h('span', 'nm', t.name));
    b.addEventListener('click', () => settings.set('theme', t.id));
    chips.appendChild(b); return [t.id, b];
  });
  ap.appendChild(chips);
  refreshers.push(() => { for (const [id, b] of chipBtns) b.setAttribute('aria-pressed', String(settings.get('theme') === id)); });

  // ---- units -----------------------------------------------------------------------------------------------------
  const un = section('Units');
  for (const [key, text, choices] of UNIT_ROWS) {
    const allowed = UNIT_CHOICES[key];
    const filtered = Object.fromEntries(Object.entries(choices).filter(([k]) => !allowed || allowed.includes(k)));
    segmented(un, text, filtered, () => settings.get('units.' + key), (v) => settings.set('units.' + key, v));
  }

  // ---- sound & feel ----------------------------------------------------------------------------------------------------
  const sf = section('Sound & feel');
  const soundBtn = button(sf, '🔊 Turn on engine sound', () => actions.toggleSound(), 'primary');
  refreshers.push(() => { const on_ = !!settings.get('soundOn'); soundBtn.textContent = on_ ? '🔇 Turn off engine sound' : '🔊 Turn on engine sound'; soundBtn.classList.toggle('on', on_); });
  slider(sf, 'Volume', 'sound.master', 0, 100, 1, (v) => `${Math.round(v * 100)}%`, 100);
  toggle('sound.engine', 'Engine note (RPM synth)', sf);
  toggle('sound.turbo', 'Turbo whistle & blow-off', sf);
  toggle('sound.squeal', 'Tyre squeal', sf);
  toggle('sound.rumble', 'Rumble strips', sf);
  toggle('sound.beep', 'Shift beep', sf);
  toggle('voice', 'Voice callouts (laps, records, warnings)', sf, 'Uses your browser\'s speech synthesis');
  const hap = toggle('haptics', 'Phone vibration (kerbs, landings, shifts)', sf, 'Android Chrome only');
  if (!navigator.vibrate) { hap.disabled = true; hap.title = 'Vibration is not supported by this browser (iPhone/Safari)'; }

  // ---- effects ---------------------------------------------------------------------------------------------------------------
  const fx = section('Effects');
  toggle('fx.speedlines', 'Speed lines (Cockpit & Dash)', fx);
  toggle('fx.vignette', 'Redline vignette', fx);
  toggle('fx.shake', 'Impact shake', fx);
  toggle('fx.confetti', 'Confetti on big unlocks', fx);

  // ---- shift lights ---------------------------------------------------------------------------------------------------------------
  const sh = section('Shift lights');
  const pct = (v) => `${Math.round(v * 100)}%`;
  slider(sh, 'First LED at', 'shift.start', 50, 92, 1, pct, 100);
  slider(sh, 'All lit at', 'shift.red', 80, 99, 1, pct, 100);
  slider(sh, 'Flash at', 'shift.flash', 90, 100, 1, pct, 100);
  slider(sh, 'Beep at', 'shift.beep', 80, 100, 1, pct, 100);
  const cfg = h('div', 'dr-note', 'Percentages of the car\'s max RPM.'); sh.appendChild(cfg);

  // ---- screen ---------------------------------------------------------------------------------------------------------------------------
  const sc = section('Screen');
  toggle('mirror', 'Mirror cockpit (windshield HUD)', sc);
  toggle('keepAwake', 'Keep screen on (no sleep / screen saver)', sc, 'Uses the Wake Lock API, or a tiny hidden video over plain http://. Phones need one tap first.');
  if (document.fullscreenEnabled) button(sc, '⛶ Toggle fullscreen', () => actions.fullscreen());
  sc.appendChild(h('div', 'dr-note', 'If the ☀ button in the top bar stays orange, this browser refused: set the device\'s auto-lock / screen saver to Never.'));

  // ---- data ---------------------------------------------------------------------------------------------------------------------------------
  const da = section('Data');
  button(da, '⬇ Export recorded timeline (CSV)', () => actions.exportCsv());
  button(da, '🖼 Save session card (PNG)', () => actions.shareCard());
  button(da, '🗺 Clear map trail', () => actions.clearMap());
  button(da, '↺ Reset session measurements', () => actions.resetSession());
  button(da, '🗑 Reset lifetime stats & trophies', () => { if (confirm('Erase all lifetime records, personal bests and trophies on this device?')) actions.resetLifetime(); }, 'danger');

  const about = section('About');
  const ver = h('div', 'dr-note', 'FH6 Telemetry web dashboard. Psst: try ↑ ↑ ↓ ↓ ← → ← → B A on a keyboard.');
  about.appendChild(ver);

  const sync = () => refreshers.forEach((f) => f());
  on('settings', sync);
  sync();
  return { sync };
}
