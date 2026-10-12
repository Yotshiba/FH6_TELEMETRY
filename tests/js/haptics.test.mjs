import test from 'node:test';
import assert from 'node:assert/strict';
import { Haptics, HAPTIC } from '../../fh6_telemetry/web/static/haptics.js';

function recorder(returns = true) {
  const calls = [];
  const fn = (p) => { calls.push(p); return typeof returns === 'function' ? returns(p) : returns; };
  fn.calls = calls;
  return fn;
}

function make(opts = {}) {
  const vibrate = recorder();
  const h = new Haptics({ vibrate, enabled: true, ...opts });
  return { h, vibrate };
}

test('disabled by default and silent while disabled', () => {
  const vibrate = recorder();
  const h = new Haptics({ vibrate });
  assert.equal(h.enabled, false);
  assert.equal(h.update({ impact: true, rumbleBits: 15 }, 0), null);
  assert.deepEqual(vibrate.calls, []);
});

test('supported reflects an injected vibrate function', () => {
  assert.equal(new Haptics({ vibrate: recorder() }).supported, true);
  assert.equal(new Haptics({ vibrate: null }).supported, false);
  assert.equal(new Haptics({ vibrate: 'nope' }).supported, false);
});

test('default vibrate binds navigator.vibrate when present, is unsupported otherwise', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  try {
    set(undefined);
    assert.equal(new Haptics().supported, false);
    set({});
    assert.equal(new Haptics().supported, false);
    const seen = [];
    const nav = { vibrate(p) { seen.push([this === nav, p]); return true; } };
    set(nav);
    const h = new Haptics({ enabled: true });
    assert.equal(h.supported, true);
    assert.deepEqual(h.update({ impact: true }, 0), [90]);
    assert.deepEqual(seen, [[true, [90]]], 'called with the navigator as receiver');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});

test('kerb rumble: [18] for one wheel, longer with more wheels', () => {
  const { h, vibrate } = make();
  assert.deepEqual(h.update({ rumbleBits: 0b0001 }, 1000), [18]);
  assert.deepEqual(h.update({ rumbleBits: 0b0011 }, 1100), [26]);
  assert.deepEqual(h.update({ rumbleBits: 0b0111 }, 1200), [34]);
  assert.deepEqual(h.update({ rumbleBits: 0b1111 }, 1300), [42]);
  assert.deepEqual(vibrate.calls, [[18], [26], [34], [42]]);
  assert.equal(h.lastKind, 'rumble');
});

test('rumble only looks at bits 0..3 (puddle bits are ignored)', () => {
  const { h, vibrate } = make();
  assert.equal(h.update({ rumbleBits: 0b11110000 }, 0), null);
  assert.equal(h.update({ rumbleBits: 0 }, 100), null);
  assert.equal(h.update({ rumbleBits: NaN }, 200), null);
  assert.deepEqual(vibrate.calls, []);
  assert.deepEqual(h.update({ rumbleBits: 0b10010000 | 0b0100 }, 300), [18]);
});

test('interval limiting: at most one pulse per minIntervalMs', () => {
  const { h, vibrate } = make();
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1000), [18]);
  assert.equal(h.update({ rumbleBits: 1 }, 1013), null);
  assert.equal(h.update({ rumbleBits: 1 }, 1089), null);
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1090), [18]);
  assert.equal(h.update({ rumbleBits: 1 }, 1100), null);
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1180), [18]);
  assert.equal(vibrate.calls.length, 3);
});

test('75 Hz input yields about 11 pulses per second', () => {
  const { h, vibrate } = make();
  for (let t = 0; t < 1000; t += 1000 / 75) h.update({ rumbleBits: 3 }, t);
  assert.ok(vibrate.calls.length >= 10 && vibrate.calls.length <= 12, `got ${vibrate.calls.length}`);
});

test('custom minIntervalMs', () => {
  const { h } = make({ minIntervalMs: 200 });
  assert.deepEqual(h.update({ rumbleBits: 1 }, 0), [18]);
  assert.equal(h.update({ rumbleBits: 1 }, 150), null);
  assert.deepEqual(h.update({ rumbleBits: 1 }, 200), [18]);
  const zero = make({ minIntervalMs: 0 }).h;
  assert.deepEqual(zero.update({ rumbleBits: 1 }, 5), [18]);
  assert.deepEqual(zero.update({ rumbleBits: 1 }, 5), [18]);
  const bad = make({ minIntervalMs: -5 }).h;                // invalid -> default 90
  bad.update({ rumbleBits: 1 }, 0);
  assert.equal(bad.update({ rumbleBits: 1 }, 50), null);
});

test('hard braking: [25] below -1.0 g', () => {
  const { h } = make();
  assert.equal(h.update({ longG: -1.0 }, 0), null, '-1.0 is not hard enough');
  assert.equal(h.update({ longG: -0.99 }, 100), null);
  assert.equal(h.update({ longG: 1.4 }, 200), null, 'acceleration is not braking');
  assert.deepEqual(h.update({ longG: -1.01 }, 300), [25]);
  assert.equal(h.lastKind, 'brake');
});

test('hard cornering: gentle [12] tick, at most every 140 ms, either direction', () => {
  const { h, vibrate } = make();
  assert.equal(h.update({ latG: 1.2 }, 0), null, '1.2 is not over the threshold');
  assert.deepEqual(h.update({ latG: 1.21 }, 1000), [12]);
  assert.equal(h.update({ latG: 1.5 }, 1090), null, 'the 90 ms rule is not enough for cornering');
  assert.equal(h.update({ latG: 1.5 }, 1139), null);
  assert.deepEqual(h.update({ latG: -1.5 }, 1140), [12], 'left corner too');
  assert.equal(vibrate.calls.length, 2);
  assert.equal(h.lastKind, 'corner');
});

test('cornering interval never drops below a larger minIntervalMs', () => {
  const { h } = make({ minIntervalMs: 300 });
  h.update({ latG: 2 }, 0);
  assert.equal(h.update({ latG: 2 }, 200), null);
  assert.deepEqual(h.update({ latG: 2 }, 300), [12]);
});

test('shift is a [10] one-shot', () => {
  const { h } = make();
  assert.deepEqual(h.update({ shift: true }, 0), [10]);
  assert.equal(h.lastKind, 'shift');
  assert.equal(h.update({ shift: false }, 500), null);
  assert.deepEqual(h.update({ shift: true }, 520), [10]);
  assert.equal(h.update({ shift: true }, 560), null, 'rate limited like any other non-impact');
  assert.deepEqual(h.update({ shift: true }, 610), [10]);
});

test('impact and landing are [90] and bypass the interval', () => {
  const { h, vibrate } = make();
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1000), [18]);
  assert.deepEqual(h.update({ impact: true }, 1005), [90]);
  assert.equal(h.lastKind, 'impact');
  assert.deepEqual(h.update({ landing: true }, 1006), [90]);
  assert.equal(h.lastKind, 'landing');
  assert.deepEqual(h.update({ impact: true }, 1006), [90], 'even the very same instant');
  assert.deepEqual(vibrate.calls, [[18], [90], [90], [90]]);
});

test('an impact resets the interval for the lower-priority patterns', () => {
  const { h } = make();
  h.update({ impact: true }, 1000);
  assert.equal(h.update({ rumbleBits: 1 }, 1050), null);
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1090), [18]);
});

test('impact accepts a magnitude; zero, negative and NaN do not count', () => {
  const { h } = make();
  assert.deepEqual(h.update({ impact: 3.2 }, 0), [90]);
  assert.equal(h.update({ impact: 0 }, 100), null);
  assert.equal(h.update({ impact: -2 }, 200), null);
  assert.equal(h.update({ impact: NaN }, 300), null);
  assert.equal(h.update({ impact: 'yes' }, 400), null);
});

test('priority: impact > landing > rumble > shift > braking > cornering', () => {
  const all = { impact: true, landing: true, rumbleBits: 15, shift: true, longG: -2, latG: 2 };
  const order = [
    [{}, 'impact', [90]],
    [{ impact: false }, 'landing', [90]],
    [{ impact: false, landing: false }, 'rumble', [42]],
    [{ impact: false, landing: false, rumbleBits: 0 }, 'shift', [10]],
    [{ impact: false, landing: false, rumbleBits: 0, shift: false }, 'brake', [25]],
    [{ impact: false, landing: false, rumbleBits: 0, shift: false, longG: 0 }, 'corner', [12]],
  ];
  let t = 10000;
  for (const [override, kind, pattern] of order) {
    const { h } = make();
    assert.deepEqual(h.update({ ...all, ...override }, t), pattern, kind);
    assert.equal(h.lastKind, kind);
    t += 1000;
  }
});

test('a rate-limited high-priority pattern does not let a lower one slip through', () => {
  const { h, vibrate } = make();
  assert.deepEqual(h.update({ rumbleBits: 1 }, 1000), [18]);
  assert.equal(h.update({ rumbleBits: 1, longG: -2, latG: 2 }, 1050), null);
  assert.equal(vibrate.calls.length, 1);
});

test('airborne suppresses rumble, braking and cornering but not shift, impact or landing', () => {
  const { h } = make();
  assert.equal(h.update({ airborne: true, rumbleBits: 15, longG: -2, latG: 2 }, 0), null);
  assert.deepEqual(h.update({ airborne: true, shift: true }, 200), [10]);
  assert.deepEqual(h.update({ airborne: true, impact: true }, 300), [90]);
  assert.deepEqual(h.update({ airborne: true, landing: true }, 400), [90]);
  assert.deepEqual(h.update({ airborne: false, rumbleBits: 1 }, 600), [18]);
});

test('setEnabled(false) cancels with vibrate(0) and silences; setEnabled(true) re-arms', () => {
  const { h, vibrate } = make();
  h.update({ rumbleBits: 1 }, 0);
  h.setEnabled(false);
  assert.deepEqual(vibrate.calls, [[18], 0]);
  assert.equal(h.enabled, false);
  assert.equal(h.update({ impact: true }, 1000), null);
  h.setEnabled(true);
  assert.equal(h.enabled, true);
  assert.deepEqual(h.update({ impact: true }, 2000), [90]);
  h.setEnabled(0);
  assert.equal(vibrate.calls.at(-1), 0);
  assert.equal(h.enabled, false);
});

test('cancel() sends vibrate(0) regardless of enabled', () => {
  const { h, vibrate } = make({ enabled: false });
  h.cancel();
  assert.deepEqual(vibrate.calls, [0]);
});

test('unsupported never throws and never fires', () => {
  const h = new Haptics({ vibrate: null, enabled: true });
  assert.equal(h.supported, false);
  assert.equal(h.update({ impact: true, rumbleBits: 15, shift: true }, 0), null);
  assert.doesNotThrow(() => h.setEnabled(false));
  assert.doesNotThrow(() => h.setEnabled(true));
  assert.doesNotThrow(() => h.cancel());
});

test('a vibrate that throws is swallowed', () => {
  const h = new Haptics({ vibrate: () => { throw new Error('not allowed'); }, enabled: true });
  assert.equal(h.update({ impact: true }, 0), null);
  assert.doesNotThrow(() => h.setEnabled(false));
  assert.equal(h.lastKind, null);
});

test('a refused vibrate (returns false) yields null and does not retry within the interval', () => {
  const vibrate = recorder(false);
  const h = new Haptics({ vibrate, enabled: true });
  assert.equal(h.update({ rumbleBits: 1 }, 0), null);
  assert.equal(h.update({ rumbleBits: 1 }, 30), null);
  assert.equal(vibrate.calls.length, 1, 'no call storm while the browser refuses');
  assert.equal(h.update({ rumbleBits: 1 }, 100), null);
  assert.equal(vibrate.calls.length, 2);
  assert.equal(h.lastKind, null);
});

test('a vibrate returning undefined counts as success', () => {
  const h = new Haptics({ vibrate: () => undefined, enabled: true });
  assert.deepEqual(h.update({ shift: true }, 0), [10]);
});

test('malformed state and times are ignored', () => {
  const { h, vibrate } = make();
  for (const bad of [null, undefined, 5, 'x', true]) assert.equal(h.update(bad, 0), null);
  assert.equal(h.update({}, 0), null);
  assert.equal(h.update({ latG: NaN, longG: NaN, rumbleBits: 'a' }, 100), null);
  assert.deepEqual(vibrate.calls, []);
});

test('missing nowMs falls back to performance.now()', () => {
  const { h } = make();
  assert.deepEqual(h.update({ rumbleBits: 1 }), [18]);
  assert.equal(h.update({ rumbleBits: 1 }, NaN), null, 'NaN falls back too, and 90 ms have not passed');
});

test('a clock that restarts does not freeze the output', () => {
  const { h } = make();
  assert.deepEqual(h.update({ rumbleBits: 1 }, 500000), [18]);
  assert.deepEqual(h.update({ rumbleBits: 1 }, 10), [18]);
  assert.equal(h.update({ rumbleBits: 1 }, 50), null);
});

test('returned patterns are copies', () => {
  const { h } = make();
  const p = h.update({ impact: true }, 0);
  p[0] = 1;
  assert.deepEqual(h.update({ impact: true }, 1), [90]);
  assert.equal(HAPTIC.impact, 90);
});
