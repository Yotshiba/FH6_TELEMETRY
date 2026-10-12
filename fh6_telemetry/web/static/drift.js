// Drift tracker: turns sideways driving into scored, multiplied "chains".
// Pure logic - no DOM, no clock. Rows are positional arrays aligned with the
// "hello" column table (store.F); keys used: SideslipDeg, SpeedKmh, TimestampMS, IsRaceOn.

/** Live-score thresholds that emit `drift_milestone` (once per chain each). */
export const DRIFT_MILESTONES = Object.freeze([500, 1000, 2000, 5000, 10000, 25000]);

const DEFAULTS = Object.freeze({
  startAngle: 12,      // |angle| (deg) needed to START a chain
  startSpeed: 40,      // km/h needed to start
  keepAngle: 8,        // |angle| needed to keep scoring inside a chain
  keepSpeed: 30,       // km/h needed to keep scoring
  gapS: 1.2,           // a below-threshold gap longer than this ends the chain
  spinAngle: 120,      // |angle| above this = spin-out (chain lost, not banked)
  maxDtMs: 250,        // larger (or non-positive) timestamp steps are discontinuities
  minScore: 50,        // shorter junk chains are discarded silently
  rate: 0.1,           // points/s = rate * speedKmh * min(|angle|, angleCap) * mult
  angleCap: 60,
  multStep: 0.5,       // multiplier = 1 + multStep * floor(driftSeconds), capped
  multMax: 5,
  milestoneMinS: 3,    // milestones only fire once the chain is at least this old
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
  o.gapMs = Math.round(o.gapS * 1000);
  const ms = opts && Array.isArray(opts.milestones) ? opts.milestones.filter(isNum) : null;
  o.milestones = (ms && ms.length ? ms : DRIFT_MILESTONES).slice().sort((a, b) => a - b);
  return o;
}

/**
 * Scores drift chains from fast rows.
 *
 * Events (drain()): `drift_start`, `drift_end {score,durationS,maxAngleDeg,mult}`,
 * `drift_milestone {score}`, `drift_fail {score}`.
 *
 * state: {active, scoring, angleDeg, score, mult, chainTimeS, driftTimeS, maxAngleDeg,
 * banked, best, sessionBestAngle, gapS, last}.
 */
export class DriftTracker {
  /**
   * @param {{F: Object<string, number>, S?: Object<string, number>}} maps key -> index maps from "hello"
   * @param {Object} [options] override any threshold in DEFAULTS (startAngle, keepSpeed, gapS, ...)
   *   plus `milestones` (array of score thresholds)
   */
  constructor(maps, options) {
    const F = maps ? maps.F : undefined;
    this._ix = {
      race: index(F, 'IsRaceOn'),
      angle: index(F, 'SideslipDeg'),
      speed: index(F, 'SpeedKmh'),
      t: index(F, 'TimestampMS'),
    };
    this._need = Math.max(this._ix.race, this._ix.angle, this._ix.speed, this._ix.t) + 1;
    this._o = resolveOptions(options);
    this._events = [];
    this.reset();
  }

  /** Forget everything: chain, banked totals, bests and pending events. */
  reset() {
    this._events.length = 0;
    this._lastT = null;
    this._angle = 0;
    this._banked = 0;
    this._best = 0;
    this._sessionBestAngle = 0;
    this._last = null;
    this._clearChain();
  }

  /**
   * Feed one fast row (oldest first). Malformed rows are ignored.
   * @param {ArrayLike<number>} row
   */
  feed(row) {
    if (!row || typeof row.length !== 'number') return;
    const ix = this._ix;
    const o = this._o;
    if (ix.angle < 0 || ix.speed < 0 || ix.t < 0 || row.length < this._need) return;
    if (ix.race >= 0) {
      const r = row[ix.race];
      if (!isNum(r)) return;
      if (r === 0) { this._raceOff(); return; }
    }
    const angle = row[ix.angle];
    const speed = row[ix.speed];
    const t = row[ix.t];
    if (!isNum(angle) || !isNum(speed) || !isNum(t)) return;

    let dt = 0;
    if (this._lastT !== null) {
      dt = t - this._lastT;
      // Equal stamps are normal (the game's clock ticks every ~15.6 ms but rows arrive every
      // ~13 ms): a zero step. Only a step backwards or a long gap is a discontinuity.
      if (!(dt >= 0) || dt > o.maxDtMs) { this._endChain(); dt = 0; }
    }
    this._lastT = t;
    this._angle = angle;
    const a = Math.abs(angle);

    if (!this._active) {
      if (a >= o.startAngle && a <= o.spinAngle && speed >= o.startSpeed) this._start(t, a);
      return;
    }
    if (a > o.spinAngle) { this._fail(); return; }

    this._chainMs = t - this._startT;
    if (a >= o.keepAngle && speed >= o.keepSpeed) {
      // The multiplier in force at the START of the interval applies to it.
      this._score += o.rate * speed * Math.min(a, o.angleCap) * (dt / 1000) * this._mult();
      this._driftMs += dt;
      this._lastScoreT = t;
      this._scoring = true;
      this._gapMs = 0;
      if (a > this._maxAngle) this._maxAngle = a;
      if (a > this._sessionBestAngle) this._sessionBestAngle = a;
      // Judged on scoring rows only, so "chain >= 3 s" matches the durationS drift_end reports.
      this._checkMilestones();
    } else {
      this._scoring = false;
      this._gapMs = t - this._lastScoreT;
      if (this._gapMs > o.gapMs) this._endChain();
    }
  }

  /** Current tracker state (a fresh plain object on every read). */
  get state() {
    const a = this._active;
    return {
      active: a,
      scoring: a && this._scoring,
      angleDeg: this._angle,
      score: a ? Math.round(this._score) : 0,
      mult: a ? this._mult() : 1,
      chainTimeS: a ? this._chainMs / 1000 : 0,
      driftTimeS: a ? this._driftMs / 1000 : 0,
      maxAngleDeg: a ? this._maxAngle : 0,
      banked: this._banked,
      best: this._best,
      sessionBestAngle: this._sessionBestAngle,
      gapS: a && !this._scoring ? this._gapMs / 1000 : 0,
      last: this._last ? { ...this._last } : null,
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

  _mult() {
    const o = this._o;
    return Math.min(o.multMax, 1 + o.multStep * Math.floor(this._driftMs / 1000));
  }

  _clearChain() {
    this._active = false;
    this._scoring = false;
    this._score = 0;
    this._driftMs = 0;
    this._chainMs = 0;
    this._startT = 0;
    this._lastScoreT = 0;
    this._gapMs = 0;
    this._maxAngle = 0;
    this._mi = 0;
  }

  _raceOff() {
    this._endChain();
    this._lastT = null;
    this._angle = 0;
  }

  _start(t, a) {
    this._clearChain();
    this._active = true;
    this._scoring = true;
    this._startT = t;
    this._lastScoreT = t;
    this._maxAngle = a;
    if (a > this._sessionBestAngle) this._sessionBestAngle = a;
    this._emit({ type: 'drift_start' });
  }

  /** Finish the chain normally: bank + `drift_end` when it scored enough, else discard silently. */
  _endChain() {
    if (!this._active) return;
    if (this._score >= this._o.minScore) {
      const score = Math.round(this._score);
      const info = {
        score,
        durationS: (this._lastScoreT - this._startT) / 1000,
        maxAngleDeg: this._maxAngle,
        mult: this._mult(),
      };
      this._banked += score;
      if (score > this._best) this._best = score;
      this._last = info;
      this._emit({ type: 'drift_end', ...info });
    }
    this._clearChain();
  }

  /** Spin-out: the chain is lost, never banked. */
  _fail() {
    this._emit({ type: 'drift_fail', score: Math.round(this._score) });
    this._clearChain();
  }

  _checkMilestones() {
    const o = this._o;
    if (this._chainMs < o.milestoneMinS * 1000) return;
    const ms = o.milestones;
    while (this._mi < ms.length && this._score >= ms[this._mi]) {
      this._emit({ type: 'drift_milestone', score: ms[this._mi] });
      this._mi++;
    }
  }
}
