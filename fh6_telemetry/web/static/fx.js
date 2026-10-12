// Screen effects: speed lines, redline vignette, impact shake, confetti.
// Driven by the app's animation loop (fx.draw) and by bus events; every effect is a setting.

import { colors, withAlpha } from './theme.js';
import { on } from './bus.js';

const CONFETTI_COLORS = ['#ff4d6d', '#ffd23f', '#3ddc84', '#4dabf7', '#b197fc', '#ff922b'];

export class Fx {
  constructor(canvas, vignetteEl, shakeEl, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.vig = vignetteEl;
    this.shakeEl = shakeEl;
    this.settings = settings;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.lines = Array.from({ length: 70 }, () => this._line(true));
    this.confetti = [];
    this.shakeMag = 0;
    this.last = 0;
    this.speedOn = true;          // the app switches this per view
    this.unsub = on('confetti', ({ n } = {}) => this.burst(n || 90));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
  }

  _line(spread) {
    return { a: Math.random() * Math.PI * 2, r: spread ? Math.random() : 0, v: 0.4 + Math.random() * 0.9, l: 0.06 + Math.random() * 0.14 };
  }

  burst(n) {
    if (!this.settings.get('fx.confetti')) return;
    for (let i = 0; i < n; i++) {
      this.confetti.push({
        x: this.w * (0.2 + Math.random() * 0.6), y: this.h * 0.18,
        vx: (Math.random() - 0.5) * 520, vy: -180 - Math.random() * 380,
        s: 5 + Math.random() * 7, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
        c: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0], life: 2.4 + Math.random() * 1.2,
      });
    }
    if (this.confetti.length > 400) this.confetti.splice(0, this.confetti.length - 400);
  }

  shake(mag) { if (this.settings.get('fx.shake')) this.shakeMag = Math.min(14, Math.max(this.shakeMag, mag)); }

  /** @param {number} ts ms  @param {{speedKmh:number, rpmRatio:number, flashing:boolean}} s */
  draw(ts, s) {
    const dt = Math.min(0.1, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const power = Math.max(0, Math.min(1, ((s.speedKmh || 0) - 70) / 230));
    const lines = this.speedOn && this.settings.get('fx.speedlines') && power > 0.02;
    // clearing a full-viewport layer costs a compositor pass: only when the last frame left ink behind
    if (this._ink || lines || this.confetti.length) ctx.clearRect(0, 0, w, h);
    this._ink = lines || this.confetti.length > 0;

    // --- speed lines -------------------------------------------------------------------------
    if (lines) {
      const c = colors();
      const cx = w / 2, cy = h / 2, maxR = Math.hypot(cx, cy);
      ctx.lineCap = 'round';
      for (const L of this.lines) {
        L.r += dt * (0.25 + power * 1.6) * L.v;
        if (L.r > 1) Object.assign(L, this._line(false));
        const r0 = (0.22 + L.r * 0.9) * maxR, r1 = r0 + L.l * maxR * (0.4 + power * 1.6) * L.r;
        const a = Math.min(1, L.r * 2) * 0.42 * power;
        ctx.strokeStyle = withAlpha(c.accent, a);
        ctx.lineWidth = 1 + L.r * 2.2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(L.a) * r0, cy + Math.sin(L.a) * r0);
        ctx.lineTo(cx + Math.cos(L.a) * r1, cy + Math.sin(L.a) * r1);
        ctx.stroke();
      }
    }

    // --- confetti ------------------------------------------------------------------------------
    if (this.confetti.length) {
      for (let i = this.confetti.length - 1; i >= 0; i--) {
        const p = this.confetti[i];
        p.life -= dt; p.vy += 900 * dt; p.vx *= 0.995; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.life <= 0 || p.y > h + 20) { this.confetti.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // --- redline vignette ------------------------------------------------------------------------
    if (this.vig) {
      let o = 0;
      if (this.settings.get('fx.vignette') && s.rpmRatio > 0.9) {
        o = Math.min(0.7, (s.rpmRatio - 0.9) * 7);
        if (s.flashing) o = 0.45 + 0.25 * Math.sin(ts / 45);
      }
      if (this._vo !== o) { this._vo = o; this.vig.style.opacity = o.toFixed(3); }
    }

    // --- shake ---------------------------------------------------------------------------------------
    if (this.shakeEl) {
      if (this.shakeMag > 0.2) {
        const m = this.shakeMag;
        this.shakeEl.style.transform = `translate(${((Math.random() - 0.5) * m).toFixed(1)}px,${((Math.random() - 0.5) * m).toFixed(1)}px)`;
        this.shakeMag *= Math.pow(0.02, dt);          // fast decay
        this._shook = true;
      } else if (this._shook) { this.shakeEl.style.transform = ''; this._shook = false; this.shakeMag = 0; }
    }
  }
}
