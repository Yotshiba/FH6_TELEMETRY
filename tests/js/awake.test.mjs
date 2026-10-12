import test from 'node:test';
import assert from 'node:assert/strict';
import { KeepAwake, describeAwake } from '../../fh6_telemetry/web/static/awake.js';

// ---- a fake browser --------------------------------------------------------------------------------------------------

function makeEnv({ wakeLock = 'ok', captureStream = true, play = 'ok', hidden = false } = {}) {
  const intervals = new Map();
  let nextId = 1;
  const listeners = {};
  const videos = [];
  const locks = [];

  const doc = {
    hidden,
    body: { children: [], appendChild(n) { this.children.push(n); n._attached = true; return n; } },
    addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    createElement(tag) {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ({ fillRect() {} }), ...(captureStream ? { captureStream: () => ({}) } : {}) };
      }
      const v = {
        tag, paused: true, ended: false, style: {}, attrs: {}, _attached: false, muted: false,
        setAttribute(k, val) { this.attrs[k] = val; },
        async play() {
          if (play === 'ok') { this.paused = false; return; }
          const e = new Error(play); e.name = play; throw e;
        },
        pause() { this.paused = true; },
        remove() { this._attached = false; const i = doc.body.children.indexOf(this); if (i >= 0) doc.body.children.splice(i, 1); },
      };
      videos.push(v);
      return v;
    },
  };
  const nav = wakeLock === 'none' ? {} : {
    wakeLock: {
      async request(kind) {
        assert.equal(kind, 'screen');
        if (wakeLock !== 'ok') { const e = new Error('nope'); e.name = 'NotAllowedError'; throw e; }
        const l = { released: false, rel: [], addEventListener(t, fn) { if (t === 'release') this.rel.push(fn); },
          async release() { this.released = true; this.rel.forEach((f) => f()); } };
        locks.push(l);
        return l;
      },
    },
  };
  const env = {
    document: doc, navigator: nav,
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
  };
  const fire = (type, ev = {}) => [...(listeners[type] || [])].forEach((fn) => fn(ev));
  return { env, doc, videos, locks, intervals, listeners, fire, setPlay: (v) => { play = v; }, setWakeLock: (v) => { wakeLock = v; } };
}
const listenerCount = (e) => Object.values(e.listeners).reduce((n, s) => n + s.size, 0);

// ---- tests -----------------------------------------------------------------------------------------------------------------------

test('Wake Lock available: that is used and no video is created', async () => {
  const e = makeEnv();
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'wakelock');
  assert.equal(k.active, true);
  assert.equal(e.locks.length, 1);
  assert.equal(e.videos.length, 0);
  await k.disable();
  assert.equal(k.mode, 'off');
  assert.equal(e.locks[0].released, true);
});

test('plain http (no Wake Lock API): falls back to the hidden looping video', async () => {
  const e = makeEnv({ wakeLock: 'none' });
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'video');
  const [v] = e.videos;
  assert.equal(v.paused, false);
  assert.equal(v.muted, true);
  assert.equal(v.loop, true);
  assert.equal(v.attrs.playsinline, '');
  assert.equal(v._attached, true);
  assert.match(v.style.cssText, /opacity:0\.02/);
  assert.match(v.style.cssText, /pointer-events:none/);
  assert.ok([...e.intervals.values()].some((i) => i.ms === 500), 'frame painter running');
  await k.disable();
  assert.equal(v._attached, false);
  assert.equal(v.paused, true);
  assert.equal(e.intervals.size, 0, 'every timer cleared');
  assert.equal(listenerCount(e), 0, 'every listener removed');
});

test('a Wake Lock request that is refused (insecure context) also falls back to the video', async () => {
  const e = makeEnv({ wakeLock: 'refuse' });
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'video');
  assert.equal(e.videos.length, 1);
  await k.disable();
});

test('a browser that cannot do either ends as unsupported (not silently "on")', async () => {
  const e = makeEnv({ wakeLock: 'none', captureStream: false });
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'unsupported');
  assert.equal(k.active, false);
  assert.equal(e.videos.length, 0);
  await k.disable();
});

test('video blocked until a tap: pending, then the first gesture starts it', async () => {
  const e = makeEnv({ wakeLock: 'none', play: 'NotAllowedError' });
  const k = new KeepAwake(e.env);
  const seen = [];
  k.onChange((m) => seen.push(m));
  assert.equal(await k.enable(), 'pending');
  assert.equal(e.videos[0]._attached, false, 'a failed attempt leaves no video behind');
  assert.equal(e.intervals.size, 1, 'only the heartbeat remains');
  e.setPlay('ok');
  e.fire('pointerdown');
  await new Promise((r) => setImmediate(r));
  assert.equal(k.mode, 'video');
  assert.deepEqual(seen, ['pending', 'video']);
  await k.disable();
});

test('refused even after a tap: unsupported (the UI then tells the user to change auto-lock)', async () => {
  const e = makeEnv({ wakeLock: 'none', play: 'NotAllowedError' });
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'pending');
  e.fire('touchend');
  await new Promise((r) => setImmediate(r));
  assert.equal(k.mode, 'unsupported');
  await k.disable();
});

test('the browser drops the Wake Lock when the tab is hidden; coming back takes it again', async () => {
  const e = makeEnv();
  const k = new KeepAwake(e.env);
  await k.enable();
  e.doc.hidden = true;
  await e.locks[0].release();                         // browser-initiated release fires the event
  assert.equal(k.mode, 'pending');
  assert.equal(e.locks.length, 1, 'no attempt while hidden');
  e.doc.hidden = false;
  e.fire('visibilitychange');
  await new Promise((r) => setImmediate(r));
  assert.equal(k.mode, 'wakelock');
  assert.equal(e.locks.length, 2);
  await k.disable();
});

test('enabling while the tab is in the background waits, then acquires on return', async () => {
  const e = makeEnv({ hidden: true });
  const k = new KeepAwake(e.env);
  assert.equal(await k.enable(), 'pending');
  assert.equal(e.locks.length, 0);
  e.doc.hidden = false;
  e.fire('visibilitychange');
  await new Promise((r) => setImmediate(r));
  assert.equal(k.mode, 'wakelock');
  await k.disable();
});

test('enable() is idempotent: no stacked videos, timers or listeners', async () => {
  const e = makeEnv({ wakeLock: 'none' });
  const k = new KeepAwake(e.env);
  await Promise.all([k.enable(), k.enable(), k.enable()]);
  await k.enable();
  await k.reacquire();
  assert.equal(e.videos.filter((v) => v._attached).length, 1);
  assert.equal(e.intervals.size, 2, 'heartbeat + frame painter');
  assert.equal(listenerCount(e), 4, 'visibilitychange + 3 gestures, registered once');
  await k.disable();
  assert.equal(e.intervals.size, 0);
  assert.equal(listenerCount(e), 0);
});

test('the heartbeat revives a video the system paused', async () => {
  const e = makeEnv({ wakeLock: 'none' });
  const k = new KeepAwake(e.env);
  await k.enable();
  e.videos[0].paused = true;                          // e.g. a phone call or power saver paused it
  const beat = [...e.intervals.values()].find((i) => i.ms === 20000);
  beat.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(k.mode, 'video');
  assert.equal(e.videos.filter((v) => v._attached).length, 1, 'the old video was replaced, not duplicated');
  assert.equal(e.videos.at(-1).paused, false);
  await k.disable();
});

test('switching to Wake Lock later (page became secure) retires the video', async () => {
  const e = makeEnv({ wakeLock: 'refuse' });
  const k = new KeepAwake(e.env);
  await k.enable();
  assert.equal(k.mode, 'video');
  e.setWakeLock('ok');
  e.videos[0].paused = true;
  await k.reacquire();
  assert.equal(k.mode, 'wakelock');
  assert.equal(e.videos.filter((v) => v._attached).length, 0);
  await k.disable();
});

test('disable() during an in-flight request does not leave a lock behind', async () => {
  const e = makeEnv();
  const k = new KeepAwake(e.env);
  const p = k.enable();
  await k.disable();
  await p;
  assert.equal(k.mode, 'off');
  assert.ok(e.locks.every((l) => l.released), 'any lock that was granted is released');
});

test('listeners: ordered notifications, unsubscribe, and a throwing listener does not break anything', async () => {
  const e = makeEnv();
  const k = new KeepAwake(e.env);
  const a = [];
  const off = k.onChange((m) => a.push(m));
  k.onChange(() => { throw new Error('boom'); });
  await k.enable();
  off();
  await k.disable();
  assert.deepEqual(a, ['wakelock']);
  assert.equal(k.mode, 'off');
});

test('importing the module and constructing it touches no browser global', () => {
  assert.doesNotThrow(() => new KeepAwake());
});

test('describeAwake has a sentence for every mode', () => {
  for (const m of ['off', 'wakelock', 'video', 'pending', 'unsupported']) assert.ok(describeAwake(m).length > 10, m);
  assert.match(describeAwake('unsupported'), /auto-lock|screen saver/i);
});
