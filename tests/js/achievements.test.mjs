import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, ACHIEVEMENT_GROUPS, Achievements } from '../../fh6_telemetry/web/static/achievements.js';

const EXPECTED_IDS = [
  'speed_100', 'speed_200', 'speed_250', 'speed_300', 'redline',
  'drift_500', 'drift_2000', 'drift_5000', 'drift_10000',
  'air_1s', 'air_2s', 'air_4s', 'lat_1_5g', 'lat_2g', 'brake_1_2g',
  'launch_3s', 'launch_2_5s', 'quarter_12s', 'quarter_10s',
  'hot_tyres', 'marathon', 'long_drift', 'combo_x5', 'jumper_10', 'perfect_stop',
];

const KEYS = [
  'IsRaceOn', 'CurrentEngineRpm', 'EngineMaxRpm', 'SpeedKmh', 'PowerHp', 'Torque', 'BoostBar', 'FuelPct',
  'Gear', 'AccelPct', 'BrakePct', 'ClutchPct', 'HandBrakePct', 'SteerPct',
  'TireTempFL', 'TireTempFR', 'TireTempRL', 'TireTempRR',
  'SuspNormFL', 'SuspNormFR', 'SuspNormRL', 'SuspNormRR',
  'TimestampMS', 'AccelGX', 'AccelGZ', 'SideslipDeg', 'Pitch', 'Roll', 'Yaw', 'PositionX', 'PositionZ',
];
const F = Object.fromEntries(KEYS.map((k, i) => [k, i]));
function row(o) {
  const r = new Array(KEYS.length).fill(0);
  for (const [k, v] of Object.entries(o)) r[F[k]] = v;
  return r;
}

const ids = (defs) => defs.map((d) => d.id);
const ev = (type, o = {}) => ({ type, ...o });

test('definitions: exactly the 25 required ids, well-formed', () => {
  assert.deepEqual(ids(ACHIEVEMENTS), EXPECTED_IDS);
  assert.equal(new Set(ids(ACHIEVEMENTS)).size, ACHIEVEMENTS.length);
  const groups = new Set(ACHIEVEMENTS.map((d) => d.group));
  const segmenter = new Intl.Segmenter();
  for (const d of ACHIEVEMENTS) {
    assert.deepEqual(Object.keys(d).sort(), ['desc', 'group', 'icon', 'id', 'rarity', 'title']);
    assert.ok(d.title.length > 0 && d.title.length <= 30, d.id);
    assert.ok(d.desc.length > 0 && d.desc.length <= 80, d.id);
    assert.ok(['common', 'rare', 'epic', 'legendary'].includes(d.rarity), d.id);
    assert.equal([...segmenter.segment(d.icon)].length, 1, `${d.id} icon must be one emoji`);
    assert.ok(/\p{Extended_Pictographic}/u.test(d.icon), `${d.id} icon is an emoji`);
    assert.ok(ACHIEVEMENT_GROUPS.some((g) => g.id === d.group), `${d.id} group ${d.group}`);
    assert.ok(Object.isFrozen(d));
  }
  for (const g of ACHIEVEMENT_GROUPS) assert.ok(groups.has(g.id), `group ${g.id} is used`);
  assert.equal(new Set(ACHIEVEMENTS.map((d) => d.icon)).size, ACHIEVEMENTS.length, 'unique icons');
  assert.equal(ACHIEVEMENTS.find((d) => d.id === 'speed_100').title, 'Warming up');
  for (const r of ['common', 'rare', 'epic', 'legendary']) {
    assert.ok(ACHIEVEMENTS.some((d) => d.rarity === r), `at least one ${r}`);
  }
  assert.ok(Object.isFrozen(ACHIEVEMENTS));
});

test('rarity ordering is sensible within a ladder', () => {
  const order = { common: 0, rare: 1, epic: 2, legendary: 3 };
  const r = (id) => order[ACHIEVEMENTS.find((d) => d.id === id).rarity];
  for (const ladder of [
    ['speed_100', 'speed_200', 'speed_250', 'speed_300'],
    ['drift_500', 'drift_2000', 'drift_5000', 'drift_10000'],
    ['air_1s', 'air_2s', 'air_4s'],
    ['lat_1_5g', 'lat_2g'],
    ['launch_3s', 'launch_2_5s'],
    ['quarter_12s', 'quarter_10s'],
  ]) {
    for (let i = 1; i < ladder.length; i++) assert.ok(r(ladder[i]) >= r(ladder[i - 1]), ladder[i]);
  }
});

test('constructor: defaults, prior unlocks, unknown ids dropped, duplicates collapsed', () => {
  assert.deepEqual(new Achievements().serialize(), []);
  assert.deepEqual(new Achievements({}).serialize(), []);
  assert.deepEqual(new Achievements({ unlocked: null }).serialize(), []);
  assert.deepEqual(new Achievements({ unlocked: 'speed_100' }).serialize(), []);
  const a = new Achievements({ unlocked: ['redline', 'speed_100', 'speed_100', 'bogus', 42, null] });
  assert.deepEqual(a.serialize(), ['redline', 'speed_100']);
  assert.equal(a.isUnlocked('redline'), true);
  assert.equal(a.isUnlocked('bogus'), false);
  assert.deepEqual(new Achievements({ unlocked: new Set(['air_1s']) }).serialize(), ['air_1s']);
});

test('prior unlocks are never returned again', () => {
  const a = new Achievements({ unlocked: ['speed_100'] });
  assert.deepEqual(ids(a.consume([ev('speed_milestone', { kmh: 100 })])), []);
  assert.deepEqual(ids(a.consume([ev('speed_milestone', { kmh: 200 })])), ['speed_200']);
});

test('speed_milestone unlocks every step reached', () => {
  const t = (kmh) => ids(new Achievements().consume([ev('speed_milestone', { kmh })]));
  assert.deepEqual(t(99.9), []);
  assert.deepEqual(t(100), ['speed_100']);
  assert.deepEqual(t(199), ['speed_100']);
  assert.deepEqual(t(200), ['speed_100', 'speed_200']);
  assert.deepEqual(t(250), ['speed_100', 'speed_200', 'speed_250']);
  assert.deepEqual(t(300), ['speed_100', 'speed_200', 'speed_250', 'speed_300']);
  assert.deepEqual(t(NaN), []);
  assert.deepEqual(t(undefined), []);
  assert.deepEqual(t('300'), []);
});

test('redline', () => {
  const a = new Achievements();
  assert.deepEqual(ids(a.consume([ev('redline')])), ['redline']);
  assert.deepEqual(a.consume([ev('redline')]), []);
});

test('record events: lateral g, braking g and top speed with loose key names', () => {
  const rec = (key, value) => ids(new Achievements().consume([ev('record', { key, value })]));
  assert.deepEqual(rec('maxLatG', 1.49), []);
  assert.deepEqual(rec('maxLatG', 1.5), ['lat_1_5g']);
  assert.deepEqual(rec('latG', 2), ['lat_1_5g', 'lat_2g']);
  assert.deepEqual(rec('lateral_g', 2.4), ['lat_1_5g', 'lat_2g']);
  assert.deepEqual(rec('maxLateralG', 1.6), ['lat_1_5g']);
  assert.deepEqual(rec('peakLatGForce', 1.6), ['lat_1_5g']);
  assert.deepEqual(rec('maxLatG', -2.1), ['lat_1_5g', 'lat_2g']);
  assert.deepEqual(rec('maxBrakeG', 1.19), []);
  assert.deepEqual(rec('maxBrakeG', 1.2), ['brake_1_2g']);
  assert.deepEqual(rec('brake_g', -1.5), ['brake_1_2g']);
  assert.deepEqual(rec('maxBrakingG', 1.3), ['brake_1_2g']);
  assert.deepEqual(rec('maxSpeed', 255), ['speed_100', 'speed_200', 'speed_250']);
  assert.deepEqual(rec('topSpeedKmh', 310).length, 4);
  // keys that are not g-forces or speeds are ignored
  assert.deepEqual(rec('maxBrakePct', 100), []);
  assert.deepEqual(rec('maxPowerHp', 900), []);
  assert.deepEqual(rec('avgSpeed', 300), []);
  assert.deepEqual(rec('maxLatG', NaN), []);
  assert.deepEqual(rec(undefined, 5), []);
  assert.deepEqual(rec(42, 5), []);
});

test('drift_end: score ladder, long drift and x5 combo', () => {
  const end = (o) => ids(new Achievements().consume([ev('drift_end', { score: 0, durationS: 1, maxAngleDeg: 30, mult: 1, ...o })]));
  assert.deepEqual(end({ score: 499 }), []);
  assert.deepEqual(end({ score: 500 }), ['drift_500']);
  assert.deepEqual(end({ score: 1999 }), ['drift_500']);
  assert.deepEqual(end({ score: 2000 }), ['drift_500', 'drift_2000']);
  assert.deepEqual(end({ score: 5000 }), ['drift_500', 'drift_2000', 'drift_5000']);
  assert.deepEqual(end({ score: 10000 }), ['drift_500', 'drift_2000', 'drift_5000', 'drift_10000']);
  assert.deepEqual(end({ durationS: 9.99 }), []);
  assert.deepEqual(end({ durationS: 10 }), ['long_drift']);
  assert.deepEqual(end({ mult: 4.5 }), []);
  assert.deepEqual(end({ mult: 5 }), ['combo_x5']);
  assert.deepEqual(end({ score: 12000, durationS: 14, mult: 5 }),
    ['drift_500', 'drift_2000', 'drift_5000', 'drift_10000', 'long_drift', 'combo_x5']);
  assert.deepEqual(end({ score: NaN, durationS: undefined, mult: 'x' }), []);
});

test('drift_milestone unlocks the live-score steps without waiting for the chain to end', () => {
  const m = (score) => ids(new Achievements().consume([ev('drift_milestone', { score })]));
  assert.deepEqual(m(500), ['drift_500']);
  assert.deepEqual(m(1000), ['drift_500']);
  assert.deepEqual(m(5000), ['drift_500', 'drift_2000', 'drift_5000']);
  assert.deepEqual(m(25000), ['drift_500', 'drift_2000', 'drift_5000', 'drift_10000']);
});

test('air_end: 1 s, 2 s and 4 s thresholds', () => {
  const air = (durationS) => ids(new Achievements().consume([ev('air_end', { durationS, distM: 10, heightM: 2 })]));
  assert.deepEqual(air(0.99), []);
  assert.deepEqual(air(1), ['air_1s']);
  assert.deepEqual(air(2), ['air_1s', 'air_2s']);
  assert.deepEqual(air(4.5), ['air_1s', 'air_2s', 'air_4s']);
  assert.deepEqual(air(NaN), []);
});

test('perf t100 launches use seconds; numbers and {time} objects both work; strict less-than', () => {
  const t100 = (value) => ids(new Achievements().consume([ev('perf', { key: 't100', value })]));
  assert.deepEqual(t100(3.0), []);
  assert.deepEqual(t100(2.99), ['launch_3s']);
  assert.deepEqual(t100(2.5), ['launch_3s']);
  assert.deepEqual(t100(2.49), ['launch_3s', 'launch_2_5s']);
  assert.deepEqual(t100({ time: 2.4, trapKmh: 100 }), ['launch_3s', 'launch_2_5s']);
  assert.deepEqual(t100(0), []);
  assert.deepEqual(t100(-1), []);
  assert.deepEqual(t100(NaN), []);
  assert.deepEqual(t100(null), []);
  assert.deepEqual(t100({}), []);
  assert.deepEqual(t100('2'), []);
});

test('perf qmile uses {time}; 12.0 and 10.0 are exclusive limits', () => {
  const q = (value) => ids(new Achievements().consume([ev('perf', { key: 'qmile', value })]));
  assert.deepEqual(q({ time: 12.0, trapKmh: 180 }), []);
  assert.deepEqual(q({ time: 11.99, trapKmh: 180 }), ['quarter_12s']);
  assert.deepEqual(q({ time: 10.0, trapKmh: 220 }), ['quarter_12s']);
  assert.deepEqual(q({ time: 9.99, trapKmh: 220 }), ['quarter_12s', 'quarter_10s']);
  assert.deepEqual(q(9.5), ['quarter_12s', 'quarter_10s']);
  assert.deepEqual(q({ trapKmh: 200 }), []);
});

test('perf brake100 uses {time} (also with {dist,time}); under 2.8 s only', () => {
  const b = (value) => ids(new Achievements().consume([ev('perf', { key: 'brake100', value })]));
  assert.deepEqual(b({ time: 2.8, dist: 40 }), []);
  assert.deepEqual(b({ time: 2.79, dist: 36 }), ['perfect_stop']);
  assert.deepEqual(b({ dist: 36, time: 2.0 }), ['perfect_stop']);
  assert.deepEqual(b(2.5), ['perfect_stop']);
});

test('perf keys are not interchangeable and unknown keys are ignored', () => {
  const a = new Achievements();
  assert.deepEqual(a.consume([
    ev('perf', { key: 't200', value: 1 }),
    ev('perf', { key: 'qmile', value: { time: 12.5 } }),
    ev('perf', { key: 'unknown', value: { time: 0.5 } }),
    ev('perf', { value: 1 }),
  ]), []);
  // the same fast time under another key does not unlock launch achievements
  assert.deepEqual(a.consume([ev('perf', { key: 'brake100', value: 2.9 })]), []);
  assert.equal(a.progress().unlocked, 0);
});

test('hot_tyres needs all four tyres at 100 C in ctx.fastRow, and the game running', () => {
  const hot = { TireTempFL: 100, TireTempFR: 100.5, TireTempRL: 120, TireTempRR: 100, IsRaceOn: 1 };
  const c = (o, extra = {}) => ids(new Achievements().consume([], { F, fastRow: row({ ...hot, ...o }), ...extra }));
  assert.deepEqual(c({}), ['hot_tyres']);
  assert.deepEqual(c({ TireTempRR: 99.9 }), []);
  assert.deepEqual(c({ TireTempFL: 0 }), []);
  assert.deepEqual(c({ TireTempFL: NaN }), []);
  assert.deepEqual(c({ IsRaceOn: 0 }), []);
  assert.deepEqual(ids(new Achievements().consume([], { fastRow: row(hot) })), []);        // no F
  assert.deepEqual(ids(new Achievements().consume([], { F })), []);                          // no row
  assert.deepEqual(ids(new Achievements().consume([], { F, fastRow: [] })), []);             // short row
  assert.deepEqual(ids(new Achievements().consume([], { F: {}, fastRow: row(hot) })), []);   // F without tyres
});

test('marathon needs lifetimeOdometerM >= 100 km', () => {
  const m = (v) => ids(new Achievements().consume([], { lifetimeOdometerM: v }));
  assert.deepEqual(m(99999), []);
  assert.deepEqual(m(100000), ['marathon']);
  assert.deepEqual(m(2.5e6), ['marathon']);
  assert.deepEqual(m(NaN), []);
  assert.deepEqual(m(undefined), []);
  assert.deepEqual(m('200000'), []);
});

test('jumper_10 needs ctx.session.jumps >= 10 (and air_end events alone do not count)', () => {
  const j = (session) => ids(new Achievements().consume([], { session }));
  assert.deepEqual(j({ jumps: 9 }), []);
  assert.deepEqual(j({ jumps: 10 }), ['jumper_10']);
  assert.deepEqual(j({ jumps: 25 }), ['jumper_10']);
  assert.deepEqual(j({}), []);
  assert.deepEqual(j(null), []);
  assert.deepEqual(j(undefined), []);
  const a = new Achievements();
  const many = Array.from({ length: 20 }, () => ev('air_end', { durationS: 0.5, distM: 5, heightM: 0.3 }));
  assert.deepEqual(a.consume(many), []);
});

test('unlockedAt is attached only when ctx.now is provided', () => {
  const a = new Achievements();
  const plain = a.consume([ev('redline')]);
  assert.equal('unlockedAt' in plain[0], false);
  assert.equal(plain[0], ACHIEVEMENTS.find((d) => d.id === 'redline'));
  const stamped = a.consume([ev('speed_milestone', { kmh: 100 })], { now: 1234567 });
  assert.equal(stamped[0].unlockedAt, 1234567);
  assert.equal(stamped[0].id, 'speed_100');
  assert.equal('unlockedAt' in ACHIEVEMENTS.find((d) => d.id === 'speed_100'), false);   // original untouched
  const zero = new Achievements().consume([ev('redline')], { now: 0 });
  assert.equal(zero[0].unlockedAt, 0);
  const isoNow = new Achievements().consume([ev('redline')], { now: '2026-01-01' });
  assert.equal(isoNow[0].unlockedAt, '2026-01-01');
});

test('returned definitions are full definitions in unlock order, each id once per call', () => {
  const a = new Achievements();
  const out = a.consume([
    ev('redline'),
    ev('speed_milestone', { kmh: 200 }),
    ev('speed_milestone', { kmh: 100 }),
    ev('redline'),
  ], { lifetimeOdometerM: 150000 });
  assert.deepEqual(ids(out), ['redline', 'speed_100', 'speed_200', 'marathon']);
  for (const d of out) assert.deepEqual(d, ACHIEVEMENTS.find((x) => x.id === d.id));
  assert.deepEqual(a.consume([ev('speed_milestone', { kmh: 200 })], { lifetimeOdometerM: 150000 }), []);
});

test('unknown event types, junk events and junk arguments are ignored without throwing', () => {
  const a = new Achievements();
  const junk = [null, undefined, 5, 'x', [], {}, { type: 'nope' }, { type: 42 }, { type: 'perf' }, { type: 'record' },
    { type: 'speed_milestone' }, { type: 'drift_end' }, { type: 'air_end', durationS: {} }, { type: '__proto__' }];
  assert.doesNotThrow(() => a.consume(junk));
  for (const ctx of [undefined, null, 0, 'x', [], {}, { fastRow: 'abc', F: 5 }, { session: 5 }]) {
    assert.doesNotThrow(() => a.consume(junk, ctx));
  }
  for (const evs of [undefined, null, 5, 'abc', {}]) assert.deepEqual(a.consume(evs), []);
  assert.equal(a.progress().unlocked, 0);
});

test('isUnlocked, serialize (sorted), progress, list and reset', () => {
  const a = new Achievements();
  assert.deepEqual(a.progress(), { unlocked: 0, total: 25 });
  a.consume([ev('speed_milestone', { kmh: 250 }), ev('redline')]);
  assert.equal(a.isUnlocked('speed_200'), true);
  assert.equal(a.isUnlocked('speed_300'), false);
  assert.equal(a.isUnlocked('nope'), false);
  assert.deepEqual(a.serialize(), ['redline', 'speed_100', 'speed_200', 'speed_250']);
  assert.deepEqual(a.progress(), { unlocked: 4, total: ACHIEVEMENTS.length });
  const list = a.list();
  assert.equal(list.length, ACHIEVEMENTS.length);
  assert.deepEqual(list.filter((d) => d.unlocked).map((d) => d.id), ['speed_100', 'speed_200', 'speed_250', 'redline']);
  assert.equal('unlocked' in ACHIEVEMENTS[0], false);
  a.reset();
  assert.deepEqual(a.serialize(), []);
  assert.deepEqual(a.progress(), { unlocked: 0, total: 25 });
  assert.deepEqual(ids(a.consume([ev('redline')])), ['redline']);       // can unlock again after reset
});

test('serialize -> constructor round trip; the serialized array is a copy', () => {
  const a = new Achievements();
  a.consume([ev('drift_milestone', { score: 5000 }), ev('redline')]);
  const saved = a.serialize();
  saved.push('hacked');
  assert.equal(a.isUnlocked('hacked'), false);
  assert.deepEqual(new Achievements({ unlocked: JSON.parse(JSON.stringify(a.serialize())) }).serialize(), a.serialize());
  const b = new Achievements({ unlocked: a.serialize() });
  assert.deepEqual(b.consume([ev('drift_milestone', { score: 5000 }), ev('redline')]), []);
});

test('every one of the 25 achievements can be earned through the documented inputs', () => {
  const a = new Achievements();
  const got = new Set();
  const take = (defs) => defs.forEach((d) => got.add(d.id));
  take(a.consume([
    ev('speed_milestone', { kmh: 300 }),
    ev('redline'),
    ev('drift_end', { score: 10000, durationS: 12, maxAngleDeg: 70, mult: 5 }),
    ev('air_end', { durationS: 4.2, distM: 300, heightM: 21 }),
    ev('record', { key: 'maxLatG', value: 2.1 }),
    ev('record', { key: 'maxBrakeG', value: 1.3 }),
    ev('perf', { key: 't100', value: 2.4 }),
    ev('perf', { key: 'qmile', value: { time: 9.8, trapKmh: 230 } }),
    ev('perf', { key: 'brake100', value: { time: 2.5, dist: 33 } }),
  ], {
    F,
    fastRow: row({ IsRaceOn: 1, TireTempFL: 105, TireTempFR: 105, TireTempRL: 105, TireTempRR: 105 }),
    lifetimeOdometerM: 123456,
    session: { jumps: 11 },
  }));
  assert.deepEqual([...got].sort(), [...EXPECTED_IDS].sort());
  assert.deepEqual(a.progress(), { unlocked: 25, total: 25 });
});
