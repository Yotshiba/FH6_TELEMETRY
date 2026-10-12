// Session records (top speed, peak g, odometer ...), speed milestones, redline hits and the G-G trail.
//
// Pure logic: no DOM, no clocks. Feed fast rows (positional arrays, oldest first) one at a time.
// Only rows with IsRaceOn set count; a paused row breaks the time integration but keeps all maxima.

const KMH_TO_MS = 1 / 3.6;
const MAX_DT_MS = 250;
/** Speeds (km/h) that raise a `speed_milestone` the first time they are reached. */
export const SPEED_MILESTONES = Object.freeze([100, 150, 200, 250, 300, 350]);
const REDLINE_RATIO = 0.98;
const REDLINE_GAP_MS = 10000;
const RECORD_GAIN = 1.01;
const RECORD_GAP_MS = 2000;
const RECORD_KEYS = ['topSpeedKmh', 'maxLatG', 'maxBrakeG', 'maxAccelG'];

function idx(map, key) {
  const i = map ? map[key] : undefined;
  return Number.isInteger(i) && i >= 0 ? i : -1;
}

function queue(owner, ev) {
  const q = owner._events;
  q.push(ev);
  if (q.length > owner._maxEvents) q.splice(0, q.length - owner._maxEvents);
}

function maxEventsOf(options) {
  const n = options && Number.isFinite(options.maxEvents) ? Math.floor(options.maxEvents) : 256;
  return Math.max(1, n);
}

/**
 * Session records and one-off events.
 *
 * `state`: {topSpeedKmh, maxRpm, maxLatG (max |AccelGX|), maxBrakeG (max -AccelGZ, >= 0), maxAccelG (max AccelGZ, >= 0),
 * maxPowerHp, maxBoostBar, odometerM, driveTimeS}. Everything starts at 0.
 *
 * Events:
 *  - `{type:'speed_milestone', kmh}` once per 100/150/200/250/300/350 km/h until `reset()`.
 *  - `{type:'redline'}` when rpm >= 98 % of EngineMaxRpm, at most once per 10 s of game time.
 *  - `{type:'record', key, value, previous}` for key topSpeedKmh | maxLatG | maxBrakeG | maxAccelG when the maximum has
 *    grown by >= 1 % over the baseline and >= 2 s of game time passed since the previous 'record' of that key. The
 *    baseline is the first positive value seen (which never emits) and afterwards the value of the last record, so a
 *    continuous climb produces a record about every 2 s instead of never. `previous` is that baseline.
 */
export class Records {
  /**
   * @param {{F: Object<string, number>, S?: Object<string, number>}} maps column key -> index maps from "hello"
   * @param {{maxEvents?: number, recordFloors?: Object<string, number>}} [options] `recordFloors` ({topSpeedKmh,
   *   maxLatG, maxBrakeG, maxAccelG}, default 0) ignore values at or below the floor for the 'record' events only
   *   (the maxima in `state` are unaffected).
   */
  constructor(maps, options = {}) {
    const F = maps && maps.F;
    this._iRace = idx(F, 'IsRaceOn');
    this._iTs = idx(F, 'TimestampMS');
    this._iSpeed = idx(F, 'SpeedKmh');
    this._iRpm = idx(F, 'CurrentEngineRpm');
    this._iMaxRpm = idx(F, 'EngineMaxRpm');
    this._iGX = idx(F, 'AccelGX');
    this._iGZ = idx(F, 'AccelGZ');
    this._iPower = idx(F, 'PowerHp');
    this._iBoost = idx(F, 'BoostBar');
    this._maxEvents = maxEventsOf(options);
    const fl = (options && options.recordFloors) || {};
    this._floors = {};
    for (const k of RECORD_KEYS) this._floors[k] = Number.isFinite(fl[k]) && fl[k] > 0 ? fl[k] : 0;
    this.reset();
  }

  /** Clear all records, re-arm the milestones and drop queued events. */
  reset() {
    this._s = {
      topSpeedKmh: 0, maxRpm: 0, maxLatG: 0, maxBrakeG: 0, maxAccelG: 0,
      maxPowerHp: 0, maxBoostBar: 0, odometerM: 0, driveTimeS: 0,
    };
    this._events = [];
    this._hasPrev = false;
    this._pSpeed = NaN;
    this._pTs = 0;
    this._nextMs = 0;
    this._lastRedline = NaN;
    this._rec = {};
    for (const k of RECORD_KEYS) this._rec[k] = { base: NaN, last: NaN };
  }

  /** Snapshot of the records (a fresh plain object each call). */
  get state() { return { ...this._s }; }

  /** Return and clear the queued events (oldest first). */
  drain() {
    const e = this._events;
    this._events = [];
    return e;
  }

  /** Feed one fast row. Malformed rows are ignored. */
  feed(row) {
    if (!row || typeof row.length !== 'number') return;
    const race = row[this._iRace];
    if (!Number.isFinite(race)) return;
    if (!race) { this._hasPrev = false; return; }
    const ts = row[this._iTs];
    if (!Number.isFinite(ts)) return;

    const s = this._s;
    const speed = this._iSpeed >= 0 ? row[this._iSpeed] : NaN;
    const okSpeed = Number.isFinite(speed) && speed >= 0;

    // time-based accumulators (valid dt only)
    if (this._hasPrev) {
      const dt = ts - this._pTs;
      if (dt > 0 && dt <= MAX_DT_MS) {
        s.driveTimeS += dt / 1000;
        if (okSpeed && Number.isFinite(this._pSpeed)) {
          s.odometerM += (this._pSpeed + speed) * 0.5 * KMH_TO_MS * (dt / 1000);
        }
      }
    }
    this._hasPrev = true;
    this._pTs = ts;
    this._pSpeed = okSpeed ? speed : NaN;

    if (okSpeed) {
      if (speed > s.topSpeedKmh) s.topSpeedKmh = speed;
      while (this._nextMs < SPEED_MILESTONES.length && speed >= SPEED_MILESTONES[this._nextMs]) {
        queue(this, { type: 'speed_milestone', kmh: SPEED_MILESTONES[this._nextMs] });
        this._nextMs++;
      }
    }

    const rpm = this._iRpm >= 0 ? row[this._iRpm] : NaN;
    if (Number.isFinite(rpm) && rpm > s.maxRpm) s.maxRpm = rpm;
    const maxRpm = this._iMaxRpm >= 0 ? row[this._iMaxRpm] : NaN;
    if (Number.isFinite(rpm) && Number.isFinite(maxRpm) && maxRpm > 0 && rpm >= REDLINE_RATIO * maxRpm) {
      const last = this._lastRedline;
      if (Number.isNaN(last) || ts < last || ts - last >= REDLINE_GAP_MS) {
        this._lastRedline = ts;
        queue(this, { type: 'redline' });
      }
    }

    const gx = this._iGX >= 0 ? row[this._iGX] : NaN;
    if (Number.isFinite(gx) && Math.abs(gx) > s.maxLatG) s.maxLatG = Math.abs(gx);
    const gz = this._iGZ >= 0 ? row[this._iGZ] : NaN;
    if (Number.isFinite(gz)) {
      if (gz > s.maxAccelG) s.maxAccelG = gz;
      if (-gz > s.maxBrakeG) s.maxBrakeG = -gz;
    }
    const power = this._iPower >= 0 ? row[this._iPower] : NaN;
    if (Number.isFinite(power) && power > s.maxPowerHp) s.maxPowerHp = power;
    const boost = this._iBoost >= 0 ? row[this._iBoost] : NaN;
    if (Number.isFinite(boost) && boost > s.maxBoostBar) s.maxBoostBar = boost;

    for (const k of RECORD_KEYS) this._checkRecord(k, s[k], ts);
  }

  _checkRecord(key, value, ts) {
    if (!(value > this._floors[key])) return;
    const r = this._rec[key];
    if (Number.isNaN(r.base)) { r.base = value; return; }      // the first sample only sets the baseline
    if (value > r.base && value >= r.base * RECORD_GAIN
        && (Number.isNaN(r.last) || ts < r.last || ts - r.last >= RECORD_GAP_MS)) {
      queue(this, { type: 'record', key, value, previous: r.base });
      r.base = value;
      r.last = ts;
    }
  }
}

/**
 * Rolling trail of the last `size` (AccelGX, AccelGZ) samples for a G-G diagram, plus session peaks per direction.
 * x is lateral g (+ = right), y is longitudinal g (+ = accelerating).
 */
export class GTrail {
  /**
   * @param {{F: Object<string, number>}} maps column key -> index map from "hello"
   * @param {{size?: number, decayPerSec?: number}} [options] `size` samples kept (default 150); `decayPerSec` makes
   *   the peaks shrink by that many g per second of game time, never below the largest value still on the trail
   *   (default 0 = peaks are session maxima).
   */
  constructor(maps, options = {}) {
    const F = maps && maps.F;
    this._iRace = idx(F, 'IsRaceOn');
    this._iTs = idx(F, 'TimestampMS');
    this._iGX = idx(F, 'AccelGX');
    this._iGZ = idx(F, 'AccelGZ');
    const size = options && Number.isFinite(options.size) && options.size >= 1 ? Math.floor(options.size) : 150;
    this._size = Math.min(size, 100000);
    this._decay = options && Number.isFinite(options.decayPerSec) && options.decayPerSec > 0 ? options.decayPerSec : 0;
    this._x = new Float64Array(this._size);
    this._y = new Float64Array(this._size);
    this.reset();
  }

  /** Empty the trail and the peaks. */
  reset() {
    this._head = 0;
    this._n = 0;
    this._hasPrev = false;
    this._pTs = 0;
    this._peaks = { left: 0, right: 0, accel: 0, brake: 0 };
  }

  /** Zero the peaks only; the trail stays. */
  resetPeaks() { this._peaks = { left: 0, right: 0, accel: 0, brake: 0 }; }

  /** Number of samples on the trail. */
  get n() { return this._n; }

  /** The newest sample as {x, y}, or null while the trail is empty. */
  get last() {
    if (!this._n) return null;
    const i = (this._head - 1 + this._size) % this._size;
    return { x: this._x[i], y: this._y[i] };
  }

  /** Peak g per direction as positive magnitudes: {left, right, accel, brake} (a fresh object each call). */
  get peaks() { return { ...this._peaks }; }

  /** The trail oldest first as {x: Float32Array, y: Float32Array, n} (fresh arrays, length n). */
  points() {
    const n = this._n;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const start = (this._head - n + this._size) % this._size;
    for (let i = 0; i < n; i++) {
      const j = (start + i) % this._size;
      x[i] = this._x[j];
      y[i] = this._y[j];
    }
    return { x, y, n };
  }

  /** Feed one fast row (only race-on rows with finite AccelGX and AccelGZ are added). */
  feed(row) {
    if (!row || typeof row.length !== 'number') return;
    const race = row[this._iRace];
    if (!Number.isFinite(race)) return;
    if (!race) { this._hasPrev = false; return; }
    const gx = this._iGX >= 0 ? row[this._iGX] : NaN;
    const gz = this._iGZ >= 0 ? row[this._iGZ] : NaN;
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return;

    this._x[this._head] = gx;
    this._y[this._head] = gz;
    this._head = (this._head + 1) % this._size;
    if (this._n < this._size) this._n++;

    const p = this._peaks;
    const ts = this._iTs >= 0 ? row[this._iTs] : NaN;
    if (this._decay > 0 && this._hasPrev && Number.isFinite(ts)) {
      const dt = ts - this._pTs;
      if (dt > 0 && dt <= MAX_DT_MS) {
        let l = 0;
        let r = 0;
        let a = 0;
        let b = 0;
        const start = (this._head - this._n + this._size) % this._size;
        for (let i = 0; i < this._n; i++) {
          const j = (start + i) % this._size;
          const x = this._x[j];
          const y = this._y[j];
          if (-x > l) l = -x;
          if (x > r) r = x;
          if (y > a) a = y;
          if (-y > b) b = -y;
        }
        const dec = this._decay * (dt / 1000);
        p.left = Math.max(l, p.left - dec);
        p.right = Math.max(r, p.right - dec);
        p.accel = Math.max(a, p.accel - dec);
        p.brake = Math.max(b, p.brake - dec);
      }
    }
    this._hasPrev = Number.isFinite(ts);
    this._pTs = Number.isFinite(ts) ? ts : 0;

    if (-gx > p.left) p.left = -gx;
    if (gx > p.right) p.right = gx;
    if (gz > p.accel) p.accel = gz;
    if (-gz > p.brake) p.brake = -gz;
  }
}
