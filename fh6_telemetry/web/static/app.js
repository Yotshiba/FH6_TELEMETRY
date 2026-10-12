// Boot: connect the stream, build the views once the server has described itself
// ("hello"), then drive the animation loop.  Everything optional (sound, effects, themes,
// analytics) hangs off the settings and the event bus.

import { Analytics } from './analytics.js';
import { emit, on } from './bus.js';
import { setChartUnits } from './charts.js';
import { describeAwake, exportCsv, exportShareCard, KeepAwake, onKonami } from './extras.js';
import { Feel } from './feel.js';
import { Fx } from './fx.js';
import { Lifetime } from './lifetime.js';
import { Settings } from './settings.js';
import { buildDrawer } from './settings_ui.js';
import { shiftLevel } from './shift.js';
import { Store } from './store.js';
import { Stream } from './stream.js';
import { invalidateTheme } from './theme.js';
import { initToasts } from './toasts.js';
import { buildCar } from './view_car.js';
import { buildCockpit } from './view_cockpit.js';
import { buildLab } from './view_lab.js';
import { buildMap } from './view_map.js';
import { buildTimeline } from './view_timeline.js';
import { buildViews } from './views.js';

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs'), viewsEl = $('views'), connEl = $('conn'), connText = $('conn-text');
const drawer = $('drawer'), backdrop = $('backdrop');

const settings = new Settings();
const lifetime = new Lifetime();
const store = new Store();
setChartUnits(() => settings.get('units'));

let views = [];
let active = null;
let lastVersion = -1;
let connState = '';
let mapView = null;

// ---- theme ----------------------------------------------------------------------------------------

function applyTheme() {
  document.documentElement.dataset.theme = settings.get('theme');
  invalidateTheme();
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute('content', bg);
  });
  lastVersion = -1;
  for (const v of views) for (const c of v.charts) c.dirty = true;
}
applyTheme();

// ---- the optional layers ------------------------------------------------------------------------------

const analytics = new Analytics(store, lifetime, settings);
const feel = new Feel({ store, settings });
feel.start();
initToasts($('toasts'));
const fx = new Fx($('fx'), $('vignette'), $('shake'), settings);
const keepAwake = new KeepAwake();
const awakeBtn = $('btn-awake');
let awakeWarned = false;
keepAwake.onChange((mode) => {                       // the ☀ button shows what the device is really doing
  awakeBtn.classList.toggle('on', mode === 'wakelock' || mode === 'video');
  awakeBtn.classList.toggle('warn', mode === 'pending' || mode === 'unsupported');
  awakeBtn.setAttribute('aria-pressed', String(mode === 'wakelock' || mode === 'video'));
  awakeBtn.title = describeAwake(mode);
  if (mode === 'unsupported' && !awakeWarned) {
    awakeWarned = true;
    emit('toast', { icon: '☀', title: "Can't keep the screen on", text: "Set this device's auto-lock / screen saver to Never", rarity: 'common', ms: 6000 });
  }
});
awakeBtn.addEventListener('click', () => settings.set('keepAwake', !settings.get('keepAwake')));

const actions = {
  toggleSound: async () => {
    try { await feel.toggleSound(); } catch (e) {
      emit('toast', { icon: '🔇', title: 'Sound unavailable', text: (e && e.message) || 'This browser blocked audio', rarity: 'common' });
    }
  },
  openDrawer: () => { drawer.classList.add('open'); backdrop.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); },
  closeDrawer: () => { drawer.classList.remove('open'); backdrop.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); },
  fullscreen: () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); },
  exportCsv: () => { if (!exportCsv(store)) emit('toast', { icon: '📭', title: 'Nothing recorded yet', text: 'Drive for a few seconds first', rarity: 'common' }); },
  shareCard: () => exportShareCard({ analytics, lifetime, settings, trail: mapView ? mapView._trail : null }),
  clearMap: () => { if (mapView) mapView.clear(); },
  resetSession: () => { analytics.resetSession(); store.clearHistory(); emit('toast', { icon: '↺', title: 'Session reset', text: 'Timers, records and rewind history cleared', rarity: 'common', ms: 2200 }); },
  // rebind first: it banks the live session's records into the lifetime, which reset() then blanks (otherwise the
  // running trackers would re-merge their maxima / odometer within 2 s and 'erase' would silently undo itself)
  resetLifetime: () => { analytics.resetSession(); lifetime.reset(); analytics.achievements.reset(); emit('toast', { icon: '🗑', title: 'Lifetime stats erased', text: '', rarity: 'common', ms: 2200 }); },
};
const ctx = { store, settings, analytics, lifetime, fx, actions };

buildDrawer(drawer, ctx);
$('btn-settings').addEventListener('click', () => actions.openDrawer());
backdrop.addEventListener('click', () => actions.closeDrawer());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') actions.closeDrawer(); });

on('settings', ({ path }) => {
  if (path === 'theme' || path === '*') applyTheme();
  if (path === 'keepAwake' || path === '*') { if (settings.get('keepAwake')) keepAwake.enable(); else keepAwake.disable(); }
  if (path && path.startsWith('units')) { lastVersion = -1; for (const v of views) for (const c of v.charts) c.dirty = true; }
});
if (settings.get('keepAwake')) keepAwake.enable();      // (retries by itself on the first tap and when the tab returns)
document.addEventListener('visibilitychange', () => { if (!document.hidden) lastVersion = -1; });

onKonami(() => {
  settings.set('theme', 'hyperdrive');
  emit('toast', { icon: '🚀', title: 'HYPERDRIVE ENGAGED', text: 'Pick another theme in ⚙ to come back', rarity: 'legendary' });
});

// ---- connection state ------------------------------------------------------------------------------------

const CONN_TEXT = {
  connecting: 'Connecting…', reconnecting: 'Reconnecting…', nosignal: 'No signal — waiting for the game',
  paused: 'Paused (tab hidden)',
};

function setConn(state) {
  const text = state === 'live' ? `Live · ${Math.round(store.pps)} pkt/s` : CONN_TEXT[state] || state;
  if (state === connState && connText.textContent === text) return;
  connState = state;
  connEl.className = 'conn conn-' + state;
  connText.textContent = text;
}

// ---- views / tabs -------------------------------------------------------------------------------------------

function select(id, persist = true) {
  const v = views.find((x) => x.id === id) || views[0];
  if (!v) return;
  active = v;
  for (const x of views) x.el.classList.toggle('active', x === v);
  for (const b of tabsEl.children) b.setAttribute('aria-selected', String(b.dataset.view === v.id));
  lastVersion = -1;
  for (const c of v.charts) { c.dirty = true; c.resize(); }
  fx.speedOn = v.id === 'cockpit' || v.id === 'dash';
  if (persist) {
    try { history.replaceState(null, '', '#' + v.id); } catch { /* sandboxed */ }
    try { localStorage.setItem('fh6.view', v.id); } catch { /* private mode */ }
  }
}

function initViews() {
  const cockpit = buildCockpit(ctx);
  mapView = buildMap(ctx);
  const classic = buildViews(store, settings);
  const byId = Object.fromEntries(classic.map((v) => [v.id, v]));
  views = [cockpit, byId.dash, mapView, buildLab(ctx), buildCar(ctx), buildTimeline(ctx),
    byId.race, byId.car, byId.tyres, byId.engine, byId.inputs, byId.motion].filter(Boolean);
  for (const v of views) {
    viewsEl.appendChild(v.el);
    const b = document.createElement('button');
    b.className = 'tab'; b.type = 'button'; b.role = 'tab'; b.textContent = v.title;
    b.dataset.view = v.id; b.style.setProperty('--tab', v.color);
    b.addEventListener('click', () => select(v.id));
    tabsEl.appendChild(b);
  }
  let wanted = location.hash.slice(1);
  if (!wanted) { try { wanted = localStorage.getItem('fh6.view') || ''; } catch { /* ignore */ } }
  select(wanted || 'cockpit', false);
  firstRunTip();
}

function firstRunTip() {
  try {
    if (localStorage.getItem('fh6.tip')) return;
    localStorage.setItem('fh6.tip', '1');
  } catch { return; }
  setTimeout(() => emit('toast', { icon: '⚙', title: 'Make it yours', text: 'Open settings for engine sound, themes, units and effects', rarity: 'rare', ms: 6000 }), 1500);
}

window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && views.length) select(id, false); });

// ---- stream ---------------------------------------------------------------------------------------------------

const guard = (fn) => (...a) => { try { fn(...a); } catch (e) { console.error(e); } };

const stream = new Stream({
  state: (s) => {
    // no live link: sound / haptics / voice must not keep acting on the last row we happened to get
    if (s === 'connecting' || s === 'reconnecting' || s === 'paused') store.signal = false;
    setConn(s === 'connecting' || s === 'reconnecting' || s === 'paused' ? s : connState);
  },
  hello: guard((d) => {
    store.setHello(d);
    if (!views.length) initViews();
    store.signal = true;
    setConn('live');
  }),
  hist: guard((d) => {
    store.clearHistory();
    store.pushRows(d.r, true);                 // replay: fills charts + timeline, no achievements
    store.seq = d.s + d.r.length - 1;
  }),
  f: guard((d, s) => {
    if (store.applyFrames(d)) return;
    // Gap: resume from the last batch we really applied (the stream's own resume point has already
    // moved past the hole, which would otherwise freeze the dashboard in a reconnect loop).
    s.lastId = store.resumeId();
    s.reopen();
  }),
  s: guard((d) => store.pushSlow(d)),
  rg: guard((d) => { Object.assign(store.ranges, d); store.version++; }),
  st: guard((d) => {
    const was = store.signal;
    store.signal = !!d.sig; store.pps = d.pps || 0;
    if (was !== store.signal) {
      store.version++;
      if (active && !active.animated) active.update(0, performance.now());
    }
    setConn(store.signal ? 'live' : 'nosignal');
  }),
  reset: () => { store.seq = null; store.last = null; store.slow = null; store.version++; analytics.resetSession(); },
});

// ---- animation loop ---------------------------------------------------------------------------------------------

let lastTs = 0, lastDraw = 0, lastAnim = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000);
  lastTs = ts;
  try {
    // effects run on every frame (they are cheap and animate on their own)
    if (store.hello && store.last) {
      // speed lines / redline vignette only while a live, racing row is arriving (not on the last row of a dead link)
      if (store.signal && store.f('IsRaceOn')) {
        const maxRpm = store.f('EngineMaxRpm') || 8000, rpm = store.f('CurrentEngineRpm');
        const lvl = shiftLevel(rpm, maxRpm, settings.get('shift'));
        fx.draw(ts, { speedKmh: store.f('SpeedKmh'), rpmRatio: lvl.ratio, flashing: lvl.flashing });
      } else {
        fx.draw(ts, { speedKmh: 0, rpmRatio: 0, flashing: false });   // confetti / shake still animate out
      }
    }
    if (!active) return;
    if (active.animated) {
      if (ts - lastAnim < 14) return;                              // ~60 fps cap: a 120 Hz phone draws every 2nd frame
      const adt = Math.min(0.1, (ts - (lastAnim || ts)) / 1000);   // seconds since the last DRAW, not the last frame
      lastAnim = ts;
      active.update(adt, ts);
      return;
    }
    if (ts - lastDraw < 32) return;
    lastDraw = ts;
    if (store.version !== lastVersion) { lastVersion = store.version; active.update(dt, ts); }
    for (const c of active.charts) c.draw();
  } catch (e) { console.error(e); }
}
requestAnimationFrame(frame);

on('analytics', (ev) => {                        // shake on hard landings
  if (ev.type === 'air_end') fx.shake(Math.min(12, 4 + ev.durationS * 4));
  if (ev.type === 'redline') fx.shake(2);
});

stream.start();
