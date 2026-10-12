import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID, MAX_WIDGETS, WIDGET_TYPES, WIDGET_TYPE_IDS, addWidget, bringToFront, cellsFor, defaultLayout, findFreeSpot,
  handleSize, hitTest, layoutsEqual, moveWidget, orientationFor, rectOf, removeWidget, resizeWidget, sanitizeLayout,
} from '../../fh6_telemetry/web/static/cockpit_layout.js';
import { WIDGET_DRAW } from '../../fh6_telemetry/web/static/cockpit_widgets.js';

const O = ['landscape', 'portrait'];

test('every catalogue entry is well formed and has a drawing function (and vice versa)', () => {
  assert.deepEqual([...WIDGET_TYPE_IDS].sort(), Object.keys(WIDGET_DRAW).sort());
  for (const [type, spec] of Object.entries(WIDGET_TYPES)) {
    assert.ok(spec.label.length > 2 && spec.hint.length > 5, type);
    for (const o of O) {
      const { cols, rows } = GRID[o];
      const [w, h] = spec.size[o];
      assert.ok(spec.min[0] >= 1 && spec.min[1] >= 1, `${type} min`);
      assert.ok(w >= spec.min[0] && h >= spec.min[1], `${type} default size is not below its minimum (${o})`);
      assert.ok(w <= cols && h <= rows, `${type} fits the ${o} grid`);
    }
  }
});

test('factory layouts: inside the grid, unique ids, and unchanged by validation', () => {
  for (const o of O) {
    const l = defaultLayout(o);
    assert.ok(l.length >= 8);
    assert.equal(new Set(l.map((x) => x.id)).size, l.length);
    const { cols, rows } = GRID[o];
    for (const wd of l) {
      assert.ok(wd.x >= 0 && wd.y >= 0 && wd.x + wd.w <= cols && wd.y + wd.h <= rows, `${o} ${wd.id} inside the grid`);
      assert.ok(wd.w >= WIDGET_TYPES[wd.type].min[0] && wd.h >= WIDGET_TYPES[wd.type].min[1], `${wd.id} not below min`);
    }
    assert.deepEqual(sanitizeLayout(l, o), l, `${o} survives sanitize unchanged`);
    assert.notEqual(defaultLayout(o), defaultLayout(o), 'fresh copies');
    assert.equal(layoutsEqual(l, defaultLayout(o)), true);
  }
});

test('sanitizeLayout: untrusted input is clamped, filtered and de-duplicated; non-arrays mean "no custom layout"', () => {
  for (const bad of [undefined, null, 'x', 5, {}, { 0: 1 }]) assert.equal(sanitizeLayout(bad, 'landscape'), null);
  assert.deepEqual(sanitizeLayout([], 'landscape'), [], 'an empty array is a real (empty) layout');
  const out = sanitizeLayout([
    { id: 'a', type: 'gear', x: -5, y: 999, w: 1, h: 99 },            // clamped into the grid, above the minimum
    { id: 'b', type: 'nonsense', x: 0, y: 0, w: 4, h: 4 },            // unknown type
    { type: 'gear', x: 'a', y: 0, w: 4, h: 4 },                        // not numbers
    null, 7, 'x', [],
    { id: '<script>', type: 'fuel', x: 1.4, y: 2.6, w: 9.2, h: 2 },   // bad id -> type, fractions rounded
    { id: 'gear', type: 'gear', x: 0, y: 0, w: 4, h: 4 },
    { id: 'gear', type: 'gear', x: 4, y: 4, w: 4, h: 4 },              // duplicate id
    { id: '__proto__', type: 'boost', x: 0, y: 0, w: 4, h: 2 },
    { type: 'constructor', x: 0, y: 0, w: 4, h: 4 },
  ], 'landscape');
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { id: 'a', type: 'gear', x: 0, y: 18 - 18, w: 2, h: 18 });
  assert.equal(out[1].id, 'fuel'); assert.deepEqual([out[1].x, out[1].y, out[1].w], [1, 3, 9]);
  assert.deepEqual(out.map((x) => x.id), ['a', 'fuel', 'gear', 'gear-2', 'boost'], '__proto__ is not accepted as an id');
  assert.equal(({}).polluted, undefined);
});

test('sanitizeLayout caps the number of widgets and works per orientation', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `w${i}`, type: 'clutch', x: i % 30, y: 0, w: 1, h: 3 }));
  assert.equal(sanitizeLayout(many, 'landscape').length, MAX_WIDGETS);
  const wide = [{ id: 'q', type: 'speedo', x: 40, y: 40, w: 30, h: 30 }];
  assert.deepEqual(sanitizeLayout(wide, 'landscape')[0], { id: 'q', type: 'speedo', x: 2, y: 0, w: 30, h: 18 });
  assert.deepEqual(sanitizeLayout(wide, 'portrait')[0], { id: 'q', type: 'speedo', x: 0, y: 2, w: 18, h: 30 });
});

test('edits are pure: they return a new layout and never touch the input', () => {
  const base = Object.freeze(defaultLayout('landscape').map((x) => Object.freeze({ ...x })));
  const snapshot = JSON.stringify(base);
  const moved = moveWidget(base, 'gear', 20, 9, 'landscape');
  const resized = resizeWidget(base, 'gear', 8, 8, 'landscape');
  const removed = removeWidget(base, 'gear');
  const front = bringToFront(base, 'speedo');
  const added = addWidget(base, 'compass', 'landscape');
  assert.equal(JSON.stringify(base), snapshot);
  assert.deepEqual(moved.find((x) => x.id === 'gear'), { id: 'gear', type: 'gear', x: 20, y: 9, w: 6, h: 6 });
  assert.deepEqual(resized.find((x) => x.id === 'gear'), { id: 'gear', type: 'gear', x: 13, y: 4, w: 8, h: 8 });
  assert.equal(removed.length, base.length - 1);
  assert.equal(front.at(-1).id, 'speedo');
  assert.equal(front.length, base.length);
  assert.equal(added.layout.length, base.length + 1);
  assert.equal(added.layout.at(-1), added.widget);
});

test('move and resize are clamped to the grid and the minimum size', () => {
  const l = [{ id: 'g', type: 'gear', x: 5, y: 5, w: 6, h: 6 }];
  assert.deepEqual(moveWidget(l, 'g', -10, -10, 'landscape')[0], { id: 'g', type: 'gear', x: 0, y: 0, w: 6, h: 6 });
  assert.deepEqual(moveWidget(l, 'g', 99, 99, 'landscape')[0], { id: 'g', type: 'gear', x: 26, y: 12, w: 6, h: 6 });
  assert.deepEqual(moveWidget(l, 'g', 99, 99, 'portrait')[0], { id: 'g', type: 'gear', x: 12, y: 26, w: 6, h: 6 });
  assert.deepEqual(resizeWidget(l, 'g', 0, 0, 'landscape')[0], { id: 'g', type: 'gear', x: 5, y: 5, w: 2, h: 2 });
  assert.deepEqual(resizeWidget(l, 'g', 99, 99, 'landscape')[0], { id: 'g', type: 'gear', x: 5, y: 5, w: 27, h: 13 });
  assert.equal(moveWidget(l, 'missing', 1, 1, 'landscape')[0].x, 5, 'unknown id: no change');
});

test('addWidget: first free spot, unique ids, full grid falls back to the middle, cap respected', () => {
  let l = [];
  const a = addWidget(l, 'gear', 'landscape');
  assert.deepEqual([a.widget.x, a.widget.y, a.widget.w, a.widget.h], [0, 0, 6, 6]);
  const b = addWidget(a.layout, 'gear', 'landscape');
  assert.equal(b.widget.id, 'gear-2');
  assert.deepEqual([b.widget.x, b.widget.y], [6, 0], 'next free cell, not on top of the first');
  assert.equal(addWidget(b.layout, 'bogus', 'landscape'), null);
  // a grid with no room: still adds (in the middle) rather than failing
  const full = [{ id: 'x', type: 'speedo', x: 0, y: 0, w: 32, h: 18 }];
  assert.equal(findFreeSpot(full, 6, 6, 'landscape'), null);
  const c = addWidget(full, 'gear', 'landscape');
  assert.deepEqual([c.widget.x, c.widget.y], [13, 6]);
  // the cap
  l = Array.from({ length: MAX_WIDGETS }, (_, i) => ({ id: `c${i}`, type: 'clutch', x: 0, y: 0, w: 1, h: 3 }));
  assert.equal(addWidget(l, 'gear', 'landscape'), null);
  // portrait uses the portrait default sizes
  assert.deepEqual([addWidget([], 'speedo', 'portrait').widget.w, addWidget([], 'speedo', 'portrait').widget.h], [14, 14]);
});

test('hitTest: top widget wins; corner buttons beat the body; empty space is null', () => {
  const l = [
    { id: 'under', type: 'speedo', x: 0, y: 0, w: 12, h: 12 },
    { id: 'over', type: 'gear', x: 4, y: 4, w: 6, h: 6 },
  ];
  const W = 800, H = 450;                                         // 25 px cells
  assert.deepEqual(hitTest(l, 'landscape', 150, 150, W, H), { id: 'over', part: 'body' });
  assert.deepEqual(hitTest(l, 'landscape', 20, 20, W, H), { id: 'under', part: 'body' });
  const r = rectOf(l[1], 'landscape', W, H);
  const hs = handleSize(r);
  assert.deepEqual(hitTest(l, 'landscape', r.x + r.w - 3, r.y + 3, W, H), { id: 'over', part: 'remove' });
  assert.deepEqual(hitTest(l, 'landscape', r.x + r.w - 3, r.y + r.h - 3, W, H), { id: 'over', part: 'resize' });
  assert.deepEqual(hitTest(l, 'landscape', r.x + r.w - hs - 4, r.y + r.h - 3, W, H), { id: 'over', part: 'body' });
  assert.equal(hitTest(l, 'landscape', 700, 400, W, H), null);
  assert.equal(hitTest([], 'landscape', 1, 1, W, H), null);
  assert.ok(handleSize({ w: 20, h: 20 }) >= 12 && handleSize({ w: 900, h: 900 }) <= 26);
});

test('geometry helpers', () => {
  const r = rectOf({ x: 4, y: 3, w: 8, h: 6 }, 'landscape', 640, 360);
  assert.deepEqual(r, { x: 80, y: 60, w: 160, h: 120 });
  assert.deepEqual(rectOf({ x: 9, y: 16, w: 9, h: 16 }, 'portrait', 360, 640), { x: 180, y: 320, w: 180, h: 320 });
  assert.deepEqual(cellsFor('landscape', 800, 450, 60, -30), { dx: 2, dy: -1 });
  assert.deepEqual(cellsFor('landscape', 800, 450, 12, 12), { dx: 0, dy: 0 }, 'less than half a cell: no move');
  assert.equal(orientationFor(800, 450), 'landscape');
  assert.equal(orientationFor(375, 812), 'portrait');
  assert.equal(orientationFor(500, 500), 'portrait', 'a square counts as portrait');
  assert.equal(layoutsEqual([{ id: 'a', type: 'gear', x: 0, y: 0, w: 2, h: 2 }], [{ id: 'a', type: 'gear', x: 1, y: 0, w: 2, h: 2 }]), false);
  assert.equal(layoutsEqual(null, []), false);
});
