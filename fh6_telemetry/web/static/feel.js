// "Feel": engine sound, shift beeps, turbo blow-off, tyre squeal, phone vibration and voice
// callouts — everything that makes the page more than a screen.  All of it is opt-in and
// starts muted: browsers only allow audio after a tap, so startAudio() must run from a click.

import { on } from './bus.js';
import { BlowOffDetector, SoundEngine } from './audio.js';
import { Haptics } from './haptics.js';
import { ShiftCue } from './shift.js';
import { Voice, describeEvent, eventKey, eventPriority, lowFuelPhrase, tyreWarning } from './voice.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];

export class Feel {
  constructor({ store, settings }) {
    this.store = store;
    this.settings = settings;
    this.engine = null;
    this.error = null;
    this.haptics = new Haptics({ enabled: settings.get('haptics') });
    this.voice = new Voice({ enabled: settings.get('voice') });
    this.cue = new ShiftCue();
    this.blow = new BlowOffDetector();
    this._gear = '';
    this._oneShot = { landing: false, impact: false, shift: false };
    this._fuelAt = 0; this._tyreAt = 0; this._impactAt = 0;

    on('settings', ({ path }) => this.applySettings(path));
    on('analytics', (ev) => this.onEvent(ev));
    store.onSlow((slow) => {
      const gy = Math.abs(slow[store.S.AccelGY] || 0);
      const now = performance.now();
      if (gy > 1.8 && now - this._impactAt > 500) { this._impactAt = now; this._oneShot.impact = true; }
    });
  }

  applySettings() {
    const s = this.settings;
    this.haptics.setEnabled(!!s.get('haptics'));
    this.voice.setEnabled(!!s.get('voice'));                 // (off also cancels the phrase being spoken)
    if (this.engine) {
      this.engine.setMaster(s.get('sound.master'));
      this.engine.setEnabled({ engine: s.get('sound.engine'), turbo: s.get('sound.turbo'), squeal: s.get('sound.squeal'), rumble: s.get('sound.rumble') });
    }
  }

  /** Must be called from a user gesture (tap / click). */
  async startAudio() {
    try {
      if (!this.engine) this.engine = new SoundEngine({ master: this.settings.get('sound.master') });
      const ok = await this.engine.start();               // resolves false (never rejects) when audio can't run
      if (!ok) {
        const why = this.engine.errors.find((e) => e.feature === 'context');
        throw new Error(why ? why.message : 'Audio could not be started');
      }
      this.applySettings();
      this.settings.set('soundOn', true);
      this.error = null;
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      this.settings.set('soundOn', false);
      throw e;
    }
  }

  stopAudio() {
    try { if (this.engine) this.engine.stop(); } catch { /* ignore */ }
    this.settings.set('soundOn', false);
  }

  async toggleSound() {
    if (this.settings.get('soundOn')) this.stopAudio(); else await this.startAudio();
  }

  onEvent(ev) {
    if (ev.type === 'air_end') this._oneShot.landing = true;
    if (this.voice.enabled) {
      const u = this.settings.get('units');
      const text = describeEvent(ev, { speed: u.speed, dist: u.dist });
      if (text) this.voice.speak(text, { priority: ev.type === 'achievement' ? 2 : eventPriority(ev), key: eventKey(ev) }, performance.now());
    }
  }

  /** Called ~30 times a second. */
  tick(nowMs) {
    const st = this.store;
    if (!st.last || !st.hello) return;
    const f = (k) => st.f(k);
    const nowS = nowMs / 1000;
    // The last row we hold is only meaningful while packets are arriving and the game is racing
    // (menus / pause / a dropped link must not leave the engine drone or the call-outs running).
    const live = !!st.signal && !!f('IsRaceOn');
    const rpm = live ? f('CurrentEngineRpm') : 0, maxRpm = f('EngineMaxRpm') || 8000, throttle = live ? f('AccelPct') : 0;
    const slip = live ? Math.max(...WHEELS.map((w) => st.s('TireCombinedSlip' + w)), 0) : 0;
    const bits = live ? (st.s('WheelFlags') | 0) & 15 : 0;
    const boost = live ? f('BoostBar') : 0;
    const gear = st.gear;
    const shifted = live && gear !== this._gear && this._gear !== '';
    this._gear = gear;

    if (this.engine && this.settings.get('soundOn')) {
      this.engine.update({
        rpm, maxRpm, throttle, boost, combinedSlip: slip, speedKmh: live ? f('SpeedKmh') : 0,
        cylinders: st.s('NumCylinders') || 4, rumbleBits: bits, gear: f('Gear'),      // numeric code: the torque-cut dip compares codes
      }, nowS);
      if (this.settings.get('sound.beep') && this.cue.update(rpm, maxRpm, nowS, this.settings.get('shift'))) this.engine.beep(nowS);
      if (this.settings.get('sound.turbo') && this.blow.update(throttle, boost, nowS)) this.engine.blowOff(nowS);
    }

    if (this.haptics.enabled && live) {
      this.haptics.update({
        rumbleBits: bits, latG: f('AccelGX'), longG: f('AccelGZ'),
        impact: this._oneShot.impact, landing: this._oneShot.landing, shift: shifted,
        airborne: Math.max(f('SuspNormFL'), f('SuspNormFR'), f('SuspNormRL'), f('SuspNormRR')) < 0.04,
      }, nowMs);
    }
    this._oneShot = { landing: false, impact: false, shift: false };

    if (this.voice.enabled && live) {
      if (nowMs - this._fuelAt > 30000) {
        const p = lowFuelPhrase(f('FuelPct'));
        if (p) { this._fuelAt = nowMs; this.voice.speak(p, { priority: 1, key: 'fuel' }, nowMs); }
      }
      if (nowMs - this._tyreAt > 45000) {
        const p = tyreWarning(WHEELS.map((w) => f('TireTemp' + w)));
        if (p) { this._tyreAt = nowMs; this.voice.speak(p, { priority: 1, key: 'tyres' }, nowMs); }
      }
    }
  }

  start() {
    this._timer = setInterval(() => { try { this.tick(performance.now()); } catch (e) { console.error(e); } }, 33);
  }
}
