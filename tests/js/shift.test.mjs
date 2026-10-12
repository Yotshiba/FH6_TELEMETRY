import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHIFT, shiftLevel, rpmRatio, ShiftCue } from '../../fh6_telemetry/web/static/shift.js';

const MAX = 10000;
const at = (ratio, cfg) => shiftLevel(ratio * MAX, MAX, cfg);

test('DEFAULT_SHIFT has the documented values', () => {
  assert.deepEqual({ ...DEFAULT_SHIFT }, { leds: 15, start: 0.70, yellow: 0.82, red: 0.90, flash: 0.965, beep: 0.94 });
});

test('rpmRatio clamps to 0..1.2 and survives bad input', () => {
  assert.equal(rpmRatio(5000, 10000), 0.5);
  assert.equal(rpmRatio(-100, 10000), 0);
  assert.equal(rpmRatio(50000, 10000), 1.2);
  for (const [a, b] of [[NaN, 100], [100, NaN], [100, 0], [100, -5], [undefined, 100], [100, Infinity]]) {
    assert.equal(rpmRatio(a, b), 0, `${a},${b}`);
  }
});

test('lit is 0 at and below start, leds at and above red, linear in between', () => {
  assert.equal(at(0).lit, 0);
  assert.equal(at(0.5).lit, 0);
  assert.equal(at(0.7).lit, 0);
  assert.equal(at(0.7001).lit, 0);
  assert.equal(at(0.9).lit, 15);
  assert.equal(at(0.95).lit, 15);
  assert.equal(at(1.2).lit, 15);
  // 15 LEDs between 0.70 and 0.90: one LED per 0.01333
  assert.equal(at(0.7133).lit, 0);
  assert.equal(at(0.7134).lit, 1);
  assert.equal(at(0.80).lit, 7);
  assert.equal(at(0.85).lit, 11);
  assert.equal(at(0.8999).lit, 14);
  let prev = 0;
  for (let r = 0; r <= 1.2; r += 0.001) {
    const { lit } = at(r);
    assert.ok(lit >= prev, `monotonic at ${r}`);
    prev = lit;
  }
  assert.equal(prev, 15);
});

test('ratio is reported and clamped', () => {
  assert.equal(at(0.5).ratio, 0.5);
  assert.equal(at(2).ratio, 1.2);
  assert.equal(shiftLevel(-5, MAX).ratio, 0);
});

test('flashing from cfg.flash on; zones turn blue', () => {
  const below = at(0.9649);
  assert.equal(below.flashing, false);
  assert.equal(below.zones.includes('b'), false);
  const on = at(0.965);
  assert.equal(on.flashing, true);
  assert.equal(on.lit, 15);
  assert.equal(on.zones.length, 15);
  assert.ok(on.zones.every((z) => z === 'b'));
});

test('zones: 40 % green, 40 % yellow, 20 % red', () => {
  const z = at(0.5).zones;
  assert.equal(z.length, 15);
  assert.equal(z.join(''), 'g'.repeat(6) + 'y'.repeat(6) + 'r'.repeat(3));
  assert.equal(shiftLevel(0, MAX, { leds: 10 }).zones.join(''), 'g'.repeat(4) + 'y'.repeat(4) + 'r'.repeat(2));
  assert.equal(shiftLevel(0, MAX, { leds: 20 }).zones.join(''), 'g'.repeat(8) + 'y'.repeat(8) + 'r'.repeat(4));
  assert.equal(shiftLevel(0, MAX, { leds: 5 }).zones.join(''), 'ggyyr');
  assert.equal(shiftLevel(0, MAX, { leds: 3 }).zones.join(''), 'gyr');
});

test('zones are sensible for every LED count', () => {
  for (let n = 1; n <= 64; n++) {
    const z = shiftLevel(0, MAX, { leds: n }).zones;
    assert.equal(z.length, n);
    assert.ok(z.every((c) => 'gyr'.includes(c)));
    assert.equal(z[n - 1], 'r', `last LED is red for ${n}`);
    // ordered g* y* r*
    assert.match(z.join(''), /^g*y*r*$/);
    if (n >= 3) {
      for (const c of 'gyr') assert.ok(z.includes(c), `${c} present for ${n}`);
    }
    const share = (c) => z.filter((x) => x === c).length / n;
    if (n >= 10) {
      near(share('g'), 0.4, 0.1);
      near(share('r'), 0.2, 0.1);
    }
  }
  function near(a, b, tol) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }
});

test('zones arrays are frozen and shared, so consumers cannot corrupt them', () => {
  const z = at(0.5).zones;
  assert.throws(() => { 'use strict'; z[0] = 'x'; });
  assert.equal(at(0.6).zones, z);
});

test('custom config is honoured and partial config falls back to the defaults', () => {
  const cfg = { leds: 8, start: 0.5, red: 0.9, flash: 0.99 };
  assert.equal(at(0.5, cfg).lit, 0);
  assert.equal(at(0.7, cfg).lit, 4);
  assert.equal(at(0.9, cfg).lit, 8);
  assert.equal(at(0.9, cfg).zones.length, 8);
  assert.equal(at(0.98, cfg).flashing, false);
  assert.equal(at(0.99, cfg).flashing, true);
  assert.equal(at(0.8, {}).lit, 7);
  assert.equal(at(0.8, null).lit, 7);
  assert.equal(at(0.8, { leds: NaN, start: 'x' }).lit, 7);
});

test('degenerate configs do not divide by zero or throw', () => {
  assert.equal(at(0.8, { start: 0.9, red: 0.9 }).lit, 0);
  assert.equal(at(0.95, { start: 0.9, red: 0.9 }).lit, 15);
  assert.equal(at(0.95, { start: 0.9, red: 0.8 }).lit, 15);
  assert.equal(shiftLevel(5000, MAX, { leds: 0 }).zones.length, 1);
  assert.equal(shiftLevel(5000, MAX, { leds: 1e9 }).zones.length, 64);
  assert.equal(shiftLevel(5000, MAX, { leds: 7.9 }).zones.length, 7);
});

test('maxRpm <= 0 and bad input switch everything off', () => {
  for (const [rpm, max] of [[5000, 0], [5000, -1], [NaN, 8000], [5000, NaN], [undefined, undefined], [1e9, 0]]) {
    const s = shiftLevel(rpm, max);
    assert.equal(s.lit, 0);
    assert.equal(s.flashing, false);
    assert.equal(s.ratio, 0);
    assert.equal(s.zones.length, 15);
    assert.equal(s.zones.includes('b'), false);
  }
});

test('lit stays within 0..leds at floating point edges', () => {
  for (const max of [6000, 7777, 8123, 9500, 12000]) {
    for (let rpm = 0; rpm <= max * 1.3; rpm += 7) {
      const { lit } = shiftLevel(rpm, max);
      assert.ok(Number.isInteger(lit) && lit >= 0 && lit <= 15);
    }
  }
  // exactly on a boundary: ratio == red must be fully lit, ratio == start must be dark
  assert.equal(shiftLevel(9000, 10000).lit, 15);
  assert.equal(shiftLevel(7000, 10000).lit, 0);
  assert.equal(shiftLevel(8100, 9000).lit, 15);
});

// ---- ShiftCue ---------------------------------------------------------------------------------------------------

test('cue fires once when the ratio crosses up through beep', () => {
  const c = new ShiftCue();
  assert.equal(c.update(5000, MAX, 0), false);
  assert.equal(c.update(9300, MAX, 0.1), false);
  assert.equal(c.update(9400, MAX, 0.2), true);
  assert.equal(c.update(9500, MAX, 0.3), false);
  assert.equal(c.update(9800, MAX, 0.4), false);
  assert.equal(c.update(9990, MAX, 5), false);
});

test('cue re-arms below beep - 0.05 (not before)', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 0), true);
  assert.equal(c.update(8950, MAX, 1), false);        // above 0.89: still not re-armed
  assert.equal(c.update(9500, MAX, 2), false);
  assert.equal(c.update(8899, MAX, 3), false);        // below 0.89: re-armed
  assert.equal(c.update(9400, MAX, 4), true);
});

test('cue refractory: at least 0.4 s between cues', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 10), true);
  assert.equal(c.update(5000, MAX, 10.125), false);   // re-armed
  assert.equal(c.update(9500, MAX, 10.375), false);   // 0.375 s since the last cue: swallowed
  assert.equal(c.update(5000, MAX, 10.5), false);
  assert.equal(c.update(9500, MAX, 10.875), true);    // 0.875 s: fine
  assert.equal(c.update(5000, MAX, 10.9375), false);
  assert.equal(c.update(9500, MAX, 11.25), false);    // 0.375 s again
  assert.equal(c.update(5000, MAX, 11.3125), false);
  assert.equal(c.update(9500, MAX, 11.3125 + 0.125 + 0.25), true);   // 0.5 s since the last cue
});

test('a crossing swallowed by the refractory does not beep late', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 0), true);
  assert.equal(c.update(5000, MAX, 0.05), false);
  assert.equal(c.update(9500, MAX, 0.1), false);
  assert.equal(c.update(9600, MAX, 2), false);        // still above beep, still the same crossing
});

test('cue uses cfg.beep and the default config when none is given', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9000, MAX, 0, { beep: 0.95 }), false);
  assert.equal(c.update(9500, MAX, 0.1, { beep: 0.95 }), true);
  const d = new ShiftCue();
  assert.equal(d.update(9399, MAX, 0), false);
  assert.equal(d.update(9400, MAX, 1), true);
  const e = new ShiftCue();
  assert.equal(e.update(9400, MAX, 1, null), true);
  const f = new ShiftCue();
  assert.equal(f.update(9400, MAX, 1, { beep: NaN }), true);
});

test('cue copes with bad input: max rpm 0 re-arms, NaN time never throws', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 0), true);
  assert.equal(c.update(9500, 0, 1), false);          // menu: ratio 0 -> re-armed
  assert.equal(c.update(9500, MAX, 2), true);
  assert.equal(c.update(NaN, NaN, NaN), false);
  const d = new ShiftCue();
  assert.equal(d.update(9500, MAX, NaN), true);       // no usable clock: do not suppress the cue
  assert.equal(d.update(5000, MAX, NaN), false);
  assert.equal(d.update(9500, MAX, 3), true);
});

test('cue copes with the clock going backwards', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 100), true);
  assert.equal(c.update(5000, MAX, 100.5), false);
  assert.equal(c.update(9500, MAX, 1), true);         // new session, clock restarted
});

test('cue reset re-arms and forgets the refractory', () => {
  const c = new ShiftCue();
  assert.equal(c.update(9500, MAX, 0), true);
  c.reset();
  assert.equal(c.update(9500, MAX, 0.05), true);
});
