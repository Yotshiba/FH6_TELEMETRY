// Lifetime stats ("garage"): records, personal bests and unlocked achievements, kept in
// localStorage across sessions.  Saves are throttled; every access is defensive.

const KEY = 'fh6.lifetime.v1';

function blank() {
  return { v: 1, odometerM: 0, sessions: 0, records: {}, best: {}, bestDrift: 0, longestAirS: 0, unlocked: [] };
}

function safeStorage() {
  try { const s = globalThis.localStorage; s.getItem('x'); return s; } catch { return null; }
}

const num = (v) => (Number.isFinite(v) ? v : 0);

/** Which direction is "better" for each personal best, and how to compare its value. */
const BEST_RULES = {
  t60mph: { low: true }, t100: { low: true }, t200: { low: true }, t100to200: { low: true },
  qmile: { low: true, of: (v) => v.time },
  brake100: { low: true, of: (v) => v.dist },
  brake60mph: { low: true, of: (v) => v.dist },
};

export class Lifetime {
  constructor(storage = safeStorage(), now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    this.data = this.load();
    this.data.sessions += 1;
    this.dirty = true;
    this.lastSave = 0;
    this.base = this.data.odometerM;           // odometer at the start of this session
  }

  load() {
    const d = blank();
    try {
      const raw = this.storage && this.storage.getItem(KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        d.odometerM = num(o.odometerM); d.sessions = Math.max(0, Math.round(num(o.sessions)));
        d.bestDrift = num(o.bestDrift); d.longestAirS = num(o.longestAirS);
        if (o.records && typeof o.records === 'object') for (const [k, v] of Object.entries(o.records)) if (Number.isFinite(v)) d.records[k] = v;
        if (o.best && typeof o.best === 'object') {
          for (const [k, v] of Object.entries(o.best)) {
            const rule = BEST_RULES[k];
            if (!rule) continue;
            const isObj = v !== null && typeof v === 'object';
            const val = isObj && rule.of ? rule.of(v) : v;            // the number this best is compared by
            if (Number.isFinite(val) && isObj === !!rule.of) d.best[k] = v;   // right shape for its rule, finite
          }
        }
        if (Array.isArray(o.unlocked)) d.unlocked = o.unlocked.filter((x) => typeof x === 'string');
      }
    } catch { /* corrupt: start fresh */ }
    return d;
  }

  save(force = false) {
    const t = this.now();
    if (!this.dirty || (!force && t - this.lastSave < 3000)) return;
    this.lastSave = t; this.dirty = false;
    try { if (this.storage) this.storage.setItem(KEY, JSON.stringify(this.data)); } catch { /* quota */ }
  }

  get best() { return this.data.best; }
  get records() { return this.data.records; }

  /** Merge this session's maxima (Records.state) into the lifetime records. */
  mergeRecords(s) {
    if (!s) return;
    for (const k of ['topSpeedKmh', 'maxRpm', 'maxLatG', 'maxBrakeG', 'maxAccelG', 'maxPowerHp', 'maxBoostBar']) {
      if (num(s[k]) > (this.data.records[k] || 0)) { this.data.records[k] = s[k]; this.dirty = true; }
    }
    const odo = this.base + num(s.odometerM);
    if (odo > this.data.odometerM) { this.data.odometerM = odo; this.data.records.odometerM = odo; this.dirty = true; }
  }

  /** Record a performance result; returns true if it is a new personal best. */
  setBest(key, value) {
    const rule = BEST_RULES[key];
    if (!rule || value === null || value === undefined) return false;
    const cmp = (v) => (rule.of ? rule.of(v) : v);
    const old = this.data.best[key];
    if (old === undefined || cmp(value) < cmp(old)) { this.data.best[key] = value; this.dirty = true; return old !== undefined; }
    return false;
  }

  noteDrift(score) { if (score > this.data.bestDrift) { this.data.bestDrift = score; this.dirty = true; return true; } return false; }
  noteAir(s) { if (s > this.data.longestAirS) { this.data.longestAirS = s; this.dirty = true; return true; } return false; }
  setUnlocked(ids) { this.data.unlocked = [...ids]; this.dirty = true; }

  reset() {
    this.data = blank(); this.data.sessions = 1; this.base = 0; this.dirty = true; this.save(true);
  }
}
