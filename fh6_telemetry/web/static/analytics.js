// Analytics: runs every tracker on the live rows (whichever view is open), turns their events
// into toasts / personal bests / achievements, and re-publishes them on the bus for the
// sound, voice and haptics managers.

import { Achievements } from './achievements.js';
import { emit } from './bus.js';
import { AirTracker } from './air.js';
import { DriftTracker } from './drift.js';
import { fmtTime } from './format.js';
import { LapDelta } from './lap.js';
import { PerfMeter } from './perf.js';
import { GTrail, Records } from './records.js';
import { conv, label } from './units.js';

const PERF_NAMES = {
  t60mph: '0–60 mph', t100: '0–100 km/h', t200: '0–200 km/h', t100to200: '100–200 km/h',
  qmile: '¼ mile', brake100: '100–0 km/h', brake60mph: '60–0 mph',
};

export class Analytics {
  /** @param store the Store  @param lifetime a Lifetime  @param settings Settings (units for toasts) */
  constructor(store, lifetime, settings) {
    this.store = store;
    this.lifetime = lifetime;
    this.settings = settings;
    this.achievements = new Achievements({ unlocked: lifetime.data.unlocked });
    this.perf = this.records = this.gtrail = this.lap = this.drift = this.air = null;
    this.lastRow = null;
    this._mergeAt = 0;
    this._ctxAt = 0;
    this.bind();
    store.onHello((_s, reset) => { if (reset) this.bind(); });
    store.onRows((rows) => this.feedRows(rows));
    store.onSlow((slow) => this.feedSlow(slow));
  }

  /** (Re)create the trackers for the current column layout. */
  bind() {
    // the session odometer restarts with the new Records: bank what the old one measured first
    if (this.records) {
      this.lifetime.mergeRecords(this.records.state);
      this.lifetime.base = this.lifetime.data.odometerM;
    }
    const { F, S } = this.store;
    this.perf = new PerfMeter({ F, S });
    this.records = new Records({ F, S });
    this.gtrail = new GTrail({ F }, { size: 150, decayPerSec: 0.8 });
    this.lap = new LapDelta({ F, S });
    this.drift = new DriftTracker({ F, S });
    this.air = new AirTracker({ F, S });
  }

  feedRows(rows) {
    const trackers = [this.perf, this.records, this.drift, this.air];
    for (const row of rows) {
      this.lastRow = row;
      for (const t of trackers) t.feed(row);
      this.gtrail.feed(row);
    }
    const events = [...this.perf.drain(), ...this.records.drain(), ...this.drift.drain(), ...this.air.drain()];
    const now = performance.now();
    // context-only achievements (hot tyres, odometer, jumps) need a look even when no tracker fired
    if (events.length || now - this._ctxAt > 500) { this._ctxAt = now; this._process(events); }
    if (now - this._mergeAt > 2000) {
      this._mergeAt = now;
      this.lifetime.mergeRecords(this.records.state);
      this.lifetime.save();
    }
  }

  feedSlow(slow) {
    this.lap.feedSlow(slow);
    const events = this.lap.drain();
    if (events.length) this._process(events);
  }

  _process(events) {
    const u = this.settings.get('units');
    for (const ev of events) {
      emit('analytics', ev);
      switch (ev.type) {
        case 'perf': {
          const nb = this.lifetime.setBest(ev.key, ev.value);
          const name = PERF_NAMES[ev.key] || ev.key;
          let text;
          if (ev.key === 'qmile') text = `${ev.value.time.toFixed(2)} s @ ${Math.round(conv.speed(ev.value.trapKmh, u))} ${label.speed(u)}`;
          else if (ev.key.startsWith('brake')) text = `${ev.value.dist.toFixed(1)} m in ${ev.value.time.toFixed(2)} s`;
          else text = `${ev.value.toFixed(2)} s`;
          emit('toast', { icon: ev.key.startsWith('brake') ? '🛑' : '⏱️', title: name + (nb ? '  ·  NEW BEST' : ''), text, rarity: nb ? 'rare' : 'common', ms: 3600 });
          break;
        }
        case 'drift_end':
          if (this.lifetime.noteDrift(ev.score) || ev.score >= 600) {
            emit('toast', { icon: '🌀', title: `Drift  ·  ${Math.round(ev.score).toLocaleString()} pts`, text: `×${ev.mult} combo · ${ev.durationS.toFixed(1)} s · ${Math.round(ev.maxAngleDeg)}°`, rarity: ev.score >= 5000 ? 'epic' : ev.score >= 2000 ? 'rare' : 'common' });
          }
          break;
        case 'drift_fail':
          emit('toast', { icon: '💥', title: 'Spun out!', text: 'Drift chain lost', rarity: 'common', ms: 1800 });
          break;
        case 'air_end':
          this.lifetime.noteAir(ev.durationS);
          if (ev.durationS >= 0.7) emit('toast', { icon: '🚀', title: `Airtime  ·  ${ev.durationS.toFixed(2)} s`, text: `${Math.round(ev.distM)} m · ~${ev.heightM.toFixed(1)} m high`, rarity: ev.durationS >= 2 ? 'rare' : 'common', ms: 3000 });
          break;
        case 'speed_milestone':
          emit('toast', { icon: '💨', title: `${Math.round(conv.speed(ev.kmh, u))} ${label.speed(u)}`, text: 'Speed milestone', rarity: ev.kmh >= 300 ? 'epic' : ev.kmh >= 200 ? 'rare' : 'common', ms: 2400 });
          break;
        case 'lap':
          emit('toast', { icon: '🏁', title: `Lap ${ev.number}  ·  ${fmtTime(ev.timeMs)}`, text: ev.best ? 'Best lap!' : '', rarity: ev.best ? 'rare' : 'common', ms: 3600 });
          break;
        default:
      }
    }
    const unlocked = this.achievements.consume(events, {
      fastRow: this.lastRow, F: this.store.F,
      lifetimeOdometerM: this.lifetime.base + this.records.state.odometerM,
      session: { jumps: this.air.state.count }, now: Date.now(),
    });
    if (unlocked && unlocked.length) {
      this.lifetime.setUnlocked(this.achievements.serialize());
      this.lifetime.save(true);
      for (const a of unlocked) {
        emit('toast', { icon: a.icon, title: `Achievement: ${a.title}`, text: a.desc, rarity: a.rarity });
        emit('analytics', { type: 'achievement', title: a.title, id: a.id });
      }
    }
  }

  /** Forget the session's measurements (not the lifetime stats). */
  resetSession() { this.bind(); }
}
