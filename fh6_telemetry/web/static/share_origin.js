// "Which address would another device use to reach this dashboard?"
//
// Opened as http://192.168.1.101:8077 the page's own origin is the answer.  Opened on the PC itself as
// http://localhost:8077 it is useless to a phone, so then ask the server (/api/urls) for the LAN address.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);

/** True for addresses that only work on this very machine. */
export function isLoopbackHost(hostname) {
  return LOOPBACK.has(String(hostname || '').toLowerCase());
}

/**
 * The origin ("http://192.168.1.101:8077", no trailing slash) to put in links and QR codes.
 * `loc` and `fetchJson` are injectable for tests; they default to the page's own.
 */
export async function resolveShareOrigin(loc = globalThis.location, fetchJson = defaultFetchJson) {
  const own = loc && loc.origin && loc.origin !== 'null' ? loc.origin : '';
  if (own && !isLoopbackHost(loc.hostname)) return own;
  try {
    const data = await fetchJson('/api/urls');
    const first = data && Array.isArray(data.urls) ? data.urls.find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : null;
    if (first) return first.replace(/\/+$/, '');
  } catch { /* offline / old server: fall back to our own origin */ }
  return own;
}

async function defaultFetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** The URL of the server-made QR code image for `text`. */
export function qrSrc(text) {
  return '/api/qr.svg?d=' + encodeURIComponent(text);
}
