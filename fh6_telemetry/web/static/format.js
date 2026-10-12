// Number / label formatting — mirrors the desktop app's text.

export const fixed = (v, d = 0) => (Number.isFinite(v) ? v : 0).toFixed(d);
export const signed = (v, d = 2) => { const x = Number.isFinite(v) ? v : 0; return (x >= 0 ? '+' : '') + x.toFixed(d); };

/** milliseconds -> M:SS.mmm ("--:--.---" when unset) */
export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--.---';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = (total % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Gear code -> label ("R", "1", "2" ...; forward gears are 1-based); unknown codes keep the previous label. */
export function gearLabel(lab, code, prev) {
  const v = lab.gear[String(code)];
  if (v !== undefined) return v;
  return prev || String(code);
}

const NEUTRAL_DEFAULT = { code: 11, holdMs: 250 };

/**
 * Gear label for a stream of rows (the twin of core/derive.py GearDisplay).
 *
 * The game reports neutral (code 11) for ONE packet at every shift. It must not flash on screen, so neutral keeps
 * the previous gear until it has lasted `holdMs` of game time, then shows "N" (at once if nothing was shown yet).
 * Real gears show immediately; other unknown codes hold the previous label.
 */
export class GearTracker {
  constructor() { this.label = ''; this._since = null; }

  reset() { this.label = ''; this._since = null; }

  /** @param lab the hello's `lab` table  @param code raw Gear  @param tsMs TimestampMS of the row (u32, may wrap) */
  update(lab, code, tsMs) {
    const known = lab.gear[String(code)];
    if (known !== undefined) { this._since = null; this.label = known; return known; }
    const nz = lab.neutral || NEUTRAL_DEFAULT;
    if (code === nz.code) {
      if (!this.label) this.label = 'N';
      else if (Number.isFinite(tsMs)) {
        if (this._since === null) this._since = tsMs;
        else {
          const elapsed = (tsMs - this._since) >>> 0;              // u32 arithmetic: survives the clock's wrap-around
          if (elapsed >= 0x80000000) this._since = tsMs;           // the clock went backwards: it restarted
          else if (elapsed >= nz.holdMs) this.label = 'N';
        }
      }
      return this.label;
    }
    return this.label || String(code);
  }
}

/** Bar fill colour: green -> amber -> red; `invert` = low is bad (fuel). Same rule as the desktop app. */
export function barColor(value, danger, invert) {
  if (!Number.isFinite(value) || danger <= 0) return '#22BB44';
  let ratio;
  if (invert) { if (value <= 0) return '#DD2200'; ratio = danger / value; } else ratio = value / danger;
  return ratio < 0.6 ? '#22BB44' : ratio < 1.0 ? '#FF9900' : '#DD2200';
}

/** Tyre temperature (°C) -> background colour using the server-provided bands. */
export function tempColor(bands, t) {
  for (const [limit, colour] of bands) if (t < limit) return colour;
  return bands[bands.length - 1][1];
}

/** Black or white text for a #rrggbb background. */
export function contrastText(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128 ? '#ffffff' : '#111111';
}

/** "Nice" step (1, 2, 5 x 10^n) >= x */
export function niceStep(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * base >= x * (1 - 1e-12)) return m * base;
  return 10 * base;
}
