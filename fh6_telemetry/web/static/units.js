// Unit conversion and formatting for the dashboard.
//
// The server ALWAYS sends metric values (km/h, deg C, bar, mechanical hp, Nm, metres). Everything
// here is pure: no DOM, no storage, no globals touched at import time. The user's choice lives in a
// "units object" such as {speed:'mph', temp:'f', pressure:'psi', power:'kw', torque:'lbft', dist:'mi'};
// pass it through `normalizeUnits` after reading it from localStorage.
//
// Every converter / label / formatter takes `u` as either the whole units object or just that
// quantity's unit string (e.g. `conv.speed(100, units)` and `conv.speed(100, 'mph')` are the same).
// Anything unrecognised silently falls back to the metric default.

/** Selectable units per quantity (first entry of each list is the default / the server's unit). */
export const UNIT_CHOICES = Object.freeze({
  speed: Object.freeze(['kmh', 'mph']),
  temp: Object.freeze(['c', 'f']),
  pressure: Object.freeze(['bar', 'psi']),
  power: Object.freeze(['hp', 'kw', 'ps']),
  torque: Object.freeze(['nm', 'lbft']),
  dist: Object.freeze(['km', 'mi']),
});

const FIELDS = Object.freeze(Object.keys(UNIT_CHOICES));
const DEFAULTS = Object.freeze({ speed: 'kmh', temp: 'c', pressure: 'bar', power: 'hp', torque: 'nm', dist: 'km' });

/** Ready-made unit sets for a one-click metric / imperial toggle. */
export const UNIT_PRESETS = Object.freeze({
  metric: Object.freeze({ ...DEFAULTS }),
  imperial: Object.freeze({ speed: 'mph', temp: 'f', pressure: 'psi', power: 'hp', torque: 'lbft', dist: 'mi' }),
});

/**
 * A fresh metric units object (mutating it never affects other callers).
 * @returns {{speed:string,temp:string,pressure:string,power:string,torque:string,dist:string}}
 */
export function defaultUnits() { return { ...DEFAULTS }; }

/**
 * Sanitise a units object (e.g. parsed from localStorage). Always returns a NEW, complete, valid
 * object; unknown, missing or wrongly typed fields fall back to the defaults; extra fields are dropped.
 * @param {unknown} obj
 */
export function normalizeUnits(obj) {
  const out = defaultUnits();
  if (obj === null || typeof obj !== 'object') return out;
  for (const f of FIELDS) {
    const v = obj[f];
    if (typeof v === 'string' && UNIT_CHOICES[f].includes(v)) out[f] = v;
  }
  return out;
}

/**
 * Which preset a units object corresponds to.
 * @param {unknown} u
 * @returns {'metric'|'imperial'|'custom'}
 */
export function matchPreset(u) {
  const n = normalizeUnits(u);
  for (const name of Object.keys(UNIT_PRESETS)) {
    if (FIELDS.every((f) => n[f] === UNIT_PRESETS[name][f])) return name;
  }
  return 'custom';
}

/**
 * The unit that follows `current` in UNIT_CHOICES[kind] (wraps around) - for "click the value to
 * switch unit" gimmicks. Unknown `kind` returns `current` unchanged; unknown `current` returns the default.
 * @param {string} kind  'speed' | 'temp' | 'pressure' | 'power' | 'torque' | 'dist'
 * @param {string} current
 */
export function nextUnit(kind, current) {
  const list = Object.prototype.hasOwnProperty.call(UNIT_CHOICES, kind) ? UNIT_CHOICES[kind] : null;
  if (!list) return current;
  const i = list.indexOf(current);
  return i < 0 ? DEFAULTS[kind] : list[(i + 1) % list.length];
}

/** Resolve the unit of `field` out of a units object or a bare unit string; invalid -> default. */
function pick(u, field) {
  let v;
  if (typeof u === 'string') v = u;
  else if (u !== null && typeof u === 'object') v = u[field];
  return typeof v === 'string' && UNIT_CHOICES[field].includes(v) ? v : DEFAULTS[field];
}

const num = (v) => (typeof v === 'number' ? v : Number.NaN);

// --- factors (metric -> display) -------------------------------------------------------------
const M_PER_MI = 1609.344;
const MPH_PER_KMH = 1 / 1.609344;
const PSI_PER_BAR = 14.503773773;
const KW_PER_HP = 0.745699872;
const PS_PER_HP = 1.01386967;
const LBFT_PER_NM = 0.737562149;
const FT_PER_M = 1 / 0.3048;

/**
 * Converters: metric input as sent by the server -> number in the chosen unit.
 * Non-number input gives NaN. All are strictly increasing, affine functions.
 */
export const conv = {
  /** km/h -> km/h | mph */
  speed(kmh, u) { const v = num(kmh); return pick(u, 'speed') === 'mph' ? v * MPH_PER_KMH : v; },
  /** deg C -> deg C | deg F */
  temp(c, u) { const v = num(c); return pick(u, 'temp') === 'f' ? v * 1.8 + 32 : v; },
  /** bar -> bar | psi */
  pressure(bar, u) { const v = num(bar); return pick(u, 'pressure') === 'psi' ? v * PSI_PER_BAR : v; },
  /** mechanical hp (as sent) -> hp | kW | PS (metric horsepower) */
  power(hp, u) {
    const v = num(hp);
    const k = pick(u, 'power');
    return k === 'kw' ? v * KW_PER_HP : k === 'ps' ? v * PS_PER_HP : v;
  },
  /** Nm -> Nm | lb-ft */
  torque(nm, u) { const v = num(nm); return pick(u, 'torque') === 'lbft' ? v * LBFT_PER_NM : v; },
  /** metres -> km | miles (a number in those units, NOT metres/feet) */
  dist(m, u) { const v = num(m); return pick(u, 'dist') === 'mi' ? v / M_PER_MI : v / 1000; },
};

/** Inverse converters: value typed/shown in the chosen unit -> metric (for threshold inputs etc.). */
export const inv = {
  speed(v, u) { const x = num(v); return pick(u, 'speed') === 'mph' ? x / MPH_PER_KMH : x; },
  temp(v, u) { const x = num(v); return pick(u, 'temp') === 'f' ? (x - 32) / 1.8 : x; },
  pressure(v, u) { const x = num(v); return pick(u, 'pressure') === 'psi' ? x / PSI_PER_BAR : x; },
  power(v, u) {
    const x = num(v);
    const k = pick(u, 'power');
    return k === 'kw' ? x / KW_PER_HP : k === 'ps' ? x / PS_PER_HP : x;
  },
  torque(v, u) { const x = num(v); return pick(u, 'torque') === 'lbft' ? x / LBFT_PER_NM : x; },
  dist(v, u) { const x = num(v); return pick(u, 'dist') === 'mi' ? x * M_PER_MI : x * 1000; },
};

/** Unit label text per quantity. */
export const label = {
  speed(u) { return pick(u, 'speed') === 'mph' ? 'mph' : 'km/h'; },
  temp(u) { return pick(u, 'temp') === 'f' ? '°F' : '°C'; },
  pressure(u) { return pick(u, 'pressure') === 'psi' ? 'psi' : 'bar'; },
  power(u) {
    const k = pick(u, 'power');
    return k === 'kw' ? 'kW' : k === 'ps' ? 'PS' : 'hp';
  },
  torque(u) { return pick(u, 'torque') === 'lbft' ? 'lb-ft' : 'Nm'; },
  dist(u) { return pick(u, 'dist') === 'mi' ? 'mi' : 'km'; },
};

// --- formatting ----------------------------------------------------------------------------------

/** toFixed that maps non-finite to 0 (same convention as format.js `fixed`) and never prints "-0". */
function fixed(v, d) {
  const x = Number.isFinite(v) ? v : 0;
  const s = x.toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Decimal places: an integer in 0..20, else the fallback. */
const digitsOr = (d, fallback) => (Number.isInteger(d) && d >= 0 && d <= 20 ? d : fallback);

const pad3 = (n) => String(n).padStart(3, '0');

/**
 * String formatters. Numeric ones map non-finite input to "0" (like format.js `fixed`); `lapTime`
 * and `delta` use their own "no value" placeholders.
 */
export const fmt = {
  /** '123' - converted speed, no unit text. */
  speed(kmh, u, digits = 0) { return fixed(conv.speed(kmh, u), digitsOr(digits, 0)); },
  /** '123 km/h' */
  speedUnit(kmh, u, digits = 0) { return `${fmt.speed(kmh, u, digits)} ${label.speed(u)}`; },

  /** '95' - converted temperature, no unit text. */
  temp(c, u, digits = 0) { return fixed(conv.temp(c, u), digitsOr(digits, 0)); },
  /** '95 °C' */
  tempUnit(c, u, digits = 0) { return `${fmt.temp(c, u, digits)} ${label.temp(u)}`; },

  /** '1.52' (bar, 2 decimals) or '22.0' (psi, 1 decimal) unless `digits` is given. */
  pressure(bar, u, digits) {
    const dflt = pick(u, 'pressure') === 'psi' ? 1 : 2;
    return fixed(conv.pressure(bar, u), digitsOr(digits, dflt));
  },
  pressureUnit(bar, u, digits) { return `${fmt.pressure(bar, u, digits)} ${label.pressure(u)}`; },

  power(hp, u, digits = 0) { return fixed(conv.power(hp, u), digitsOr(digits, 0)); },
  powerUnit(hp, u, digits = 0) { return `${fmt.power(hp, u, digits)} ${label.power(u)}`; },

  torque(nm, u, digits = 0) { return fixed(conv.torque(nm, u), digitsOr(digits, 0)); },
  torqueUnit(nm, u, digits = 0) { return `${fmt.torque(nm, u, digits)} ${label.torque(u)}`; },

  /** '12.35' - distance in km / miles with 2 decimals (no unit text). */
  dist(m, u, digits = 2) { return fixed(conv.dist(m, u), digitsOr(digits, 2)); },
  distUnit(m, u, digits = 2) { return `${fmt.dist(m, u, digits)} ${label.dist(u)}`; },

  /**
   * Short distance: metres / feet while small, else km / miles with 2 decimals.
   * Metric: '402 m' below 1000 m, '1.50 km' from there. Imperial: '1320 ft' below half a mile
   * (2640 ft), '0.50 mi' from there. The switch is decided on the ROUNDED value, so 999.6 m is '1.00 km'.
   */
  distShort(m, u) {
    const v = Number.isFinite(m) ? m : 0;
    if (pick(u, 'dist') === 'mi') {
      const ft = Math.round(v * FT_PER_M);
      if (Math.abs(ft) < 2640) return `${ft === 0 ? 0 : ft} ft`;
      return `${fixed(v / M_PER_MI, 2)} mi`;
    }
    const r = Math.round(v);
    if (Math.abs(r) < 1000) return `${r === 0 ? 0 : r} m`;
    return `${fixed(v / 1000, 2)} km`;
  },

  /** Milliseconds -> 'M:SS.mmm'; '--:--.---' for <= 0 or non-finite (no lap time yet). */
  lapTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '--:--.---';
    const total = Math.round(ms);
    const m = Math.floor(total / 60000);
    const rem = total % 60000;
    return `${m}:${String(Math.floor(rem / 1000)).padStart(2, '0')}.${pad3(rem % 1000)}`;
  },

  /**
   * Time delta in seconds -> always-signed, 3 decimals: '+0.123', '-1.204'. Anything that rounds to
   * 0.000 (including exactly 0) is '±0.000'. Non-finite input gives '--.---'.
   */
  delta(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '--.---';
    const r = Math.round(seconds * 1000);
    if (r === 0) return '±0.000';
    const a = Math.abs(r);
    return `${r < 0 ? '-' : '+'}${Math.floor(a / 1000)}.${pad3(a % 1000)}`;
  },
};

// --- chart axes ------------------------------------------------------------------------------------

/** Shared identity function: `fns[i] === identity` means "no conversion for this line". */
export const identity = (v) => v;

const EMPTY_TRANSFORM = Object.freeze({ unit: null, fns: Object.freeze([]) });
const transformCache = new Map();

/** Identity when the unit is the metric default, else a monotonic converter bound to that unit. */
function lineFn(kind, unit) {
  return unit === DEFAULTS[kind] ? identity : (v) => conv[kind](v, unit);
}

/**
 * How to display one of the server's charts in the user's units.
 *
 * Returns `{unit, fns}`:
 *  - `unit`: axis/unit label to show, or `null` = keep the server's own unit text;
 *  - `fns`: one function per chart line (same order as the server's `lines`), `identity` where no
 *    conversion applies. Every function is strictly increasing, so a y-range [lo, hi] may be mapped
 *    through them too. `fns: []` (unknown chart id) means identity for every line.
 *
 * Charts: 'engine_rpm' (none), 'engine_power_torque' (power, torque; unit e.g. 'kW / lb-ft'),
 * 'tyre_temp' (4 x temp; '°C'|'°F'), 'inputs_throttle_brake' (none), 'motion_suspension' (none),
 * 'motion_speed' (speed; 'km/h'|'mph').
 *
 * Results are immutable and memoised: the same chart + same units yield the SAME object, so callers
 * can detect a unit change with `!==`.
 * @param {string} chartId
 * @param {unknown} u  units object (sanitised with normalizeUnits)
 * @returns {{unit: string|null, fns: ReadonlyArray<(v:number)=>number>}}
 */
export function chartTransform(chartId, u) {
  if (typeof chartId !== 'string') return EMPTY_TRANSFORM;
  const n = normalizeUnits(u);
  const key = `${chartId}|${FIELDS.map((f) => n[f]).join('|')}`;
  const hit = transformCache.get(key);
  if (hit) return hit;

  let out;
  switch (chartId) {
    case 'engine_rpm':
      out = { unit: null, fns: [identity, identity] };
      break;
    case 'engine_power_torque':
      out = {
        unit: `${label.power(n.power)} / ${label.torque(n.torque)}`,
        fns: [lineFn('power', n.power), lineFn('torque', n.torque)],
      };
      break;
    case 'tyre_temp': {
      const f = lineFn('temp', n.temp);
      out = { unit: label.temp(n.temp), fns: [f, f, f, f] };
      break;
    }
    case 'inputs_throttle_brake':
      out = { unit: null, fns: [identity, identity] };
      break;
    case 'motion_suspension':
      out = { unit: null, fns: [identity, identity, identity, identity] };
      break;
    case 'motion_speed':
      out = { unit: label.speed(n.speed), fns: [lineFn('speed', n.speed)] };
      break;
    default:
      return EMPTY_TRANSFORM;
  }
  Object.freeze(out.fns);
  Object.freeze(out);
  transformCache.set(key, out);
  return out;
}
