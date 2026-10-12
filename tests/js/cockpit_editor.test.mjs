// The cockpit: every widget draws, a saved layout is honoured, and the editor (add / move / resize / remove /
// undo / reset / keyboard / rotation) works end to end against a stub DOM, settings included.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCockpit } from '../../fh6_telemetry/web/static/view_cockpit.js';
import { WIDGET_TYPES, WIDGET_TYPE_IDS, defaultLayout, layoutsEqual } from '../../fh6_telemetry/web/static/cockpit_layout.js';
import { drive, fireWindow, installDom, removeDom, setup } from './helpers/stubdom.mjs';

const find = (view, pred) => view.el.find(pred);
const button = (view, text) => find(view, (c) => c.tag === 'button' && c.textContent === text);
const canvasOf = (view) => find(view, (c) => c.tag === 'canvas');

/** A cockpit that has seen a few seconds of data, with the call recorder attached to its canvas. */
function cockpit(configure) {
  installDom();
  const app = setup();
  if (configure) configure(app);
  const view = buildCockpit(app);
  drive(app, view, 120);
  return { app, view, canvas: canvasOf(view) };
}
const frame = (c, n = 1) => { for (let i = 0; i < n; i++) c.view.update(1 / 60, 9999 + i); };
const stored = (app, o = 'landscape') => app.settings.get('cockpit.' + o);

test('every widget type draws something, in both orientations, with sane and with garbage data', () => {
  for (const orient of ['landscape', 'portrait']) {
    for (const type of WIDGET_TYPE_IDS) {
      for (const garbage of [false, true]) {
        installDom();
        try {
          const app = setup();
          app.settings.set('cockpit.' + orient, [{ id: type, type, x: 0, y: 0, w: orient === 'landscape' ? 16 : 18, h: orient === 'landscape' ? 12 : 16 }]);
          const view = buildCockpit(app);
          const canvas = canvasOf(view);
          if (orient === 'portrait') canvas.rect = { width: 375, height: 812 };
          drive(app, view, 120, garbage ? { rowOver: () => ({ SpeedKmh: 1e12, CurrentEngineRpm: -5, EngineMaxRpm: 0, AccelGX: 1e30, FuelPct: -40, BoostBar: 1e9, TireTempFL: 1e9, Yaw: NaN }) } : {});
          const g = canvas.getContext('2d');
          g.__rec = [];
          view.update(1 / 60, 20000);
          const drawn = g.__rec.filter(([k]) => ['fill', 'stroke', 'fillText', 'fillRect', 'arc'].includes(k)).length;
          assert.ok(drawn > 0, `${type} (${orient}${garbage ? ', garbage data' : ''}) drew nothing`);
        } finally { removeDom(); }
      }
    }
  }
});

test('the dash shows exactly the saved layout (and the factory one when nothing is saved)', () => {
  const c = cockpit();
  const g = c.canvas.getContext('2d');
  g.__rec = []; frame(c);
  assert.ok(g.__rec.some(([k]) => k === 'createRadialGradient'), 'the factory layout has dials');
  removeDom();

  const only = cockpit((app) => app.settings.set('cockpit.landscape', [{ id: 'gear', type: 'gear', x: 10, y: 4, w: 12, h: 10 }]));
  const g2 = only.canvas.getContext('2d');
  g2.__rec = []; frame(only);
  assert.equal(g2.__rec.some(([k]) => k === 'createRadialGradient'), false, 'no dial: they were not saved');
  assert.ok(g2.__rec.some(([k, s]) => k === 'fillText' && s === only.app.store.gear), 'the gear label is drawn');
  removeDom();

  const empty = cockpit((app) => app.settings.set('cockpit.landscape', []));
  const g3 = empty.canvas.getContext('2d');
  g3.__rec = []; frame(empty);
  assert.equal(g3.__rec.filter(([k]) => k === 'fillText').length, 0, 'an empty layout is an empty dash');
  removeDom();
});

test('edit mode: the bars swap, the overlay appears, Done leaves and restores everything', () => {
  const c = cockpit();
  try {
    const sound = button(c.view, '🔇 Sound'), edit = button(c.view, '✎ Edit');
    const addBtn = button(c.view, '＋ Add');
    const editBar = addBtn && c.view.el.children.find((x) => x.className.includes('cockpit-edit'));
    assert.ok(sound && edit && addBtn);
    assert.equal(editBar.style.display, 'none');
    edit.fire('click');
    frame(c);
    assert.equal(editBar.style.display, '');
    assert.ok(c.view.el.className.includes('editing'));
    const g = c.canvas.getContext('2d');
    g.__rec = []; frame(c);
    assert.ok(g.__rec.some(([k]) => k === 'setLineDash'), 'dashed widget outlines are drawn');
    button(c.view, '✓ Done').fire('click');
    assert.equal(editBar.style.display, 'none');
    assert.equal(c.view.el.className.includes('editing'), false);
  } finally { removeDom(); }
});

test('drag to move: snaps to cells, saves, and a plain tap changes nothing', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    const before = defaultLayout('landscape').find((x) => x.id === 'gear');            // x13 y4 w6 h6; 25 px cells
    c.canvas.fire('pointerdown', { clientX: 400, clientY: 175 });
    assert.equal(c.view._edit.selected, 'gear');
    c.canvas.fire('pointermove', { clientX: 500, clientY: 225 });                        // +4 cells, +2 cells
    frame(c);
    assert.equal(stored(c.app), null, 'nothing is saved while the finger is still down');
    c.canvas.fire('pointerup', {});
    const saved = stored(c.app);
    const gear = saved.find((x) => x.id === 'gear');
    assert.deepEqual([gear.x, gear.y, gear.w, gear.h], [before.x + 4, before.y + 2, 6, 6]);
    assert.equal(saved.at(-1).id, 'gear', 'the dragged widget is raised to the top');
    assert.equal(saved.length, defaultLayout('landscape').length);
    // a tap without moving only raises the widget (nothing else changes) ...
    const before2 = stored(c.app).filter((x) => x.id !== 'speedo');
    c.canvas.fire('pointerdown', { clientX: 120, clientY: 150 });
    c.canvas.fire('pointerup', {});
    assert.equal(stored(c.app).at(-1).id, 'speedo');
    assert.deepEqual(stored(c.app).filter((x) => x.id !== 'speedo'), before2);
    // ... and tapping the widget that is already on top changes nothing at all
    const snapshot = JSON.stringify(stored(c.app));
    c.canvas.fire('pointerdown', { clientX: 120, clientY: 150 });
    c.canvas.fire('pointerup', {});
    assert.equal(JSON.stringify(stored(c.app)), snapshot);
    // dragging way past the edge is clamped inside the grid
    c.canvas.fire('pointerdown', { clientX: 120, clientY: 150 });                          // the speedo
    c.canvas.fire('pointermove', { clientX: -900, clientY: -900 });
    c.canvas.fire('pointerup', {});
    const speedo = stored(c.app).find((x) => x.id === 'speedo');
    assert.deepEqual([speedo.x, speedo.y], [0, 0]);
  } finally { removeDom(); }
});

test('resize from the corner handle respects the minimum size', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    // gear: x13 y4 w6 h6 -> pixels 325..475 x 100..250; its handle is the bottom-right corner
    c.canvas.fire('pointerdown', { clientX: 470, clientY: 245 });
    c.canvas.fire('pointermove', { clientX: 545, clientY: 270 });                          // +3 cells wide, +1 tall
    c.canvas.fire('pointerup', {});
    let gear = stored(c.app).find((x) => x.id === 'gear');
    assert.deepEqual([gear.w, gear.h], [9, 7]);
    // shrink far below the minimum
    const r = { x: (gear.x + gear.w) * 25, y: (gear.y + gear.h) * 25 };
    c.canvas.fire('pointerdown', { clientX: r.x - 4, clientY: r.y - 4 });
    c.canvas.fire('pointermove', { clientX: r.x - 900, clientY: r.y - 900 });
    c.canvas.fire('pointerup', {});
    gear = stored(c.app).find((x) => x.id === 'gear');
    assert.deepEqual([gear.w, gear.h], WIDGET_TYPES.gear.min);
  } finally { removeDom(); }
});

test('remove with the corner x, then Undo brings it back; Undo with nothing to undo is harmless', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    const n = defaultLayout('landscape').length;
    const undo = button(c.view, '↶ Undo');
    undo.fire('click');                                                                      // nothing yet
    assert.equal(stored(c.app), null);
    c.canvas.fire('pointerdown', { clientX: 470, clientY: 105 });                            // gear's top-right x
    assert.equal(stored(c.app).length, n - 1);
    assert.equal(stored(c.app).some((x) => x.id === 'gear'), false);
    undo.fire('click');
    assert.equal(stored(c.app), null, 'back to the factory layout, stored as "none"');
    assert.ok(layoutsEqual(c.view._edit.working, defaultLayout('landscape')));
  } finally { removeDom(); }
});

test('palette: adds a gauge at a free spot, selects it, and tells you when the dash is full', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    const palette = find(c.view, (x) => x.className === 'cockpit-palette');
    assert.equal(palette.style.display, 'none');
    button(c.view, '＋ Add').fire('click');
    assert.equal(palette.style.display, '');
    const items = palette.find((x) => x.className === 'pal-grid').children;
    assert.equal(items.length, WIDGET_TYPE_IDS.length);
    const tyres = items.find((i) => i.children[0].textContent === WIDGET_TYPES.tyres.label);
    tyres.fire('click');
    assert.equal(palette.style.display, 'none');
    const added = stored(c.app).find((x) => x.type === 'tyres');
    assert.ok(added && added.id === 'tyres');
    assert.equal(c.view._edit.selected, 'tyres');
    // a second one gets its own id
    button(c.view, '＋ Add').fire('click');
    items.find((i) => i.children[0].textContent === WIDGET_TYPES.tyres.label).fire('click');
    assert.deepEqual(stored(c.app).filter((x) => x.type === 'tyres').map((x) => x.id), ['tyres', 'tyres-2']);
  } finally { removeDom(); }
});

test('Reset needs a second tap, restores the factory layout and stores it as "none"', () => {
  const c = cockpit((app) => app.settings.set('cockpit.landscape', [{ id: 'gear', type: 'gear', x: 0, y: 0, w: 6, h: 6 }]));
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    const reset = button(c.view, '↺ Reset');
    reset.fire('click');                                                                     // arms
    assert.equal(stored(c.app).length, 1);
    frame(c);
    assert.equal(button(c.view, 'Tap again to reset') !== null, true);
    reset.fire('click');
    assert.equal(stored(c.app), null);
    assert.ok(layoutsEqual(c.view._edit.working, defaultLayout('landscape')));
    // ... and Undo can take the reset back
    button(c.view, '↶ Undo').fire('click');
    assert.equal(stored(c.app).length, 1);
  } finally { removeDom(); }
});

test('keyboard: arrows move, shift+arrows resize, Delete removes, Escape deselects', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    fireWindow('keydown', { key: 'ArrowLeft' });                                             // nothing selected: ignored
    assert.equal(stored(c.app), null);
    c.canvas.fire('pointerdown', { clientX: 400, clientY: 175 });                            // select the gear
    c.canvas.fire('pointerup', {});
    fireWindow('keydown', { key: 'ArrowRight' });
    fireWindow('keydown', { key: 'ArrowDown' });
    fireWindow('keydown', { key: 'ArrowRight', shiftKey: true });
    let gear = stored(c.app).find((x) => x.id === 'gear');
    assert.deepEqual([gear.x, gear.y, gear.w, gear.h], [14, 5, 7, 6]);
    fireWindow('keydown', { key: 'Escape' });
    assert.equal(c.view._edit.selected, null);
    fireWindow('keydown', { key: 'Delete' });                                                // deselected: ignored
    assert.ok(stored(c.app).some((x) => x.id === 'gear'));
    c.canvas.fire('pointerdown', { clientX: 400, clientY: 175 });
    c.canvas.fire('pointerup', {});
    // typing in a text field must not move gauges around
    fireWindow('keydown', { key: 'ArrowLeft', target: { tagName: 'INPUT' } });
    gear = stored(c.app).find((x) => x.id === 'gear');
    assert.equal(gear.x, 14);
    fireWindow('keydown', { key: 'Delete' });
    assert.equal(stored(c.app).some((x) => x.id === 'gear'), false);
  } finally { removeDom(); }
});

test('rotating the device while editing switches to that orientation\'s layout; each is kept separately', () => {
  const c = cockpit();
  try {
    button(c.view, '✎ Edit').fire('click'); frame(c);
    c.canvas.fire('pointerdown', { clientX: 400, clientY: 175 });
    c.canvas.fire('pointerup', {});
    fireWindow('keydown', { key: 'ArrowRight' });
    assert.ok(stored(c.app, 'landscape'));
    c.canvas.rect = { width: 375, height: 812 };                                             // phone turned upright
    frame(c);
    assert.equal(c.view._edit.orient, 'portrait');
    assert.ok(layoutsEqual(c.view._edit.working, defaultLayout('portrait')));
    assert.equal(c.view._edit.selected, null);
    // edit the portrait layout: add a gauge there
    button(c.view, '＋ Add').fire('click');
    find(c.view, (x) => x.className === 'pal-grid').children[0].fire('click');
    assert.equal(stored(c.app, 'portrait').length, defaultLayout('portrait').length + 1);
    assert.equal(stored(c.app, 'landscape').find((x) => x.id === 'gear').x, 14, 'the landscape layout is untouched');
  } finally { removeDom(); }
});

test('a corrupt saved layout can never break the dash: it is sanitised on load', () => {
  const c = cockpit((app) => {
    app.settings.data.cockpit.landscape = null;                                              // (settings sanitise on set, so go through set)
    app.settings.set('cockpit.landscape', [{ id: 'x', type: 'warp_drive', x: 0, y: 0, w: 3, h: 3 }, 17, { type: 'gear', x: 'a' }]);
  });
  try {
    assert.deepEqual(stored(c.app), []);                                                     // nothing valid left: an empty (but valid) layout
    assert.doesNotThrow(() => frame(c, 3));
  } finally { removeDom(); }
});
