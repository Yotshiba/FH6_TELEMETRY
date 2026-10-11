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

/** Gear code -> label; unknown codes (the one-packet shift transient) keep the previous label. */
export function gearLabel(lab, code, prev) {
  const v = lab.gear[String(code)];
  if (v !== undefined) return v;
  return prev || String(code);
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
