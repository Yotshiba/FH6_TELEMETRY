// Client-side data model: the latest rows plus rolling histories for the charts.
// Rows are positional arrays aligned with the column tables from the "hello" event.

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
    this.gear = '';                    // last valid gear label (shift transients keep it)
  }

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
      this.last = null; this.slow = null; this.seq = null;
    }
    this.race = this.F.IsRaceOn;
    this.version++;
    return !keep;
  }

  clearHistory() { for (const r of this.rings.values()) r.clear(); }

  /** Append rows (oldest first). Paused frames update labels but are not plotted. */
  pushRows(rows) {
    for (const row of rows) {
      this.last = row;
      if (row[this.race]) for (const [col, ring] of this.rings) ring.push(row[col]);
    }
    this.version++;
  }

  f(key) { return this.last ? this.last[this.F[key]] : 0; }
  s(key) { return this.slow ? this.slow[this.S[key]] : 0; }
}
