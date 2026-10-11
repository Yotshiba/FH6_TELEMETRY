// Boot: connect the stream, build the views once the server has described itself
// ("hello"), then redraw the active view at most ~30 times a second.

import { gearLabel } from './format.js';
import { Store } from './store.js';
import { Stream } from './stream.js';
import { buildViews } from './views.js';

const store = new Store();
let views = [];
let active = null;
let lastVersion = -1;
let connState = '';

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs'), viewsEl = $('views'), connEl = $('conn'), connText = $('conn-text');

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

// ---- views / tabs ---------------------------------------------------------------------

function select(id, persist = true) {
  const v = views.find((x) => x.id === id) || views[0];
  if (!v) return;
  active = v;
  for (const x of views) x.el.classList.toggle('active', x === v);
  for (const b of tabsEl.children) b.setAttribute('aria-selected', String(b.dataset.view === v.id));
  lastVersion = -1;
  for (const c of v.charts) { c.dirty = true; c.resize(); }
  if (persist) {
    try { history.replaceState(null, '', '#' + v.id); } catch { /* sandboxed */ }
    try { localStorage.setItem('fh6.view', v.id); } catch { /* private mode */ }
  }
}

function initViews() {
  views = buildViews(store);
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
  select(wanted || 'dash', false);
  addFullscreenButton();
}

window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && views.length) select(id, false); });

function addFullscreenButton() {
  if (!document.fullscreenEnabled) return;       // not on iPhone: use "Add to Home Screen" instead
  const b = document.createElement('button');
  b.className = 'tab'; b.type = 'button'; b.textContent = '⛶'; b.title = 'Fullscreen'; b.setAttribute('aria-label', 'Fullscreen');
  b.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  });
  connEl.before(b);
}

// ---- stream ----------------------------------------------------------------------------

const guard = (fn) => (...a) => { try { fn(...a); } catch (e) { console.error(e); } };

const stream = new Stream({
  state: (s) => setConn(s === 'connecting' || s === 'reconnecting' || s === 'paused' ? s : connState),
  hello: guard((d) => {
    store.setHello(d);
    if (!views.length) initViews();
    store.signal = true;
    setConn('live');
  }),
  hist: guard((d) => {
    store.clearHistory();
    store.pushRows(d.r);
    store.seq = d.s + d.r.length - 1;
  }),
  f: guard((d, s) => {
    if (store.seq !== null && d.s - d.r.length !== store.seq) { s.reopen(); return; }   // gap: resync
    store.pushRows(d.r);
    store.seq = d.s;
  }),
  s: guard((d) => { store.slow = d; store.version++; }),
  rg: guard((d) => { Object.assign(store.ranges, d); store.version++; }),
  st: guard((d) => {
    const was = store.signal;
    store.signal = !!d.sig; store.pps = d.pps || 0;
    if (was !== store.signal) {
      store.version++;
      if (active) active.update();          // don't wait for a (possibly throttled) animation frame
    }
    setConn(store.signal ? 'live' : 'nosignal');
  }),
  reset: () => { store.seq = null; store.last = null; store.slow = null; store.version++; },
});

// ---- draw loop ---------------------------------------------------------------------------

let lastDraw = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!active || document.hidden || ts - lastDraw < 32) return;
  lastDraw = ts;
  try {
    if (store.hello && store.last) store.gear = gearLabel(store.hello.lab, store.f('Gear'), store.gear);
    if (store.version !== lastVersion) { lastVersion = store.version; active.update(); }
    for (const c of active.charts) c.draw();
  } catch (e) { console.error(e); }
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => { if (!document.hidden) lastVersion = -1; });

stream.start();
