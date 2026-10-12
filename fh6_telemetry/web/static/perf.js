// Automatic performance timers (drag-race meter): standing-start times, quarter mile and braking distances.
//
// Pure logic: no DOM, no clocks. Feed fast rows (positional arrays, oldest first) one at a time; read `state`
// for the live picture and `drain()` for discrete events. Time comes from the game's TimestampMS column.

const KMH_TO_MS = 1 / 3.6;
/** 60 mph in km/h. */
export const MPH60_KMH = 96.5606;
/** A quarter mile in metres. */
export const QUARTER_MILE_M = 402.336;

const STOP_KMH = 1.5;        // below this the car counts as stopped (arming)
const GO_KMH = 1.0;          // above this an armed meter starts the run
const MAX_START_KMH = 15;    // ... but only if it is still crawling: a first row far above this is a teleport / respawn, not a launch
const ARM_MS = 400;          // how long the car must stay stopped to arm
const END_DROP_KMH = 12;     // run ends this far below the peak speed
const MAX_RUN_S = 90;        // ... or after this long
const MAX_DT_MS = 250;       // longer row spacing is a discontinuity

const BRAKE_MIN_PCT = 40;    // brake pedal needed at the moment the speed crosses the start threshold
const BRAKE_LOW_PCT = 10;    // pedal below this counts as released
const BRAKE_LOW_MS = 800;    // released for longer than this cancels the measurement
const BRAKE_RISE_KMH = 3;    // speed rising this far above the running minimum cancels it
const BRAKE_DONE_KMH = 1.0;  // the measurement completes below this speed

const ACCEL_KEYS = ['t60mph', 't100', 't200', 't100to200', 'qmile'];
const THRESHOLDS = [['t60mph', MPH60_KMH], ['t100', 100], ['t200', 200]];

function idx(map, key) {
  const i = map ? map[key] : undefined;
  return Number.isInteger(i) && i >= 0 ? i : -1;
}

function makeBrake(key, thr) {
  return { key, thr, active: false, dist: 0, time: 0, minSpeed: 0, lowSince: NaN, order: 0 };
}

/**
 * Standing-start and braking timers.
 *
 * Phases (`state.phase`): 'idle' -> 'armed' (stopped for 0.4 s) -> 'running' (moving) -> 'done' -> 'armed' (stopped again).
 *
 * Row timing: dt is the TimestampMS difference to the previous race-on row. dt === 0 (the game clock is quantised, so
 * equal stamps are normal) is a zero-length step; dt < 0 or dt > 250 ms is a discontinuity that aborts a running test
 * ('gap'), cancels braking measurements and restarts the stopped-streak timer. IsRaceOn = 0 rows are skipped and abort
 * running tests ('paused').
 *
 * Events (see `drain()`):
 *  - `{type:'perf_start'}`
 *  - `{type:'perf', key, value}`  key is t60mph | t100 | t200 | t100to200 (seconds) | qmile ({time, trapKmh})
 *    | brake100 | brake60mph ({dist, time}).
 *  - `{type:'perf_end', peakKmh}`
 *  - `{type:'perf_abort', reason}` reason 'paused' | 'gap' | 'creep' (the standing-start run was dropped), or
 *    `{type:'perf_abort', reason:'brake-cancel', test:'brake100'|'brake60mph', cause:'paused'|'gap'|'no-brake'|'speed-rise'}`.
 */
export class PerfMeter {
  /**
   * @param {{F: Object<string, number>, S?: Object<string, number>}} maps column key -> index maps from "hello"
   * @param {{maxEvents?: number}} [options] maxEvents caps the undrained event queue (default 256, oldest dropped)
   */
  constructor(maps, options = {}) {
    const F = maps && maps.F;
    this._iRace = idx(F, 'IsRaceOn');
    this._iSpeed = idx(F, 'SpeedKmh');
    this._iTs = idx(F, 'TimestampMS');
    this._iBrake = idx(F, 'BrakePct');
    const me = options && Number.isFinite(options.maxEvents) ? Math.floor(options.maxEvents) : 256;
    this._maxEvents = Math.max(1, me);
    this.reset();
  }

  /** Forget everything: phase 'idle', results cleared, queued events dropped. */
  reset() {
    this._events = [];
    this._phase = 'idle';
    this._results = {
      t60mph: null, t100: null, t200: null, t100to200: null, qmile: null, brake100: null, brake60mph: null,
    };
    this._live = { t: 0, speedKmh: 0, distM: 0, peakKmh: 0 };
    this._run = null;
    this._hasPrev = false;
    this._pSpeed = 0;
    this._pTs = 0;
    this._still = NaN;      // game time at which the current stopped streak began (NaN = none)
    this._brakes = [makeBrake('brake100', 100), makeBrake('brake60mph', MPH60_KMH)];
    this._brakeSeq = 0;
  }

  /**
   * Snapshot of the meter (a fresh plain object each call; safe to keep).
   * `phase` 'idle'|'armed'|'running'|'done'.
   * `live` {t, speedKmh, distM, peakKmh}: updated on every row while running, keeps its final values in 'done',
   *   zeroed after an abort.
   * `results` {t60mph, t100, t200, t100to200 (s), qmile {time, trapKmh}, brake100 {dist, time}, brake60mph {dist, time}},
   *   null while unset. The acceleration results are cleared when the next run starts; the brake results are
   *   kept until a newer braking test completes.
   * `brake` {active, distM, timeS, target}: the oldest running braking measurement (target 'brake100'|'brake60mph').
   */
  get state() {
    let b = null;
    for (const m of this._brakes) if (m.active && (!b || m.order < b.order)) b = m;
    return {
      phase: this._phase,
      live: { ...this._live },
      results: { ...this._results },
      brake: b
        ? { active: true, distM: b.dist, timeS: b.time, target: b.key }
        : { active: false, distM: 0, timeS: 0, target: null },
    };
  }

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
    if (!race) { this._pause(); return; }
    const speed = row[this._iSpeed];
    const ts = row[this._iTs];
    if (!Number.isFinite(speed) || !Number.isFinite(ts) || speed < 0) return;
    const brakePct = this._iBrake >= 0 ? row[this._iBrake] : NaN;

    if (this._hasPrev) {
      const dt = ts - this._pTs;
      // The game clock is quantised (~15.6 ms), so equal consecutive stamps are normal: a zero step.
      if (!(dt >= 0) || dt > MAX_DT_MS) {
        this._discontinuity(speed, ts);
        return;
      }
      if (this._run) this._stepRun(speed, dt);
      this._stepBrakes(speed, ts, dt, brakePct);
    }
    this._stepPhase(speed, ts);
    this._hasPrev = true;
    this._pSpeed = speed;
    this._pTs = ts;
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  _emit(ev) {
    const q = this._events;
    q.push(ev);
    if (q.length > this._maxEvents) q.splice(0, q.length - this._maxEvents);
  }

  _brakeActive() {
    for (const m of this._brakes) if (m.active) return true;
    return false;
  }

  _pause() {
    if (this._run) this._abortRun('paused');
    this._cancelBrakes('paused');
    this._hasPrev = false;
    this._still = NaN;
    if (this._phase === 'armed') this._phase = 'idle';
  }

  _discontinuity(speed, ts) {
    if (this._run) this._abortRun('gap');
    this._cancelBrakes('gap');
    if (this._phase === 'armed') this._phase = 'idle';
    this._still = speed < STOP_KMH ? ts : NaN;
    this._hasPrev = true;
    this._pSpeed = speed;
    this._pTs = ts;
  }

  _abortRun(reason) {
    this._run = null;
    this._phase = 'idle';
    this._still = NaN;
    this._live = { t: 0, speedKmh: 0, distM: 0, peakKmh: 0 };
    this._emit({ type: 'perf_abort', reason });
  }

  _setResult(key, value) {
    this._results[key] = value;
    this._emit({ type: 'perf', key, value });
  }

  _startRun(speed) {
    for (const k of ACCEL_KEYS) this._results[k] = null;
    this._run = { ms: 0, dist: 0, peak: speed };
    this._phase = 'running';
    this._still = NaN;
    this._live = { t: 0, speedKmh: speed, distM: 0, peakKmh: speed };
    this._emit({ type: 'perf_start' });
  }

  _stepRun(speed, dt) {
    const run = this._run;
    const prev = this._pSpeed;
    const dtS = dt / 1000;
    const t0 = run.ms / 1000;
    const d0 = run.dist;
    run.ms += dt;                       // integer milliseconds: no float drift against the 90 s limit
    const t1 = run.ms / 1000;
    run.dist = d0 + (prev + speed) * 0.5 * KMH_TO_MS * dtS;
    if (speed > run.peak) run.peak = speed;

    const r = this._results;
    for (const [key, thr] of THRESHOLDS) {
      if (r[key] === null && prev < thr && speed >= thr) {
        this._setResult(key, t0 + ((thr - prev) / (speed - prev)) * dtS);
        if (key === 't200' && r.t100 !== null) this._setResult('t100to200', r.t200 - r.t100);
      }
    }
    if (r.qmile === null && d0 < QUARTER_MILE_M && run.dist >= QUARTER_MILE_M) {
      const f = (QUARTER_MILE_M - d0) / (run.dist - d0);
      this._setResult('qmile', Object.freeze({ time: t0 + f * dtS, trapKmh: prev + f * (speed - prev) }));
    }

    const live = this._live;
    live.t = t1;
    live.speedKmh = speed;
    live.distM = run.dist;
    live.peakKmh = run.peak;

    // Rolled a few centimetres and stopped again: that was not a launch, and a 12 km/h drop can never happen.
    if (run.peak < END_DROP_KMH && speed < GO_KMH) { this._abortRun('creep'); return; }
    if (run.peak - speed >= END_DROP_KMH || run.ms > MAX_RUN_S * 1000) {
      this._run = null;
      this._phase = 'done';
      this._emit({ type: 'perf_end', peakKmh: run.peak });
    }
  }

  _stepPhase(speed, ts) {
    const ph = this._phase;
    if (ph === 'armed') {
      if (speed > MAX_START_KMH) { this._phase = 'idle'; this._still = NaN; }
      else if (speed > GO_KMH) this._startRun(speed);
    } else if (ph === 'idle' || ph === 'done') {
      if (speed < STOP_KMH) {
        if (Number.isNaN(this._still)) this._still = ts;
        else if (ts - this._still >= ARM_MS) this._phase = 'armed';
      } else {
        this._still = NaN;
      }
    }
  }

  _stepBrakes(speed, ts, dt, brakePct) {
    const prev = this._pSpeed;
    const dtS = dt / 1000;
    for (const m of this._brakes) {
      if (m.active) {
        if (speed - m.minSpeed > BRAKE_RISE_KMH) { this._cancelBrake(m, 'speed-rise'); continue; }
        if (speed < BRAKE_DONE_KMH) {
          // Stop the clock where the speed crossed the "stopped" threshold, not a whole row later.
          const part = ((prev - BRAKE_DONE_KMH) / (prev - speed)) * dtS;
          m.dist += (prev + BRAKE_DONE_KMH) * 0.5 * KMH_TO_MS * part;
          m.time += part;
          this._setResult(m.key, Object.freeze({ dist: m.dist, time: m.time }));
          this._clearBrake(m);
          continue;
        }
        m.dist += (prev + speed) * 0.5 * KMH_TO_MS * dtS;
        m.time += dtS;
        if (speed < m.minSpeed) m.minSpeed = speed;
        if (brakePct < BRAKE_LOW_PCT) {
          if (Number.isNaN(m.lowSince)) m.lowSince = ts;
          else if (ts - m.lowSince > BRAKE_LOW_MS) this._cancelBrake(m, 'no-brake');
        } else {
          m.lowSince = NaN;
        }
      } else if (prev >= m.thr && speed < m.thr && speed >= BRAKE_DONE_KMH && brakePct >= BRAKE_MIN_PCT) {
        const rem = (1 - (prev - m.thr) / (prev - speed)) * dtS;   // time from the interpolated crossing to this row
        m.active = true;
        m.dist = (m.thr + speed) * 0.5 * KMH_TO_MS * rem;
        m.time = rem;
        m.minSpeed = speed;
        m.lowSince = NaN;
        m.order = ++this._brakeSeq;
      }
    }
  }

  _clearBrake(m) {
    m.active = false;
    m.dist = 0;
    m.time = 0;
    m.lowSince = NaN;
  }

  _cancelBrake(m, cause) {
    this._clearBrake(m);
    this._emit({ type: 'perf_abort', reason: 'brake-cancel', test: m.key, cause });
  }

  _cancelBrakes(cause) {
    for (const m of this._brakes) if (m.active) this._cancelBrake(m, cause);
  }
}
