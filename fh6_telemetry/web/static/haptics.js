// Phone haptics: turns driving feel (kerbs, g-forces, impacts, shifts) into navigator.vibrate patterns.
//
// The vibrate function is injected, so this module is testable in Node and never touches `navigator`
// at import time.

/** Thresholds and patterns (ms). Exported so a settings UI / tests can show or reuse them. */
export const HAPTIC = Object.freeze({
  latG: 1.2,            // |lateral g| above this -> cornering tick
  brakeG: 1.0,          // longitudinal g below -this -> braking thump
  cornerIntervalMs: 140,
  impact: 90,
  shift: 10,
  brake: 25,
  corner: 12,
  rumbleByWheels: Object.freeze([0, 18, 26, 34, 42]),
});

const NOOP = () => false;

function defaultVibrate() {
  const nav = globalThis.navigator;
  if (nav && typeof nav.vibrate === 'function') return nav.vibrate.bind(nav);
  return NOOP;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** boolean-ish flag: true, or a positive number (a magnitude) */
const flag = (v) => (typeof v === 'number' ? v > 0 : v === true);

function wheelsOnRumble(bits) {
  const b = Math.trunc(num(bits));
  if (!(b >= 0)) return 0;
  let n = 0;
  for (let i = 0; i < 4; i++) if (b & (1 << i)) n++;
  return n;
}

export class Haptics {
  /**
   * @param {object} [options]
   * @param {(pattern: number|number[]) => boolean} [options.vibrate] default: navigator.vibrate (bound) or a no-op returning false.
   *   Pass `null` to force "unsupported".
   * @param {number} [options.minIntervalMs=90] minimum gap between vibrations (impacts and landings ignore it)
   * @param {boolean} [options.enabled=false]
   */
  constructor(options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    let v = o.vibrate;
    if (v === undefined) v = defaultVibrate();
    else if (typeof v !== 'function') v = NOOP;
    this._vibrate = v;
    this.minIntervalMs = typeof o.minIntervalMs === 'number' && Number.isFinite(o.minIntervalMs) && o.minIntervalMs >= 0
      ? o.minIntervalMs : 90;
    /** current on/off state (use setEnabled to change it) */
    this.enabled = !!o.enabled;
    /** kind of the last vibration fired: 'impact' | 'landing' | 'rumble' | 'shift' | 'brake' | 'corner' | null */
    this.lastKind = null;
    this._lastAt = -Infinity;
  }

  /** true when a real vibrate function exists (a no-op stand-in does not count) */
  get supported() { return this._vibrate !== NOOP; }

  /**
   * Turn haptics on or off. Turning off cancels any vibration in progress with vibrate(0).
   * @param {boolean} on
   */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.cancel();
  }

  /** Stop any vibration in progress (vibrate(0)). Safe when unsupported. */
  cancel() {
    if (!this.supported) return;
    try { this._vibrate(0); } catch (_) { /* some browsers throw outside a user gesture */ }
  }

  /**
   * Decide and fire at most one vibration for this sample.
   * Priority: impact > landing > rumble > shift > braking > cornering. The highest-priority condition that is
   * true is the candidate; if it is rate-limited nothing lower fires instead. Rumble, braking and cornering are
   * ignored while `airborne`.
   * @param {{rumbleBits?: number, latG?: number, longG?: number, impact?: boolean|number, shift?: boolean,
   *          landing?: boolean, airborne?: boolean}} state impact may be a g-spike magnitude (> 0 counts)
   * @param {number} [nowMs] monotonic caller clock in ms (defaults to performance.now() if available)
   * @returns {number[]|null} the pattern passed to vibrate (e.g. [18]) or null when nothing was fired
   */
  update(state, nowMs) {
    if (!this.enabled || !this.supported || !state || typeof state !== 'object') return null;
    let now = nowMs;
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      const p = globalThis.performance;
      if (!p || typeof p.now !== 'function') return null;
      now = p.now();
    }

    const airborne = flag(state.airborne);
    let kind = null;
    let pattern = null;
    let interval = this.minIntervalMs;
    if (flag(state.impact)) { kind = 'impact'; pattern = [HAPTIC.impact]; }
    else if (flag(state.landing)) { kind = 'landing'; pattern = [HAPTIC.impact]; }
    else if (!airborne && wheelsOnRumble(state.rumbleBits) > 0) {
      kind = 'rumble'; pattern = [HAPTIC.rumbleByWheels[wheelsOnRumble(state.rumbleBits)]];
    } else if (flag(state.shift)) { kind = 'shift'; pattern = [HAPTIC.shift]; }
    else if (!airborne && num(state.longG) < -HAPTIC.brakeG) { kind = 'brake'; pattern = [HAPTIC.brake]; }
    else if (!airborne && Math.abs(num(state.latG)) > HAPTIC.latG) {
      kind = 'corner'; pattern = [HAPTIC.corner]; interval = Math.max(interval, HAPTIC.cornerIntervalMs);
    }
    if (!kind) return null;

    if (kind !== 'impact' && kind !== 'landing') {
      const dt = now - this._lastAt;
      if (dt >= 0 && dt < interval) return null;           // negative dt = clock restarted: allow
    }

    this._lastAt = now;                                    // a refused call also consumes the slot: no retry storm
    let ok;
    try { ok = this._vibrate(pattern); } catch (_) { ok = false; }
    if (ok === false) return null;
    this.lastKind = kind;
    return pattern.slice();
  }
}
