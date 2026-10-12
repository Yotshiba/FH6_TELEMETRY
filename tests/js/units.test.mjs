import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_CHOICES, UNIT_PRESETS, defaultUnits, normalizeUnits, matchPreset, nextUnit,
  conv, inv, label, fmt, chartTransform, identity,
} from '../../fh6_telemetry/web/static/units.js';

const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);

const IMPERIAL = { speed: 'mph', temp: 'f', pressure: 'psi', power: 'kw', torque: 'lbft', dist: 'mi' };

// --- choices / defaults / normalize ------------------------------------------------------------

test('UNIT_CHOICES lists the expected options', () => {
  assert.deepEqual(UNIT_CHOICES, {
    speed: ['kmh', 'mph'], temp: ['c', 'f'], pressure: ['bar', 'psi'],
    power: ['hp', 'kw', 'ps'], torque: ['nm', 'lbft'], dist: ['km', 'mi'],
  });
});

test('defaultUnits is metric and returns a fresh object each time', () => {
  const a = defaultUnits();
  assert.deepEqual(a, { speed: 'kmh', temp: 'c', pressure: 'bar', power: 'hp', torque: 'nm', dist: 'km' });
  a.speed = 'mph';
  assert.equal(defaultUnits().speed, 'kmh');
});

test('normalizeUnits keeps valid fields and defaults the rest', () => {
  assert.deepEqual(normalizeUnits({ speed: 'mph', temp: 'f' }), { ...defaultUnits(), speed: 'mph', temp: 'f' });
  assert.deepEqual(normalizeUnits(IMPERIAL), IMPERIAL);
});

test('normalizeUnits survives garbage', () => {
  const d = defaultUnits();
  for (const bad of [null, undefined, 0, 1, NaN, 'mph', '{"speed":"mph"}', true, [], ['mph'], () => 1, Symbol('x')]) {
    assert.deepEqual(normalizeUnits(bad), d, String(typeof bad));
  }
  assert.deepEqual(normalizeUnits({ speed: 'knots', temp: 5, pressure: null, power: {}, torque: ['nm'], dist: 'MI' }), d);
  assert.deepEqual(normalizeUnits({ speed: 'mph', bogus: 'x', __proto__: { temp: 'f' } }).temp, 'f'); // inherited is fine
  assert.equal('bogus' in normalizeUnits({ bogus: 1 }), false);
});

test('normalizeUnits returns a new object and never mutates its input', () => {
  const src = Object.freeze({ speed: 'mph' });
  const out = normalizeUnits(src);
  assert.notEqual(out, src);
  assert.equal(src.temp, undefined);
  const full = { ...IMPERIAL };
  assert.notEqual(normalizeUnits(full), full);
});

test('presets and matchPreset', () => {
  assert.equal(matchPreset(defaultUnits()), 'metric');
  assert.equal(matchPreset(UNIT_PRESETS.imperial), 'imperial');
  assert.equal(matchPreset({ ...UNIT_PRESETS.imperial, temp: 'c' }), 'custom');
  assert.equal(matchPreset(null), 'metric');
  assert.equal(matchPreset({ speed: 'mph' }), 'custom');
  // the exported presets are not the live objects callers mutate
  assert.throws(() => { 'use strict'; UNIT_PRESETS.metric.speed = 'mph'; }, TypeError);
});

test('nextUnit cycles and wraps', () => {
  assert.equal(nextUnit('speed', 'kmh'), 'mph');
  assert.equal(nextUnit('speed', 'mph'), 'kmh');
  assert.equal(nextUnit('power', 'hp'), 'kw');
  assert.equal(nextUnit('power', 'kw'), 'ps');
  assert.equal(nextUnit('power', 'ps'), 'hp');
  assert.equal(nextUnit('power', 'bogus'), 'hp');
  assert.equal(nextUnit('nope', 'x'), 'x');
  assert.equal(nextUnit('constructor', 'x'), 'x');
  assert.equal(nextUnit('toString', 'x'), 'x');
});

// --- converters: exact values ------------------------------------------------------------------------

test('speed conversion', () => {
  assert.equal(conv.speed(100, 'kmh'), 100);
  near(conv.speed(100, 'mph'), 62.1371);
  near(conv.speed(160.9344, 'mph'), 100, 1e-9);
  assert.equal(conv.speed(0, 'mph'), 0);
  near(conv.speed(-100, 'mph'), -62.1371);
});

test('temperature conversion', () => {
  assert.equal(conv.temp(100, 'c'), 100);
  near(conv.temp(100, 'f'), 212, 1e-9);
  near(conv.temp(0, 'f'), 32, 1e-9);
  near(conv.temp(-40, 'f'), -40, 1e-9);
});

test('pressure conversion', () => {
  assert.equal(conv.pressure(1, 'bar'), 1);
  near(conv.pressure(1, 'psi'), 14.5038, 1e-4);
  near(conv.pressure(2.5, 'psi'), 36.2594, 1e-3);
});

test('power conversion', () => {
  assert.equal(conv.power(100, 'hp'), 100);
  near(conv.power(100, 'kw'), 74.57, 1e-3);
  near(conv.power(100, 'ps'), 101.386967, 1e-6);
  near(conv.power(1000, 'kw'), 745.699872, 1e-6);
});

test('torque conversion', () => {
  assert.equal(conv.torque(100, 'nm'), 100);
  near(conv.torque(100, 'lbft'), 73.7562, 1e-4);
});

test('distance conversion (metres -> km / miles)', () => {
  assert.equal(conv.dist(1000, 'km'), 1);
  assert.equal(conv.dist(2500, 'km'), 2.5);
  near(conv.dist(1609.344, 'mi'), 1, 1e-12);
  near(conv.dist(5000, 'mi'), 3.10686, 1e-5);
});

test('converters accept a whole units object or a bare unit string', () => {
  assert.equal(conv.speed(100, IMPERIAL), conv.speed(100, 'mph'));
  assert.equal(conv.temp(50, IMPERIAL), conv.temp(50, 'f'));
  assert.equal(conv.power(100, IMPERIAL), conv.power(100, 'kw'));
  // a unit string that belongs to another quantity is invalid -> default
  assert.equal(conv.speed(100, 'psi'), 100);
});

test('converters fall back to metric for bad unit arguments', () => {
  for (const bad of [undefined, null, 5, {}, [], 'wat', { speed: 'nope' }]) {
    assert.equal(conv.speed(77, bad), 77);
    assert.equal(conv.temp(77, bad), 77);
    assert.equal(conv.pressure(77, bad), 77);
    assert.equal(conv.power(77, bad), 77);
    assert.equal(conv.torque(77, bad), 77);
    assert.equal(conv.dist(1000, bad), 1);
  }
});

test('converters turn non-numbers into NaN, never throw', () => {
  for (const bad of [undefined, null, 'abc', {}, NaN]) {
    assert.ok(Number.isNaN(conv.speed(bad, 'mph')));
    assert.ok(Number.isNaN(conv.temp(bad, 'f')));
    assert.ok(Number.isNaN(conv.power(bad, 'kw')));
  }
  assert.equal(conv.speed(Infinity, 'mph'), Infinity);
});

test('inv is the inverse of conv for every quantity and unit', () => {
  const vals = [-12.5, 0, 1, 37.25, 100, 812.4];
  for (const kind of Object.keys(UNIT_CHOICES)) {
    for (const unit of UNIT_CHOICES[kind]) {
      for (const v of vals) {
        near(inv[kind](conv[kind](v, unit), unit), v, 1e-9);
      }
    }
  }
  near(inv.speed(100, 'mph'), 160.9344, 1e-9);
  near(inv.temp(212, 'f'), 100, 1e-12);
});

// --- labels -----------------------------------------------------------------------------------------------

test('unit labels', () => {
  assert.equal(label.speed('kmh'), 'km/h');
  assert.equal(label.speed('mph'), 'mph');
  assert.equal(label.temp('c'), '°C');
  assert.equal(label.temp('f'), '°F');
  assert.equal(label.pressure('bar'), 'bar');
  assert.equal(label.pressure('psi'), 'psi');
  assert.equal(label.power('hp'), 'hp');
  assert.equal(label.power('kw'), 'kW');
  assert.equal(label.power('ps'), 'PS');
  assert.equal(label.torque('nm'), 'Nm');
  assert.equal(label.torque('lbft'), 'lb-ft');
  assert.equal(label.dist('km'), 'km');
  assert.equal(label.dist('mi'), 'mi');
  assert.equal(label.speed(IMPERIAL), 'mph');
  assert.equal(label.power(IMPERIAL), 'kW');
  assert.equal(label.speed(undefined), 'km/h');
  assert.equal(label.power('bogus'), 'hp');
});

// --- formatting -----------------------------------------------------------------------------------------------

test('fmt.speed / speedUnit', () => {
  assert.equal(fmt.speed(123.4, 'kmh'), '123');
  assert.equal(fmt.speed(123.6, 'kmh'), '124');
  assert.equal(fmt.speed(100, 'mph'), '62');
  assert.equal(fmt.speed(100, 'mph', 2), '62.14');
  assert.equal(fmt.speedUnit(123, 'kmh'), '123 km/h');
  assert.equal(fmt.speedUnit(100, IMPERIAL), '62 mph');
  assert.equal(fmt.speedUnit(100, 'mph', 1), '62.1 mph');
});

test('fmt numeric helpers handle junk without printing NaN or -0', () => {
  assert.equal(fmt.speed(NaN, 'kmh'), '0');
  assert.equal(fmt.speed(undefined, 'mph'), '0');
  assert.equal(fmt.speed(Infinity, 'kmh'), '0');
  assert.equal(fmt.speed(-0.4, 'kmh'), '0');
  assert.equal(fmt.speed(-0.4, 'kmh', 1), '-0.4');
  assert.equal(fmt.speed(-0.04, 'kmh', 1), '0.0');
  assert.equal(fmt.speed(12, 'kmh', -1), '12');       // bad digits -> default
  assert.equal(fmt.speed(12, 'kmh', 1.5), '12');
  assert.equal(fmt.speed(12, 'kmh', 'x'), '12');
  assert.equal(fmt.speed(12, 'kmh', 999), '12');
});

test('fmt.temp', () => {
  assert.equal(fmt.temp(100, 'c'), '100');
  assert.equal(fmt.temp(100, 'f'), '212');
  assert.equal(fmt.temp(85.56, 'c', 1), '85.6');
  assert.equal(fmt.temp(36.6, 'f', 1), '97.9');
  assert.equal(fmt.tempUnit(90, 'f'), '194 °F');
  assert.equal(fmt.tempUnit(90, 'c'), '90 °C');
});

test('fmt.pressure default digits depend on the unit', () => {
  assert.equal(fmt.pressure(1.5, 'bar'), '1.50');
  assert.equal(fmt.pressure(1.5, 'psi'), '21.8');
  assert.equal(fmt.pressure(1.5, 'psi', 0), '22');
  assert.equal(fmt.pressureUnit(2, 'bar'), '2.00 bar');
  assert.equal(fmt.pressureUnit(1, 'psi'), '14.5 psi');
});

test('fmt.power / torque', () => {
  assert.equal(fmt.power(500, 'hp'), '500');
  assert.equal(fmt.power(500, 'kw'), '373');
  assert.equal(fmt.power(500, 'ps'), '507');
  assert.equal(fmt.powerUnit(500, 'kw'), '373 kW');
  assert.equal(fmt.torque(500, 'nm'), '500');
  assert.equal(fmt.torque(500, 'lbft'), '369');
  assert.equal(fmt.torqueUnit(500, 'lbft'), '369 lb-ft');
  assert.equal(fmt.torqueUnit(500, IMPERIAL), '369 lb-ft');
});

test('fmt.dist / distUnit', () => {
  assert.equal(fmt.dist(12345, 'km'), '12.35');
  assert.equal(fmt.dist(1609.344, 'mi'), '1.00');
  assert.equal(fmt.distUnit(12345, 'km'), '12.35 km');
  assert.equal(fmt.distUnit(1609.344, 'mi', 1), '1.0 mi');
});

test('fmt.distShort metric', () => {
  assert.equal(fmt.distShort(402, 'km'), '402 m');
  assert.equal(fmt.distShort(402.4, 'km'), '402 m');
  assert.equal(fmt.distShort(0, 'km'), '0 m');
  assert.equal(fmt.distShort(999, 'km'), '999 m');
  assert.equal(fmt.distShort(999.4, 'km'), '999 m');
  assert.equal(fmt.distShort(999.6, 'km'), '1.00 km');   // rounded value reaches 1000
  assert.equal(fmt.distShort(1000, 'km'), '1.00 km');
  assert.equal(fmt.distShort(1500, 'km'), '1.50 km');
  assert.equal(fmt.distShort(12345, 'km'), '12.35 km');
  assert.equal(fmt.distShort(-0.2, 'km'), '0 m');
  assert.equal(fmt.distShort(NaN, 'km'), '0 m');
  assert.equal(fmt.distShort(undefined, undefined), '0 m');
});

test('fmt.distShort imperial', () => {
  assert.equal(fmt.distShort(402, 'mi'), '1319 ft');          // 402 m = 1318.9 ft
  assert.equal(fmt.distShort(402.336, 'mi'), '1320 ft');      // exactly a quarter mile
  assert.equal(fmt.distShort(0, 'mi'), '0 ft');
  assert.equal(fmt.distShort(804, 'mi'), '2638 ft');
  assert.equal(fmt.distShort(804.672, 'mi'), '0.50 mi');      // exactly half a mile
  assert.equal(fmt.distShort(1609.344, 'mi'), '1.00 mi');
  assert.equal(fmt.distShort(10000, 'mi'), '6.21 mi');
  assert.equal(fmt.distShort(Infinity, IMPERIAL), '0 ft');
});

test('fmt.lapTime', () => {
  assert.equal(fmt.lapTime(0), '--:--.---');
  assert.equal(fmt.lapTime(-5), '--:--.---');
  assert.equal(fmt.lapTime(NaN), '--:--.---');
  assert.equal(fmt.lapTime(Infinity), '--:--.---');
  assert.equal(fmt.lapTime(undefined), '--:--.---');
  assert.equal(fmt.lapTime('90000'), '--:--.---');
  assert.equal(fmt.lapTime(1), '0:00.001');
  assert.equal(fmt.lapTime(999), '0:00.999');
  assert.equal(fmt.lapTime(1000), '0:01.000');
  assert.equal(fmt.lapTime(59999), '0:59.999');
  assert.equal(fmt.lapTime(60000), '1:00.000');
  assert.equal(fmt.lapTime(83456), '1:23.456');
  assert.equal(fmt.lapTime(83456.4), '1:23.456');
  assert.equal(fmt.lapTime(83456.6), '1:23.457');
  assert.equal(fmt.lapTime(599999.7), '10:00.000');
  assert.equal(fmt.lapTime(3_723_004), '62:03.004');
});

test('fmt.delta is always signed with three decimals', () => {
  assert.equal(fmt.delta(0.123), '+0.123');
  assert.equal(fmt.delta(-1.204), '-1.204');
  assert.equal(fmt.delta(0), '±0.000');
  assert.equal(fmt.delta(-0), '±0.000');
  assert.equal(fmt.delta(0.0004), '±0.000');
  assert.equal(fmt.delta(-0.0004), '±0.000');
  assert.equal(fmt.delta(0.001), '+0.001');
  assert.equal(fmt.delta(-0.001), '-0.001');
  assert.equal(fmt.delta(12), '+12.000');
  assert.equal(fmt.delta(-61.5), '-61.500');
  assert.equal(fmt.delta(NaN), '--.---');
  assert.equal(fmt.delta(Infinity), '--.---');
  assert.equal(fmt.delta(null), '--.---');
  assert.equal(fmt.delta('1'), '--.---');
});

// --- chartTransform --------------------------------------------------------------------------------------

const CHART_LINES = {
  engine_rpm: 2, engine_power_torque: 2, tyre_temp: 4,
  inputs_throttle_brake: 2, motion_suspension: 4, motion_speed: 1,
};

function allUnitCombos() {
  const out = [];
  for (const speed of UNIT_CHOICES.speed) for (const temp of UNIT_CHOICES.temp) {
    for (const pressure of UNIT_CHOICES.pressure) for (const power of UNIT_CHOICES.power) {
      for (const torque of UNIT_CHOICES.torque) for (const dist of UNIT_CHOICES.dist) {
        out.push({ speed, temp, pressure, power, torque, dist });
      }
    }
  }
  return out;
}

test('chartTransform: one function per line, all strictly increasing, for every unit combo', () => {
  const probes = [-300, -40, -1, 0, 0.5, 1, 20, 100, 350, 1000, 12345];
  for (const u of allUnitCombos()) {
    for (const [id, lines] of Object.entries(CHART_LINES)) {
      const t = chartTransform(id, u);
      assert.equal(t.fns.length, lines, id);
      for (const fn of t.fns) {
        assert.equal(typeof fn, 'function');
        let prev = -Infinity;
        for (const p of probes) {
          const y = fn(p);
          assert.ok(Number.isFinite(y));
          assert.ok(y > prev, `${id} ${JSON.stringify(u)} not increasing at ${p}`);
          prev = y;
        }
      }
    }
  }
});

test('chartTransform: labels and conversions in metric', () => {
  const m = defaultUnits();
  assert.deepEqual(chartTransform('engine_rpm', m).unit, null);
  assert.equal(chartTransform('engine_power_torque', m).unit, 'hp / Nm');
  assert.equal(chartTransform('tyre_temp', m).unit, '°C');
  assert.equal(chartTransform('inputs_throttle_brake', m).unit, null);
  assert.equal(chartTransform('motion_suspension', m).unit, null);
  assert.equal(chartTransform('motion_speed', m).unit, 'km/h');
  for (const id of Object.keys(CHART_LINES)) {
    for (const fn of chartTransform(id, m).fns) assert.equal(fn, identity);
  }
});

test('chartTransform: labels and conversions in imperial', () => {
  const t = (id) => chartTransform(id, IMPERIAL);
  assert.equal(t('engine_power_torque').unit, 'kW / lb-ft');
  near(t('engine_power_torque').fns[0](100), 74.57, 1e-3);
  near(t('engine_power_torque').fns[1](100), 73.7562, 1e-4);
  assert.equal(t('tyre_temp').unit, '°F');
  for (const fn of t('tyre_temp').fns) near(fn(100), 212, 1e-9);
  assert.equal(t('motion_speed').unit, 'mph');
  near(t('motion_speed').fns[0](100), 62.1371, 1e-4);
  // unaffected charts stay identity with the server's unit text
  assert.equal(t('engine_rpm').unit, null);
  assert.equal(t('inputs_throttle_brake').unit, null);
  assert.equal(t('motion_suspension').unit, null);
  for (const id of ['engine_rpm', 'inputs_throttle_brake', 'motion_suspension']) {
    for (const fn of t(id).fns) assert.equal(fn(0.37), 0.37);
  }
});

test('chartTransform: power/torque labels follow each unit independently', () => {
  assert.equal(chartTransform('engine_power_torque', { power: 'ps' }).unit, 'PS / Nm');
  assert.equal(chartTransform('engine_power_torque', { torque: 'lbft' }).unit, 'hp / lb-ft');
  assert.equal(chartTransform('engine_power_torque', { power: 'kw', torque: 'lbft' }).unit, 'kW / lb-ft');
  const t = chartTransform('engine_power_torque', { power: 'ps' });
  near(t.fns[0](100), 101.386967, 1e-6);
  assert.equal(t.fns[1], identity);
});

test('chartTransform: unknown ids and non-string ids are identity-like', () => {
  for (const id of ['nope', '', 'ENGINE_RPM', undefined, null, 7, {}]) {
    const t = chartTransform(id, IMPERIAL);
    assert.equal(t.unit, null);
    assert.deepEqual([...t.fns], []);
  }
});

test('chartTransform: garbage units behave like metric', () => {
  for (const bad of [undefined, null, 'mph', 42, { speed: 'warp' }]) {
    assert.equal(chartTransform('motion_speed', bad).unit, 'km/h');
    assert.equal(chartTransform('motion_speed', bad).fns[0](88), 88);
    assert.equal(chartTransform('engine_power_torque', bad).unit, 'hp / Nm');
  }
});

test('chartTransform: memoised and immutable, snapshots the units it was given', () => {
  const u = { ...IMPERIAL };
  const a = chartTransform('motion_speed', u);
  assert.equal(chartTransform('motion_speed', { ...IMPERIAL }), a);
  assert.notEqual(chartTransform('motion_speed', defaultUnits()), a);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.fns));
  u.speed = 'kmh';                                  // later mutation must not change the cached transform
  near(a.fns[0](100), 62.1371, 1e-4);
  assert.equal(chartTransform('motion_speed', u).unit, 'km/h');
});

test('chartTransform: lo/hi mapping preserves order', () => {
  const t = chartTransform('tyre_temp', IMPERIAL);
  const [lo, hi] = [0, 150].map(t.fns[0]);
  assert.ok(lo < hi);
  near(lo, 32, 1e-9);
  near(hi, 302, 1e-9);
});
