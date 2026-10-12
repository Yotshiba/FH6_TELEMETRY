// Full-rate history recorder for a scrub-able timeline, min/max decimation and CSV export.
//
// Storage layout (one ring of `capacity` rows):
//   _data  Float32Array(capacity * keys.length)  all columns except the time column's slot (unused)
//   _raw   Float64Array(capacity)                the RAW TimestampMS (game clock, up to 2^32 ms - does NOT
//                                                fit float32 exactly, hence the separate float64 array)
//   _t     Float64Array(capacity)                seconds on the timeline: 0 at the first sample since
//                                                clear(), continuous and NON-DECREASING across segments
//   _seg   Uint32Array(capacity)                 segment id of every row
//
// Segments: a timestamp that goes backwards (new session) or jumps by more than `jumpMs` (2 s: pause,
// teleport, reconnect) starts a NEW SEGMENT. The timeline clock does not follow the jump; the first
// row of the new segment is placed `gapS` (0.013 s) after the last row of the previous one, so time
// never goes backwards and the gap on screen is one frame. Equal timestamps are allowed (same time,
// both rows kept). Everything is deterministic and DOM-free.

const DEFAULT_CAPACITY = 22500;
const MAX_CAPACITY = 1 << 22;
const MAX_PIXELS = 65536;
const DEFAULT_JUMP_MS = 2000;
const DEFAULT_GAP_S = 0.013;
const FALLBACK_DT_MS = 1000 / 75;     // used only when the time column is not among `keys`

const isRowLike = (r) => Array.isArray(r) || (ArrayBuffer.isView(r) && !(r instanceof DataView));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Shortest decimal text that reads back as exactly this float32 (so 0.1 prints as "0.1"). */
function f32Text(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  for (let p = 6; p < 9; p++) {
    const d = Number(v.toPrecision(p));
    if (Math.fround(d) === v) return String(d);
  }
  return String(Number(v.toPrecision(9)));
}

const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export class Timeline {
  /**
   * @param {object} opts
   * @param {string[]} opts.keys     column names in row order
   * @param {number} [opts.capacity=22500]  rows kept (oldest are overwritten)
   * @param {string} [opts.timeKey='TimestampMS']  which column is the game clock in ms
   * @param {number} [opts.jumpMs=2000]  forward jump (ms) that starts a new segment
   * @param {number} [opts.gapS=0.013]   timeline gap inserted at a segment start (s)
   */
  constructor(opts = {}) {
    const o = opts !== null && typeof opts === 'object' ? opts : {};
    const keys = Array.isArray(o.keys) ? o.keys.map((k) => String(k)) : [];
    const cap = Math.floor(Number(o.capacity));
    this._keys = Object.freeze(keys);
    this._stride = keys.length;
    this._cap = Number.isFinite(cap) && cap >= 1 ? Math.min(cap, MAX_CAPACITY) : DEFAULT_CAPACITY;
    this._timeKey = typeof o.timeKey === 'string' ? o.timeKey : 'TimestampMS';
    this._jumpMs = isNum(o.jumpMs) && o.jumpMs >= 0 ? o.jumpMs : DEFAULT_JUMP_MS;
    this._gapS = isNum(o.gapS) && o.gapS >= 0 ? o.gapS : DEFAULT_GAP_S;

    this._index = new Map();                       // key -> column (first occurrence wins)
    keys.forEach((k, i) => { if (!this._index.has(k)) this._index.set(k, i); });
    this._timeCol = this._index.has(this._timeKey) ? this._index.get(this._timeKey) : -1;

    this._data = new Float32Array(this._cap * this._stride);
    this._raw = new Float64Array(this._cap);
    this._t = new Float64Array(this._cap);
    this._seg = new Uint32Array(this._cap);
    this.clear();
  }

  /** Forget everything (time restarts at 0, segment ids restart at 0). */
  clear() {
    this._head = 0;          // next write position
    this._len = 0;
    this._segId = 0;
    this._lastMs = 0;
    this._lastT = 0;
    this._segStartMs = 0;
    this._segBaseT = 0;
  }

  /** Number of rows currently held (<= capacity). */
  get length() { return this._len; }
  get capacity() { return this._cap; }
  /** Column names in row order. */
  get keys() { return this._keys; }
  /** Is `key` a known column? */
  has(key) { return this._index.has(key); }

  /** Physical slot of logical index i (0 = oldest). */
  _p(i) {
    const p = this._head - this._len + i;
    return p < 0 ? p + this._cap : p;
  }

  /** First logical index whose time is >= tq. */
  _lower(tq) {
    let lo = 0, hi = this._len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._t[this._p(mid)] < tq) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** First logical index whose time is > tq. */
  _upper(tq) {
    let lo = 0, hi = this._len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._t[this._p(mid)] <= tq) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** First logical index whose segment id is > id. */
  _upperSeg(id) {
    let lo = 0, hi = this._len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._seg[this._p(mid)] <= id) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Record one fast row (an array aligned with `keys`). Non-array input and rows without a finite
   * timestamp are ignored. Missing/non-numeric cells in a short row are stored as NaN.
   * @param {ArrayLike<number>} row
   * @returns {boolean} true when the row was stored
   */
  push(row) {
    if (!isRowLike(row)) return false;
    let ms;
    if (this._timeCol >= 0) {
      ms = row[this._timeCol];
      if (!isNum(ms)) return false;
    } else {
      ms = this._len === 0 ? 0 : this._lastMs + FALLBACK_DT_MS;
    }

    let t;
    if (this._len === 0) {
      this._segId = 0;
      this._segStartMs = ms;
      this._segBaseT = 0;
      t = 0;
    } else {
      const dt = ms - this._lastMs;
      if (dt < 0 || dt > this._jumpMs) {
        this._segId++;
        this._segStartMs = ms;
        this._segBaseT = this._lastT + this._gapS;
        t = this._segBaseT;
      } else {
        t = this._segBaseT + (ms - this._segStartMs) / 1000;
      }
    }

    const p = this._head;
    const base = p * this._stride;
    const n = row.length;
    for (let c = 0; c < this._stride; c++) {
      const v = c < n ? row[c] : NaN;
      this._data[base + c] = typeof v === 'number' ? v : NaN;
    }
    this._raw[p] = ms;
    this._t[p] = t;
    this._seg[p] = this._segId;
    this._head = p + 1 === this._cap ? 0 : p + 1;
    if (this._len < this._cap) this._len++;
    this._lastMs = ms;
    this._lastT = t;
    return true;
  }

  /** Push several rows (oldest first). Returns how many were stored. */
  pushMany(rows) {
    let n = 0;
    if (Array.isArray(rows)) for (const r of rows) if (this.push(r)) n++;
    return n;
  }

  _val(p, col) {
    return col === this._timeCol ? this._raw[p] : this._data[p * this._stride + col];
  }

  /**
   * Value of column `key` at logical index `i` (0 = oldest). The time column returns the exact raw
   * ms. NaN for an unknown key or out-of-range / non-integer index.
   */
  get(i, key) {
    const col = this._index.get(key);
    if (col === undefined || !Number.isInteger(i) || i < 0 || i >= this._len) return NaN;
    return this._val(this._p(i), col);
  }

  /** A copy of row `i` (array aligned with `keys`, time column = exact ms), or null if out of range. */
  row(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this._len) return null;
    const p = this._p(i);
    const out = new Array(this._stride);
    for (let c = 0; c < this._stride; c++) out[c] = this._val(p, c);
    return out;
  }

  /** Timeline seconds of row `i` (NaN when out of range). Non-decreasing in i. */
  timeAt(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this._len) return NaN;
    return this._t[this._p(i)];
  }

  /** Segment id of row `i`, or -1. */
  segmentAt(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this._len) return -1;
    return this._seg[this._p(i)];
  }

  /** Timeline seconds of the newest row (NaN when empty). */
  latestTime() { return this._len ? this._lastT : NaN; }

  /** Timeline seconds of the oldest row still held (NaN when empty). */
  earliestTime() { return this._len ? this._t[this._p(0)] : NaN; }

  /**
   * The segments still (partly) held, oldest first:
   * `{id, start, end, t0, t1}` with `start`/`end` INCLUSIVE logical indices and t0/t1 their timeline
   * seconds. Ids are consecutive; the first one may be truncated by the ring.
   */
  get segments() {
    const n = this._len;
    if (!n) return [];
    const first = this._seg[this._p(0)];
    const last = this._seg[this._p(n - 1)];
    const out = [];
    let start = 0;
    for (let id = first; id <= last; id++) {
      const next = id === last ? n : this._upperSeg(id);
      if (next > start) {
        out.push({ id, start, end: next - 1, t0: this._t[this._p(start)], t1: this._t[this._p(next - 1)] });
      }
      start = next;
    }
    return out;
  }

  /**
   * Nearest row to timeline second `t` (ties go to the earlier row), clamped to the ends.
   * -1 when empty or `t` is NaN.
   */
  indexAtTime(t) {
    const n = this._len;
    if (!n || typeof t !== 'number' || Number.isNaN(t)) return -1;
    const j = this._lower(t);
    if (j === 0) return 0;
    if (j === n) return n - 1;
    const a = this._t[this._p(j - 1)];
    const b = this._t[this._p(j)];
    return t - a <= b - t ? j - 1 : j;
  }

  /**
   * Inclusive index range of the rows with t0 <= time <= t1 (arguments may be given in either order).
   * `{i0: -1, i1: -1}` when none.
   */
  indexRange(t0, t1) {
    if (!this._len || !isNum(t0) || !isNum(t1)) return { i0: -1, i1: -1 };
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    const i0 = this._lower(t0);
    const i1 = this._upper(t1) - 1;
    return i0 <= i1 ? { i0, i1 } : { i0: -1, i1: -1 };
  }

  /**
   * Min/max decimation of column `key` over [t0, t1] into `pixels` equal time slices.
   * A row lands in column floor((t - t0) / (t1 - t0) * pixels); a row exactly at t1 goes in the
   * last column. Rows whose value is not finite (NaN, +-Infinity) are skipped; empty columns are
   * NaN. Cost: O(log n + rows in window + pixels). `pixels` is floored and capped at 65536.
   * @returns {{min: Float32Array, max: Float32Array, n: number, i0: number, i1: number}}
   *   `n` = rows inside the window (even if their value is NaN), `i0`/`i1` = their inclusive index
   *   range (-1/-1 when none). For the time column the min/max are narrowed to float32.
   */
  window(key, t0, t1, pixels) {
    let px = Math.floor(Number(pixels));
    px = Number.isFinite(px) && px > 0 ? Math.min(px, MAX_PIXELS) : 0;
    const min = new Float32Array(px).fill(NaN);
    const max = new Float32Array(px).fill(NaN);
    const res = { min, max, n: 0, i0: -1, i1: -1 };
    const col = this._index.get(key);
    if (col === undefined || px === 0) return res;
    if (!isNum(t0) || !isNum(t1)) return res;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    const { i0, i1 } = this.indexRange(t0, t1);
    if (i0 < 0) return res;
    res.n = i1 - i0 + 1;
    res.i0 = i0;
    res.i1 = i1;

    const isTime = col === this._timeCol;
    const arr = isTime ? this._raw : this._data;
    const stride = isTime ? 1 : this._stride;
    const off = isTime ? 0 : col;
    const span = t1 - t0;
    const cap = this._cap;
    const tt = this._t;
    let p = this._p(i0);
    for (let i = i0; i <= i1; i++) {
      const v = arr[p * stride + off];
      if (v - v === 0) {                 // finite (NaN and +-Infinity are skipped)
        let c = span > 0 ? Math.floor((tt[p] - t0) / span * px) : 0;
        if (c >= px) c = px - 1; else if (c < 0) c = 0;
        const lo = min[c];
        if (lo !== lo || v < lo) min[c] = v;
        const hi = max[c];
        if (hi !== hi || v > hi) max[c] = v;
      }
      if (++p === cap) p = 0;
    }
    return res;
  }

  /**
   * Linearly interpolated value of `key` at timeline second `t`. `null` for an empty timeline, an
   * unknown key, a non-finite `t` or a `t` outside [earliestTime, latestTime]. Between two rows of
   * DIFFERENT segments there is no blending: the nearer row's value is returned. NaN cells give NaN.
   */
  valueAtTime(key, t) {
    const col = this._index.get(key);
    const n = this._len;
    if (col === undefined || !n || !isNum(t)) return null;
    const first = this._t[this._p(0)];
    const last = this._t[this._p(n - 1)];
    if (t < first || t > last) return null;
    const j = this._upper(t);                 // first row with time > t
    const lo = this._p(j - 1);                // last row with time <= t (j >= 1 because t >= first)
    if (j >= n) return this._val(lo, col);
    const hi = this._p(j);
    const tl = this._t[lo];
    const th = this._t[hi];
    const vl = this._val(lo, col);
    if (t === tl) return vl;
    const vh = this._val(hi, col);
    if (this._seg[lo] !== this._seg[hi]) return t - tl <= th - t ? vl : vh;
    return vl + (vh - vl) * ((t - tl) / (th - tl));
  }

  /**
   * CSV text: header `time_s,<keys...>` then one line per row, '\n' separated with a trailing '\n'.
   * `time_s` is the timeline second (<= 6 decimals, trailing zeros trimmed); the time column keeps its
   * exact integer ms; other numbers use the shortest text that reads back as the stored float32;
   * NaN / non-finite cells are empty.
   * @param {{from?: number, to?: number, keys?: string[]}} [opts]  `from`/`to` are INCLUSIVE logical
   *   indices (default 0 .. length-1, clamped); `keys` defaults to all columns, unknown keys are skipped.
   */
  toCSV(opts) {
    const o = opts !== null && typeof opts === 'object' ? opts : {};
    const n = this._len;
    const from = Math.max(0, isNum(o.from) ? Math.floor(o.from) : 0);
    const to = Math.min(n - 1, isNum(o.to) ? Math.floor(o.to) : n - 1);
    const names = Array.isArray(o.keys) ? o.keys.filter((k) => this._index.has(k)) : this._keys;
    const cols = names.map((k) => this._index.get(k));
    const lines = [['time_s', ...names].map(csvCell).join(',')];
    for (let i = from; i <= to; i++) {
      const p = this._p(i);
      const cells = [String(Number(this._t[p].toFixed(6)))];
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        cells.push(col === this._timeCol ? String(this._raw[p]) : f32Text(this._data[p * this._stride + col]));
      }
      lines.push(cells.join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Summary of `key` over rows with t0 <= time <= t1 (either order). Non-finite cells (NaN,
   * +-Infinity) are skipped; the mean is the plain per-sample mean.
   * `{min: NaN, max: NaN, mean: NaN, count: 0}` when nothing qualifies.
   * @returns {{min: number, max: number, mean: number, count: number}}
   */
  stats(key, t0, t1) {
    const none = { min: NaN, max: NaN, mean: NaN, count: 0 };
    const col = this._index.get(key);
    if (col === undefined) return none;
    const { i0, i1 } = this.indexRange(t0, t1);
    if (i0 < 0) return none;
    let lo = Infinity, hi = -Infinity, sum = 0, count = 0;
    let p = this._p(i0);
    for (let i = i0; i <= i1; i++) {
      const v = this._val(p, col);
      if (v - v === 0) {                 // finite
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
        count++;
      }
      if (++p === this._cap) p = 0;
    }
    return count ? { min: lo, max: hi, mean: sum / count, count } : none;
  }
}
