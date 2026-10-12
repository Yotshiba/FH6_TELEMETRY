// Top-down car: tyre temperature, slip glow, suspension compression, weight transfer,
// brake lights, exhaust flames at the limiter, and a floating shadow when airborne.

import { tempColor } from './format.js';
import { fitCanvas, roundRect, smooth } from './gauges.js';
import { colors, mix, withAlpha } from './theme.js';
import { conv, label } from './units.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function buildCar(ctx) {
  const { store, settings } = ctx;
  const root = h('div', 'view v-chassis');
  const canvas = h('canvas', 'car-canvas');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');
  const st = { steer: 0, latG: 0, longG: 0, susp: [0.45, 0.45, 0.45, 0.45], air: 0, flame: 0, brake: 0 };

  function update(dt, ts) {
    const c = colors();
    const u = settings.get('units');
    const { w, h: H } = fitCanvas(canvas, g);
    g.clearRect(0, 0, w, H);
    const bands = store.hello ? store.hello.ui.temp : [[50, '#1a6fb5'], [999, '#DD2200']];

    st.steer = smooth(st.steer, store.f('SteerPct') / 100 * 0.5, dt, 22);
    st.latG = smooth(st.latG, store.f('AccelGX'), dt, 12);
    st.longG = smooth(st.longG, store.f('AccelGZ'), dt, 12);
    st.brake = smooth(st.brake, store.f('BrakePct') / 100, dt, 25);
    const susp = WHEELS.map((wl) => store.f('SuspNorm' + wl));
    st.susp = st.susp.map((v, i) => smooth(v, susp[i], dt, 25));
    const airborne = Math.max(...susp) < 0.04 && store.f('SpeedKmh') > 15;
    st.air = smooth(st.air, airborne ? 1 : 0, dt, 12);
    const rpmRatio = store.f('CurrentEngineRpm') / (store.f('EngineMaxRpm') || 1);
    const flameOn = rpmRatio > 0.97 && store.f('AccelPct') > 70;
    st.flame = smooth(st.flame, flameOn ? 1 : 0, dt, 30);

    const cx = w / 2, cy = H / 2;
    const unit = Math.min(H * 0.92, w * 0.98);          // the tyre read-outs reach ±0.47 unit from the centre line
    const L = unit * 0.78, W = unit * 0.36;
    const tw = W * 0.24, tl = L * 0.22;
    const pos = { FL: [-1, -1], FR: [1, -1], RL: [-1, 1], RR: [1, 1] };
    const lift = st.air * unit * 0.025;

    // ground shadow (floats away when airborne)
    g.fillStyle = `rgba(0,0,0,${0.35 - 0.2 * st.air})`;
    roundRect(g, cx - W / 2 - lift * 0.5, cy - L / 2 + lift * 1.5, W * (1 + st.air * 0.1), L, W * 0.3); g.fill();

    g.save();
    g.translate(0, -lift);

    // ---- tyres ---------------------------------------------------------------------------------
    const info = [];
    WHEELS.forEach((wl, i) => {
      const [sx, sy] = pos[wl];
      const tx = cx + sx * (W / 2 + tw * 0.15), ty = cy + sy * L * 0.30;
      const temp = store.f('TireTemp' + wl);
      const slip = store.s('TireCombinedSlip' + wl);
      const base = tempColor(bands, temp);
      const load = Math.max(0, Math.min(1, st.susp[i]));
      const hot = Math.max(0, Math.min(1, (slip - 0.8) / 1.2));
      g.save();
      g.translate(tx, ty);
      if (sy < 0) g.rotate(st.steer);
      g.shadowColor = hot > 0.02 ? mix(c.amber, c.red, hot) : 'transparent'; g.shadowBlur = hot * unit * 0.07;
      g.fillStyle = mix('#101010', base, 0.55 + 0.35 * load);
      roundRect(g, -tw / 2, -tl / 2, tw, tl, tw * 0.3); g.fill();
      g.shadowColor = 'transparent';
      g.strokeStyle = hot > 0.05 ? mix(c.amber, c.red, hot) : withAlpha(c.bright, 0.35);
      g.lineWidth = 1.5 + hot * 3; roundRect(g, -tw / 2, -tl / 2, tw, tl, tw * 0.3); g.stroke();
      // tread marks
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1;
      for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(-tw / 2, k * tl * 0.16); g.lineTo(tw / 2, k * tl * 0.16); g.stroke(); }
      g.restore();
      // suspension bar (outside the tyre)
      const bx = tx + sx * (tw / 2 + unit * 0.035), bh = tl * 1.15, bw = unit * 0.022;
      g.fillStyle = c.panel2; roundRect(g, bx - bw / 2, ty - bh / 2, bw, bh, bw / 2); g.fill();
      if (load > 0.03) {
        g.fillStyle = load > 0.85 ? c.red : load > 0.65 ? c.amber : c.green;
        roundRect(g, bx - bw / 2, ty + bh / 2 - bh * load, bw, bh * load, bw / 2); g.fill();
      } else {
        g.strokeStyle = c.red; g.lineWidth = 1.5; roundRect(g, bx - bw / 2, ty - bh / 2, bw, bh, bw / 2); g.stroke();
      }
      // numbers
      const lx = tx + sx * (tw / 2 + unit * 0.11), align = sx < 0 ? 'right' : 'left';
      info.push({ wl, temp, slip, lx, ty, align, sx });
    });

    // ---- body ------------------------------------------------------------------------------------
    const body = g.createLinearGradient(cx - W / 2, 0, cx + W / 2, 0);
    body.addColorStop(0, mix(c.panel, '#000000', 0.25)); body.addColorStop(0.5, c.panel); body.addColorStop(1, mix(c.panel, '#000000', 0.25));
    g.fillStyle = body; g.strokeStyle = withAlpha(c.accent, 0.8); g.lineWidth = 2;
    g.shadowColor = c.glow; g.shadowBlur = unit * 0.04;
    roundRect(g, cx - W / 2, cy - L / 2, W, L, W * 0.38); g.fill(); g.stroke();
    g.shadowColor = 'transparent';
    // cabin / glass
    g.fillStyle = withAlpha('#000000', 0.55);
    roundRect(g, cx - W * 0.36, cy - L * 0.16, W * 0.72, L * 0.34, W * 0.2); g.fill();
    g.strokeStyle = withAlpha(c.bright, 0.18); g.lineWidth = 1;
    roundRect(g, cx - W * 0.36, cy - L * 0.16, W * 0.72, L * 0.34, W * 0.2); g.stroke();
    // hood line
    g.beginPath(); g.moveTo(cx - W * 0.3, cy - L * 0.33); g.lineTo(cx, cy - L * 0.4); g.lineTo(cx + W * 0.3, cy - L * 0.33); g.stroke();
    // headlights
    g.fillStyle = '#fff6cf'; g.shadowColor = '#fff6cf'; g.shadowBlur = unit * 0.02;
    roundRect(g, cx - W * 0.42, cy - L / 2 + L * 0.015, W * 0.22, L * 0.03, 3); g.fill();
    roundRect(g, cx + W * 0.2, cy - L / 2 + L * 0.015, W * 0.22, L * 0.03, 3); g.fill();
    // tail lights
    const tailC = mix('#5a0a0a', '#ff2a2a', Math.min(1, 0.25 + st.brake * 1.2));
    g.fillStyle = tailC; g.shadowColor = '#ff2a2a'; g.shadowBlur = unit * (0.01 + st.brake * 0.06);
    roundRect(g, cx - W * 0.42, cy + L / 2 - L * 0.045, W * 0.26, L * 0.03, 3); g.fill();
    roundRect(g, cx + W * 0.16, cy + L / 2 - L * 0.045, W * 0.26, L * 0.03, 3); g.fill();
    g.shadowColor = 'transparent';

    // ---- exhaust flames ------------------------------------------------------------------------------
    if (st.flame > 0.05) {
      for (const fx of [-0.2, 0.2]) {
        const len = L * (0.1 + 0.1 * st.flame) * (0.7 + 0.5 * Math.random());
        const x = cx + W * fx, y = cy + L / 2;
        const gr = g.createLinearGradient(x, y, x, y + len);
        gr.addColorStop(0, '#fff6a8'); gr.addColorStop(0.4, '#ff9a1a'); gr.addColorStop(1, 'rgba(255,60,0,0)');
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(x - W * 0.045, y); g.lineTo(x, y + len); g.lineTo(x + W * 0.045, y); g.closePath(); g.fill();
      }
    }

    // ---- weight-transfer ball -----------------------------------------------------------------------------------
    const br = W * 0.27;
    g.strokeStyle = withAlpha(c.bright, 0.25); g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy + L * 0.01, br, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy + L * 0.01, br * 0.5, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - br, cy + L * 0.01); g.lineTo(cx + br, cy + L * 0.01); g.moveTo(cx, cy + L * 0.01 - br); g.lineTo(cx, cy + L * 0.01 + br); g.stroke();
    const kx = Math.max(-1.3, Math.min(1.3, -st.latG)) / 1.3, ky = Math.max(-1.3, Math.min(1.3, st.longG)) / 1.3;
    g.fillStyle = c.accent; g.shadowColor = c.accent; g.shadowBlur = 10;
    g.beginPath(); g.arc(cx + kx * br, cy + L * 0.01 + ky * br, Math.max(4, W * 0.035), 0, Math.PI * 2); g.fill();
    g.shadowColor = 'transparent';
    g.restore();

    // ---- readouts --------------------------------------------------------------------------------------------------------
    g.font = `700 ${Math.round(unit * 0.034)}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (const i of info) {
      g.textAlign = i.align;
      g.fillStyle = c.bright;
      g.fillText(`${Math.round(conv.temp(i.temp, u))}${label.temp(u)}`, i.lx, i.ty - unit * 0.018);
      g.fillStyle = i.slip > 1.1 ? c.red : c.dim;
      g.font = `600 ${Math.round(unit * 0.024)}px system-ui, sans-serif`;
      g.fillText(`slip ${i.slip.toFixed(2)}`, i.lx, i.ty + unit * 0.02);
      g.font = `700 ${Math.round(unit * 0.034)}px system-ui, sans-serif`;
    }
    if (st.air > 0.5) {
      g.fillStyle = withAlpha(c.amber, 0.6 + 0.4 * Math.sin(ts / 90)); g.textAlign = 'center';
      g.font = `800 ${Math.round(unit * 0.06)}px system-ui, sans-serif`;
      g.fillText('AIRBORNE', cx, cy - L * 0.62 > 20 ? cy - L * 0.62 : 28);
    }
    g.fillStyle = c.chartText; g.font = `600 ${Math.round(unit * 0.022)}px system-ui, sans-serif`; g.textAlign = 'left';
    g.fillText('bars: suspension load · ball: weight transfer · glow: tyre slip', 12, H - 14);
  }

  return { id: 'chassis', title: 'Chassis', color: '#ff9900', el: root, charts: [], animated: true, update };
}
