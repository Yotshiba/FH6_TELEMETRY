// Share code for cockpit layouts: a short text a friend can paste into their dashboard (or scan as a QR code).
//
//     FH6-<base64url of: version, flags, [count, count x (type, x, y, w, h)] per orientation, CRC-8>
//
// Compact (5 bytes per gauge) so the whole dash fits a QR code, and checked (version + CRC-8), so a truncated or
// mistyped code is refused instead of silently producing a strange dash.  The numeric gauge codes below are part
// of the format: NEVER renumber or reuse one (a golden test pins them).

import { MAX_WIDGETS, WIDGET_TYPES, sanitizeLayout } from './cockpit_layout.js';

export const SHARE_PREFIX = 'FH6-';
const FORMAT_VERSION = 1;

/** Stable numeric code of every gauge type. Append only. */
export const TYPE_CODES = Object.freeze({
  speedo: 1, tacho: 2, speed_digital: 3, rpm_digital: 4, gear: 5, shift_lights: 6, wheel: 7, brake: 8, throttle: 9,
  clutch: 10, fuel: 11, boost: 12, power: 13, tyres: 14, delta: 15, laptime: 16, gforce: 17, compass: 18,
  speed_trace: 19, drift: 20,
});
const TYPE_BY_CODE = Object.freeze(Object.fromEntries(Object.entries(TYPE_CODES).map(([t, c]) => [c, t])));

function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(text) {
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The share code for a pair of layouts ({ landscape, portrait }, each an array of gauges or null/undefined for
 * "not included").  Returns '' when there is nothing to share.
 */
export function encodeShare({ landscape, portrait } = {}) {
  const parts = [[landscape, 'landscape', 1], [portrait, 'portrait', 2]];
  const bytes = [FORMAT_VERSION, 0];
  for (const [layout, orient, bit] of parts) {
    const clean = sanitizeLayout(layout, orient);
    if (!clean) continue;
    bytes[1] |= bit;
    bytes.push(clean.length);
    for (const w of clean) bytes.push(TYPE_CODES[w.type], w.x, w.y, w.w, w.h);
  }
  if (!bytes[1]) return '';
  bytes.push(crc8(bytes));
  return SHARE_PREFIX + b64url(bytes);
}

/**
 * Read a share code out of text: the bare code, a link containing it (`...?cockpit=FH6-...`) or any text that has it
 * in it.  Returns { ok: true, landscape, portrait } (each a sanitised array, or null when the code did not include
 * that orientation) or { ok: false, error }.
 */
export function decodeShare(text) {
  const src = String(text || '');
  let m = /FH6-[A-Za-z0-9_-]+/.exec(src);
  let res = m ? decodeCode(m[0]) : null;
  if ((!res || !res.ok) && /\s/.test(src)) {            // a code pasted from a wrapped message: join the lines and retry
    const joined = /FH6-[A-Za-z0-9_-]+/.exec(src.replace(/\s+/g, ''));
    if (joined) {
      const again = decodeCode(joined[0]);
      if (again.ok || !res) res = again;
    }
  }
  return res || { ok: false, error: 'That does not look like a cockpit code (it should start with FH6-).' };
}

function decodeCode(code) {
  let bytes;
  try { bytes = fromB64url(code.slice(SHARE_PREFIX.length)); } catch { return { ok: false, error: 'The code is damaged: some characters are wrong.' }; }
  if (bytes.length < 4) return { ok: false, error: 'The code is too short: was it cut off?' };
  if (bytes[bytes.length - 1] !== crc8(bytes.subarray(0, bytes.length - 1))) {
    return { ok: false, error: 'The code is damaged or cut off (its checksum does not match).' };
  }
  if (bytes[0] !== FORMAT_VERSION) return { ok: false, error: 'This code comes from a newer version of the dashboard.' };
  const flags = bytes[1];
  if (!(flags & 3) || flags & ~3) return { ok: false, error: 'The code does not contain a layout.' };
  let pos = 2;
  const out = { ok: true, landscape: null, portrait: null };
  for (const [orient, bit] of [['landscape', 1], ['portrait', 2]]) {
    if (!(flags & bit)) continue;
    const n = bytes[pos++];
    if (n > MAX_WIDGETS || pos + n * 5 > bytes.length - 1) return { ok: false, error: 'The code is damaged (bad length).' };
    const raw = [];
    for (let i = 0; i < n; i++, pos += 5) {
      const type = TYPE_BY_CODE[bytes[pos]];
      if (type && WIDGET_TYPES[type]) raw.push({ type, x: bytes[pos + 1], y: bytes[pos + 2], w: bytes[pos + 3], h: bytes[pos + 4] });
    }
    out[orient] = sanitizeLayout(raw, orient);
  }
  if (pos !== bytes.length - 1) return { ok: false, error: 'The code is damaged (extra data).' };
  return out;
}

/** The link that opens the dashboard and offers the layout: <origin>/?cockpit=<code> (short: it goes in a QR code). */
export function shareLink(origin, code) {
  return `${String(origin).replace(/\/+$/, '')}/?cockpit=${code}`;
}
