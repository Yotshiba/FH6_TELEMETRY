// Air-time tracker: detects jumps from the four suspension compression values.
// Pure logic - no DOM, no clock. Rows are positional arrays aligned with the
// "hello" column table (store.F); keys used: SuspNormFL/FR/RL/RR, SpeedKmh, TimestampMS, IsRaceOn.

const DEFAULTS = Object.freeze({
  extendThresh: 0.04,  // max(SuspNorm) below this = all wheels (nearly) fully extended
  airRows: 3,          // consecutive extended rows (at speed) before "airborne" is declared
  landRows: 2,         // consecutive compressed rows before "landed" is declared
  minSpeedKmh: 15,     // an extended row only counts while moving at least this fast
  minAirS: 0.25,       // shorter flights are discarded silently
  maxDtMs: 250,        // larger (or non-positive) timestamp steps are discontinuities
  heightK: 1.225,      // heightM = heightK * duration^2   (g t^2 / 8)
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function index(map, key) {
  const i = map ? map[key] : undefined;
  return Number.isInteger(i) && i >= 0 ? i : -1;
}

function resolveOptions(opts) {
  const o = { ...DEFAULTS };
  if (opts && typeof opts === 'object') {
    for (const k of Object.keys(DEFAULTS)) if (isNum(opts[k])) o[k] = opts[k];
  }
  o.minAirMs = o.minAirS * 1000;
  return o;
}

/**
 * Detects and measures jumps from fast rows.
 *
 * Events (drain()): `air_start {speedKmh}` (take-off speed) and
 * `air_end {durationS, distM, heightM, speedKmh, landKmh}` (only for flights >= minAirS;
 * `speedKmh` = take-off speed, `landKmh` = speed at touchdown). A shorter flight yields an
 * `air_start` with no matching `air_end`.
 *
 * state: {active, tS, last: {durationS, distM, heightM, speedKmh} | null, longestS, count, totalS}
 */
export class AirTracker {
  /**
   * @param {{F: Object<string, number>, S?: Object<string, number>}} maps key -> index maps from "hello"
   * @param {Object} [options] override any threshold in DEFAULTS (airRows, landRows, ...)
   */
  constructor(maps, options) {
    const F = maps ? maps.F : undefined;
    this._ix = {
      race: index(F, 'IsRaceOn'),
      speed: index(F, 'SpeedKmh'),
      t: index(F, 'TimestampMS'),
      susp: ['FL', 'FR', 'RL', 'RR'].map((w) => index(F, `SuspNorm${w}`)),
    };
    this._need = Math.max(this._ix.race, this._ix.speed, this._ix.t, ...this._ix.susp) + 1;
    this._o = resolveOptions(options);
    this._events = [];
    this.reset();
  }

  /** Forget everything: any flight in progress, the totals and pending events. */
  reset() {
    this._events.length = 0;
    this._last = null;
    this._longestS = 0;
    this._count = 0;
    this._totalS = 0;
    this._lastT = null;
    this._prevV = 0;
    this._cancel();
  }

  /**
   * Feed one fast row (oldest first). Malformed rows are ignored.
   * @param {ArrayLike<number>} row
   */
  feed(row) {
    if (!row || typeof row.length !== 'number') return;
    const ix = this._ix;
    const o = this._o;
    if (ix.speed < 0 || ix.t < 0 || ix.susp.some((i) => i < 0) || row.length < this._need) return;
    if (ix.race >= 0) {
      const r = row[ix.race];
      if (!isNum(r)) return;
      if (r === 0) { this._cancel(); this._lastT = null; return; }
    }
    const v = row[ix.speed];
    const t = row[ix.t];
    if (!isNum(v) || !isNum(t)) return;
    let mx = -Infinity;
    for (const i of ix.susp) {
      const s = row[i];
      if (!isNum(s)) return;
      if (s > mx) mx = s;
    }

    let dt = 0;
    if (this._lastT !== null) {
      dt = t - this._lastT;
      // Equal stamps are normal (15.6 ms clock tick vs ~13 ms rows): a zero step, not a gap.
      if (!(dt >= 0) || dt > o.maxDtMs) { this._cancel(); dt = 0; }
    }
    this._lastT = t;
    const low = mx < o.extendThresh;
    const high = mx > o.extendThresh;     // exactly == threshold is neither: breaks both streaks

    if (!this._air) {
      if (low && v >= o.minSpeedKmh) {
        if (this._cand === 0) { this._candT0 = t; this._candV0 = v; this._dist = 0; }
        else this._dist += ((this._prevV + v) / 2 / 3.6) * (dt / 1000);
        this._cand++;
        if (this._cand >= o.airRows) {
          this._air = true;
          this._airT0 = this._candT0;
          this._takeoffKmh = this._candV0;
          this._landN = 0;
          this._snap = null;
          this._tMs = t - this._airT0;
          this._emit({ type: 'air_start', speedKmh: this._takeoffKmh });
        }
      } else {
        this._cand = 0;
        this._dist = 0;
      }
    } else {
      this._dist += ((this._prevV + v) / 2 / 3.6) * (dt / 1000);
      this._tMs = t - this._airT0;
      if (high) {
        this._landN++;
        if (this._landN === 1) this._snap = { t, dist: this._dist, v };
        if (this._landN >= o.landRows) this._land();
      } else {
        this._landN = 0;
        this._snap = null;
      }
    }
    this._prevV = v;
  }

  /** Current tracker state (a fresh plain object on every read). */
  get state() {
    return {
      active: this._air,
      tS: this._air ? this._tMs / 1000 : 0,
      last: this._last ? { ...this._last } : null,
      longestS: this._longestS,
      count: this._count,
      totalS: this._totalS,
    };
  }

  /** Return and clear the pending events. */
  drain() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  // ---- internals ----

  _emit(ev) {
    this._events.push(ev);
    if (this._events.length > 512) this._events.splice(0, this._events.length - 512);
  }

  /** Drop any candidate / in-progress flight without an event. */
  _cancel() {
    this._air = false;
    this._cand = 0;
    this._candT0 = 0;
    this._candV0 = 0;
    this._dist = 0;
    this._airT0 = 0;
    this._takeoffKmh = 0;
    this._landN = 0;
    this._snap = null;
    this._tMs = 0;
  }

  /** Landing confirmed: the touchdown time is the FIRST compressed row. */
  _land() {
    const o = this._o;
    const snap = this._snap;
    const durMs = snap.t - this._airT0;
    const takeoff = this._takeoffKmh;
    this._cancel();
    if (durMs < o.minAirMs) return;     // too short to count
    const durationS = durMs / 1000;
    const info = {
      durationS,
      distM: snap.dist,
      heightM: o.heightK * durationS * durationS,
      speedKmh: takeoff,
    };
    this._last = info;
    this._count++;
    this._totalS += durationS;
    if (durationS > this._longestS) this._longestS = durationS;
    this._emit({ type: 'air_end', ...info, landKmh: snap.v });
  }
}
