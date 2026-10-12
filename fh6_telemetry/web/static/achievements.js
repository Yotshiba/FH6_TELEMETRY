// Achievements: pure rules that turn tracker events (and a little context) into unlocks.
// No persistence, no DOM, no clock: the caller stores `serialize()` and passes it back in.
//
// Session-based: jumper_10 (ctx.session.jumps), and the per-run perf ones are judged on each
//   `perf` event as it happens.
// Lifetime: marathon (ctx.lifetimeOdometerM) and, because unlocks are persisted by the caller,
//   every other achievement once earned.

/** Display order and labels of the `group` field. */
export const ACHIEVEMENT_GROUPS = Object.freeze([
  Object.freeze({ id: 'speed', title: 'Speed' }),
  Object.freeze({ id: 'drift', title: 'Drift' }),
  Object.freeze({ id: 'air', title: 'Air' }),
  Object.freeze({ id: 'grip', title: 'Grip' }),
  Object.freeze({ id: 'launch', title: 'Launch' }),
  Object.freeze({ id: 'drag', title: 'Drag' }),
  Object.freeze({ id: 'car', title: 'Car' }),
  Object.freeze({ id: 'career', title: 'Career' }),
]);

const def = (id, icon, title, desc, rarity, group) => Object.freeze({ id, icon, title, desc, rarity, group });

/** All achievement definitions: {id, icon, title, desc, rarity, group}. */
export const ACHIEVEMENTS = Object.freeze([
  def('speed_100', '🚗', 'Warming up', 'Reach 100 km/h.', 'common', 'speed'),
  def('speed_200', '💨', 'Double Century', 'Reach 200 km/h.', 'common', 'speed'),
  def('speed_250', '⚡', 'Autobahn Cruiser', 'Reach 250 km/h.', 'rare', 'speed'),
  def('speed_300', '🚀', 'Ludicrous Speed', 'Reach 300 km/h. Hold on to something.', 'epic', 'speed'),
  def('redline', '🔥', 'Needle Pinned', 'Hit the rev limiter.', 'common', 'car'),
  def('drift_500', '🌀', 'Sideways Starter', 'Score 500 in a single drift.', 'common', 'drift'),
  def('drift_2000', '😎', 'Tail Happy', 'Score 2,000 in a single drift.', 'rare', 'drift'),
  def('drift_5000', '🌋', 'Smoke Show', 'Score 5,000 in a single drift.', 'epic', 'drift'),
  def('drift_10000', '👑', 'Drift King', 'Score 10,000 in a single drift.', 'legendary', 'drift'),
  def('air_1s', '🐇', 'Hang Time', 'Stay airborne for 1 second.', 'common', 'air'),
  def('air_2s', '🛫', 'Flying Lessons', 'Stay airborne for 2 seconds.', 'rare', 'air'),
  def('air_4s', '🛸', 'Is It a Plane?', 'Stay airborne for 4 seconds.', 'legendary', 'air'),
  def('lat_1_5g', '🧲', 'Glued to the Road', 'Corner at 1.5 g lateral.', 'common', 'grip'),
  def('lat_2g', '💪', 'Neck Workout', 'Corner at 2 g lateral.', 'rare', 'grip'),
  def('brake_1_2g', '⚓', 'Anchors Away', 'Brake at 1.2 g.', 'common', 'grip'),
  def('launch_3s', '🐆', 'Quick Off the Line', '0-100 km/h in under 3.0 s.', 'common', 'launch'),
  def('launch_2_5s', '💥', 'Hole Shot', '0-100 km/h in under 2.5 s.', 'epic', 'launch'),
  def('quarter_12s', '🕛', 'Twelve-Second Club', 'Quarter mile in under 12.0 s.', 'rare', 'drag'),
  def('quarter_10s', '🔟', 'Ten-Second Club', 'Quarter mile in under 10.0 s.', 'epic', 'drag'),
  def('hot_tyres', '🍳', 'Cooking Rubber', 'All four tyres at 100 °C or hotter.', 'common', 'car'),
  def('marathon', '🏁', 'Odometer Hero', 'Drive 100 km in total.', 'rare', 'career'),
  def('long_drift', '🌊', 'Endless Slide', 'Hold a single drift chain for 10 seconds.', 'rare', 'drift'),
  def('combo_x5', '🎯', 'Max Combo', 'Reach the x5 drift multiplier.', 'rare', 'drift'),
  def('jumper_10', '🦘', 'Jackrabbit', 'Make 10 jumps in one session.', 'rare', 'air'),
  def('perfect_stop', '🛑', 'Brake Check', '100 to 0 km/h in under 2.8 s.', 'rare', 'grip'),
]);

const BY_ID = new Map(ACHIEVEMENTS.map((d) => [d.id, d]));

const SPEED_STEPS = [['speed_100', 100], ['speed_200', 200], ['speed_250', 250], ['speed_300', 300]];
const DRIFT_STEPS = [['drift_500', 500], ['drift_2000', 2000], ['drift_5000', 5000], ['drift_10000', 10000]];
const AIR_STEPS = [['air_1s', 1], ['air_2s', 2], ['air_4s', 4]];
const LAT_STEPS = [['lat_1_5g', 1.5], ['lat_2g', 2]];
const BRAKE_STEPS = [['brake_1_2g', 1.2]];
const LAUNCH_STEPS = [['launch_3s', 3.0], ['launch_2_5s', 2.5]];      // time < limit
const QUARTER_STEPS = [['quarter_12s', 12.0], ['quarter_10s', 10.0]];  // time < limit
const STOP_STEPS = [['perfect_stop', 2.8]];                            // time < limit

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** value is a number of seconds, or an object carrying `.time`; anything else -> NaN. */
function perfTime(value) {
  const t = typeof value === 'number' ? value : value && typeof value === 'object' ? value.time : NaN;
  return isNum(t) && t > 0 ? t : NaN;
}

/** Classify a `record` key ('maxLatG', 'lateral_g', 'brakeG', 'topSpeed', ...). */
function recordKind(key) {
  if (typeof key !== 'string') return null;
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/speed/.test(k) && !/avg|average|min/.test(k)) return 'speed';
  if (/lat/.test(k) && /g$|gforce|accel/.test(k)) return 'lat';
  if (/brak|decel/.test(k) && /g$|gforce|accel|decel/.test(k)) return 'brake';
  return null;
}

/**
 * Tracks which achievements are unlocked. Rules are driven by events from the other trackers.
 *
 * consume() input events: `speed_milestone {kmh}`, `redline`, `record {key,value}`,
 * `drift_end {score,durationS,maxAngleDeg,mult}`, `drift_milestone {score}`,
 * `air_end {durationS,...}`, `perf {key,value}` (t100 / qmile / brake100: value = seconds or
 * {time,...}). Unknown event types are ignored.
 *
 * `record` keys are classified loosely (case/punctuation-insensitive): *speed* -> top speed in
 * km/h, *lat...g* / *lateral...accel* -> lateral g (absolute value), *brak...g* / *decel* ->
 * braking g (absolute value).
 */
export class Achievements {
  /** @param {{unlocked?: Iterable<string>}} [init] ids unlocked earlier; unknown ids are dropped */
  constructor({ unlocked = [] } = {}) {
    this._set = new Set();
    if (unlocked && typeof unlocked[Symbol.iterator] === 'function' && typeof unlocked !== 'string') {
      for (const id of unlocked) if (BY_ID.has(id)) this._set.add(id);
    }
  }

  /**
   * Evaluate events and context; returns the NEWLY unlocked definitions (never repeats).
   * @param {Array<Object>} events events produced by the other trackers since the last call
   * @param {{fastRow?: ArrayLike<number>, F?: Object<string, number>, lifetimeOdometerM?: number,
   *   session?: {jumps?: number}, now?: *}} [ctx] `now` (any value) is copied to `unlockedAt`
   * @returns {Array<Object>} definitions; copies with `unlockedAt` when ctx.now is given
   */
  consume(events, ctx = {}) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const out = [];
    if (Array.isArray(events)) for (const ev of events) this._event(ev, out);
    this._context(c, out);
    if (c.now === undefined || c.now === null) return out;
    return out.map((d) => ({ ...d, unlockedAt: c.now }));
  }

  /** @param {string} id */
  isUnlocked(id) { return this._set.has(id); }

  /** Sorted array of unlocked ids, ready to persist. */
  serialize() { return [...this._set].sort(); }

  /** @returns {{unlocked: number, total: number}} */
  progress() { return { unlocked: this._set.size, total: ACHIEVEMENTS.length }; }

  /** All definitions in display order, each with an extra boolean `unlocked`. */
  list() { return ACHIEVEMENTS.map((d) => ({ ...d, unlocked: this._set.has(d.id) })); }

  /** Forget every unlock. */
  reset() { this._set.clear(); }

  // ---- internals ----

  _unlock(id, out) {
    if (this._set.has(id)) return;
    const d = BY_ID.get(id);
    if (!d) return;
    this._set.add(id);
    out.push(d);
  }

  /** Unlock every step whose threshold `value` reaches (>=). */
  _atLeast(steps, value, out) {
    if (!isNum(value)) return;
    for (const [id, limit] of steps) if (value >= limit) this._unlock(id, out);
  }

  /** Unlock every step whose limit `value` beats (<). */
  _below(steps, value, out) {
    if (!isNum(value)) return;
    for (const [id, limit] of steps) if (value < limit) this._unlock(id, out);
  }

  _event(ev, out) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'speed_milestone':
        this._atLeast(SPEED_STEPS, ev.kmh, out);
        break;
      case 'redline':
        this._unlock('redline', out);
        break;
      case 'record': {
        const kind = recordKind(ev.key);
        if (kind === 'speed') this._atLeast(SPEED_STEPS, ev.value, out);
        else if (kind === 'lat') this._atLeast(LAT_STEPS, isNum(ev.value) ? Math.abs(ev.value) : NaN, out);
        else if (kind === 'brake') this._atLeast(BRAKE_STEPS, isNum(ev.value) ? Math.abs(ev.value) : NaN, out);
        break;
      }
      case 'drift_end':
        this._atLeast(DRIFT_STEPS, ev.score, out);
        if (isNum(ev.durationS) && ev.durationS >= 10) this._unlock('long_drift', out);
        if (isNum(ev.mult) && ev.mult >= 5) this._unlock('combo_x5', out);
        break;
      case 'drift_milestone':
        this._atLeast(DRIFT_STEPS, ev.score, out);
        break;
      case 'air_end':
        this._atLeast(AIR_STEPS, ev.durationS, out);
        break;
      case 'perf': {
        const t = perfTime(ev.value);
        if (ev.key === 't100') this._below(LAUNCH_STEPS, t, out);
        else if (ev.key === 'qmile') this._below(QUARTER_STEPS, t, out);
        else if (ev.key === 'brake100') this._below(STOP_STEPS, t, out);
        break;
      }
      default:
        break;
    }
  }

  _context(c, out) {
    const row = c.fastRow;
    const F = c.F;
    if (row && F && typeof row.length === 'number') {
      const raceIdx = F.IsRaceOn;
      const racing = !Number.isInteger(raceIdx) || !(row[raceIdx] === 0);
      if (racing) {
        const idx = ['FL', 'FR', 'RL', 'RR'].map((w) => F[`TireTemp${w}`]);
        if (idx.every((i) => Number.isInteger(i) && i >= 0) && idx.every((i) => isNum(row[i]) && row[i] >= 100)) {
          this._unlock('hot_tyres', out);
        }
      }
    }
    if (isNum(c.lifetimeOdometerM) && c.lifetimeOdometerM >= 100000) this._unlock('marathon', out);
    const jumps = c.session && c.session.jumps;
    if (isNum(jumps) && jumps >= 10) this._unlock('jumper_10', out);
  }
}
