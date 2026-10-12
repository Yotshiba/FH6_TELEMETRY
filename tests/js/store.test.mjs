import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../fh6_telemetry/web/static/store.js';
import { Stream } from '../../fh6_telemetry/web/static/stream.js';

const COLS = ['IsRaceOn', 'SpeedKmh', 'TimestampMS'];
const hello = (over = {}) => ({
  epoch: 1, resume: false, hist: 300, tick: 30, charts: [], rg: {},
  F: COLS.map((k) => ({ k })), S: [{ k: 'LapNumber' }], ...over,
});
const rows = (n, t0 = 0) => Array.from({ length: n }, (_, i) => [1, 50 + i, t0 + i * 16]);

test('applyFrames applies a contiguous batch and tracks the sequence', () => {
  const st = new Store();
  st.setHello(hello());
  st.pushRows(rows(3), true); st.seq = 10;
  assert.equal(st.applyFrames({ s: 12, r: rows(2) }), true);
  assert.equal(st.seq, 12);
  assert.equal(st.timeline.length, 5);
});

test('applyFrames refuses a gap and leaves the store untouched; resumeId points at the last applied batch', () => {
  const st = new Store();
  st.setHello(hello({ epoch: 7 }));
  st.pushRows(rows(3), true); st.seq = 10;
  const before = st.timeline.length;
  assert.equal(st.applyFrames({ s: 15, r: rows(2) }), false);     // rows 11..13 never arrived
  assert.equal(st.seq, 10);
  assert.equal(st.timeline.length, before);
  assert.equal(st.resumeId(), '7:10');
});

test('resumeId is null before any sequence is known', () => {
  const st = new Store();
  assert.equal(st.resumeId(), null);
  st.setHello(hello());
  assert.equal(st.resumeId(), null);
});

test('gen changes whenever the history is wiped (views drop time-keyed state)', () => {
  const st = new Store();
  const g0 = st.gen;
  st.setHello(hello());
  assert.ok(st.gen > g0, 'fresh hello');
  const g1 = st.gen;
  st.setHello(hello({ resume: true }));                            // same epoch resume keeps the history
  assert.equal(st.gen, g1);
  st.clearHistory();
  assert.ok(st.gen > g1, 'clearHistory');
  const g2 = st.gen;
  st.setHello(hello({ epoch: 2, resume: true }));                  // a different epoch is a reset even if flagged resume
  assert.ok(st.gen > g2);
});

// ---- the whole resync loop, against a fake EventSource that follows the server's resume rules ----------------------

class FakeEventSource {
  static instances = [];
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeEventSource.instances.push(this); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(name, data, id = '') { for (const fn of this.listeners[name] || []) fn({ data: JSON.stringify(data), lastEventId: id }); }
}

test('a sequence gap resyncs from the last applied batch instead of looping forever', () => {
  const saved = { EventSource: globalThis.EventSource, document: globalThis.document, window: globalThis.window };
  globalThis.EventSource = FakeEventSource;
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  FakeEventSource.instances.length = 0;
  try {
    const st = new Store();
    const handlers = {
      state() {},
      hello: (d) => st.setHello(d),
      hist: (d) => { st.clearHistory(); st.pushRows(d.r, true); st.seq = d.s + d.r.length - 1; },
      f: (d, s) => {
        if (st.applyFrames(d)) return;
        s.lastId = st.resumeId();
        s.reopen();
      },
    };
    const stream = new Stream(handlers);
    stream.wantOpen = true;
    stream.open();
    let es = FakeEventSource.instances.at(-1);
    es.emit('hello', hello({ epoch: 3 }), '3:0');
    es.emit('hist', { s: 1, r: rows(1) }, '3:1');
    assert.equal(st.seq, 1);
    es.emit('f', { s: 3, r: rows(2) }, '3:3');
    assert.equal(st.seq, 3);
    es.emit('f', { s: 8, r: rows(2) }, '3:8');                      // 4..6 were skipped by the server
    assert.equal(st.seq, 3, 'the gapped batch is not applied');
    assert.ok(es.closed, 'stream reopened');
    es = FakeEventSource.instances.at(-1);
    assert.match(es.url, /since=3%3A3$/, 'resumes from the last applied batch, not from the gapped id');
    // the server answers the resume with everything after seq 3, contiguous with what we hold
    es.emit('hello', hello({ epoch: 3, resume: true }), '3:8');
    es.emit('f', { s: 8, r: rows(5) }, '3:8');
    assert.equal(st.seq, 8, 'caught up');
    assert.equal(st.timeline.length, 1 + 2 + 5);
    stream.wantOpen = false; stream.close();
  } finally {
    Object.assign(globalThis, saved);
    for (const k of ['EventSource', 'document', 'window']) if (saved[k] === undefined) delete globalThis[k];
  }
});
