import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GearTracker, gearLabel } from '../../fh6_telemetry/web/static/format.js';
import { Store } from '../../fh6_telemetry/web/static/store.js';

const HELLO = JSON.parse(readFileSync(new URL('./hello.json', import.meta.url), 'utf-8'));
const LAB = HELLO.lab;

test('the gear table is 1-based: code n is gear n, 0 is reverse (regression: it used to show n-1 and an "N" for 1st)', () => {
  assert.equal(LAB.gear['0'], 'R');
  for (let g = 1; g <= 10; g++) assert.equal(LAB.gear[String(g)], String(g));
  assert.equal(Object.values(LAB.gear).includes('N'), false);
  assert.deepEqual(LAB.neutral, { code: 11, holdMs: 250 });
  assert.equal(gearLabel(LAB, 1, ''), '1');
  assert.equal(gearLabel(LAB, 6, ''), '6');
  assert.equal(gearLabel(LAB, 11, '4'), '4');           // the neutral transient holds the previous label
});

test('a shift (5, one neutral packet, 6) never flashes N', () => {
  const g = new GearTracker();
  const seen = [];
  let t = 1000;
  for (const code of [5, 5, 5, 11, 6, 6]) { seen.push(g.update(LAB, code, t)); t += 13; }
  assert.deepEqual(seen, ['5', '5', '5', '5', '6', '6']);
});

test('real neutral shows N once it lasts, and a real gear replaces it at once', () => {
  const g = new GearTracker();
  g.update(LAB, 2, 0);
  const labels = [];
  for (let t = 1000; t <= 1400; t += 50) labels.push(g.update(LAB, 11, t));
  assert.deepEqual(labels.slice(0, 5), ['2', '2', '2', '2', '2']);          // 0..200 ms
  assert.equal(labels.at(-1), 'N');                                       // >= 250 ms
  assert.equal(g.update(LAB, 1, 1450), '1');
  assert.equal(g.update(LAB, 0, 1500), 'R');
});

test('edge cases: first row neutral, no clock, unknown codes, clock restart and u32 wrap', () => {
  assert.equal(new GearTracker().update(LAB, 11, 5), 'N');
  assert.equal(new GearTracker().update(LAB, 99, 5), '99');
  const g = new GearTracker();
  g.update(LAB, 3, 0);
  assert.equal(g.update(LAB, 99, 1), '3');
  assert.equal(g.update(LAB, 11, undefined), '3');                       // no clock: never promoted
  assert.equal(g.update(LAB, 11, 5000), '3');
  assert.equal(g.update(LAB, 11, 4000), '3');                            // the clock went backwards: timer restarts
  assert.equal(g.update(LAB, 11, 4250), 'N');
  const w = new GearTracker();
  w.update(LAB, 4, 0xFFFFFF00);
  w.update(LAB, 11, 0xFFFFFF80);
  assert.equal(w.update(LAB, 11, (0xFFFFFF80 + 250) % 2 ** 32), 'N');       // 250 ms later, the clock having wrapped to a small number
  const w2 = new GearTracker();
  w2.update(LAB, 4, 0xFFFFFF00);
  w2.update(LAB, 11, 0xFFFFFFF0);
  assert.equal(w2.update(LAB, 11, 0xEA), 'N');                           // 0xFFFFFFF0 + 250 wrapped
  const old = new GearTracker();
  assert.equal(old.update({ gear: { 3: '3' } }, 11, 1), 'N');            // a hello without the neutral entry uses 11 / 250
});

test('Store keeps the label row by row: the one-packet neutral between two real rows never reaches the screen', () => {
  const st = new Store();
  st.setHello(HELLO);
  const row = (code, ts, race = 1) => {
    const r = new Array(HELLO.F.length).fill(0);
    r[st.F.IsRaceOn] = race; r[st.F.Gear] = code; r[st.F.TimestampMS] = ts;
    return r;
  };
  const shown = [];
  for (const [code, ts] of [[5, 0], [5, 13], [11, 26], [6, 39], [6, 52]]) {
    st.pushRows([row(code, ts)]);
    shown.push(st.gear);
  }
  assert.deepEqual(shown, ['5', '5', '5', '6', '6']);
  st.pushRows([row(0, 100, 0)]);                                          // menus / paused: the label is left alone
  assert.equal(st.gear, '6');
  st.setHello({ ...HELLO, epoch: 2 });                                    // a new source resets the display
  assert.equal(st.gear, '');
});
