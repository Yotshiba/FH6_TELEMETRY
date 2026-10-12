// Cockpit layout model: which widgets are on the dash, where, and how big.  Pure logic (no DOM, no canvas):
// the view draws it, the settings persist it, and the editor changes it through the functions below, which
// NEVER mutate their input (every change returns a new layout, so undo is just keeping the old one).
//
// A layout is an array of widgets, drawn in array order (the last one is on top):
//     { id: 'speedo', type: 'speedo', x: 0, y: 2, w: 12, h: 12 }       (grid cells)
// There is one layout per orientation: landscape is a 32x18 grid, portrait an 18x32 grid, so a cell is about
// square on a 16:9 screen.  Whatever the real screen shape, the grid stretches to fill it.

export const GRID = Object.freeze({
  landscape: Object.freeze({ cols: 32, rows: 18 }),
  portrait: Object.freeze({ cols: 18, rows: 32 }),
});
export const ORIENTATIONS = Object.freeze(['landscape', 'portrait']);
export const MAX_WIDGETS = 40;

/**
 * The catalogue.  `min` = smallest size (cells); `size` = the size a freshly added widget gets, per orientation.
 * (The drawing code lives in cockpit_widgets.js, keyed by the same type names.)
 */
export const WIDGET_TYPES = Object.freeze({
  speedo: { label: 'Speedometer', hint: 'Analogue dial with the speed inside', min: [6, 6], size: { landscape: [12, 12], portrait: [14, 14] } },
  tacho: { label: 'Tachometer', hint: 'Analogue rev counter with redline', min: [6, 6], size: { landscape: [12, 12], portrait: [14, 14] } },
  speed_digital: { label: 'Speed (digital)', hint: 'Big speed number', min: [4, 2], size: { landscape: [8, 4], portrait: [9, 4] } },
  rpm_digital: { label: 'RPM (digital)', hint: 'Rev number with a bar', min: [4, 2], size: { landscape: [8, 3], portrait: [9, 3] } },
  gear: { label: 'Gear', hint: 'Current gear', min: [2, 2], size: { landscape: [6, 6], portrait: [6, 6] } },
  shift_lights: { label: 'Shift lights', hint: 'Row of LEDs that fill as you near the limiter', min: [6, 1], size: { landscape: [28, 2], portrait: [16, 2] } },
  wheel: { label: 'Steering wheel', hint: 'A wheel that turns with your steering', min: [3, 3], size: { landscape: [5, 5], portrait: [8, 8] } },
  brake: { label: 'Brake pedal', hint: 'Brake pressure bar', min: [1, 3], size: { landscape: [2, 6], portrait: [2, 7] } },
  throttle: { label: 'Throttle pedal', hint: 'Throttle bar', min: [1, 3], size: { landscape: [2, 6], portrait: [2, 7] } },
  clutch: { label: 'Clutch pedal', hint: 'Clutch bar', min: [1, 3], size: { landscape: [2, 6], portrait: [2, 7] } },
  fuel: { label: 'Fuel', hint: 'Fuel level bar (turns red when low)', min: [3, 1], size: { landscape: [9, 2], portrait: [7, 2] } },
  boost: { label: 'Boost', hint: 'Turbo / supercharger pressure', min: [3, 1], size: { landscape: [6, 2], portrait: [8, 2] } },
  power: { label: 'Power & torque', hint: 'Engine output numbers', min: [4, 1], size: { landscape: [8, 2], portrait: [8, 2] } },
  tyres: { label: 'Tyre temperatures', hint: 'Four tiles coloured by temperature', min: [4, 3], size: { landscape: [8, 6], portrait: [9, 7] } },
  delta: { label: 'Lap delta', hint: 'Time ahead / behind your best lap', min: [3, 1], size: { landscape: [6, 3], portrait: [8, 4] } },
  laptime: { label: 'Lap times', hint: 'Current, last and best lap', min: [5, 2], size: { landscape: [9, 4], portrait: [9, 4] } },
  gforce: { label: 'G-force', hint: 'A ball that follows the forces on the car', min: [3, 3], size: { landscape: [5, 5], portrait: [7, 7] } },
  compass: { label: 'Compass', hint: 'Heading', min: [3, 3], size: { landscape: [5, 5], portrait: [7, 7] } },
  speed_trace: { label: 'Speed trace', hint: 'The last 20 seconds of speed', min: [5, 2], size: { landscape: [10, 4], portrait: [16, 5] } },
  drift: { label: 'Drift score', hint: 'Current drift chain and multiplier', min: [4, 2], size: { landscape: [8, 4], portrait: [9, 4] } },
});
export const WIDGET_TYPE_IDS = Object.freeze(Object.keys(WIDGET_TYPES));

const w = (type, x, y, wd, ht) => ({ id: type, type, x, y, w: wd, h: ht });

/** The factory layouts (fresh copies every call). */
export function defaultLayout(orientation) {
  if (orientation === 'portrait') {
    // (the last two rows stay free: the Sound / HUD / Edit buttons float there)
    return [
      w('shift_lights', 1, 0, 16, 2),
      w('tacho', 2, 2, 14, 14),
      w('gear', 6, 5, 6, 5),
      w('speed_digital', 1, 16, 9, 4),
      w('delta', 10, 16, 7, 3),
      w('fuel', 10, 19, 7, 2),
      w('brake', 1, 21, 2, 6),
      w('wheel', 5, 21, 8, 7),
      w('throttle', 15, 21, 2, 6),
      w('boost', 1, 28, 9, 2),
      w('power', 10, 28, 8, 2),
    ];
  }
  return [
    w('shift_lights', 2, 0, 28, 2),
    w('speedo', 0, 2, 12, 12),
    w('tacho', 20, 2, 12, 12),
    w('delta', 12, 2, 8, 2),
    w('gear', 13, 4, 6, 6),
    w('brake', 12, 10, 2, 6),
    w('wheel', 14, 11, 4, 4),
    w('throttle', 18, 10, 2, 6),
    w('fuel', 8, 16, 9, 2),                       // (right of the Sound / HUD / Edit buttons)
    w('boost', 21, 15, 5, 2),
    w('power', 26, 15, 6, 2),
  ];
}

// ---- validation ---------------------------------------------------------------------------------------------------------------

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function gridOf(orientation) { return GRID[orientation] || GRID.landscape; }

/** A widget clamped into the grid and above its minimum size; null when it is not a widget at all. */
function cleanWidget(raw, orientation) {
  if (!raw || typeof raw !== 'object') return null;
  const spec = Object.prototype.hasOwnProperty.call(WIDGET_TYPES, raw.type) ? WIDGET_TYPES[raw.type] : null;
  if (!spec || !isNum(raw.x) || !isNum(raw.y) || !isNum(raw.w) || !isNum(raw.h)) return null;
  const { cols, rows } = gridOf(orientation);
  const wd = clampInt(raw.w, spec.min[0], cols), ht = clampInt(raw.h, spec.min[1], rows);
  return {
    id: typeof raw.id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(raw.id) ? raw.id : raw.type,
    type: raw.type,
    x: clampInt(raw.x, 0, cols - wd), y: clampInt(raw.y, 0, rows - ht), w: wd, h: ht,
  };
}

/**
 * Validate an untrusted layout (localStorage may hold anything).  Returns an array (possibly empty: the user
 * removed everything) or null when `raw` is not an array, meaning "no custom layout, use the default".
 * Unknown widget types and malformed entries are dropped; sizes and positions are clamped into the grid; ids are
 * made unique; at most MAX_WIDGETS are kept.
 */
export function sanitizeLayout(raw, orientation) {
  if (!Array.isArray(raw)) return null;
  const out = [], seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_WIDGETS) break;
    const wd = cleanWidget(item, orientation);
    if (!wd) continue;
    let id = wd.id, n = 2;
    while (seen.has(id)) id = `${wd.type}-${n++}`;
    seen.add(id);
    out.push({ ...wd, id });
  }
  return out;
}

// ---- geometry -------------------------------------------------------------------------------------------------------------------

/** Pixel rectangle of a widget on a W x H canvas. */
export function rectOf(widget, orientation, W, H) {
  const { cols, rows } = gridOf(orientation);
  const cw = W / cols, ch = H / rows;
  return { x: widget.x * cw, y: widget.y * ch, w: widget.w * cw, h: widget.h * ch };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** First free spot (scanning rows, then columns) for a w x h widget; null when the grid has no room. */
export function findFreeSpot(layout, wd, ht, orientation) {
  const { cols, rows } = gridOf(orientation);
  for (let y = 0; y + ht <= rows; y++) {
    for (let x = 0; x + wd <= cols; x++) {
      const cand = { x, y, w: wd, h: ht };
      if (!layout.some((o) => overlaps(cand, o))) return { x, y };
    }
  }
  return null;
}

function uniqueId(layout, type) {
  const used = new Set(layout.map((x) => x.id));
  let id = type, n = 2;
  while (used.has(id)) id = `${type}-${n++}`;
  return id;
}

// ---- edits (all pure) -------------------------------------------------------------------------------------------------------

/** Add a widget of `type` at the first free spot (or the middle of the grid if it is full). Null if at the cap. */
export function addWidget(layout, type, orientation) {
  const spec = WIDGET_TYPES[type];
  if (!spec || layout.length >= MAX_WIDGETS) return null;
  const [sw, sh] = spec.size[orientation] || spec.size.landscape;
  const { cols, rows } = gridOf(orientation);
  const wd = Math.min(sw, cols), ht = Math.min(sh, rows);
  const spot = findFreeSpot(layout, wd, ht, orientation) || { x: Math.floor((cols - wd) / 2), y: Math.floor((rows - ht) / 2) };
  const widget = { id: uniqueId(layout, type), type, x: spot.x, y: spot.y, w: wd, h: ht };
  return { layout: [...layout, widget], widget };
}

export function removeWidget(layout, id) {
  return layout.filter((x) => x.id !== id);
}

/** Move to (x, y) in cells, kept inside the grid. */
export function moveWidget(layout, id, x, y, orientation) {
  const { cols, rows } = gridOf(orientation);
  return layout.map((it) => (it.id === id
    ? { ...it, x: clampInt(x, 0, cols - it.w), y: clampInt(y, 0, rows - it.h) }
    : it));
}

/** Resize to w x h cells: not below the type's minimum, not past the grid edge. */
export function resizeWidget(layout, id, wd, ht, orientation) {
  const { cols, rows } = gridOf(orientation);
  return layout.map((it) => {
    if (it.id !== id) return it;
    const min = WIDGET_TYPES[it.type].min;
    return { ...it, w: clampInt(wd, min[0], cols - it.x), h: clampInt(ht, min[1], rows - it.y) };
  });
}

/** Put a widget on top of the others (drawn last, hit first). */
export function bringToFront(layout, id) {
  const it = layout.find((x) => x.id === id);
  return it ? [...layout.filter((x) => x !== it), it] : layout;
}

// ---- hit testing --------------------------------------------------------------------------------------------------------------

/**
 * What is under the pointer?  Widgets are tested top first.  Returns { id, part } with part 'remove' (the corner
 * x), 'resize' (the bottom-right handle) or 'body', or null for empty space.
 */
export function hitTest(layout, orientation, px, py, W, H) {
  for (let i = layout.length - 1; i >= 0; i--) {
    const it = layout[i];
    const r = rectOf(it, orientation, W, H);
    if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
    const hs = handleSize(r);
    if (px >= r.x + r.w - hs && py <= r.y + hs) return { id: it.id, part: 'remove' };
    if (px >= r.x + r.w - hs && py >= r.y + r.h - hs) return { id: it.id, part: 'resize' };
    return { id: it.id, part: 'body' };
  }
  return null;
}

/** Size (px) of the corner buttons: big enough for a finger, never more than a third of a small widget. */
export function handleSize(r) {
  return Math.max(12, Math.min(26, Math.min(r.w, r.h) / 3));
}

/** Convert a pixel drag distance into whole grid cells. */
export function cellsFor(orientation, W, H, dxPx, dyPx) {
  const { cols, rows } = gridOf(orientation);
  return { dx: Math.round(dxPx / (W / cols)), dy: Math.round(dyPx / (H / rows)) };
}

/** Which orientation a canvas of this size uses. */
export function orientationFor(w, h) { return w / h < 1.05 ? 'portrait' : 'landscape'; }

/** Same widgets in the same places and order? (a customised layout equal to the factory one is stored as "no custom layout") */
export function layoutsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p, i) => p.id === b[i].id && p.type === b[i].type && p.x === b[i].x && p.y === b[i].y && p.w === b[i].w && p.h === b[i].h);
}
