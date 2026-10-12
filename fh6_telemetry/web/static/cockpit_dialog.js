// The "Layouts" dialog of the cockpit: keep several dashes by name, share the current one (code, link and a QR code
// a second phone can scan) and import one somebody else sent.
//
// The dialog knows nothing about the cockpit view: it is handed
//   snapshot()                 -> { landscape, portrait }  the layouts as they are now
//   apply({landscape,portrait}) put these layouts on the dash
//   notify(toast)              show a toast
// so the view stays in charge of edit mode, undo and persistence.

import { copyText } from './clipboard.js';
import { PRESET_MAX, PRESET_NAME_MAX, cleanPresetName, defaultLayout, deletePreset, layoutsEqual, upsertPreset } from './cockpit_layout.js';
import { decodeShare, encodeShare, shareLink } from './cockpit_share.js';
import { qrSrc, resolveShareOrigin } from './share_origin.js';

/** The preset made automatically before a load / import replaces the dash, so a mistake is one tap to undo. */
export const BACKUP_NAME = 'Before last change';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const same = (a, b) => layoutsEqual(a.landscape, b.landscape) && layoutsEqual(a.portrait, b.portrait);

export function buildLayoutsDialog({ settings, snapshot, apply, notify, getOrigin = resolveShareOrigin }) {
  const el = h('div', 'layouts-dialog');
  el.style.display = 'none';
  const card = h('div', 'lay-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Cockpit layouts');
  el.appendChild(card);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });          // a tap outside the card closes it

  const head = h('div', 'lay-head');
  const closeBtn = h('button', 'chip', '✕'); closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => close());
  head.append(h('div', 'lay-title', 'Cockpit layouts'), closeBtn);

  // ---- saved layouts ---------------------------------------------------------------------------------------------------
  const saved = h('section', 'lay-sec');
  saved.appendChild(h('h4', null, 'Saved layouts'));
  const list = h('div', 'lay-list');
  const nameInput = h('input', 'lay-input');
  nameInput.type = 'text'; nameInput.maxLength = PRESET_NAME_MAX; nameInput.placeholder = 'Name this dash (e.g. Race, Drift)';
  const saveBtn = h('button', 'chip on', 'Save current');
  const saveRow = h('div', 'lay-row');
  saveRow.append(nameInput, saveBtn);
  const savedMsg = h('div', 'lay-msg');
  saved.append(list, saveRow, savedMsg);

  // ---- share ---------------------------------------------------------------------------------------------------------------
  const share = h('section', 'lay-sec');
  share.appendChild(h('h4', null, 'Share this cockpit'));
  const shareBody = h('div', 'lay-share');
  const qrImg = h('img', 'lay-qr');
  qrImg.alt = 'QR code of the cockpit link'; qrImg.width = 200; qrImg.height = 200;
  qrImg.style.display = 'none';
  const shareSide = h('div', 'lay-share-side');
  const codeBox = h('textarea', 'lay-code');
  codeBox.readOnly = true; codeBox.rows = 3; codeBox.setAttribute('aria-label', 'Share code');
  const copyCode = h('button', 'chip', 'Copy code');
  const copyLink = h('button', 'chip', 'Copy link');
  const shareBtns = h('div', 'lay-row');
  shareBtns.append(copyCode, copyLink);
  const shareNote = h('div', 'lay-msg', '');
  shareSide.append(codeBox, shareBtns, shareNote);
  shareBody.append(qrImg, shareSide);
  share.appendChild(shareBody);

  // ---- import --------------------------------------------------------------------------------------------------------------
  const imp = h('section', 'lay-sec');
  imp.appendChild(h('h4', null, 'Import a cockpit'));
  const impBox = h('textarea', 'lay-code');
  impBox.rows = 2; impBox.placeholder = 'Paste a code (FH6-…) or a link here'; impBox.setAttribute('aria-label', 'Code or link to import');
  const impBtn = h('button', 'chip on', 'Import');
  const impMsg = h('div', 'lay-msg');
  const impRow = h('div', 'lay-row');
  impRow.append(impBtn);
  imp.append(impBox, impRow, impMsg);

  card.append(head, saved, share, imp);

  // ---- state -----------------------------------------------------------------------------------------------------------------
  let isOpen = false;
  let origin = '';
  let linkText = '';

  const presets = () => settings.get('cockpit.presets') || [];
  const say = (node, text, bad = false) => { node.textContent = text; node.classList.toggle('bad', !!bad); };

  /** Keep what is on the dash now as the "Before last change" preset (never silently deleting another one). */
  function backup() {
    const cur = snapshot();
    const next = upsertPreset(presets(), BACKUP_NAME, cur.landscape, cur.portrait);
    if (next) { settings.set('cockpit.presets', next); return true; }
    notify({ icon: '💾', title: 'No room for a backup', text: `You have ${PRESET_MAX} saved layouts: delete one to keep a backup of your current dash`, rarity: 'common', ms: 4500 });
    return false;
  }

  function renderList() {
    list.textContent = '';                                   // (removes the old rows)
    const items = presets();
    if (!items.length) {
      list.appendChild(h('div', 'lay-empty', 'Nothing saved yet. Arrange your dash, name it below and tap Save.'));
    }
    for (const p of items) {
      const row = h('div', 'lay-row lay-item');
      row.appendChild(h('span', 'lay-name', p.name));
      const load = h('button', 'chip', 'Load'); load.title = `Put “${p.name}” on the dash`;
      load.addEventListener('click', () => loadPreset(p.name));
      const del = h('button', 'chip', '✕'); del.title = `Delete “${p.name}”`;
      del.addEventListener('click', () => {
        settings.set('cockpit.presets', deletePreset(presets(), p.name));
        say(savedMsg, `Deleted “${p.name}”.`);
        renderList();
      });
      row.append(load, del);
      list.appendChild(row);
    }
  }

  function loadPreset(name) {
    const p = presets().find((x) => x.name === name);
    if (!p) return;
    const next = { landscape: p.landscape || defaultLayout('landscape'), portrait: p.portrait || defaultLayout('portrait') };
    if (!same(next, snapshot()) && name !== BACKUP_NAME) backup();
    apply(next);
    renderList();
    renderShare();
    say(savedMsg, `Loaded “${p.name}”.`);
    notify({ icon: '🎛️', title: `Loaded “${p.name}”`, text: 'Your previous layout is under “' + BACKUP_NAME + '”', rarity: 'common', ms: 3000 });
  }

  function saveCurrent() {
    const name = cleanPresetName(nameInput.value);
    if (!name) { say(savedMsg, 'Type a name first.', true); return; }
    const cur = snapshot();
    const next = upsertPreset(presets(), name, cur.landscape, cur.portrait);
    if (!next) { say(savedMsg, `You can keep ${PRESET_MAX} saved layouts: delete one first.`, true); return; }
    settings.set('cockpit.presets', next);
    nameInput.value = '';
    say(savedMsg, `Saved “${name}”.`);
    renderList();
  }

  function renderShare() {
    const cur = snapshot();
    const code = encodeShare(cur);
    codeBox.value = code;
    linkText = origin ? shareLink(origin, code) : code;
    if (!origin || !code) { qrImg.style.display = 'none'; say(shareNote, origin ? '' : 'Looking for this PC’s address…'); return; }
    say(shareNote, 'Scan with a phone on the same Wi-Fi to load this cockpit there, or send the code to a friend.');
    qrImg.onerror = () => { qrImg.style.display = 'none'; say(shareNote, 'This layout is too big for a QR code: copy the code or link instead.'); };
    qrImg.onload = () => { qrImg.style.display = ''; };
    qrImg.src = qrSrc(linkText);
    qrImg.style.display = '';
  }

  async function doCopy(text, what) {
    const ok = await copyText(text, codeBox);
    say(shareNote, ok ? `${what} copied.` : `Couldn’t copy automatically: the text is selected, press Ctrl+C.`, !ok);
    return ok;
  }

  function importNow() {
    const res = decodeShare(impBox.value);
    if (!res.ok) { say(impMsg, res.error, true); return; }
    const cur = snapshot();
    const next = { landscape: res.landscape || cur.landscape, portrait: res.portrait || cur.portrait };
    if (same(next, cur)) { say(impMsg, 'That is the layout you already have.'); return; }
    backup();
    apply(next);
    impBox.value = '';
    renderList();
    renderShare();
    const what = res.landscape && res.portrait ? 'landscape and portrait layouts' : res.landscape ? 'landscape layout' : 'portrait layout';
    say(impMsg, `Imported the ${what}. Your previous dash is saved as “${BACKUP_NAME}”.`);
    notify({ icon: '📥', title: 'Cockpit imported', text: `Your previous layout is saved as “${BACKUP_NAME}”`, rarity: 'rare', ms: 3500 });
  }

  saveBtn.addEventListener('click', saveCurrent);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
  copyCode.addEventListener('click', () => doCopy(codeBox.value, 'Code'));
  copyLink.addEventListener('click', () => doCopy(linkText, 'Link'));
  impBtn.addEventListener('click', importNow);
  window.addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape') close(); });

  async function open({ importText } = {}) {
    isOpen = true;
    el.style.display = '';
    say(savedMsg, ''); say(impMsg, '');
    renderList();
    renderShare();
    if (importText) {
      impBox.value = importText;
      say(impMsg, 'A shared cockpit was opened: press Import to use it.');
    }
    if (!origin) {
      try { origin = await getOrigin(); } catch { origin = ''; }
      if (isOpen) renderShare();
    }
  }

  function close() { isOpen = false; el.style.display = 'none'; }

  return { el, open, close, get isOpen() { return isOpen; }, refresh: () => { renderList(); renderShare(); } };
}
