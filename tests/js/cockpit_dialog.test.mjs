// The Layouts dialog (save / load / delete / share / import), the clipboard helper and the address resolver,
// against the stub DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutsDialog, BACKUP_NAME } from '../../fh6_telemetry/web/static/cockpit_dialog.js';
import { PRESET_MAX, defaultLayout, layoutsEqual, upsertPreset } from '../../fh6_telemetry/web/static/cockpit_layout.js';
import { decodeShare, encodeShare, shareLink } from '../../fh6_telemetry/web/static/cockpit_share.js';
import { copyText } from '../../fh6_telemetry/web/static/clipboard.js';
import { isLoopbackHost, qrSrc, resolveShareOrigin } from '../../fh6_telemetry/web/static/share_origin.js';
import { Settings } from '../../fh6_telemetry/web/static/settings.js';
import { fireWindow, installDom, removeDom } from './helpers/stubdom.mjs';

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const L = () => defaultLayout('landscape');
const P = () => defaultLayout('portrait');
const ORIGIN = 'http://192.168.1.101:8077';

/** A dialog wired to a fake "dash": `state` is what is on screen, `applied` records every apply(). */
function setup({ getOrigin = async () => ORIGIN, state } = {}) {
  installDom();
  const settings = new Settings(memoryStorage());
  const dash = { state: state || { landscape: L(), portrait: P() }, applied: [], toasts: [] };
  const dialog = buildLayoutsDialog({
    settings,
    snapshot: () => dash.state,
    apply: (l) => { dash.state = { landscape: l.landscape, portrait: l.portrait }; dash.applied.push(l); },
    notify: (t) => dash.toasts.push(t),
    getOrigin,
  });
  const q = (pred) => dialog.el.find(pred);
  const button = (text) => q((c) => c.tag === 'button' && c.textContent === text);
  const ui = {
    list: q((c) => c.className === 'lay-list'),
    name: q((c) => c.tag === 'input'),
    share: q((c) => c.className === 'lay-code' && c.readOnly),
    importBox: q((c) => c.className === 'lay-code' && !c.readOnly),
    qr: q((c) => c.tag === 'img'),
    rows: () => ui.list.children.filter((c) => c.className.includes('lay-item')),
  };
  return { dialog, settings, dash, ui, button, q };
}
const presets = (s) => s.get('cockpit.presets');
const tick = () => new Promise((r) => setImmediate(r));

test('opening shows the share code of what is on the dash and a QR code of the link', async () => {
  const t = setup();
  try {
    assert.equal(t.dialog.el.style.display, 'none');
    await t.dialog.open();
    assert.equal(t.dialog.el.style.display, '');
    assert.equal(t.dialog.isOpen, true);
    const code = encodeShare(t.dash.state);
    assert.equal(t.ui.share.value, code);
    assert.equal(t.ui.qr.src, qrSrc(shareLink(ORIGIN, code)));
    assert.equal(t.ui.qr.style.display, '');
    assert.match(t.ui.list.children[0].textContent, /Nothing saved yet/);
    assert.equal(decodeShare(t.ui.share.value).ok, true);
  } finally { removeDom(); }
});

test('if the PC address cannot be found the code is still offered, just without a QR code', async () => {
  const t = setup({ getOrigin: async () => { throw new Error('offline'); } });
  try {
    await t.dialog.open();
    assert.equal(t.ui.share.value, encodeShare(t.dash.state));
    assert.equal(t.ui.qr.style.display, 'none');
  } finally { removeDom(); }
});

test('a layout too big for a QR code hides the image and says why', async () => {
  const t = setup();
  try {
    await t.dialog.open();
    t.ui.qr.onerror();                                                // the server answered 413
    assert.equal(t.ui.qr.style.display, 'none');
    assert.match(t.q((c) => c.className.includes('lay-msg') && /too big/.test(c.textContent)).textContent, /copy the code or link/);
  } finally { removeDom(); }
});

test('Save current: stores both orientations under the name, replaces a same-named one, refuses empty names', async () => {
  const t = setup();
  try {
    await t.dialog.open();
    t.button('Save current').fire('click');
    assert.equal(presets(t.settings).length, 0, 'no name, nothing saved');
    t.ui.name.value = '  Race  ';
    t.button('Save current').fire('click');
    assert.equal(presets(t.settings).length, 1);
    assert.equal(presets(t.settings)[0].name, 'Race');
    assert.ok(layoutsEqual(presets(t.settings)[0].landscape, L()) && layoutsEqual(presets(t.settings)[0].portrait, P()));
    assert.equal(t.ui.name.value, '', 'the field is cleared');
    assert.equal(t.ui.rows().length, 1);
    t.dash.state = { landscape: [], portrait: P() };
    t.ui.name.value = 'race';                                         // same name, any case: replaced
    t.ui.name.fire('keydown', { key: 'Enter' });                      // Enter saves too
    assert.equal(presets(t.settings).length, 1);
    assert.deepEqual(presets(t.settings)[0].landscape, []);
    // a full list refuses a new name
    for (let i = 0; i < PRESET_MAX; i++) t.settings.set('cockpit.presets', upsertPreset(presets(t.settings), `p${i}`, null, null) || presets(t.settings));
    assert.equal(presets(t.settings).length, PRESET_MAX);
    t.ui.name.value = 'one too many';
    t.button('Save current').fire('click');
    assert.equal(presets(t.settings).some((p) => p.name === 'one too many'), false);
  } finally { removeDom(); }
});

test('Load puts the saved layouts on the dash after backing up the current ones; null layouts mean factory', async () => {
  const t = setup();
  try {
    t.settings.set('cockpit.presets', upsertPreset([], 'Drift', [{ id: 'gear', type: 'gear', x: 0, y: 0, w: 6, h: 6 }], null));
    t.dash.state = { landscape: L(), portrait: [{ id: 'fuel', type: 'fuel', x: 1, y: 1, w: 5, h: 2 }] };
    await t.dialog.open();
    t.ui.rows()[0].children.find((c) => c.textContent === 'Load').fire('click');
    assert.equal(t.dash.applied.length, 1);
    assert.deepEqual(t.dash.state.landscape.map((x) => x.id), ['gear']);
    assert.ok(layoutsEqual(t.dash.state.portrait, P()), 'null in the preset = the factory portrait layout');
    const backup = presets(t.settings).find((p) => p.name === BACKUP_NAME);
    assert.ok(backup, 'the previous dash was saved');
    assert.ok(layoutsEqual(backup.landscape, L()) && backup.portrait.length === 1);
    assert.ok(t.dash.toasts.some((x) => /Loaded/.test(x.title)));
    // loading the backup brings the old dash back and does NOT overwrite the backup itself
    const before = JSON.stringify(backup);
    t.ui.rows().find((r) => r.children[0].textContent === BACKUP_NAME).children.find((c) => c.textContent === 'Load').fire('click');
    assert.ok(layoutsEqual(t.dash.state.landscape, L()));
    assert.equal(JSON.stringify(presets(t.settings).find((p) => p.name === BACKUP_NAME)), before);
  } finally { removeDom(); }
});

test('Load of a layout identical to the current one makes no backup; Delete removes the row', async () => {
  const t = setup();
  try {
    t.settings.set('cockpit.presets', upsertPreset([], 'Same', L(), P()));
    await t.dialog.open();
    t.ui.rows()[0].children.find((c) => c.textContent === 'Load').fire('click');
    assert.equal(presets(t.settings).some((p) => p.name === BACKUP_NAME), false);
    t.ui.rows()[0].children.find((c) => c.textContent === '✕').fire('click');
    assert.equal(presets(t.settings).length, 0);
    assert.equal(t.ui.rows().length, 0);
    assert.match(t.ui.list.children[0].textContent, /Nothing saved yet/);
  } finally { removeDom(); }
});

test('Import: a valid code is applied (previous dash backed up), a one-orientation code keeps the other', async () => {
  const customPortrait = [{ id: 'fuel', type: 'fuel', x: 2, y: 3, w: 6, h: 2 }];
  const t = setup({ state: { landscape: L(), portrait: customPortrait } });
  try {
    await t.dialog.open();
    const mine = [{ id: 'gear', type: 'gear', x: 4, y: 4, w: 8, h: 8 }, { id: 'tyres', type: 'tyres', x: 20, y: 4, w: 8, h: 6 }];
    t.ui.importBox.value = shareLink(ORIGIN, encodeShare({ landscape: mine }));            // a whole link works
    t.button('Import').fire('click');
    assert.equal(t.dash.applied.length, 1);
    assert.deepEqual(t.dash.state.landscape.map((x) => [x.type, x.x, x.y, x.w, x.h]), mine.map((x) => [x.type, x.x, x.y, x.w, x.h]));
    assert.deepEqual(t.dash.state.portrait, customPortrait, 'portrait was not in the code: unchanged (not reset to the factory one)');
    assert.ok(layoutsEqual(presets(t.settings).find((p) => p.name === BACKUP_NAME).landscape, L()));
    assert.equal(t.ui.importBox.value, '');
    assert.match(t.q((c) => c.className.includes('lay-msg') && /Imported/.test(c.textContent)).textContent, /landscape layout/);
    assert.equal(t.ui.share.value, encodeShare(t.dash.state), 'the share box follows the new dash');
    // importing what is already there is a no-op
    t.ui.importBox.value = encodeShare(t.dash.state);
    t.button('Import').fire('click');
    assert.equal(t.dash.applied.length, 1);
  } finally { removeDom(); }
});

test('Import: bad codes explain themselves and change nothing', async () => {
  const t = setup();
  try {
    await t.dialog.open();
    const good = encodeShare({ landscape: L(), portrait: P() });
    for (const bad of ['', 'hello', good.slice(0, 40), 'FH6-AQ']) {
      t.ui.importBox.value = bad;
      t.button('Import').fire('click');
    }
    assert.equal(t.dash.applied.length, 0);
    assert.equal(presets(t.settings).length, 0, 'no backup for a failed import');
    const msg = t.q((c) => c.className.includes('lay-msg') && c.className.includes('bad'));
    assert.ok(msg && msg.textContent.length > 10);
  } finally { removeDom(); }
});

test('opening from a shared link fills the import box and invites the user to press Import', async () => {
  const t = setup();
  try {
    const code = encodeShare({ landscape: [] });
    await t.dialog.open({ importText: code });
    assert.equal(t.ui.importBox.value, code);
    assert.ok(t.q((c) => c.className.includes('lay-msg') && /press Import/.test(c.textContent)));
    assert.equal(t.dash.applied.length, 0, 'nothing is applied until the user agrees');
  } finally { removeDom(); }
});

test('a full list of saved layouts still imports, with a warning that no backup was made', async () => {
  const t = setup();
  try {
    let full = [];
    for (let i = 0; i < PRESET_MAX; i++) full = upsertPreset(full, `p${i}`, null, null);
    t.settings.set('cockpit.presets', full);
    await t.dialog.open();
    t.ui.importBox.value = encodeShare({ landscape: [] });
    t.button('Import').fire('click');
    assert.equal(t.dash.applied.length, 1);
    assert.equal(presets(t.settings).some((p) => p.name === BACKUP_NAME), false);
    assert.ok(t.dash.toasts.some((x) => /No room for a backup/.test(x.title)));
  } finally { removeDom(); }
});

test('Escape, the close button and a tap outside the card all close it', async () => {
  const t = setup();
  try {
    await t.dialog.open();
    fireWindow('keydown', { key: 'Escape' });
    assert.equal(t.dialog.isOpen, false);
    assert.equal(t.dialog.el.style.display, 'none');
    await t.dialog.open();
    t.button('✕').fire('click');
    assert.equal(t.dialog.isOpen, false);
    await t.dialog.open();
    t.dialog.el.fire('pointerdown', { target: t.dialog.el });
    assert.equal(t.dialog.isOpen, false);
    await t.dialog.open();
    t.dialog.el.fire('pointerdown', { target: t.ui.share });          // a tap inside the card does not
    assert.equal(t.dialog.isOpen, true);
    fireWindow('keydown', { key: 'a' });
    assert.equal(t.dialog.isOpen, true);
  } finally { removeDom(); }
});

test('Copy code / Copy link: uses the clipboard fallback and says whether it worked', async () => {
  const t = setup();
  try {
    await t.dialog.open();
    const copied = [];
    globalThis.document.execCommand = (cmd) => { copied.push([cmd, t.ui.share.value]); return true; };
    t.button('Copy code').fire('click');
    await tick(); await tick();
    assert.deepEqual(copied.at(-1), ['copy', encodeShare(t.dash.state)]);
    assert.ok(t.q((c) => c.className.includes('lay-msg') && /Code copied/.test(c.textContent)));
    t.button('Copy link').fire('click');
    await tick(); await tick();
    assert.equal(copied.at(-1)[1], shareLink(ORIGIN, encodeShare(t.dash.state)));
    globalThis.document.execCommand = () => false;
    t.button('Copy code').fire('click');
    await tick(); await tick();
    assert.ok(t.q((c) => c.className.includes('lay-msg') && /press Ctrl\+C/.test(c.textContent)));
  } finally { removeDom(); }
});

// ---- clipboard ---------------------------------------------------------------------------------------------------------------

test('copyText prefers the clipboard API in a secure context and falls back to selecting + execCommand', async () => {
  installDom();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    const written = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (x) => { written.push(x); } } }, configurable: true });
    globalThis.isSecureContext = true;
    assert.equal(await copyText('abc'), true);
    assert.deepEqual(written, ['abc']);
    // API present but refusing: the fallback runs
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, configurable: true });
    const box = { value: '', selected: false, focus() {}, select() { this.selected = true; }, setSelectionRange() {} };
    globalThis.document.execCommand = () => box.selected;
    assert.equal(await copyText('hello', box), true);
    assert.equal(box.value, 'hello');
    // plain http (not a secure context): never touches the API
    globalThis.isSecureContext = false;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('must not be called'); } } }, configurable: true });
    box.selected = false;
    assert.equal(await copyText('x', box), true);
    globalThis.document.execCommand = () => false;
    assert.equal(await copyText('x', box), false, 'reports failure so the UI can ask for Ctrl+C');
    globalThis.document.execCommand = () => { throw new Error('boom'); };
    assert.equal(await copyText('x', box), false);
  } finally {
    delete globalThis.isSecureContext;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    removeDom();
  }
});

// ---- address resolver ------------------------------------------------------------------------------------------------------

test('isLoopbackHost and qrSrc', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', '']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['192.168.1.101', 'pc.local', '10.0.0.5']) assert.equal(isLoopbackHost(h), false, h);
  assert.equal(qrSrc('http://a/?x=1&y=2'), '/api/qr.svg?d=http%3A%2F%2Fa%2F%3Fx%3D1%26y%3D2');
});

test('resolveShareOrigin: the page origin when it is a LAN address, the server\'s answer when on localhost', async () => {
  const never = async () => { throw new Error('must not ask the server'); };
  assert.equal(await resolveShareOrigin({ origin: 'http://192.168.1.101:8077', hostname: '192.168.1.101' }, never), 'http://192.168.1.101:8077');
  const asked = [];
  const server = async (url) => { asked.push(url); return { urls: ['http://192.168.1.101:8077/', 'http://10.0.0.5:8077/'] }; };
  assert.equal(await resolveShareOrigin({ origin: 'http://localhost:8077', hostname: 'localhost' }, server), 'http://192.168.1.101:8077');
  assert.deepEqual(asked, ['/api/urls']);
  assert.equal(await resolveShareOrigin({ origin: 'http://127.0.0.1:8077', hostname: '127.0.0.1' }, async () => ({ urls: ['javascript:alert(1)', 'ftp://x/', 'http://10.1.1.1:8077/'] })), 'http://10.1.1.1:8077', 'only http(s) addresses are trusted');
  // the server cannot help: fall back to our own origin (may be loopback)
  assert.equal(await resolveShareOrigin({ origin: 'http://localhost:8077', hostname: 'localhost' }, never), 'http://localhost:8077');
  assert.equal(await resolveShareOrigin({ origin: 'http://localhost:8077', hostname: 'localhost' }, async () => ({ urls: [] })), 'http://localhost:8077');
  assert.equal(await resolveShareOrigin({ origin: 'http://localhost:8077', hostname: 'localhost' }, async () => null), 'http://localhost:8077');
  assert.equal(await resolveShareOrigin(undefined, never), '', 'no location at all');
  assert.equal(await resolveShareOrigin({ origin: 'null', hostname: '' }, never), '');
});
