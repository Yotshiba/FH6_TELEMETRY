import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings, THEMES, defaults, sanitize } from '../../fh6_telemetry/web/static/settings.js';
import { Lifetime } from '../../fh6_telemetry/web/static/lifetime.js';
import { on } from '../../fh6_telemetry/web/static/bus.js';

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}
const throwingStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

test('defaults are valid and survive sanitize unchanged', () => {
  assert.deepEqual(sanitize(defaults()), defaults());
  assert.deepEqual(sanitize(null), defaults());
  assert.deepEqual(sanitize('garbage'), defaults());
  assert.deepEqual(sanitize([1, 2]), defaults());
});

test('sanitize rejects unknown themes, clamps numbers, drops wrong types', () => {
  const s = sanitize({
    theme: 'rainbow', voice: 'yes', haptics: 1, mirror: 'true',
    sound: { master: 7, engine: 'no', turbo: false },
    fx: { shake: true, confetti: 'x' },
    shift: { leds: 500, start: -3, flash: 'a' },
  });
  assert.equal(s.theme, 'neon');
  assert.equal(s.voice, false);
  assert.equal(s.haptics, false);
  assert.equal(s.mirror, false);
  assert.equal(s.sound.master, 1);
  assert.equal(s.sound.engine, true);
  assert.equal(s.sound.turbo, false);
  assert.equal(s.fx.shake, true);
  assert.equal(s.fx.confetti, true);
  assert.equal(s.shift.leds, 30);
  assert.equal(s.shift.start, 0.3);
  assert.equal(s.shift.flash, defaults().shift.flash);
});

test('every listed theme (and the hidden hyperdrive) is accepted', () => {
  for (const t of THEMES) assert.equal(sanitize({ theme: t.id }).theme, t.id);
  assert.equal(sanitize({ theme: 'hyperdrive' }).theme, 'hyperdrive');
});

test('audio never starts on: soundOn is always false after a load', () => {
  assert.equal(sanitize({ soundOn: true }).soundOn, false);
  const st = memoryStorage({ 'fh6.settings.v1': JSON.stringify({ soundOn: true, theme: 'carbon' }) });
  const s = new Settings(st);
  assert.equal(s.get('soundOn'), false);
  assert.equal(s.get('theme'), 'carbon');
});

test('set() validates, persists, announces and keeps soundOn runtime-only', () => {
  const st = memoryStorage();
  const s = new Settings(st);
  const seen = [];
  const off = on('settings', (d) => seen.push(d));
  assert.equal(s.set('fx.speedlines', false), true);
  assert.equal(s.get('fx.speedlines'), false);
  assert.equal(seen.at(-1).path, 'fx.speedlines');
  assert.equal(seen.at(-1).value, false);
  assert.equal(JSON.parse(st.m.get('fh6.settings.v1')).fx.speedlines, false);
  s.set('sound.master', 99);
  assert.equal(s.get('sound.master'), 1);
  s.set('theme', 'nonsense');
  assert.equal(s.get('theme'), 'neon');
  s.set('soundOn', true);
  assert.equal(s.get('soundOn'), true);
  assert.equal(JSON.parse(st.m.get('fh6.settings.v1')).soundOn, false, 'stored muted');
  assert.equal(s.set('nope.deep.path', 1), false);
  off();
});

test('soundOn survives every other change (the engine keeps running) but is never stored as on', () => {
  const st = memoryStorage();
  const s = new Settings(st);
  s.set('soundOn', true);
  s.set('sound.master', 0.8);
  s.set('theme', 'carbon');
  s.set('mirror', true);
  s.set('units.speed', 'mph');
  assert.equal(s.get('soundOn'), true);
  assert.equal(JSON.parse(st.m.get('fh6.settings.v1')).soundOn, false);
  s.reset();
  assert.equal(s.get('soundOn'), true, 'reset keeps the running state too');
  s.set('soundOn', false);
  assert.equal(s.get('soundOn'), false);
});

test('prototype-polluting paths are refused', () => {
  const s = new Settings(memoryStorage());
  assert.equal(s.set('__proto__.polluted', 1), false);
  assert.equal(s.set('fx.__proto__.polluted', 1), false);
  assert.equal(s.set('constructor.prototype.polluted', 1), false);
  assert.equal({}.polluted, undefined);
});

test('a reload sees what was saved; reset() restores the defaults', () => {
  const st = memoryStorage();
  const a = new Settings(st);
  a.set('theme', 'synthwave');
  a.set('units.speed', 'mph');
  const b = new Settings(st);
  assert.equal(b.get('theme'), 'synthwave');
  assert.equal(b.get('units').speed, 'mph');
  b.reset();
  assert.deepEqual(b.data, defaults());
  assert.deepEqual(new Settings(st).data, defaults());
});

test('corrupt JSON or a throwing storage falls back to defaults without throwing', () => {
  assert.deepEqual(new Settings(memoryStorage({ 'fh6.settings.v1': '{not json' })).data, defaults());
  const s = new Settings(throwingStorage);
  assert.deepEqual(s.data, defaults());
  assert.doesNotThrow(() => s.set('theme', 'carbon'));
  assert.equal(s.get('theme'), 'carbon');
  assert.deepEqual(new Settings(null).data, defaults());
});

// ---- lifetime -----------------------------------------------------------------------------------------------------

test('lifetime: sessions count, records only grow, odometer is session-relative', () => {
  const st = memoryStorage();
  let now = 0;
  const l = new Lifetime(st, () => now);
  assert.equal(l.data.sessions, 1);
  l.mergeRecords({ topSpeedKmh: 200, maxLatG: 1.2, odometerM: 5000 });
  l.mergeRecords({ topSpeedKmh: 150, maxLatG: 1.5, odometerM: 6000 });
  assert.equal(l.records.topSpeedKmh, 200);
  assert.equal(l.records.maxLatG, 1.5);
  assert.equal(l.data.odometerM, 6000);
  now = 10000; l.save();
  const l2 = new Lifetime(st, () => now);
  assert.equal(l2.data.sessions, 2);
  assert.equal(l2.base, 6000);
  l2.mergeRecords({ odometerM: 1000 });
  assert.equal(l2.data.odometerM, 7000, 'odometer = earlier sessions + this one');
});

test('lifetime: personal bests compare by the right field and report "new best" only against an older value', () => {
  const l = new Lifetime(memoryStorage(), () => 0);
  assert.equal(l.setBest('t100', 3.5), false, 'first value is not announced as a new best');
  assert.equal(l.setBest('t100', 3.9), false);
  assert.equal(l.best.t100, 3.5);
  assert.equal(l.setBest('t100', 3.1), true);
  assert.equal(l.best.t100, 3.1);
  assert.equal(l.setBest('qmile', { time: 12.5, trapKmh: 180 }), false);
  assert.equal(l.setBest('qmile', { time: 11.9, trapKmh: 170 }), true);
  assert.equal(l.best.qmile.time, 11.9);
  assert.equal(l.setBest('brake100', { dist: 40, time: 3 }), false);
  assert.equal(l.setBest('brake100', { dist: 45, time: 3 }), false);
  assert.equal(l.best.brake100.dist, 40);
  assert.equal(l.setBest('unknown', 1), false);
  assert.equal(l.setBest('t200', null), false);
});

test('lifetime: drift/air bests, unlocks, throttled saves, hostile storage', () => {
  const st = memoryStorage();
  let now = 0;
  const l = new Lifetime(st, () => now);
  assert.equal(l.noteDrift(500), true);
  assert.equal(l.noteDrift(400), false);
  assert.equal(l.noteAir(1.5), true);
  assert.equal(l.noteAir(1.0), false);
  l.setUnlocked(['speed_100']);
  now = 1000; l.save();                                  // 3 s throttle
  now = 5000; l.save();
  assert.ok(st.m.has('fh6.lifetime.v1'));
  const back = new Lifetime(st, () => now);
  assert.equal(back.data.bestDrift, 500);
  assert.equal(back.data.longestAirS, 1.5);
  assert.deepEqual(back.data.unlocked, ['speed_100']);
  back.reset();
  assert.equal(back.data.sessions, 1);
  assert.deepEqual(back.data.unlocked, []);
  const evil = memoryStorage({ 'fh6.lifetime.v1': JSON.stringify({ odometerM: 'x', records: { a: 'nope', b: 3 }, best: { t100: 'bad', zzz: 1 }, unlocked: [1, 'a'] }) });
  const e = new Lifetime(evil, () => 0);
  assert.equal(e.data.odometerM, 0);
  assert.deepEqual(e.records, { b: 3 });
  assert.deepEqual(e.best, {});
  assert.deepEqual(e.data.unlocked, ['a']);
  const shapes = memoryStorage({ 'fh6.lifetime.v1': JSON.stringify({ best: {
    t100: 3.2, t200: { time: 1 }, qmile: 5, brake100: {}, brake60mph: { dist: 31.5, time: 2.3 }, t60mph: Infinity, qmile2: 1,
  } }) });
  assert.deepEqual(new Lifetime(shapes, () => 0).best, { t100: 3.2, brake60mph: { dist: 31.5, time: 2.3 } }, 'wrong shapes are dropped');
  assert.doesNotThrow(() => new Lifetime(throwingStorage, () => 0).save(true));
});
