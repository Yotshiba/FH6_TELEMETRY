import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WIDGETS, PRESET_MAX, PRESET_NAME_MAX, WIDGET_TYPE_IDS, cleanPresetName, defaultLayout, deletePreset, sanitizeLayout,
  sanitizePresets, upsertPreset,
} from '../../fh6_telemetry/web/static/cockpit_layout.js';
import { SHARE_PREFIX, TYPE_CODES, decodeShare, encodeShare, shareLink } from '../../fh6_telemetry/web/static/cockpit_share.js';

const L = () => defaultLayout('landscape');
const P = () => defaultLayout('portrait');
/** Layouts compare equal ignoring ids (the code does not carry them). */
const shape = (layout) => layout.map(({ type, x, y, w, h }) => ({ type, x, y, w, h }));

function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff; }
  return crc;
}
/** A code for hand-built bytes, with a valid checksum. */
const seal = (bytes) => SHARE_PREFIX + btoa(String.fromCharCode(...bytes, crc8(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('gauge codes are unique, cover the whole catalogue, and are frozen (they are part of the format)', () => {
  assert.deepEqual(Object.keys(TYPE_CODES).sort(), [...WIDGET_TYPE_IDS].sort());
  assert.equal(new Set(Object.values(TYPE_CODES)).size, WIDGET_TYPE_IDS.length);
  assert.deepEqual(Object.values(TYPE_CODES).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  // a golden snapshot: if this fails, an already-shared code would decode differently - do not "fix" the test
  assert.deepEqual(TYPE_CODES, {
    speedo: 1, tacho: 2, speed_digital: 3, rpm_digital: 4, gear: 5, shift_lights: 6, wheel: 7, brake: 8, throttle: 9,
    clutch: 10, fuel: 11, boost: 12, power: 13, tyres: 14, delta: 15, laptime: 16, gforce: 17, compass: 18,
    speed_trace: 19, drift: 20,
  });
});

test('golden code: a known layout always produces (and reads back from) the same text', () => {
  const layout = [
    { id: 'speedo', type: 'speedo', x: 0, y: 2, w: 12, h: 12 },
    { id: 'gear', type: 'gear', x: 13, y: 4, w: 6, h: 6 },
    { id: 'tyres', type: 'tyres', x: 24, y: 8, w: 8, h: 6 },
  ];
  const code = encodeShare({ landscape: layout });
  assert.equal(code, seal([1, 1, 3, 1, 0, 2, 12, 12, 5, 13, 4, 6, 6, 14, 24, 8, 8, 6]), 'the documented byte layout');
  assert.match(code, /^FH6-[A-Za-z0-9_-]+$/);
  const back = decodeShare(code);
  assert.equal(back.ok, true);
  assert.deepEqual(shape(back.landscape), shape(layout));
  assert.equal(back.portrait, null);
});

test('round trips: both factory layouts, one orientation, an empty dash, and every gauge type', () => {
  const both = decodeShare(encodeShare({ landscape: L(), portrait: P() }));
  assert.deepEqual(shape(both.landscape), shape(L()));
  assert.deepEqual(shape(both.portrait), shape(P()));
  const only = decodeShare(encodeShare({ portrait: P() }));
  assert.equal(only.landscape, null);
  assert.deepEqual(shape(only.portrait), shape(P()));
  const empty = decodeShare(encodeShare({ landscape: [] }));
  assert.deepEqual(empty.landscape, []);
  const all = WIDGET_TYPE_IDS.map((type, i) => ({ id: type, type, x: i % 10, y: Math.floor(i / 10) * 4, w: 2 + (i % 3), h: 3 }));
  const sane = sanitizeLayout(all, 'landscape');
  assert.deepEqual(shape(decodeShare(encodeShare({ landscape: sane })).landscape), shape(sane));
  assert.equal(encodeShare({}), '');
  assert.equal(encodeShare(), '');
  assert.equal(encodeShare({ landscape: 'nope', portrait: null }), '');
});

test('the code is compact: both factory layouts fit in about 160 characters, and a full 80-gauge dash in a QR code', () => {
  assert.ok(encodeShare({ landscape: L(), portrait: P() }).length <= 170);
  const big = Array.from({ length: MAX_WIDGETS }, (_, i) => ({ id: `c${i}`, type: 'clutch', x: i % 30, y: 0, w: 1, h: 3 }));
  const code = encodeShare({ landscape: big, portrait: big });
  assert.ok(shareLink('http://192.168.100.101:8077', code).length < 800, 'link <= what /api/qr.svg accepts');
});

test('decoding validates everything: a hostile code never yields an out-of-grid dash or an unknown gauge', () => {
  // out-of-range numbers (a 200x200 speedo at 40,40) and a gauge code that does not exist (231)
  const res = decodeShare(seal([1, 1, 2, 1, 40, 40, 200, 200, 231, 0, 0, 3, 3]));
  assert.equal(res.ok, true);
  assert.equal(res.landscape.length, 1, 'the unknown gauge code was dropped');
  assert.deepEqual(res.landscape[0], { id: 'speedo', type: 'speedo', x: 0, y: 0, w: 32, h: 18 }, 'clamped into the grid');
});

test('bad input gives a helpful message, never an exception', () => {
  const good = encodeShare({ landscape: L(), portrait: P() });
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const cases = {
    nothing: ['', /start with FH6-/],
    garbage: ['hello world', /start with FH6-/],
    null: [null, /start with FH6-/],
    undefined: [undefined, /start with FH6-/],
    'prefix only': ['FH6-', /start with FH6-/],
    'cut off': [good.slice(0, 60), /damaged|cut off|checksum|length/],
    'one wrong character': [flip(good, 30), /damaged|checksum|length/],
    'a lone byte': ['FH6-AQ', /too short/],
  };
  for (const [name, [input, pattern]] of Object.entries(cases)) {
    const r = decodeShare(input);
    assert.equal(r.ok, false, name);
    assert.match(r.error, pattern, name);
  }
  // wrong version / no layout flag / stray bytes, each with a VALID checksum
  assert.match(decodeShare(seal([9, 1, 0])).error, /newer version/);
  assert.match(decodeShare(seal([1, 0, 0])).error, /does not contain a layout/);
  assert.match(decodeShare(seal([1, 4, 0])).error, /does not contain a layout/);
  assert.match(decodeShare(seal([1, 1, 0, 99])).error, /extra data/);
  assert.match(decodeShare(seal([1, 1, 99])).error, /bad length/);
});

test('a code can be pasted as a link, inside a sentence, or wrapped over several lines', () => {
  const code = encodeShare({ landscape: L(), portrait: P() });
  const want = shape(L());
  assert.deepEqual(shape(decodeShare(shareLink('http://192.168.1.101:8077', code)).landscape), want);
  assert.deepEqual(shape(decodeShare(`try my dash!  ${code}  (it is great)`).landscape), want);
  const wrapped = code.replace(/(.{40})/g, '$1\n');
  assert.deepEqual(shape(decodeShare(wrapped).landscape), want);
  assert.deepEqual(shape(decodeShare(`  \n${code}\n `).landscape), want);
  assert.equal(shareLink('http://h:1/', 'FH6-x'), 'http://h:1/?cockpit=FH6-x', 'no double slash');
});

// ---- presets ---------------------------------------------------------------------------------------------------------------

test('cleanPresetName trims, collapses, strips control characters and limits the length', () => {
  assert.equal(cleanPresetName('  My   Race  Dash '), 'My Race Dash');
  assert.equal(cleanPresetName('a\u0000b\tc\nd'), 'a b c d');
  assert.equal(cleanPresetName('x'.repeat(100)).length, PRESET_NAME_MAX);
  assert.equal(cleanPresetName(''), '');
  assert.equal(cleanPresetName(42), '');
  assert.equal(cleanPresetName(null), '');
  assert.equal(cleanPresetName('   '), '');
});

test('sanitizePresets drops junk, de-duplicates names case-insensitively and caps the list', () => {
  const good = { name: 'Race', landscape: L(), portrait: null };
  const out = sanitizePresets([good, { ...good, name: 'RACE' }, null, 'x', { name: '', landscape: [] }, { name: 7 },
    { name: 'Drift', landscape: 'nope', portrait: [{ type: 'warp', x: 0, y: 0, w: 1, h: 1 }] }]);
  assert.deepEqual(out.map((p) => p.name), ['Race', 'Drift']);
  assert.deepEqual(out[1], { name: 'Drift', landscape: null, portrait: [] });
  assert.equal(out[0].landscape.length, L().length);
  assert.deepEqual(sanitizePresets('nope'), []);
  assert.deepEqual(sanitizePresets(undefined), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, landscape: null, portrait: null }));
  assert.equal(sanitizePresets(many).length, PRESET_MAX);
});

test('upsertPreset: add, replace by name (any case), refuse empty names and a full list; never mutates', () => {
  const base = Object.freeze([]);
  const a = upsertPreset(base, '  Race ', L(), P());
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'Race');
  assert.equal(base.length, 0);
  const b = upsertPreset(a, 'race', [], null);                      // replaces, keeps the position
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].landscape, []);
  assert.equal(b[0].name, 'race');
  assert.equal(a[0].landscape.length, L().length, 'the old list is untouched');
  assert.equal(upsertPreset(a, '   ', L(), P()), null);
  let full = [];
  for (let i = 0; i < PRESET_MAX; i++) full = upsertPreset(full, `p${i}`, null, null);
  assert.equal(full.length, PRESET_MAX);
  assert.equal(upsertPreset(full, 'one more', null, null), null, 'full');
  assert.equal(upsertPreset(full, 'P3', L(), null).length, PRESET_MAX, 'but replacing is fine');
});

test('deletePreset removes by name, any case, and ignores unknown names', () => {
  const list = upsertPreset(upsertPreset([], 'A', null, null), 'B', null, null);
  assert.deepEqual(deletePreset(list, 'a').map((p) => p.name), ['B']);
  assert.equal(deletePreset(list, 'zzz').length, 2);
  assert.equal(list.length, 2);
});
