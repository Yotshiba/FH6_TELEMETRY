// Copy text to the clipboard.  The modern API only exists in a secure context (https or localhost), which a page
// opened as http://192.168.x.x is NOT, so there is a fallback through a selected text box and the old execCommand.

/**
 * Copy `text`. `fallbackEl` (a textarea / input already on the page) is selected for the fallback and left
 * selected, so if copying is refused the user can simply press Ctrl+C.  Resolves to true when the text was copied.
 */
export async function copyText(text, fallbackEl) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && globalThis.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* denied or unavailable: use the fallback */ }
  const el = fallbackEl || makeTemp(text);
  try {
    if (fallbackEl) fallbackEl.value = text;
    el.focus && el.focus();
    el.select && el.select();
    if (el.setSelectionRange) el.setSelectionRange(0, String(text).length);
    const ok = typeof document !== 'undefined' && typeof document.execCommand === 'function' && document.execCommand('copy');
    return !!ok;
  } catch {
    return false;
  } finally {
    if (!fallbackEl && el.remove) el.remove();
  }
}

function makeTemp(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  return ta;
}
