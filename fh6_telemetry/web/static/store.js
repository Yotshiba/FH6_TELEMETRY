// Client-side data model: the latest rows plus rolling histories for the charts, a
// full-rate timeline for the rewind view, and subscribers for the analytics / map / sound.
// Rows are positional arrays aligned with the column tables from the "hello" event.

import { GearTracker } from './format.js';
import { Timeline } from './timeline.js';

export class Ring {
  constructor(n) { this.n = n; this.a = new Float64Array(n); this.head = 0; this.count = 0; }
  push(v) {
    this.a[this.head] = v;
    this.head = (this.head + 1) % this.n;
    if (this.count < this.n) this.count++;
  }
  clear() { this.head = 0; this.count = 0; }
  /** i-th sample counted from the oldest (0 .. count-1) */
  at(i) { return this.a[(this.head - this.count + i + this.n) % this.n]; }
  min() { let m = Infinity; for (let i = 0; i < this.count; i++) m = Math.min(m, this.at(i)); return m; }
  max() { let m = -Infinity; for (let i = 0; i < this.count; i++) m = Math.max(m, this.at(i)); return m; }
}

export class Store {
  constructor() {
    this.hello = null;
    this.F = {}; this.S = {};          // column key -> index
    this.rings = new Map();            // F column index -> Ring (only columns a chart plots)
    this.last = null;                  // latest fast row (any state)
    this.slow = null;                  // latest slow snapshot
    this.seq = null;                   // sequence number of the last row received
    this.ranges = {};                  // chart id -> [lo, hi] from the server
    this.signal = false;
    this.pps = 0;
    this.version = 0;                  // bumped whenever data changed
    this.gen = 0;                      // bumped whenever the history is wiped (views drop time-keyed state)
    this.gear = '';                    // gear label to show (maintained row by row; a shift's neutral never flashes)
    this.gearTracker = new GearTracker();
    this.timeline = null;              // full-rate history for the rewind view
    this.rowListeners = [];            // fn(rows) — live rows only (not replayed history)
    this.slowListeners = [];           // fn(slowRow)
    this.helloListeners = [];          // fn(store, reset)
  }

  onRows(fn) { this.rowListeners.push(fn); return () => { this.rowListeners = this.rowListeners.filter((f) => f !== fn); }; }
  onSlow(fn) { this.slowListeners.push(fn); return () => { this.slowListeners = this.slowListeners.filter((f) => f !== fn); }; }
  onHello(fn) { this.helloListeners.push(fn); }

  /** Apply a "hello". Returns true if the histories were reset. */
  setHello(h) {
    const keep = h.resume && this.hello && this.hello.epoch === h.epoch;
    this.hello = h;
    this.F = Object.fromEntries(h.F.map((c, i) => [c.k, i]));
    this.S = Object.fromEntries(h.S.map((c, i) => [c.k, i]));
    this.ranges = { ...(keep ? this.ranges : {}), ...(h.rg || {}) };
    if (!keep) {
      this.rings.clear();
      for (const c of h.charts) for (const l of c.lines) {
        if (!this.rings.has(l.k)) this.rings.set(l.k, new Ring(h.hist));
      }
      this.timeline = new Timeline({ keys: h.F.map((c) => c.k) });
      this.last = null; this.slow = null; this.seq = null;
      this.gearTracker.reset(); this.gear = '';
      this.gen++;
    }
    this.race = this.F.IsRaceOn;
    this._iGear = this.F.Gear; this._iTs = this.F.TimestampMS;
    this.version++;
    for (const fn of this.helloListeners) { try { fn(this, !keep); } catch (e) { console.error(e); } }
    return !keep;
  }

  clearHistory() { for (const r of this.rings.values()) r.clear(); if (this.timeline) this.timeline.clear(); this.gen++; }

  /**
   * Apply an "f" batch if it continues the sequence. Returns false on a gap (the server skipped a
   * tick for a slow client): the caller must resync from `resumeId()`.
   */
  applyFrames(d) {
    if (this.seq !== null && d.s - d.r.length !== this.seq) return false;
    this.pushRows(d.r);
    this.seq = d.s;
    return true;
  }

  /** The SSE id of the last batch that was actually applied ("<epoch>:<seq>"), or null. */
  resumeId() { return this.hello && this.seq !== null ? `${this.hello.epoch}:${this.seq}` : null; }

  /**
   * Append rows (oldest first).  Paused frames update labels but are not plotted.
   * `replay` rows (the history sent on connect) fill the charts and the timeline but are
   * NOT announced to listeners — otherwise a reconnect would re-trigger every achievement.
   */
  pushRows(rows, replay = false) {
    for (const row of rows) {
      this.last = row;
      if (row[this.race]) {
        for (const [col, ring] of this.rings) ring.push(row[col]);
        if (this._iGear !== undefined) this.gear = this.gearTracker.update(this.hello.lab, row[this._iGear], row[this._iTs]);
      }
      if (this.timeline) this.timeline.push(row);
    }
    this.version++;
    if (!replay && rows.length) {
      for (const fn of this.rowListeners) { try { fn(rows); } catch (e) { console.error(e); } }
    }
  }

  pushSlow(slow) {
    this.slow = slow;
    this.version++;
    for (const fn of this.slowListeners) { try { fn(slow); } catch (e) { console.error(e); } }
  }

  f(key) { return this.last ? this.last[this.F[key]] : 0; }
  s(key) { return this.slow ? this.slow[this.S[key]] : 0; }
}
