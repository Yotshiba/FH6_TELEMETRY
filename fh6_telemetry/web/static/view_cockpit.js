// Cockpit: a dash you can build yourself.  The widgets (dials, shift lights, wheel, pedals, tyre temperatures ...)
// come from cockpit_widgets.js and their arrangement from cockpit_layout.js; this view smooths the live values,
// draws the layout of the current orientation and runs the editor (✎ Edit: drag to move, corner handle to resize,
// ✕ to remove, ＋ Add for the palette).  Layouts are remembered per orientation in the settings.

import { colors, withAlpha } from './theme.js';
import { fitCanvas, roundRect, smooth } from './gauges.js';
import { shiftLevel } from './shift.js';
import {
  GRID, WIDGET_TYPES, WIDGET_TYPE_IDS, addWidget, bringToFront, cellsFor, defaultLayout, handleSize, hitTest,
  layoutsEqual, moveWidget, orientationFor, rectOf, removeWidget, resizeWidget,
} from './cockpit_layout.js';
import { WIDGET_DRAW } from './cockpit_widgets.js';
import { emit } from './bus.js';
import { conv } from './units.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const HISTORY_MAX = 40;
const DEFAULTS = { landscape: defaultLayout('landscape'), portrait: defaultLayout('portrait') };

export function buildCockpit(ctx) {
  const { store, settings, analytics, actions } = ctx;
  const root = h('div', 'view v-cockpit');
  const canvas = h('canvas', 'cockpit-canvas');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');

  // ---- controls ---------------------------------------------------------------------------------------------------------
  const ctl = h('div', 'cockpit-ctl');
  const bSound = h('button', 'chip', '🔇 Sound'); bSound.title = 'Engine sound (needs a tap)';
  const bMirror = h('button', 'chip', '🪞 HUD'); bMirror.title = 'Mirror the cockpit for a windshield HUD';
  const bEdit = h('button', 'chip', '✎ Edit'); bEdit.title = 'Add, remove and move the gauges';
  bSound.addEventListener('click', () => actions.toggleSound());
  bMirror.addEventListener('click', () => settings.set('mirror', !settings.get('mirror')));
  ctl.append(bSound, bMirror, bEdit);

  const editBar = h('div', 'cockpit-ctl cockpit-edit');
  editBar.style.display = 'none';
  const bAdd = h('button', 'chip on', '＋ Add'); bAdd.title = 'Add a gauge';
  const bUndo = h('button', 'chip', '↶ Undo'); bUndo.title = 'Undo the last change';
  const bReset = h('button', 'chip', '↺ Reset'); bReset.title = 'Back to the factory layout';
  const bDone = h('button', 'chip', '✓ Done');
  const editInfo = h('span', 'cockpit-edit-info', '');
  editBar.append(bAdd, bUndo, bReset, bDone, editInfo);

  const palette = h('div', 'cockpit-palette');
  palette.style.display = 'none';
  palette.appendChild(h('div', 'pal-title', 'Add a gauge'));
  const palGrid = h('div', 'pal-grid');
  for (const type of WIDGET_TYPE_IDS) {
    const spec = WIDGET_TYPES[type];
    const b = h('button', 'pal-item');
    b.append(h('b', null, spec.label), h('span', null, spec.hint));
    b.addEventListener('click', () => addType(type));
    palGrid.appendChild(b);
  }
  palette.appendChild(palGrid);
  root.append(ctl, editBar, palette);

  // ---- state ----------------------------------------------------------------------------------------------------------------
  const st = { speed: 0, rpm: 0, wheel: 0, thr: 0, brk: 0, clu: 0, delta: 0, latG: 0, longG: 0 };
  /** The per-frame state the widgets draw from (one object, refilled every frame). */
  const S = { g, c: null, u: null, ts: 0, kmh: 0, rpm: 0, rpmS: 0, maxRpm: 8000, speed: 0, wheel: 0, thr: 0, brk: 0, clu: 0, delta: 0, latG: 0, longG: 0, level: null, gear: 'N', store, analytics };
  const E = { active: false, orient: 'landscape', working: null, preview: null, history: [], selected: null, drag: null, resetArmed: 0 };
  let geo = { w: 800, h: 450, orient: 'landscape' };

  const storedLayout = (orient) => settings.get('cockpit.' + orient) || DEFAULTS[orient];
  const shown = () => (E.active ? (E.preview || E.working) : storedLayout(geo.orient));

  function persist(layout) {
    // a layout equal to the factory one is stored as "none", so it follows future factory changes
    settings.set('cockpit.' + E.orient, layoutsEqual(layout, DEFAULTS[E.orient]) ? null : layout);
  }

  /** Make `layout` the working layout (remembering the previous one for Undo) and save it. */
  function commit(layout) {
    if (layoutsEqual(layout, E.working)) return;
    E.history.push(E.working);
    if (E.history.length > HISTORY_MAX) E.history.shift();
    E.working = layout;
    E.preview = null;
    persist(layout);
  }

  function enterEdit() {
    E.active = true;
    E.orient = geo.orient;
    E.working = storedLayout(E.orient).map((x) => ({ ...x }));
    E.preview = null; E.history = []; E.selected = null; E.drag = null; E.resetArmed = 0;
    palette.style.display = 'none';
    ctl.style.display = 'none'; editBar.style.display = '';
    root.classList.add('editing');
  }

  function leaveEdit() {
    E.active = false; E.drag = null; E.preview = null;
    palette.style.display = 'none';
    ctl.style.display = ''; editBar.style.display = 'none';
    root.classList.remove('editing');
  }

  function addType(type) {
    const res = addWidget(E.working, type, E.orient);
    palette.style.display = 'none';
    if (!res) { emit('toast', { icon: '🧩', title: 'The dash is full', text: 'Remove a gauge before adding another', rarity: 'common', ms: 2500 }); return; }
    commit(res.layout);
    E.selected = res.widget.id;
  }

  bEdit.addEventListener('click', enterEdit);
  bDone.addEventListener('click', leaveEdit);
  bAdd.addEventListener('click', () => { palette.style.display = palette.style.display === 'none' ? '' : 'none'; });
  bUndo.addEventListener('click', () => {
    const prev = E.history.pop();
    if (!prev) return;
    E.working = prev; E.preview = null; E.selected = null;
    persist(prev);
  });
  bReset.addEventListener('click', () => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!E.resetArmed || now - E.resetArmed > 3000) { E.resetArmed = now; return; }   // the first tap only arms it
    E.resetArmed = 0;
    commit(DEFAULTS[E.orient].map((x) => ({ ...x })));
    E.selected = null;
  });

  // ---- pointer editing ---------------------------------------------------------------------------------------------------
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener('pointerdown', (e) => {
    if (!E.active) return;
    const p = local(e);
    const hit = hitTest(E.working, E.orient, p.x, p.y, geo.w, geo.h);
    palette.style.display = 'none';
    if (!hit) { E.selected = null; return; }
    if (hit.part === 'remove') { commit(removeWidget(E.working, hit.id)); E.selected = null; return; }
    E.selected = hit.id;
    const base = bringToFront(E.working, hit.id);
    const it = base.find((x) => x.id === hit.id);
    E.drag = { mode: hit.part === 'resize' ? 'resize' : 'move', id: hit.id, x0: p.x, y0: p.y, orig: { ...it }, base, moved: false };
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const d = E.drag;
    if (!E.active || !d) return;
    const p = local(e);
    const { dx, dy } = cellsFor(E.orient, geo.w, geo.h, p.x - d.x0, p.y - d.y0);
    const next = d.mode === 'move'
      ? moveWidget(d.base, d.id, d.orig.x + dx, d.orig.y + dy, E.orient)
      : resizeWidget(d.base, d.id, d.orig.w + dx, d.orig.h + dy, E.orient);
    E.preview = next;
    d.moved = d.moved || dx !== 0 || dy !== 0;
  });

  const endDrag = () => {
    const d = E.drag;
    E.drag = null;
    if (!d) return;
    if (E.preview && d.moved) commit(E.preview);
    else if (!layoutsEqual(d.base, E.working)) commit(d.base);       // a plain tap still raises the widget
    E.preview = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { E.drag = null; E.preview = null; });

  window.addEventListener('keydown', (e) => {
    if (!E.active || !E.selected) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const it = E.working.find((x) => x.id === E.selected);
    if (!it) return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (step) {
      e.preventDefault();
      commit(e.shiftKey
        ? resizeWidget(E.working, it.id, it.w + step[0], it.h + step[1], E.orient)
        : moveWidget(E.working, it.id, it.x + step[0], it.y + step[1], E.orient));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      commit(removeWidget(E.working, it.id));
      E.selected = null;
    } else if (e.key === 'Escape') {
      E.selected = null;
    }
  });

  // ---- the editor's overlay ---------------------------------------------------------------------------------------------
  function drawEditOverlay(c, layout) {
    const { w, h: H, orient } = geo;
    const { cols, rows } = GRID[orient];
    g.save();
    g.strokeStyle = withAlpha(c.bright, 0.07); g.lineWidth = 1; g.beginPath();
    for (let i = 1; i < cols; i++) { const x = Math.round(i * w / cols) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
    for (let j = 1; j < rows; j++) { const y = Math.round(j * H / rows) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    if (!layout.length) {
      g.fillStyle = c.dim; g.font = '600 16px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('Nothing here yet: tap ＋ Add to put a gauge on the dash', w / 2, H / 2);
    }
    for (const it of layout) {
      const r = rectOf(it, orient, w, H);
      const sel = it.id === E.selected;
      g.fillStyle = sel ? withAlpha(c.accent, 0.12) : withAlpha(c.bright, 0.03);
      roundRect(g, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6); g.fill();
      g.strokeStyle = sel ? c.accent : withAlpha(c.bright, 0.35); g.lineWidth = sel ? 2 : 1;
      if (!sel) g.setLineDash([5, 4]);
      roundRect(g, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6); g.stroke();
      g.setLineDash([]);
      // name tag
      const name = WIDGET_TYPES[it.type].label;
      g.font = '700 10px system-ui, sans-serif';
      const tw = Math.min(r.w - 4, g.measureText(name).width + 10);
      if (tw > 24 && r.h >= 16) {
        g.fillStyle = withAlpha(c.panel2, 0.85); roundRect(g, r.x + 3, r.y + 3, tw, 15, 5); g.fill();
        g.fillStyle = sel ? c.accent : c.dim; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.save(); g.beginPath(); g.rect(r.x + 3, r.y + 3, tw, 15); g.clip();
        g.fillText(name, r.x + 8, r.y + 11); g.restore();
      }
      const hs = handleSize(r);
      // remove button (top-right)
      const bx = r.x + r.w - hs / 2 - 1, by = r.y + hs / 2 + 1;
      g.fillStyle = c.red; g.beginPath(); g.arc(bx, by, hs / 2 - 1, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1.5, hs * 0.09); g.lineCap = 'round';
      const k = hs * 0.18;
      g.beginPath(); g.moveTo(bx - k, by - k); g.lineTo(bx + k, by + k); g.moveTo(bx + k, by - k); g.lineTo(bx - k, by + k); g.stroke();
      // resize handle (bottom-right)
      const rx = r.x + r.w - 2, ry = r.y + r.h - 2;
      g.fillStyle = sel ? c.accent : withAlpha(c.bright, 0.55);
      g.beginPath(); g.moveTo(rx, ry - hs * 0.8); g.lineTo(rx, ry); g.lineTo(rx - hs * 0.8, ry); g.closePath(); g.fill();
    }
    g.restore();
  }

  // ---- frame ----------------------------------------------------------------------------------------------------------------------
  function update(dt, ts) {
    const c = colors();
    const u = settings.get('units');
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    const orient = orientationFor(w, H);
    geo = { w, h: H, orient };
    if (E.active && orient !== E.orient) {                  // the device was rotated while editing: edit that orientation's layout
      E.orient = orient;
      E.working = storedLayout(orient).map((x) => ({ ...x }));
      E.preview = null; E.history = []; E.selected = null; E.drag = null;
    }
    root.classList.toggle('mirror', !!settings.get('mirror') && !E.active);
    const snd = !!settings.get('soundOn');
    if (bSound._on !== snd) { bSound._on = snd; bSound.textContent = snd ? '🔊 Sound' : '🔇 Sound'; bSound.classList.toggle('on', snd); }
    bMirror.classList.toggle('on', !!settings.get('mirror'));
    if (E.active) {
      bUndo.style.opacity = E.history.length ? '' : '0.45';
      const armed = E.resetArmed && (typeof performance !== 'undefined' ? performance.now() : Date.now()) - E.resetArmed < 3000;
      const rt = armed ? 'Tap again to reset' : '↺ Reset';
      if (bReset._t !== rt) { bReset._t = rt; bReset.textContent = rt; }
      const info = `${orient} layout`;
      if (editInfo._t !== info) { editInfo._t = info; editInfo.textContent = info; }
    }

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
    st.latG = smooth(st.latG, store.f('AccelGX'), dt, 14);
    st.longG = smooth(st.longG, store.f('AccelGZ'), dt, 14);
    const lap = analytics && analytics.lap ? analytics.lap.state : null;
    if (lap && lap.valid) st.delta = smooth(st.delta, lap.deltaS, dt, 8);

    S.c = c; S.u = u; S.ts = ts; S.kmh = kmh; S.rpm = rpm; S.rpmS = st.rpm; S.maxRpm = maxRpm;
    S.speed = st.speed; S.wheel = st.wheel; S.thr = st.thr; S.brk = st.brk; S.clu = st.clu; S.delta = st.delta;
    S.latG = st.latG; S.longG = st.longG;
    S.level = shiftLevel(rpm, maxRpm, settings.get('shift'));
    S.gear = store.gear || 'N';

    const layout = shown();
    for (const it of layout) {
      const draw = WIDGET_DRAW[it.type];
      if (!draw) continue;
      const r = rectOf(it, orient, w, H);
      g.save();                                                                       // (a glow may spill past the box: no clip)
      try { draw(S, r); } catch (err) { console.error(err); }
      g.restore();
    }
    if (E.active) drawEditOverlay(c, layout);
  }

  return {
    id: 'cockpit', title: 'Cockpit', color: '#ff4d6d', el: root, charts: [], animated: true, update,
    _edit: E,                                                                      // (read by tests)
  };
}
