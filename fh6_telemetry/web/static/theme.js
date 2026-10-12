// Canvas drawings read their colours from the same CSS variables as the DOM, so every
// theme re-colours gauges, maps and charts too.  The values are cached and re-read
// whenever the theme changes (call invalidateTheme()).

let cache = null;

const FALLBACK = {
  bg: '#0d0d1a', panel: '#1a1a2e', panel2: '#111122', border: '#2a2a4a', text: '#dddddd',
  bright: '#eeeeee', dim: '#888899', dimmer: '#666688', accent: '#44ccff', green: '#22bb44',
  amber: '#ff9900', red: '#dd2200', yellow: '#ffdd44', blue: '#3d8bff', glow: 'rgba(68,204,255,0.35)',
  chartGrid: 'rgba(255,255,255,0.12)', chartText: '#aaaaaa', chartTitle: '#8a8aa0',
  ledOff: '#1b1b2c', needle: '#ff4d4d',
};

const MAP = {
  bg: '--bg', panel: '--panel', panel2: '--panel-2', border: '--border', text: '--text',
  bright: '--bright', dim: '--dim', dimmer: '--dimmer', accent: '--accent', green: '--green',
  amber: '--amber', red: '--red', yellow: '--yellow', blue: '--blue', glow: '--glow',
  chartGrid: '--chart-grid', chartText: '--chart-text', chartTitle: '--chart-title',
  ledOff: '--led-off', needle: '--needle',
};

export function colors() {
  if (cache) return cache;
  const out = { ...FALLBACK };
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const [k, v] of Object.entries(MAP)) {
      const val = cs.getPropertyValue(v).trim();
      if (val) out[k] = val;
    }
  } catch { /* no DOM (tests) */ }
  cache = out;
  return out;
}

export function invalidateTheme() { cache = null; }

/** #rrggbb / rgb() -> rgba() string with the given alpha (best effort). */
export function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const r = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (r) { const p = r[1].split(',').map((x) => x.trim()); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
  return color;
}

/** Linear blend of two #rrggbb colours, t in 0..1. */
export function mix(c1, c2, t) {
  const p = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  if (!/^#[0-9a-f]{6}$/i.test(c1) || !/^#[0-9a-f]{6}$/i.test(c2)) return c1;
  const a = p(c1), b = p(c2);
  const k = Math.max(0, Math.min(1, t));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

/** Speed heat colour: blue -> cyan -> green -> yellow -> red for t in 0..1. */
export function heat(t) {
  const stops = ['#2a5bff', '#00c8ff', '#22dd66', '#ffe14a', '#ff7a1a', '#ff2a2a'];
  const x = Math.max(0, Math.min(0.9999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return mix(stops[i], stops[i + 1], x - i);
}
