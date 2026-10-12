// Shift-light logic: how many LEDs to light for an rpm, their colours, and a one-shot "shift now" cue.
//
// Pure functions plus a small class: no DOM, no audio, no clocks (the caller passes the time).

/**
 * Default shift-light configuration. All thresholds are fractions of EngineMaxRpm.
 *  - leds: number of LEDs in the bar
 *  - start: first LED lights above this ratio
 *  - red: every LED is lit from this ratio on
 *  - flash: the bar flashes (all blue) from this ratio on
 *  - beep: ratio at which `ShiftCue` fires
 *  - yellow: informational (where a skin may switch its colour ramp); `shiftLevel` colours by LED position
 */
export const DEFAULT_SHIFT = Object.freeze({ leds: 15, start: 0.70, yellow: 0.82, red: 0.90, flash: 0.965, beep: 0.94 });

const MAX_RATIO = 1.2;
const MAX_LEDS = 64;
const CUE_REFRACTORY_S = 0.4;
const CUE_REARM_BELOW = 0.05;

const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * rpm / maxRpm clamped to 0..1.2 (0 when either value is unusable or maxRpm <= 0).
 * @param {number} rpm
 * @param {number} maxRpm
 * @returns {number}
 */
export function rpmRatio(rpm, maxRpm) {
  if (!Number.isFinite(rpm) || !Number.isFinite(maxRpm) || maxRpm <= 0) return 0;
  const r = rpm / maxRpm;
  return r < 0 ? 0 : r > MAX_RATIO ? MAX_RATIO : r;
}

const zoneCache = new Map();

/** Frozen colour array for `n` LEDs: first 40 % 'g', last 20 % 'r', the rest 'y'; all 'b' when flashing. */
function zonesFor(n, flashing) {
  const key = flashing ? -n : n;
  let z = zoneCache.get(key);
  if (!z) {
    z = new Array(n);
    if (flashing) {
      z.fill('b');
    } else {
      let g = Math.round(n * 0.4);
      let r = Math.round(n * 0.2);
      if (n === 1) { g = 0; r = 1; } else if (n === 2) { g = 1; r = 1; }
      for (let i = 0; i < n; i++) z[i] = i < g ? 'g' : i >= n - r ? 'r' : 'y';
    }
    Object.freeze(z);
    zoneCache.set(key, z);
  }
  return z;
}

/**
 * Shift-light state for one rpm sample.
 *
 * `lit` counts LEDs from the left: 0 at ratio <= cfg.start, rising linearly (floored) to cfg.leds at ratio >= cfg.red.
 * `zones` is a frozen array of 'g' | 'y' | 'r' per LED (40 / 40 / 20 %), or all 'b' while `flashing`
 * (ratio >= cfg.flash). maxRpm <= 0 or non-finite input gives ratio 0, lit 0, not flashing.
 *
 * @param {number} rpm current engine rpm
 * @param {number} maxRpm engine redline rpm
 * @param {{leds?: number, start?: number, yellow?: number, red?: number, flash?: number, beep?: number}} [cfg]
 * @returns {{ratio: number, lit: number, flashing: boolean, zones: ReadonlyArray<string>}}
 */
export function shiftLevel(rpm, maxRpm, cfg = DEFAULT_SHIFT) {
  const c = cfg || DEFAULT_SHIFT;
  const leds = Math.min(MAX_LEDS, Math.max(1, Math.floor(num(c.leds, DEFAULT_SHIFT.leds))));
  const start = num(c.start, DEFAULT_SHIFT.start);
  const red = num(c.red, DEFAULT_SHIFT.red);
  const flash = num(c.flash, DEFAULT_SHIFT.flash);
  const ratio = rpmRatio(rpm, maxRpm);
  const valid = Number.isFinite(rpm) && Number.isFinite(maxRpm) && maxRpm > 0;

  let lit = 0;
  if (valid && ratio > start) {
    lit = ratio >= red ? leds : Math.min(leds, Math.floor(((ratio - start) / (red - start)) * leds + 1e-9));
  }
  const flashing = valid && ratio >= flash;
  return { ratio, lit, flashing, zones: zonesFor(leds, flashing) };
}

/**
 * One-shot "shift now" cue. Call `update` on every sample; it returns true on the sample where the rpm ratio crosses
 * up through `cfg.beep`, if the previous cue was at least 0.4 s ago. After a cue (or a crossing swallowed by the
 * refractory period) it stays quiet until the ratio has fallen below `cfg.beep - 0.05`.
 */
export class ShiftCue {
  constructor() { this.reset(); }

  /** Re-arm and forget the last cue time. */
  reset() {
    this._armed = true;
    this._last = NaN;
  }

  /**
   * @param {number} rpm current engine rpm
   * @param {number} maxRpm engine redline rpm
   * @param {number} nowSeconds any monotonic clock in seconds (game time or performance.now()/1000)
   * @param {{beep?: number}} [cfg] defaults to DEFAULT_SHIFT
   * @returns {boolean} true exactly once per crossing
   */
  update(rpm, maxRpm, nowSeconds, cfg = DEFAULT_SHIFT) {
    const beep = num((cfg || DEFAULT_SHIFT).beep, DEFAULT_SHIFT.beep);
    const ratio = rpmRatio(rpm, maxRpm);
    if (ratio < beep - CUE_REARM_BELOW) { this._armed = true; return false; }
    if (!this._armed || ratio < beep) return false;

    this._armed = false;                         // this crossing is used up whether or not it beeps
    const now = nowSeconds;
    const last = this._last;
    const clear = !Number.isFinite(now) || Number.isNaN(last) || now < last || now - last >= CUE_REFRACTORY_S - 1e-9;
    if (!clear) return false;
    if (Number.isFinite(now)) this._last = now;
    return true;
  }
}
