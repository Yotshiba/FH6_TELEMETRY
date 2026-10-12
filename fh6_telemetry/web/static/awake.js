// Keep the device awake while the dashboard is open (no screen dimming, no screen saver, no auto-lock).
//
// Two layers, tried in this order:
//   1. the Screen Wake Lock API: the proper way, but browsers only offer it in a *secure context*
//      (https:// or localhost), so it is normally NOT available when you open http://192.168.x.x:8077
//   2. a tiny looping, muted, audio-less video (the "NoSleep" trick): browsers keep the screen on while a
//      visible video plays. Phones usually insist on a tap before a video may start, so this layer waits
//      for the first touch / click / key and retries by itself.
//
// `mode` tells the UI what is going on:
//   'off'          not wanted
//   'wakelock'     held through the Wake Lock API
//   'video'        held through the video trick
//   'pending'      wanted but not holding yet (waiting for a tap, or the tab is in the background)
//   'unsupported'  this browser refused both layers: the user must change the device's auto-lock setting
//
// All environment access goes through `env` so the logic can be unit-tested without a browser.

const GESTURES = ['pointerdown', 'touchend', 'keydown'];
const HEARTBEAT_MS = 20000;

export class KeepAwake {
  /** @param {{navigator?: any, document?: any, setInterval?: Function, clearInterval?: Function}} [env] */
  constructor(env = {}) {
    this.env = env;
    this.mode = 'off';
    this.wanted = false;
    this.lock = null;
    this.video = null;
    this.tick = null;
    this.beat = null;
    this.listeners = new Set();
    this._busy = null;
    this._watching = false;
    this._onGesture = () => { if (this.wanted && !this.active) this._acquire(true); };
    this._onVisible = () => { const d = this._doc(); if (this.wanted && d && !d.hidden) this.reacquire(); };
  }

  // ---- environment (resolved lazily so importing this module never touches a browser global) --------------------
  _nav() { return this.env.navigator || (typeof navigator !== 'undefined' ? navigator : undefined); }
  _doc() { return this.env.document || (typeof document !== 'undefined' ? document : undefined); }
  _setInterval(fn, ms) { return (this.env.setInterval || globalThis.setInterval)(fn, ms); }
  _clearInterval(id) { (this.env.clearInterval || globalThis.clearInterval)(id); }

  // ---- state ----------------------------------------------------------------------------------------------------------------
  get active() { return this.mode === 'wakelock' || this.mode === 'video'; }

  /** Subscribe to mode changes: fn(mode, keepAwake). Returns an unsubscribe function. */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _set(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const fn of [...this.listeners]) { try { fn(mode, this); } catch { /* a bad listener must not break the lock */ } }
  }

  /** Is what we hold still holding? (a released lock or a paused video is not) */
  _healthy() {
    if (this.mode === 'wakelock') return !!this.lock && this.lock.released !== true;
    if (this.mode === 'video') return !!this.video && !this.video.paused && !this.video.ended;
    return false;
  }

  // ---- public API -----------------------------------------------------------------------------------------------------------
  /** Start keeping the device awake. Safe to call repeatedly. Resolves with the resulting mode. */
  async enable() {
    this.wanted = true;
    this._startWatching();
    return this._acquire(false);
  }

  /** Stop, release everything and detach every listener / timer. */
  async disable() {
    this.wanted = false;
    this._stopWatching();
    const lock = this.lock;
    this.lock = null;
    try { if (lock && typeof lock.release === 'function') await lock.release(); } catch { /* already released */ }
    this._dropVideo();
    this._set('off');
  }

  /** Take the lock again if it was lost (tab came back, system paused the video ...). */
  async reacquire() {
    if (!this.wanted) return this.mode;
    return this._acquire(false);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------
  _startWatching() {
    if (this._watching) return;
    this._watching = true;
    const d = this._doc();
    if (d && d.addEventListener) {
      d.addEventListener('visibilitychange', this._onVisible);
      for (const g of GESTURES) d.addEventListener(g, this._onGesture, { capture: true, passive: true });
    }
    // a periodic check also covers a system that silently paused our video or dropped the lock
    this.beat = this._setInterval(() => {
      const doc = this._doc();
      if (this.wanted && !(doc && doc.hidden) && !this._healthy()) this._acquire(false);
    }, HEARTBEAT_MS);
  }

  _stopWatching() {
    if (!this._watching) return;
    this._watching = false;
    const d = this._doc();
    if (d && d.removeEventListener) {
      d.removeEventListener('visibilitychange', this._onVisible);
      for (const g of GESTURES) d.removeEventListener(g, this._onGesture, { capture: true });
    }
    if (this.beat !== null) this._clearInterval(this.beat);
    this.beat = null;
  }

  _acquire(fromGesture) {
    if (!this.wanted) return Promise.resolve(this.mode);
    if (this._busy) return this._busy;                 // one attempt at a time
    const run = this._tryAll(fromGesture);
    this._busy = run;
    const done = () => { if (this._busy === run) this._busy = null; };
    run.then(done, done);
    return run;
  }

  async _tryAll(fromGesture) {
    const d = this._doc();
    if (this._healthy()) return this.mode;
    if (d && d.hidden) { if (!this.active) this._set('pending'); return this.mode; }   // nothing can be held from the background

    // 1. Screen Wake Lock (secure contexts only)
    const nav = this._nav();
    if (nav && nav.wakeLock && typeof nav.wakeLock.request === 'function') {
      try {
        const lock = await nav.wakeLock.request('screen');
        if (!this.wanted) { try { await lock.release(); } catch { /* ignore */ } return this.mode; }
        this._dropVideo();
        this.lock = lock;
        if (typeof lock.addEventListener === 'function') {
          lock.addEventListener('release', () => {            // e.g. the tab was hidden: the browser drops the lock
            if (this.lock !== lock) return;
            this.lock = null;
            if (this.wanted) { this._set('pending'); this._acquire(false); }
          });
        }
        this._set('wakelock');
        return this.mode;
      } catch { /* insecure context, battery saver, policy: fall through to the video */ }
    }

    // 2. the hidden looping video
    const r = await this._startVideo();
    if (!this.wanted) { this._dropVideo(); return this.mode; }
    if (r.ok) { this._set('video'); return this.mode; }
    // refused for lack of a tap: wait for one; refused even after a tap: this browser can't do it
    this._set(r.needsGesture && !fromGesture ? 'pending' : 'unsupported');
    return this.mode;
  }

  async _startVideo() {
    const d = this._doc();
    if (!d || !d.createElement) return { ok: false };
    this._dropVideo();                                     // never stack a second video / timer
    let v = null, tick = null;
    try {
      const cv = d.createElement('canvas');
      cv.width = cv.height = 32;
      if (typeof cv.captureStream !== 'function') return { ok: false };
      const cx = cv.getContext('2d');
      let n = 0;
      const paint = () => { cx.fillStyle = (n++ & 1) ? '#000000' : '#010101'; cx.fillRect(0, 0, 32, 32); };
      paint();
      v = d.createElement('video');
      v.muted = true; v.defaultMuted = true; v.loop = true; v.autoplay = true;
      for (const [k, val] of [['muted', ''], ['playsinline', ''], ['webkit-playsinline', ''], ['disablepictureinpicture', ''], ['aria-hidden', 'true']]) v.setAttribute(k, val);
      // big enough and (almost) invisible: some browsers only count a video that is really on screen
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:64px;height:64px;opacity:0.02;pointer-events:none;z-index:-1';
      v.srcObject = cv.captureStream(4);
      d.body.appendChild(v);
      tick = this._setInterval(paint, 500);                // keep frames flowing so the stream never stalls
      await v.play();
      this.video = v; this.tick = tick;
      return { ok: true };
    } catch (e) {
      if (tick !== null) this._clearInterval(tick);
      if (v && typeof v.remove === 'function') v.remove();
      return { ok: false, needsGesture: !!e && e.name === 'NotAllowedError' };
    }
  }

  _dropVideo() {
    if (this.tick !== null) this._clearInterval(this.tick);
    this.tick = null;
    if (this.video) {
      try { this.video.pause(); } catch { /* ignore */ }
      if (typeof this.video.remove === 'function') this.video.remove();
      this.video = null;
    }
  }
}

/** One-line, user-facing description of a mode (tooltips, toasts, settings). */
export function describeAwake(mode) {
  switch (mode) {
    case 'wakelock': return 'Screen stays on (Wake Lock)';
    case 'video': return 'Screen stays on (background video)';
    case 'pending': return 'Waiting for a tap to keep the screen on';
    case 'unsupported': return "This browser can't keep the screen on: set the device's auto-lock / screen saver to Never";
    default: return 'Keep the screen on: off';
  }
}
