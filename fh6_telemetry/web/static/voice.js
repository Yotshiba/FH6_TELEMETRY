// Spoken callouts: a small speechSynthesis wrapper with cooldowns/priorities, plus pure helpers that turn
// telemetry events into short phrases.
//
// Everything browser-specific (speechSynthesis, SpeechSynthesisUtterance) is injected or looked up lazily,
// so the module loads and tests in plain Node.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Number / phrase helpers
// ---------------------------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    if (h) parts.push('and');
    if (r < 20) parts.push(ONES[r]);
    else parts.push(r % 10 ? `${TENS[Math.floor(r / 10)]}-${ONES[r % 10]}` : TENS[Math.floor(r / 10)]);
  }
  return parts.join(' ');
}

/**
 * Integer in words, British style: 200 -> "two hundred", 124 -> "one hundred and twenty-four",
 * 1250 -> "one thousand two hundred and fifty". Rounds to the nearest integer; |n| >= 1,000,000 is left as digits;
 * non-numbers give ''.
 * @param {number} n
 * @returns {string}
 */
export function spokenNumber(n) {
  if (!isNum(n)) return '';
  let v = Math.round(n);
  if (v === 0) return 'zero';
  const neg = v < 0;
  v = Math.abs(v);
  if (v >= 1e6) return String(neg ? -v : v);
  let s;
  if (v >= 1000) {
    const rest = v % 1000;
    s = `${below1000(Math.floor(v / 1000))} thousand`;
    if (rest) s += (rest < 100 ? ' and ' : ' ') + below1000(rest);
  } else {
    s = below1000(v);
  }
  return neg ? `minus ${s}` : s;
}

/** 3.1 -> "3.1 seconds", 1.04 -> "1 second", 2 -> "2 seconds" */
function secondsPhrase(sec) {
  const s = sec.toFixed(1);
  const t = s.endsWith('.0') ? s.slice(0, -2) : s;
  return `${t} ${t === '1' ? 'second' : 'seconds'}`;
}

/** Seconds from a duration given in seconds, or in milliseconds when >= 300 (nothing is that slow in seconds). */
function toSeconds(v) {
  if (!isNum(v) || v <= 0) return null;
  return v >= 300 ? v / 1000 : v;
}

/** 72400 ms -> "1 minute 12.4"; 52400 -> "52.4 seconds" */
function lapTimePhrase(ms) {
  if (!isNum(ms) || ms <= 0) return null;
  const tenths = Math.round(ms / 100);
  const m = Math.floor(tenths / 600);
  const sec = ((tenths - m * 600) / 10).toFixed(1);
  return m > 0 ? `${m} minute${m === 1 ? '' : 's'} ${sec}` : `${sec} seconds`;
}

function speedPhrase(kmh, units) {
  if (units.speed === 'mph') return `${spokenNumber(kmh * 0.621371)} miles an hour`;
  return `${spokenNumber(kmh)} kilometres an hour`;
}

function distPhrase(metres, units) {
  if (units.dist === 'mi') return `${Math.round(metres * 3.28084)} feet`;
  return `${Math.round(metres)} metres`;
}

function perfPhrase(ev, units) {
  const v = ev.value;
  const obj = v !== null && typeof v === 'object' ? v : null;
  switch (ev.key) {
    case 't100':
    case 't60mph':
    case 't200': {
      const sec = toSeconds(obj ? obj.time : v);
      if (sec === null) return null;
      const target = { t100: 'one hundred', t60mph: 'sixty', t200: 'two hundred' }[ev.key];
      return `Zero to ${target} in ${secondsPhrase(sec)}`;
    }
    case 'qmile': {
      const sec = toSeconds(obj ? obj.time : v);
      if (sec === null) return null;
      let s = `Quarter mile in ${secondsPhrase(sec)}`;
      if (obj && isNum(obj.trapKmh) && obj.trapKmh > 0) s += `, trap speed ${speedPhrase(obj.trapKmh, units)}`;
      return s;
    }
    case 'brake100': {
      if (obj && isNum(obj.dist) && obj.dist > 0) return `One hundred to zero in ${distPhrase(obj.dist, units)}`;
      const sec = toSeconds(obj ? obj.time : v);
      return sec === null ? null : `One hundred to zero in ${secondsPhrase(sec)}`;
    }
    default:
      return null;
  }
}

/**
 * Short spoken phrase for a telemetry event, or null when it is not worth speaking.
 *
 * - speed_milestone {kmh}: "Two hundred kilometres an hour" (mph when units.speed === 'mph')
 * - drift_end {score, durationS}: "Drift, 2400 points" (score >= 1000 only)
 * - air_end {durationS}: "Big air, 1.4 seconds" (>= 1 s only)
 * - perf {key, value}: t100 / t60mph / t200 (value = seconds, or ms when >= 300) -> "Zero to one hundred in 3.1 seconds";
 *   qmile {time, trapKmh}; brake100 {dist (m), time} (feet when units.dist === 'mi')
 * - lap {number, timeMs, best}: "Lap 2, 1 minute 12.4. Best lap!"
 * - achievement {title}
 * - redline, record and anything else: null
 * @param {{type: string}} ev
 * @param {{speed?: 'kmh'|'mph', dist?: 'km'|'mi'}} [units]
 * @returns {string|null}
 */
export function describeEvent(ev, units = { speed: 'kmh', dist: 'km' }) {
  if (!ev || typeof ev !== 'object') return null;
  const u = { speed: 'kmh', dist: 'km', ...(units && typeof units === 'object' ? units : {}) };
  switch (ev.type) {
    case 'speed_milestone':
      return isNum(ev.kmh) && ev.kmh > 0 ? cap(speedPhrase(ev.kmh, u)) : null;
    case 'drift_end':
      return isNum(ev.score) && ev.score >= 1000 ? `Drift, ${Math.round(ev.score)} points` : null;
    case 'air_end':
      return isNum(ev.durationS) && ev.durationS >= 1 ? `Big air, ${secondsPhrase(ev.durationS)}` : null;
    case 'perf':
      return perfPhrase(ev, u);
    case 'lap': {
      const time = lapTimePhrase(ev.timeMs);
      if (!isNum(ev.number) && !time) return null;
      const label = isNum(ev.number) ? `Lap ${Math.round(ev.number)}` : 'Lap complete';
      return (time ? `${label}, ${time}` : label) + (ev.best ? '. Best lap!' : '');
    }
    case 'achievement': {
      const title = typeof ev.title === 'string' ? ev.title.trim().slice(0, 80) : '';
      return title ? `Achievement unlocked, ${title}` : null;
    }
    default:
      return null;
  }
}

/**
 * Suggested cooldown key for an event, so each distinct callout has its own cooldown
 * (e.g. every speed milestone, every perf test).
 * @returns {string|null}
 */
export function eventKey(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  if (ev.type === 'speed_milestone') return `speed_milestone:${ev.kmh}`;
  if (ev.type === 'perf') return `perf:${ev.key}`;
  return ev.type;
}

/** Suggested priority: lap / perf / achievement are 1, everything else 0. */
export function eventPriority(ev) {
  const t = ev && ev.type;
  return t === 'lap' || t === 'perf' || t === 'achievement' ? 1 : 0;
}

/**
 * "Fuel critical" at <= 7 %, "Low fuel" at <= 15 %, otherwise null. Only call this while driving: a 0 reading
 * in menus is indistinguishable from an empty tank.
 * @param {number} fuelPct 0..100
 */
export function lowFuelPhrase(fuelPct) {
  if (!isNum(fuelPct)) return null;
  if (fuelPct <= 7) return 'Fuel critical';
  if (fuelPct <= 15) return 'Low fuel';
  return null;
}

/**
 * "Tyres overheating" when any tyre is hotter than the threshold, else null.
 * @param {number[]|Float64Array|{FL?:number,FR?:number,RL?:number,RR?:number}|number} tempsC tyre temperatures in deg C
 * @param {number} [thresholdC=115]
 */
export function tyreWarning(tempsC, thresholdC = 115) {
  const limit = isNum(thresholdC) ? thresholdC : 115;
  let vals;
  if (Array.isArray(tempsC) || ArrayBuffer.isView(tempsC)) vals = Array.from(tempsC);
  else if (tempsC && typeof tempsC === 'object') vals = Object.values(tempsC);
  else vals = [tempsC];
  return vals.some((t) => isNum(t) && t > limit) ? 'Tyres overheating' : null;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

const KEY_COOLDOWN_MS = 8000;

export class Voice {
  /**
   * @param {object} [options]
   * @param {object|null} [options.synth] speechSynthesis-like ({speak, cancel}); default globalThis.speechSynthesis; null = unsupported
   * @param {(text: string) => object} [options.makeUtterance] returns an object with text/rate/pitch/volume/lang;
   *   default `new SpeechSynthesisUtterance(text)` when that global exists
   * @param {boolean} [options.enabled=false]
   * @param {number} [options.volume=1] 0..1
   * @param {number} [options.minGapMs=1500] minimum silence between utterances (priority >= 2 ignores it)
   * @param {{speed?: string, dist?: string}} [options.units] used by speakEvent
   * @param {number} [options.rate=1.05] @param {number} [options.pitch=1] @param {string} [options.lang='en-US']
   * @param {() => number} [options.clock] optional ms clock; with it minGapMs counts from when an utterance ENDED
   *   (otherwise from when it started)
   */
  constructor(options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    this._synth = o.synth !== undefined ? o.synth : (globalThis.speechSynthesis || null);
    this._customMake = typeof o.makeUtterance === 'function' ? o.makeUtterance : null;
    this._clock = typeof o.clock === 'function' ? o.clock : null;
    /** on/off (use setEnabled) */
    this.enabled = !!o.enabled;
    this.volume = isNum(o.volume) ? clamp01(o.volume) : 1;
    this.minGapMs = isNum(o.minGapMs) && o.minGapMs >= 0 ? o.minGapMs : 1500;
    this.keyCooldownMs = KEY_COOLDOWN_MS;
    this.maxUtteranceMs = 15000;           // safety net when a browser never fires onend
    this.rate = isNum(o.rate) && o.rate > 0 ? o.rate : 1.05;
    this.pitch = isNum(o.pitch) && o.pitch > 0 ? o.pitch : 1;
    this.lang = typeof o.lang === 'string' && o.lang ? o.lang : 'en-US';
    this.units = { speed: 'kmh', dist: 'km', ...(o.units && typeof o.units === 'object' ? o.units : {}) };
    this._speaking = false;
    this._current = null;
    this._curPriority = 0;
    this._startMs = -Infinity;
    this._gapRefMs = -Infinity;
    this._keyAt = new Map();
  }

  /** true when a synth with speak() and a way to make utterances are available */
  get supported() {
    const s = this._synth;
    if (!s || typeof s.speak !== 'function') return false;
    return this._customMake !== null || typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  /** true from speak() until the utterance's onend / onerror (or cancel) */
  get speaking() { return this._speaking; }

  /** @param {boolean} on  Turning off cancels whatever is being said. */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.cancel();
  }

  /** @param {number} v 0..1, applies to utterances created from now on */
  setVolume(v) { if (isNum(v)) this.volume = clamp01(v); }

  /** @param {{speed?: string, dist?: string}} units for speakEvent */
  setUnits(units) { if (units && typeof units === 'object') this.units = { ...this.units, ...units }; }

  _now(nowMs) {
    if (isNum(nowMs)) return nowMs;
    if (this._clock) { const c = this._clock(); if (isNum(c)) return c; }
    const p = globalThis.performance;
    return p && typeof p.now === 'function' ? p.now() : 0;
  }

  _makeUtterance(text) {
    if (this._customMake) return this._customMake(text);
    return new globalThis.SpeechSynthesisUtterance(text);
  }

  /**
   * Say `text` unless a rule drops it. Rules, in order: disabled/unsupported/empty -> drop; per-`key` cooldown of 8 s
   * (priority >= 2 ignores it); while speaking, equal or lower priority is dropped and a higher one cancels the
   * current utterance; otherwise minGapMs must have passed since the last utterance (priority >= 2 ignores it).
   * @param {string} text
   * @param {{priority?: number, key?: string}} [options]
   * @param {number} [nowMs] monotonic caller clock in ms (defaults to the injected clock / performance.now())
   * @returns {boolean} true when the phrase was handed to the synth
   */
  speak(text, options = {}, nowMs) {
    if (!this.enabled || !this.supported) return false;
    const phrase = typeof text === 'string' ? text.trim() : '';
    if (!phrase) return false;
    const opt = options && typeof options === 'object' ? options : {};
    const priority = isNum(opt.priority) ? opt.priority : 0;
    const key = opt.key === undefined || opt.key === null ? null : String(opt.key);
    const now = this._now(nowMs);

    if (this._speaking && (now < this._startMs || now - this._startMs > this.maxUtteranceMs)) {
      this._speaking = false;              // onend never arrived (or the clock restarted): stop trusting the flag
      this._current = null;
    }

    if (key !== null && priority < 2) {
      const last = this._keyAt.get(key);
      if (last !== undefined) {
        const d = now - last;
        if (d >= 0 && d < this.keyCooldownMs) return false;
      }
    }

    let preempt = false;
    if (this._speaking) {
      if (priority <= this._curPriority) return false;
      preempt = true;
    } else if (priority < 2) {
      const d = now - this._gapRefMs;
      if (d >= 0 && d < this.minGapMs) return false;
    }

    let u;
    try { u = this._makeUtterance(phrase); } catch (_) { return false; }
    if (!u || typeof u !== 'object') return false;
    if (typeof u.text !== 'string') u.text = phrase;
    u.rate = this.rate; u.pitch = this.pitch; u.volume = this.volume; u.lang = this.lang;
    const done = () => {
      if (this._current !== u) return;     // a cancelled utterance reporting late must not clear its successor
      this._current = null;
      this._speaking = false;
      if (this._clock) { const c = this._clock(); if (isNum(c)) this._gapRefMs = c; }
    };
    u.onend = done;
    u.onerror = done;

    if (preempt) {
      try { if (typeof this._synth.cancel === 'function') this._synth.cancel(); } catch (_) { /* ignore */ }
    }
    // State first: a synth may fire onend synchronously from speak().
    this._current = u;
    this._speaking = true;
    this._curPriority = priority;
    this._startMs = now;
    this._gapRefMs = now;
    try {
      this._synth.speak(u);
    } catch (_) {
      if (this._current === u) { this._current = null; this._speaking = false; }
      return false;
    }
    if (key !== null) {
      this._keyAt.set(key, now);
      if (this._keyAt.size > 64) {
        for (const [k, t] of this._keyAt) if (now - t >= this.keyCooldownMs || now < t) this._keyAt.delete(k);
      }
    }
    return true;
  }

  /**
   * Describe a telemetry event with describeEvent() and speak it with a per-event key and priority.
   * @param {{type: string}} ev
   * @param {number} [nowMs]
   * @returns {boolean} true when spoken
   */
  speakEvent(ev, nowMs) {
    const text = describeEvent(ev, this.units);
    if (!text) return false;
    return this.speak(text, { priority: eventPriority(ev), key: eventKey(ev) }, nowMs);
  }

  /** Stop speaking now. Safe when unsupported. */
  cancel() {
    this._current = null;
    this._speaking = false;
    const s = this._synth;
    if (s && typeof s.cancel === 'function') {
      try { s.cancel(); } catch (_) { /* ignore */ }
    }
  }
}
