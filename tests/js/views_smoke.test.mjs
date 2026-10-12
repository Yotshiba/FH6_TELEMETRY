// Smoke tests for the canvas views: build each one against a stub DOM + the server's real "hello" payload
// (tests/js/hello.json, regenerate with tools/dump_hello_fixture.py), feed it a few seconds of plausible rows and
// call update() every frame.  A view that throws at runtime but still parses (a swallowed '+', a wrong field name,
// a null deref on the first frame) cannot hide from this.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCockpit } from '../../fh6_telemetry/web/static/view_cockpit.js';
import { buildMap } from '../../fh6_telemetry/web/static/view_map.js';
import { buildLab } from '../../fh6_telemetry/web/static/view_lab.js';
import { buildCar } from '../../fh6_telemetry/web/static/view_car.js';
import { buildTimeline } from '../../fh6_telemetry/web/static/view_timeline.js';
import { buildViews } from '../../fh6_telemetry/web/static/views.js';
import { El, HELLO, IMPERIAL, drive, fastRow, installDom, removeDom, setup, slowRow } from './helpers/stubdom.mjs';


const BUILDERS = { cockpit: buildCockpit, map: buildMap, lab: buildLab, chassis: buildCar, timeline: buildTimeline };

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
