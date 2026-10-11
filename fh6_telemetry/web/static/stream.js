// EventSource wrapper: resume, watchdog, backoff, and phone-friendly lifecycle.
//
// * the server numbers frames ("<epoch>:<seq>" as the SSE id) so a reconnect asks for
//   only what it missed (`?since=`); a changed epoch or a gap means a full resync
// * a 5 s watchdog reopens a stream that went silent without an error (iOS Safari
//   can leave a suspended EventSource looking open)
// * the stream is closed while the tab is hidden for a while and reopened on return

const EVENTS = ['hello', 'hist', 'f', 's', 'rg', 'st', 'reset'];
const WATCHDOG_MS = 5000;
const HIDDEN_GRACE_MS = 10000;

export class Stream {
  /** @param {Object} h  handlers: hello(d) hist(d) f(d) s(d) rg(d) st(d) reset(d) state(name) */
  constructor(h, url = '/stream') {
    this.h = h; this.url = url; this.es = null; this.lastId = null;
    this.backoff = 1000; this.watchdog = null; this.retry = null; this.hiddenTimer = null;
    this.wantOpen = false;
  }

  start() {
    this.wantOpen = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenTimer = setTimeout(() => { this.close(); this.h.state('paused'); }, HIDDEN_GRACE_MS);
      } else {
        clearTimeout(this.hiddenTimer);
        if (this.wantOpen && !this.es) this.open();
      }
    });
    window.addEventListener('online', () => { if (this.wantOpen && !this.es) this.open(); });
    this.open();
  }

  close() {
    clearTimeout(this.watchdog); clearTimeout(this.retry);
    if (this.es) { this.es.onopen = this.es.onerror = null; this.es.close(); this.es = null; }
  }

  /** Drop the connection and reconnect right away (resuming from the last id). */
  reopen() { this.close(); this.open(); }

  /** Forget the resume point: the next connection is a full resync. */
  forget() { this.lastId = null; }

  open() {
    this.close();
    if (document.hidden && this.hiddenTimer === null) { /* opened while hidden: fine */ }
    const url = this.lastId ? `${this.url}?since=${encodeURIComponent(this.lastId)}` : this.url;
    const es = new EventSource(url);
    this.es = es;
    this.h.state(this.lastId ? 'reconnecting' : 'connecting');
    es.onopen = () => { this.backoff = 1000; this.arm(); };
    es.onerror = () => {
      this.close();
      this.h.state('reconnecting');
      this.retry = setTimeout(() => { if (this.wantOpen) this.open(); }, this.backoff);
      this.backoff = Math.min(10000, Math.round(this.backoff * 1.6));
    };
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        this.arm();
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (e.lastEventId) this.lastId = e.lastEventId;
        if (name === 'reset') { this.forget(); this.h.reset && this.h.reset(data); this.reopen(); return; }
        const fn = this.h[name];
        if (fn) fn(data, this);
      });
    }
  }

  arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { this.h.state('reconnecting'); this.reopen(); }, WATCHDOG_MS);
  }
}
