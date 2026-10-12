// Live lap delta against the best lap recorded in this session.
//
// Pure logic: no DOM, no clocks. Fed with slow snapshots only (about 10 per second), because everything it needs
// (LapNumber, CurrentLapMs, DistanceTraveled, LastLapMs, BestLapMs) lives in the slow table.

const MIN_SPACING_M = 5;        // minimum distance between recorded samples
const MAX_SAMPLES = 20000;      // per lap
const FIRST_LAP_MAX_MS = 2000;  // a lap seen from its first two seconds counts as fully recorded
const REWIND_M = 2;             // distance going back by more than this is treated as a flashback
const EXTRAPOLATE_M = 25;       // how far past the end of the reference lap the delta is still extrapolated
const MIN_LAP_M = 20;           // shorter recordings are not usable as a reference
const MIN_VALID_M = 1;          // the delta needs this much distance into the lap
const MIN_SEEN_MS = 2000;       // the last snapshot of a lap must show at least this much lap time to count as a lap
const MAX_CROSS_MS = 2000;      // largest believable gap between the last snapshot of a lap and the finish line
const LAST_LAP_SLACK_MS = 1500; // LastLapMs may not be shorter than the last CurrentLapMs seen minus this

function idx(map, key) {
  const i = map ? map[key] : undefined;
  return Number.isInteger(i) && i >= 0 ? i : -1;
}

/**
 * Lap delta tracker. `feed()` does nothing; use `feedSlow()`.
 *
 * `state`: {valid, deltaS, refLapMs, lapNumber, progress}
 *  - valid: LapNumber >= 1, a reference lap exists, the current lap was seen from its start and DistanceTraveled has
 *    advanced (free roam, where it stays 0, is never valid).
 *  - deltaS: current lap time minus the reference lap's time at the same distance into the lap, in seconds;
 *    negative = ahead of the reference. 0 while not valid.
 *  - refLapMs: the reference lap's time in ms (0 when there is none).
 *  - lapNumber: LapNumber of the latest snapshot.
 *  - progress: 0..1 distance into the lap relative to the reference lap's length (0 without a reference).
 *
 * Events: `{type:'lap', number, timeMs, best}` when a lap completes. `number` is the LapNumber the game reported for
 * the lap that just finished; `timeMs` its time (LastLapMs, else the last CurrentLapMs seen); `best` is true when it is
 * faster than every lap seen so far (the game's BestLapMs counts too). The reference lap is replaced whenever a fully
 * recorded lap beats it.
 */
export class LapDelta {
  /**
   * @param {{F?: Object<string, number>, S: Object<string, number>}} maps column key -> index maps from "hello"
   * @param {{maxEvents?: number}} [options] maxEvents caps the undrained event queue (default 256, oldest dropped)
   */
  constructor(maps, options = {}) {
    const S = maps && maps.S;
    this._iLap = idx(S, 'LapNumber');
    this._iCur = idx(S, 'CurrentLapMs');
    this._iDist = idx(S, 'DistanceTraveled');
    this._iBest = idx(S, 'BestLapMs');
    this._iLast = idx(S, 'LastLapMs');
    const me = options && Number.isFinite(options.maxEvents) ? Math.floor(options.maxEvents) : 256;
    this._maxEvents = Math.max(1, me);
    this.reset();
  }

  /** Forget the reference lap, the current lap and queued events (call on a session change). */
  reset() {
    this._events = [];
    this._clear();
  }

  _clear() {
    this._lap = null;       // {number, startD, partial, broken, d: number[], t: number[]}
    this._last = null;      // previous accepted snapshot {dist, cur}
    this._ref = null;       // {d: Float64Array, t: Float64Array, timeMs, length}
    this._bestKnown = Infinity;
    this._state = { valid: false, deltaS: 0, refLapMs: 0, lapNumber: 0, progress: 0 };
  }

  /** Snapshot of the delta state (a fresh plain object each call). */
  get state() { return { ...this._state }; }

  /** Return and clear the queued events (oldest first). */
  drain() {
    const e = this._events;
    this._events = [];
    return e;
  }

  /** Fast rows carry nothing this tracker needs. */
  feed() {}

  /** Feed one slow snapshot. Malformed snapshots are ignored. */
  feedSlow(slow) {
    if (!slow || typeof slow.length !== 'number') return;
    const lapN = slow[this._iLap];
    const cur0 = slow[this._iCur];
    const dist = slow[this._iDist];
    if (!Number.isFinite(lapN) || !Number.isFinite(cur0) || !Number.isFinite(dist) || lapN < 0) return;
    const cur = cur0 < 0 ? 0 : cur0;
    const lastLap = this._iLast >= 0 ? slow[this._iLast] : NaN;
    const best = this._iBest >= 0 ? slow[this._iBest] : NaN;

    const L = this._lap;
    if (!L) {
      this._beginFirst(lapN, dist, cur);
    } else if (lapN > L.number) {
      this._finish(lapN, dist, cur, lastLap);
    } else if (lapN < L.number) {
      this._clear();                                // session change: the old laps are of no use any more
      this._beginFirst(lapN, dist, cur);
    } else {
      this._advance(dist, cur);
    }
    if (Number.isFinite(best) && best > 0 && best < this._bestKnown) this._bestKnown = best;
    this._last = { dist, cur };
    this._refresh(dist, cur);
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  _emit(ev) {
    const q = this._events;
    q.push(ev);
    if (q.length > this._maxEvents) q.splice(0, q.length - this._maxEvents);
  }

  _beginFirst(lapN, dist, cur) {
    const partial = cur > FIRST_LAP_MAX_MS;         // joined mid-lap: the start of the lap was never seen
    this._lap = { number: lapN, startD: dist, partial, broken: false, d: partial ? [] : [0], t: partial ? [] : [cur] };
  }

  _finish(lapN, dist, cur, lastLap) {
    const L = this._lap;
    const p = this._last;
    const consecutive = lapN === L.number + 1;

    // Lap time and the moment the finish line was crossed (between the previous snapshot and this one).
    let timeMs = 0;
    let fromLast = false;
    // The lap must really have been observed running: a counter that ticks 0 -> 1 when a race starts, while the
    // clock still reads 0 and the game still reports the previous race's LastLapMs, is not a finished lap.
    if (consecutive && p && p.cur >= MIN_SEEN_MS) {
      if (lastLap > 0 && lastLap >= p.cur - LAST_LAP_SLACK_MS) { timeMs = lastLap; fromLast = true; }
      else timeMs = p.cur;
    }
    let crossD = NaN;
    if (fromLast) {
      const before = timeMs - p.cur;
      if (before >= 0 && before <= MAX_CROSS_MS && before + cur > 0 && dist >= p.dist) {
        crossD = p.dist + (dist - p.dist) * (before / (before + cur));
      }
    }

    if (consecutive && timeMs > 0) {
      // Close the lap with a sample at the line so the reference covers the whole lap.
      if (!L.partial && !L.broken && L.d.length && p) {
        const endD = Number.isFinite(crossD) ? crossD - L.startD : p.dist - L.startD;
        const endT = Number.isFinite(crossD) ? timeMs : p.cur;
        const n = L.d.length - 1;
        if (endD > L.d[n] + 0.01 && endT > L.t[n]) { L.d.push(endD); L.t.push(endT); }
      }
      const isBest = timeMs < this._bestKnown;
      if (isBest) this._bestKnown = timeMs;
      this._emit({ type: 'lap', number: L.number, timeMs, best: isBest });

      const usable = !L.partial && !L.broken && L.d.length >= 2 && L.d[L.d.length - 1] >= MIN_LAP_M;
      if (usable && (!this._ref || timeMs < this._ref.timeMs)) {
        this._ref = {
          d: Float64Array.from(L.d), t: Float64Array.from(L.t), timeMs, length: L.d[L.d.length - 1],
        };
      }
    }

    // The new lap starts at the interpolated crossing when we have one, else at this snapshot.
    const known = Number.isFinite(crossD);
    const startD = known ? crossD : dist;
    const partial = !known && cur > FIRST_LAP_MAX_MS;
    this._lap = {
      number: lapN, startD, partial, broken: false,
      d: partial ? [] : [0], t: partial ? [] : [known ? 0 : cur],
    };
    this._advance(dist, cur);
  }

  _advance(dist, cur) {
    const L = this._lap;
    if (L.partial || L.broken) return;
    const dIn = dist - L.startD;
    if (dIn < -MIN_VALID_M) { L.broken = true; return; }        // the distance counter was reset mid-lap
    if (dIn < L.d[L.d.length - 1] - REWIND_M) {                 // flashback: forget what is now "in the future"
      while (L.d.length > 1 && L.d[L.d.length - 1] > dIn) { L.d.pop(); L.t.pop(); }
    }
    const n = L.d.length - 1;
    if (dIn - L.d[n] >= MIN_SPACING_M && cur > L.t[n] && L.d.length < MAX_SAMPLES) {
      L.d.push(dIn);
      L.t.push(cur);
    }
  }

  _refresh(dist, cur) {
    const L = this._lap;
    const ref = this._ref;
    const dIn = dist - L.startD;
    const st = { valid: false, deltaS: 0, refLapMs: ref ? ref.timeMs : 0, lapNumber: L.number, progress: 0 };
    if (ref) st.progress = Math.min(1, Math.max(0, dIn / ref.length));
    if (L.number >= 1 && ref && !L.partial && !L.broken && dIn > MIN_VALID_M) {
      const rt = refTime(ref, dIn);
      if (rt !== null) { st.valid = true; st.deltaS = (cur - rt) / 1000; }
    }
    this._state = st;
  }
}

/** Reference lap time (ms) at `x` metres into the lap, linearly interpolated; null if x is out of range. */
function refTime(ref, x) {
  const d = ref.d;
  const t = ref.t;
  const n = d.length;
  if (x <= d[0]) return t[0];
  if (x > d[n - 1]) {
    if (x - d[n - 1] > EXTRAPOLATE_M) return null;
    const slope = (t[n - 1] - t[n - 2]) / (d[n - 1] - d[n - 2]);
    return slope > 0 && Number.isFinite(slope) ? t[n - 1] + slope * (x - d[n - 1]) : null;
  }
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] >= x) hi = mid; else lo = mid + 1;
  }
  const f = (x - d[lo - 1]) / (d[lo] - d[lo - 1]);
  return t[lo - 1] + f * (t[lo] - t[lo - 1]);
}
