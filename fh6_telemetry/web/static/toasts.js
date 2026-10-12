// Toast notifications ("achievement unlocked", records, drift scores …).
//   emit('toast', { icon, title, text, rarity, ms })        (via bus.js)
// Rare unlocks also ask the FX layer for confetti.

import { emit, on } from './bus.js';

const RARITY_MS = { common: 3200, rare: 4200, epic: 5200, legendary: 6500 };
const MAX_VISIBLE = 4;

export function initToasts(root) {
  on('toast', (t) => show(root, t));
}

function show(root, t) {
  if (!root || !t) return;
  const rarity = ['common', 'rare', 'epic', 'legendary'].includes(t.rarity) ? t.rarity : 'common';
  const el = document.createElement('div');
  el.className = `toast toast-${rarity}`;
  const icon = document.createElement('div'); icon.className = 'toast-icon'; icon.textContent = t.icon || '🏁';
  const body = document.createElement('div'); body.className = 'toast-body';
  const title = document.createElement('div'); title.className = 'toast-title'; title.textContent = t.title || '';
  const text = document.createElement('div'); text.className = 'toast-text'; text.textContent = t.text || '';
  body.append(title, text);
  el.append(icon, body);
  root.appendChild(el);
  while (root.children.length > MAX_VISIBLE) root.firstChild.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  const ms = t.ms || RARITY_MS[rarity];
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, ms);
  if (rarity === 'epic' || rarity === 'legendary') emit('confetti', { n: rarity === 'legendary' ? 160 : 90 });
}
