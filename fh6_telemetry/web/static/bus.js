// A tiny publish/subscribe bus (the pieces of the UI stay decoupled).
//   emit('toast', {...})    on('settings', (detail) => ...)

const target = new EventTarget();

export function emit(type, detail) { target.dispatchEvent(new CustomEvent(type, { detail })); }

/** Subscribe; returns an unsubscribe function. */
export function on(type, fn) {
  const h = (e) => { try { fn(e.detail); } catch (err) { console.error(err); } };
  target.addEventListener(type, h);
  return () => target.removeEventListener(type, h);
}
