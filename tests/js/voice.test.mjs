import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Voice, describeEvent, lowFuelPhrase, tyreWarning, spokenNumber, eventKey, eventPriority,
} from '../../fh6_telemetry/web/static/voice.js';

class FakeSynth {
  constructor() { this.spoken = []; this.cancels = 0; }
  speak(u) { this.spoken.push(u); }
  cancel() { this.cancels++; }
  get texts() { return this.spoken.map((u) => u.text); }
}
const makeUtterance = (text) => ({ text });

function make(opts = {}) {
  const synth = new FakeSynth();
  const v = new Voice({ synth, makeUtterance, enabled: true, ...opts });
  return { v, synth };
}

// ---------------------------------------------------------------------------
// spokenNumber
// ---------------------------------------------------------------------------

test('spokenNumber speaks integers naturally', () => {
  const cases = [
    [0, 'zero'], [7, 'seven'], [13, 'thirteen'], [20, 'twenty'], [21, 'twenty-one'], [99, 'ninety-nine'],
    [100, 'one hundred'], [101, 'one hundred and one'], [124, 'one hundred and twenty-four'],
    [150, 'one hundred and fifty'], [200, 'two hundred'], [250, 'two hundred and fifty'], [999, 'nine hundred and ninety-nine'],
    [1000, 'one thousand'], [1005, 'one thousand and five'], [1250, 'one thousand two hundred and fifty'],
    [21000, 'twenty-one thousand'], [-5, 'minus five'],
  ];
  for (const [n, words] of cases) assert.equal(spokenNumber(n), words, String(n));
  assert.equal(spokenNumber(199.6), 'two hundred', 'rounds');
  assert.equal(spokenNumber(1234567), '1234567', 'huge numbers left as digits');
  for (const bad of [NaN, Infinity, undefined, null, '5']) assert.equal(spokenNumber(bad), '');
});

// ---------------------------------------------------------------------------
// describeEvent
// ---------------------------------------------------------------------------

test('speed_milestone', () => {
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 200 }), 'Two hundred kilometres an hour');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 150 }), 'One hundred and fifty kilometres an hour');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 100 }, { speed: 'kmh', dist: 'km' }), 'One hundred kilometres an hour');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 200 }, { speed: 'mph', dist: 'mi' }), 'One hundred and twenty-four miles an hour');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 322 }, { speed: 'mph' }), 'Two hundred miles an hour');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 200 }, { dist: 'mi' }), 'Two hundred kilometres an hour', 'partial units merge with defaults');
  assert.equal(describeEvent({ type: 'speed_milestone', kmh: 200 }, null), 'Two hundred kilometres an hour');
  for (const kmh of [0, -50, NaN, undefined, '200']) assert.equal(describeEvent({ type: 'speed_milestone', kmh }), null);
});

test('drift_end only for 1000+ points', () => {
  assert.equal(describeEvent({ type: 'drift_end', score: 2400, durationS: 5 }), 'Drift, 2400 points');
  assert.equal(describeEvent({ type: 'drift_end', score: 1000, durationS: 2 }), 'Drift, 1000 points');
  assert.equal(describeEvent({ type: 'drift_end', score: 2400.6 }), 'Drift, 2401 points');
  assert.equal(describeEvent({ type: 'drift_end', score: 999.9, durationS: 9 }), null);
  assert.equal(describeEvent({ type: 'drift_end', score: NaN }), null);
  assert.equal(describeEvent({ type: 'drift_end' }), null);
});

test('air_end only for 1 s or more', () => {
  assert.equal(describeEvent({ type: 'air_end', durationS: 1.4 }), 'Big air, 1.4 seconds');
  assert.equal(describeEvent({ type: 'air_end', durationS: 1 }), 'Big air, 1 second');
  assert.equal(describeEvent({ type: 'air_end', durationS: 2.04 }), 'Big air, 2 seconds');
  assert.equal(describeEvent({ type: 'air_end', durationS: 0.99 }), null);
  assert.equal(describeEvent({ type: 'air_end', durationS: NaN }), null);
});

test('perf: zero-to-speed times', () => {
  assert.equal(describeEvent({ type: 'perf', key: 't100', value: 3.1 }), 'Zero to one hundred in 3.1 seconds');
  assert.equal(describeEvent({ type: 'perf', key: 't60mph', value: 3.46 }), 'Zero to sixty in 3.5 seconds');
  assert.equal(describeEvent({ type: 'perf', key: 't200', value: 9.8 }), 'Zero to two hundred in 9.8 seconds');
  assert.equal(describeEvent({ type: 'perf', key: 't100', value: 3 }), 'Zero to one hundred in 3 seconds');
  assert.equal(describeEvent({ type: 'perf', key: 't100', value: 3100 }), 'Zero to one hundred in 3.1 seconds', 'milliseconds are accepted');
  assert.equal(describeEvent({ type: 'perf', key: 't100', value: { time: 2.5 } }), 'Zero to one hundred in 2.5 seconds');
  for (const value of [0, -1, NaN, undefined, null, 'x']) assert.equal(describeEvent({ type: 'perf', key: 't100', value }), null);
  assert.equal(describeEvent({ type: 'perf', key: 'mystery', value: 3 }), null);
  assert.equal(describeEvent({ type: 'perf', value: 3 }), null);
});

test('perf: quarter mile and 100-0 braking', () => {
  assert.equal(describeEvent({ type: 'perf', key: 'qmile', value: { time: 11.42, trapKmh: 210 } }),
    'Quarter mile in 11.4 seconds, trap speed two hundred and ten kilometres an hour');
  assert.equal(describeEvent({ type: 'perf', key: 'qmile', value: { time: 11.42, trapKmh: 210 } }, { speed: 'mph' }),
    'Quarter mile in 11.4 seconds, trap speed one hundred and thirty miles an hour');
  assert.equal(describeEvent({ type: 'perf', key: 'qmile', value: { time: 12 } }), 'Quarter mile in 12 seconds', 'trap speed optional');
  assert.equal(describeEvent({ type: 'perf', key: 'qmile', value: { trapKmh: 200 } }), null);
  assert.equal(describeEvent({ type: 'perf', key: 'brake100', value: { dist: 34.2, time: 2.9 } }), 'One hundred to zero in 34 metres');
  assert.equal(describeEvent({ type: 'perf', key: 'brake100', value: { dist: 34.2, time: 2.9 } }, { dist: 'mi' }), 'One hundred to zero in 112 feet');
  assert.equal(describeEvent({ type: 'perf', key: 'brake100', value: { time: 2.9 } }), 'One hundred to zero in 2.9 seconds', 'falls back to the time');
  assert.equal(describeEvent({ type: 'perf', key: 'brake100', value: {} }), null);
  assert.equal(describeEvent({ type: 'perf', key: 'brake100', value: null }), null);
});

test('lap', () => {
  assert.equal(describeEvent({ type: 'lap', number: 2, timeMs: 72400, best: true }), 'Lap 2, 1 minute 12.4. Best lap!');
  assert.equal(describeEvent({ type: 'lap', number: 3, timeMs: 72400, best: false }), 'Lap 3, 1 minute 12.4');
  assert.equal(describeEvent({ type: 'lap', number: 3, timeMs: 72400 }), 'Lap 3, 1 minute 12.4');
  assert.equal(describeEvent({ type: 'lap', number: 4, timeMs: 132500 }), 'Lap 4, 2 minutes 12.5');
  assert.equal(describeEvent({ type: 'lap', number: 1, timeMs: 52400 }), 'Lap 1, 52.4 seconds');
  assert.equal(describeEvent({ type: 'lap', number: 1, timeMs: 119960 }), 'Lap 1, 2 minutes 0.0', 'no 1:60.0');
  assert.equal(describeEvent({ type: 'lap', number: 1, timeMs: 59970 }), 'Lap 1, 1 minute 0.0', 'rounding carries into the minute');
  assert.equal(describeEvent({ type: 'lap', number: 5 }), 'Lap 5');
  assert.equal(describeEvent({ type: 'lap', number: 5, timeMs: 0, best: true }), 'Lap 5. Best lap!');
  assert.equal(describeEvent({ type: 'lap', timeMs: 72400 }), 'Lap complete, 1 minute 12.4');
  assert.equal(describeEvent({ type: 'lap' }), null);
  assert.equal(describeEvent({ type: 'lap', number: NaN, timeMs: NaN, best: true }), null);
});

test('achievement', () => {
  assert.equal(describeEvent({ type: 'achievement', title: 'Speed Demon' }), 'Achievement unlocked, Speed Demon');
  assert.equal(describeEvent({ type: 'achievement', title: '  Spaces  ' }), 'Achievement unlocked, Spaces');
  assert.equal(describeEvent({ type: 'achievement', title: '' }), null);
  assert.equal(describeEvent({ type: 'achievement', title: '   ' }), null);
  assert.equal(describeEvent({ type: 'achievement' }), null);
  assert.equal(describeEvent({ type: 'achievement', title: 42 }), null);
  assert.ok(describeEvent({ type: 'achievement', title: 'x'.repeat(500) }).length < 120);
});

test('redline, record, unknown and malformed events are silent', () => {
  assert.equal(describeEvent({ type: 'redline' }), null);
  assert.equal(describeEvent({ type: 'record', key: 'topSpeed', value: 300 }), null);
  assert.equal(describeEvent({ type: 'something_else' }), null);
  for (const bad of [null, undefined, 0, 'lap', [], {}, { type: 5 }]) assert.equal(describeEvent(bad), null);
});

test('eventKey and eventPriority', () => {
  assert.equal(eventKey({ type: 'speed_milestone', kmh: 200 }), 'speed_milestone:200');
  assert.equal(eventKey({ type: 'speed_milestone', kmh: 250 }), 'speed_milestone:250');
  assert.equal(eventKey({ type: 'perf', key: 't100' }), 'perf:t100');
  assert.equal(eventKey({ type: 'lap' }), 'lap');
  assert.equal(eventKey({}), null);
  assert.equal(eventKey(null), null);
  assert.equal(eventPriority({ type: 'lap' }), 1);
  assert.equal(eventPriority({ type: 'perf' }), 1);
  assert.equal(eventPriority({ type: 'achievement' }), 1);
  assert.equal(eventPriority({ type: 'drift_end' }), 0);
  assert.equal(eventPriority({ type: 'air_end' }), 0);
  assert.equal(eventPriority(null), 0);
});

// ---------------------------------------------------------------------------
// lowFuelPhrase / tyreWarning
// ---------------------------------------------------------------------------

test('lowFuelPhrase thresholds', () => {
  assert.equal(lowFuelPhrase(50), null);
  assert.equal(lowFuelPhrase(15.1), null);
  assert.equal(lowFuelPhrase(15), 'Low fuel');
  assert.equal(lowFuelPhrase(10), 'Low fuel');
  assert.equal(lowFuelPhrase(7.1), 'Low fuel');
  assert.equal(lowFuelPhrase(7), 'Fuel critical');
  assert.equal(lowFuelPhrase(2), 'Fuel critical');
  assert.equal(lowFuelPhrase(0), 'Fuel critical');
  for (const bad of [NaN, undefined, null, '5', Infinity]) assert.equal(lowFuelPhrase(bad), null);
});

test('tyreWarning', () => {
  assert.equal(tyreWarning([90, 95, 100, 99]), null);
  assert.equal(tyreWarning([90, 95, 115, 99]), null, 'exactly at the threshold is fine');
  assert.equal(tyreWarning([90, 95, 115.1, 99]), 'Tyres overheating');
  assert.equal(tyreWarning([120, 0, 0, 0]), 'Tyres overheating');
  assert.equal(tyreWarning([100, 100, 100, 100], 90), 'Tyres overheating');
  assert.equal(tyreWarning([100, 100, 100, 100], 120), null);
  assert.equal(tyreWarning(new Float64Array([80, 130, 80, 80])), 'Tyres overheating');
  assert.equal(tyreWarning({ FL: 80, FR: 130, RL: 80, RR: 80 }), 'Tyres overheating');
  assert.equal(tyreWarning(130), 'Tyres overheating');
  assert.equal(tyreWarning([90, NaN, undefined, 'hot']), null);
  assert.equal(tyreWarning([], 115), null);
  assert.equal(tyreWarning(null), null);
  assert.equal(tyreWarning(undefined), null);
  assert.equal(tyreWarning([116], NaN), 'Tyres overheating', 'bad threshold falls back to 115');
});

// ---------------------------------------------------------------------------
// Voice: support, enabling, utterance
// ---------------------------------------------------------------------------

test('disabled by default: speak does nothing', () => {
  const synth = new FakeSynth();
  const v = new Voice({ synth, makeUtterance });
  assert.equal(v.enabled, false);
  assert.equal(v.speak('Hello', {}, 0), false);
  assert.deepEqual(synth.spoken, []);
  v.setEnabled(true);
  assert.equal(v.speak('Hello', {}, 0), true);
});

test('unsupported: no synth, a synth without speak(), or no utterance factory', () => {
  const saved = globalThis.SpeechSynthesisUtterance;
  delete globalThis.SpeechSynthesisUtterance;
  try {
    for (const opts of [
      { synth: null, makeUtterance },
      { synth: {}, makeUtterance },
      { synth: { speak: 1 }, makeUtterance },
      { synth: new FakeSynth() },                    // no makeUtterance and no global constructor
    ]) {
      const v = new Voice({ enabled: true, ...opts });
      assert.equal(v.supported, false);
      assert.equal(v.speak('Hello', {}, 0), false);
      assert.equal(v.speaking, false);
      assert.doesNotThrow(() => v.cancel());
      assert.doesNotThrow(() => v.setEnabled(false));
      assert.equal(v.speakEvent({ type: 'lap', number: 1, timeMs: 60000 }, 0), false);
    }
    assert.equal(new Voice({ enabled: true }).supported, false, 'plain Node: no speechSynthesis at all');
  } finally {
    if (saved !== undefined) globalThis.SpeechSynthesisUtterance = saved;
  }
});

test('defaults come from the browser globals when present', () => {
  const savedSynth = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const savedU = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  try {
    const synth = new FakeSynth();
    Object.defineProperty(globalThis, 'speechSynthesis', { value: synth, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      value: class { constructor(text) { this.text = text; this.ctor = true; } }, configurable: true, writable: true,
    });
    const v = new Voice({ enabled: true });
    assert.equal(v.supported, true);
    assert.equal(v.speak('Hi there', {}, 0), true);
    assert.equal(synth.spoken[0].ctor, true);
    assert.equal(synth.spoken[0].text, 'Hi there');
    assert.equal(new Voice({ enabled: true, synth: null }).supported, false, 'explicit null overrides the global');
  } finally {
    if (savedSynth) Object.defineProperty(globalThis, 'speechSynthesis', savedSynth); else delete globalThis.speechSynthesis;
    if (savedU) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', savedU); else delete globalThis.SpeechSynthesisUtterance;
  }
});

test('the utterance carries text, rate, pitch, volume, lang and end callbacks', () => {
  const { v, synth } = make({ volume: 0.4, rate: 1.2, pitch: 0.9, lang: 'en-GB' });
  assert.equal(v.speak('  Two hundred  ', {}, 0), true);
  const u = synth.spoken[0];
  assert.equal(u.text, 'Two hundred');
  assert.equal(u.volume, 0.4);
  assert.equal(u.rate, 1.2);
  assert.equal(u.pitch, 0.9);
  assert.equal(u.lang, 'en-GB');
  assert.equal(typeof u.onend, 'function');
  assert.equal(typeof u.onerror, 'function');
  const d = make().synth;
  const w = new Voice({ synth: d, makeUtterance, enabled: true });
  w.speak('x', {}, 0);
  assert.equal(d.spoken[0].volume, 1);
  assert.equal(d.spoken[0].lang, 'en-US');
});

test('setVolume applies to later utterances and is clamped', () => {
  const { v, synth } = make();
  v.setVolume(0.25);
  v.speak('a', {}, 0);
  v.setVolume(5);
  v.speak('b', { priority: 2 }, 10);
  v.setVolume(NaN);
  v.setVolume(-1);
  v.speak('c', { priority: 3 }, 20);
  assert.deepEqual(synth.spoken.map((u) => u.volume), [0.25, 1, 0]);
});

test('empty or non-string text is ignored', () => {
  const { v, synth } = make();
  for (const t of ['', '   ', null, undefined, 42, {}]) assert.equal(v.speak(t, {}, 0), false);
  assert.deepEqual(synth.spoken, []);
});

test('garbage options are tolerated', () => {
  const { v, synth } = make();
  assert.equal(v.speak('a', null, 0), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('b', 'x', 5000), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('c', { priority: 'high', key: undefined }, 10000), true);
});

// ---------------------------------------------------------------------------
// Voice: speaking state
// ---------------------------------------------------------------------------

test('speaking follows onend', () => {
  const { v, synth } = make();
  assert.equal(v.speaking, false);
  v.speak('a', {}, 0);
  assert.equal(v.speaking, true);
  synth.spoken[0].onend();
  assert.equal(v.speaking, false);
});

test('speaking follows onerror', () => {
  const { v, synth } = make();
  v.speak('a', {}, 0);
  synth.spoken[0].onerror({ error: 'interrupted' });
  assert.equal(v.speaking, false);
});

test('onend that fires synchronously inside speak() does not leave a stuck speaking flag', () => {
  const synth = { spoken: [], speak(u) { this.spoken.push(u); u.onend(); }, cancel() {} };
  const v = new Voice({ synth, makeUtterance, enabled: true });
  assert.equal(v.speak('a', {}, 0), true);
  assert.equal(v.speaking, false);
});

test('cancel() stops speaking and calls synth.cancel()', () => {
  const { v, synth } = make();
  v.speak('a', {}, 0);
  v.cancel();
  assert.equal(v.speaking, false);
  assert.equal(synth.cancels, 1);
  synth.spoken[0].onend();                               // late callback is harmless
  assert.equal(v.speaking, false);
});

test('setEnabled(false) cancels the current phrase', () => {
  const { v, synth } = make();
  v.speak('a', {}, 0);
  v.setEnabled(false);
  assert.equal(v.speaking, false);
  assert.equal(synth.cancels, 1);
  assert.equal(v.speak('b', { priority: 5 }, 100000), false);
});

test('a stale speaking flag (onend never fired) is cleared after maxUtteranceMs', () => {
  const { v, synth } = make();
  v.speak('a', { priority: 1 }, 0);
  assert.equal(v.speak('b', { priority: 0 }, 14000), false, 'still within the safety window');
  assert.equal(v.speak('b', { priority: 0 }, 15001), true);
  assert.equal(synth.texts.join('|'), 'a|b');
  assert.equal(synth.cancels, 0, 'no cancel needed, the old one was presumed finished');
});

// ---------------------------------------------------------------------------
// Voice: cooldowns, priority, gap
// ---------------------------------------------------------------------------

test('per-key cooldown of 8 s', () => {
  const { v, synth } = make({ minGapMs: 0 });
  assert.equal(v.speak('Low fuel', { key: 'fuel' }, 0), true);
  synth.spoken[0].onend();
  assert.equal(v.speak('Low fuel', { key: 'fuel' }, 7999), false);
  assert.equal(v.speak('Low fuel', { key: 'fuel' }, 8000), true);
  synth.spoken[1].onend();
  assert.equal(v.speak('Low fuel', { key: 'fuel' }, 15999), false, 'cooldown restarts at the last spoken time');
  assert.equal(v.speak('Low fuel', { key: 'fuel' }, 16000), true);
  assert.equal(synth.spoken.length, 3);
});

test('different keys and no key do not share a cooldown', () => {
  const { v, synth } = make({ minGapMs: 0 });
  assert.equal(v.speak('a', { key: 'one' }, 0), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('b', { key: 'two' }, 10), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('c', {}, 20), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('c', {}, 30), true, 'no key, no cooldown');
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('a again', { key: 'one' }, 40), false);
});

test('priority >= 2 ignores the key cooldown (priority 1 does not)', () => {
  const { v, synth } = make({ minGapMs: 0 });
  v.speak('Fuel critical', { key: 'fuel', priority: 2 }, 0);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('Fuel critical', { key: 'fuel', priority: 1 }, 1000), false);
  assert.equal(v.speak('Fuel critical', { key: 'fuel', priority: 2 }, 1000), true);
  synth.spoken.at(-1).onend();
  assert.equal(v.speak('Fuel critical', { key: 'fuel', priority: 3 }, 1100), true);
});

test('a phrase dropped for another reason does not start a key cooldown', () => {
  const { v, synth } = make({ minGapMs: 0 });
  v.speak('long phrase', { priority: 1 }, 0);
  assert.equal(v.speak('x', { key: 'k', priority: 0 }, 100), false, 'dropped: lower priority while speaking');
  synth.spoken[0].onend();
  assert.equal(v.speak('x', { key: 'k', priority: 0 }, 200), true, 'never spoken before, so no cooldown');
});

test('while speaking, lower and equal priority phrases are dropped', () => {
  const { v, synth } = make({ minGapMs: 0 });
  assert.equal(v.speak('current', { priority: 1 }, 0), true);
  assert.equal(v.speak('lower', { priority: 0 }, 100), false);
  assert.equal(v.speak('equal', { priority: 1 }, 200), false);
  assert.deepEqual(synth.texts, ['current']);
  assert.equal(synth.cancels, 0);
  assert.equal(v.speaking, true);
});

test('a higher priority phrase cancels the current one and speaks', () => {
  const { v, synth } = make({ minGapMs: 5000 });
  v.speak('drift', { priority: 0 }, 0);
  assert.equal(v.speak('Low fuel', { priority: 1 }, 100), true, 'preemption ignores the gap');
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.texts, ['drift', 'Low fuel']);
  assert.equal(v.speaking, true);
  assert.equal(v.speak('Fuel critical', { priority: 2 }, 200), true);
  assert.equal(synth.cancels, 2);
  assert.equal(v.speak('another one', { priority: 2 }, 300), false, 'equal priority does not preempt');
  assert.deepEqual(synth.texts, ['drift', 'Low fuel', 'Fuel critical']);
});

test('cancel() is called before the new speak()', () => {
  const order = [];
  const synth = { speak: () => order.push('speak'), cancel: () => order.push('cancel') };
  const v = new Voice({ synth, makeUtterance, enabled: true });
  v.speak('a', { priority: 0 }, 0);
  v.speak('b', { priority: 1 }, 10);
  assert.deepEqual(order, ['speak', 'cancel', 'speak']);
});

test('a late onend from a cancelled utterance does not clear its successor', () => {
  const { v, synth } = make();
  v.speak('first', { priority: 0 }, 0);
  v.speak('second', { priority: 1 }, 100);
  const [first, second] = synth.spoken;
  first.onerror({ error: 'canceled' });
  assert.equal(v.speaking, true, 'second is still being spoken');
  second.onend();
  assert.equal(v.speaking, false);
});

test('preemption still works if the old utterance reports end synchronously from cancel()', () => {
  const synth = {
    spoken: [],
    speak(u) { this.spoken.push(u); },
    cancel() { const u = this.spoken.at(-1); if (u && u.onerror) u.onerror({ error: 'canceled' }); },
  };
  const v = new Voice({ synth, makeUtterance, enabled: true });
  v.speak('a', { priority: 0 }, 0);
  assert.equal(v.speak('b', { priority: 1 }, 10), true);
  assert.equal(v.speaking, true);
});

test('minGapMs between utterances (counted from the start without a clock)', () => {
  const { v, synth } = make({ minGapMs: 1500 });
  assert.equal(v.speak('a', {}, 1000), true);
  synth.spoken[0].onend();
  assert.equal(v.speak('b', {}, 1000), false);
  assert.equal(v.speak('b', {}, 2499), false);
  assert.equal(v.speak('b', {}, 2500), true);
  synth.spoken[1].onend();
  assert.equal(v.speak('c', {}, 3000), false);
  assert.equal(v.speak('c', {}, 4000), true);
  assert.deepEqual(synth.texts, ['a', 'b', 'c']);
});

test('minGapMs counts from the end of the utterance when a clock is injected', () => {
  let t = 0;
  const { v, synth } = make({ minGapMs: 1500, clock: () => t });
  assert.equal(v.speak('a', {}, 0), true);
  t = 3000;                                              // the phrase took three seconds
  synth.spoken[0].onend();
  assert.equal(v.speak('b', {}, 3000), false);
  assert.equal(v.speak('b', {}, 4499), false);
  assert.equal(v.speak('b', {}, 4500), true);
});

test('priority >= 2 ignores the minimum gap', () => {
  const { v, synth } = make({ minGapMs: 5000 });
  v.speak('a', {}, 0);
  synth.spoken[0].onend();
  assert.equal(v.speak('b', { priority: 1 }, 100), false);
  assert.equal(v.speak('Fuel critical', { priority: 2 }, 100), true);
});

test('minGapMs of 0 allows back-to-back phrases', () => {
  const { v, synth } = make({ minGapMs: 0 });
  v.speak('a', {}, 0);
  synth.spoken[0].onend();
  assert.equal(v.speak('b', {}, 0), true);
});

test('a clock that restarts does not block speech forever', () => {
  const { v, synth } = make();
  v.speak('a', { key: 'k' }, 900000);
  synth.spoken[0].onend();
  assert.equal(v.speak('a', { key: 'k' }, 1000), true, 'time went backwards: cooldown and gap forgotten');
});

test('missing nowMs falls back to the injected clock', () => {
  let t = 5000;
  const { v, synth } = make({ clock: () => t, minGapMs: 1500 });
  assert.equal(v.speak('a'), true);
  synth.spoken[0].onend();
  assert.equal(v.speak('b'), false);
  t = 7000;
  assert.equal(v.speak('b'), true);
});

// ---------------------------------------------------------------------------
// Voice: failures and speakEvent
// ---------------------------------------------------------------------------

test('a synth that throws on speak() yields false and leaves no stuck state', () => {
  const synth = { speak() { throw new Error('synth busy'); }, cancel() {} };
  const v = new Voice({ synth, makeUtterance, enabled: true, minGapMs: 0 });
  assert.equal(v.speak('a', { key: 'k' }, 0), false);
  assert.equal(v.speaking, false);
  synth.speak = (u) => { synth.last = u; };
  assert.equal(v.speak('a', { key: 'k' }, 10), true, 'a failed attempt left no key cooldown behind');
});

test('a synth that throws on cancel() is tolerated', () => {
  const synth = { spoken: [], speak(u) { this.spoken.push(u); }, cancel() { throw new Error('nope'); } };
  const v = new Voice({ synth, makeUtterance, enabled: true });
  v.speak('a', { priority: 0 }, 0);
  assert.equal(v.speak('b', { priority: 1 }, 10), true);
  assert.doesNotThrow(() => v.cancel());
  assert.doesNotThrow(() => v.setEnabled(false));
});

test('a makeUtterance that throws or returns junk yields false', () => {
  for (const make1 of [() => { throw new Error('no ctor'); }, () => null, () => 'str']) {
    const synth = new FakeSynth();
    const v = new Voice({ synth, makeUtterance: make1, enabled: true });
    assert.equal(v.speak('a', {}, 0), false);
    assert.deepEqual(synth.spoken, []);
    assert.equal(v.speaking, false);
  }
});

test('speakEvent describes, keys and prioritises an event', () => {
  const { v, synth } = make({ minGapMs: 0 });
  assert.equal(v.speakEvent({ type: 'speed_milestone', kmh: 200 }, 0), true);
  synth.spoken.at(-1).onend();
  assert.equal(synth.texts[0], 'Two hundred kilometres an hour');
  assert.equal(v.speakEvent({ type: 'speed_milestone', kmh: 200 }, 1000), false, 'same milestone, key cooldown');
  assert.equal(v.speakEvent({ type: 'speed_milestone', kmh: 250 }, 1000), true, 'different milestone, different key');
  synth.spoken.at(-1).onend();
  assert.equal(v.speakEvent({ type: 'redline' }, 20000), false);
  assert.equal(v.speakEvent({ type: 'drift_end', score: 500 }, 20000), false);
  // lap (priority 1) preempts a drift callout (priority 0)
  assert.equal(v.speakEvent({ type: 'drift_end', score: 3000 }, 30000), true);
  assert.equal(v.speakEvent({ type: 'lap', number: 2, timeMs: 72400, best: true }, 30100), true);
  assert.equal(synth.texts.at(-1), 'Lap 2, 1 minute 12.4. Best lap!');
  assert.equal(synth.cancels, 1);
});

test('speakEvent honours units from the constructor and setUnits', () => {
  const { v, synth } = make({ units: { speed: 'mph' }, minGapMs: 0 });
  v.speakEvent({ type: 'speed_milestone', kmh: 200 }, 0);
  assert.equal(synth.texts[0], 'One hundred and twenty-four miles an hour');
  synth.spoken[0].onend();
  v.setUnits({ speed: 'kmh' });
  v.speakEvent({ type: 'speed_milestone', kmh: 300 }, 100);
  assert.equal(synth.texts[1], 'Three hundred kilometres an hour');
});
