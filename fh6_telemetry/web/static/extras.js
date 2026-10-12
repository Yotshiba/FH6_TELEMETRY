// Extras: file export (CSV, share card), keep-screen-awake, and the Konami easter egg.

import { colors, heat } from './theme.js';
import { conv, fmt, label } from './units.js';
import { fmtTime } from './format.js';

export function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

export function exportCsv(store) {
  const tl = store.timeline;
  if (!tl || !tl.length) return false;
  downloadBlob(`fh6-telemetry-${stamp()}.csv`, new Blob([tl.toCSV({})], { type: 'text/csv' }));
  return true;
}

/** Render a 1080×1350 "session card" PNG: records, best times and the track you drove. */
export async function exportShareCard({ analytics, lifetime, settings, trail }) {
  const W = 1080, H = 1350;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const c = colors();
  const u = settings.get('units');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, c.bg); bg.addColorStop(1, c.panel);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = c.accent; g.font = '800 64px system-ui, sans-serif'; g.textBaseline = 'alphabetic';
  g.fillText('FH6 TELEMETRY', 60, 110);
  g.fillStyle = c.dim; g.font = '600 28px system-ui, sans-serif';
  g.fillText(new Date().toLocaleString(), 60, 156);

  // track
  const box = { x: 60, y: 200, w: W - 120, h: 520 };
  g.fillStyle = c.panel2; g.fillRect(box.x, box.y, box.w, box.h);
  g.strokeStyle = c.border; g.lineWidth = 2; g.strokeRect(box.x, box.y, box.w, box.h);
  if (trail && trail.x.length > 1) {
    const bw = Math.max(40, trail.maxX - trail.minX), bz = Math.max(40, trail.maxZ - trail.minZ);
    const s = Math.min((box.w - 80) / bw, (box.h - 80) / bz);
    const cx = (trail.minX + trail.maxX) / 2, cz = (trail.minZ + trail.maxZ) / 2;
    const vmax = Math.max(120, trail.vmax);
    g.lineWidth = 6; g.lineCap = 'round';
    for (let i = 1; i < trail.x.length; i++) {
      if (trail.brk.has(i)) continue;
      g.strokeStyle = heat(trail.v[i] / vmax);
      g.beginPath();
      g.moveTo(box.x + box.w / 2 + (trail.x[i - 1] - cx) * s, box.y + box.h / 2 - (trail.z[i - 1] - cz) * s);
      g.lineTo(box.x + box.w / 2 + (trail.x[i] - cx) * s, box.y + box.h / 2 - (trail.z[i] - cz) * s);
      g.stroke();
    }
  } else {
    g.fillStyle = c.dim; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('No track recorded yet', box.x + box.w / 2, box.y + box.h / 2); g.textAlign = 'left';
  }

  // stats grid
  const r = analytics.records.state, life = lifetime.data;
  const p = analytics.perf.state.results;
  const best = life.best;
  const cell = (i, title, value, sub) => {
    const x = 60 + (i % 2) * 495, y = 770 + Math.floor(i / 2) * 150;
    g.fillStyle = c.panel; g.fillRect(x, y, 465, 128);
    g.strokeStyle = c.border; g.lineWidth = 2; g.strokeRect(x, y, 465, 128);
    g.fillStyle = c.dim; g.font = '700 22px system-ui, sans-serif'; g.fillText(title.toUpperCase(), x + 24, y + 38);
    g.fillStyle = c.bright; g.font = '800 54px system-ui, sans-serif'; g.fillText(value, x + 24, y + 96);
    if (sub) { g.fillStyle = c.dim; g.font = '600 22px system-ui, sans-serif'; g.textAlign = 'right'; g.fillText(sub, x + 441, y + 96); g.textAlign = 'left'; }
  };
  const t100 = best.t100 ?? p.t100, tq = best.qmile ?? p.qmile;
  cell(0, 'Top speed', `${Math.round(conv.speed(Math.max(r.topSpeedKmh, life.records.topSpeedKmh || 0), u))}`, label.speed(u));
  cell(1, '0–100 km/h', t100 ? `${t100.toFixed(2)} s` : '—', '');
  cell(2, 'Quarter mile', tq ? `${tq.time.toFixed(2)} s` : '—', tq ? `${Math.round(conv.speed(tq.trapKmh, u))} ${label.speed(u)}` : '');
  cell(3, 'Best drift', Math.round(Math.max(life.bestDrift, analytics.drift.state.best)).toLocaleString(), 'points');
  cell(4, 'Longest air', `${Math.max(life.longestAirS, analytics.air.state.longestS).toFixed(2)} s`, '');
  cell(5, 'Max lateral', `${Math.max(r.maxLatG, life.records.maxLatG || 0).toFixed(2)} g`, '');
  const pr = analytics.achievements.progress();
  g.fillStyle = c.accent; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText(`🏆 ${pr.unlocked}/${pr.total} achievements  ·  ${conv.dist(life.odometerM, u).toFixed(1)} ${label.dist(u)} driven`, W / 2, H - 60);
  await new Promise((res) => cv.toBlob((b) => { if (b) downloadBlob(`fh6-session-${stamp()}.png`, b); res(); }, 'image/png'));
}

/** Best-effort "keep the screen on": Wake Lock where allowed, else a muted canvas-stream video. */
export class KeepAwake {
  constructor() { this.lock = null; this.video = null; this.tick = null; this.on = false; }

  async enable() {
    this.on = true;
    this._dropVideo();                                 // idempotent: never stack a second fallback video / timer
    try {
      if ('wakeLock' in navigator) { this.lock = await navigator.wakeLock.request('screen'); return 'wakelock'; }
    } catch { /* not a secure context / denied: fall through */ }
    let v = null, tick = null;
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 16;
      const cx = cv.getContext('2d');
      v = document.createElement('video');
      v.muted = true; v.loop = true; v.setAttribute('playsinline', '');
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
      v.srcObject = cv.captureStream(5);
      document.body.appendChild(v);
      tick = setInterval(() => { cx.fillStyle = Math.random() < 0.5 ? '#000' : '#010101'; cx.fillRect(0, 0, 16, 16); }, 1000);
      await v.play();
      this.video = v; this.tick = tick;
      return 'video';
    } catch {
      clearInterval(tick);                             // play() was refused: leave nothing behind
      if (v) v.remove();
      return 'unsupported';
    }
  }

  _dropVideo() {
    clearInterval(this.tick); this.tick = null;
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; }
  }

  async disable() {
    this.on = false;
    try { if (this.lock) await this.lock.release(); } catch { /* ignore */ }
    this.lock = null;
    this._dropVideo();
  }

  /** The browser drops a wake lock when the tab is hidden: take it again on return. */
  reacquire() { if (this.on && !this.lock && !this.video) this.enable(); else if (this.on && 'wakeLock' in navigator && !this.video) this.enable(); }
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Calls cb() after ↑↑↓↓←→←→BA (or the same taps: swipe-free alternative is the version label tap ×7). */
export function onKonami(cb) {
  let i = 0;
  window.addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    i = k === KONAMI[i] ? i + 1 : (k === KONAMI[0] ? 1 : 0);
    if (i === KONAMI.length) { i = 0; cb(); }
  });
}
