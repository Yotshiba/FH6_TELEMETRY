"""
Crash hardening: log unhandled exceptions to a file instead of aborting.

PyQt6 calls ``qFatal()`` (aborting the process, silently in the windowed exe)
when a Python exception escapes a slot or a timer callback while the default
``sys.excepthook`` is in place.  Installing our own hook turns that into a log
line so one bad frame can no longer kill the dashboard.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import traceback
from pathlib import Path

_MAX_LOG_BYTES = 512 * 1024
_RATE_LIMIT_S = 30.0
_UNHANDLED_RATE_S = 5.0
_MAX_KEYS = 256

_lock = threading.Lock()
_last_logged: dict[str, float] = {}
_log_path: Path | None = None


def data_dir() -> Path:
    """Per-user directory for logs (``%LOCALAPPDATA%\\FH6Telemetry``)."""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_STATE_HOME")
    root = Path(base) if base else Path.home() / ".local" / "state"
    return root / "FH6Telemetry"


def ensure_std_streams() -> None:
    """A windowed (``console=False``) exe has ``sys.stdout/stderr = None``.

    ``print``, ``logging`` handlers and ``http.server`` all write to them and
    would raise, so give them a harmless sink.
    """
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))


def log_path() -> Path:
    return _log_path or data_dir() / "error.log"


def log_exception(
    where: str,
    exc: BaseException | None = None,
    *,
    rate_limit: bool = True,
    interval: float = _RATE_LIMIT_S,
) -> bool:
    """Append *exc* (default: the exception being handled) to the error log.

    Identical errors from the same place are logged at most once every 30 s so
    a per-frame failure can't flood the disk at 75 packets/s.  Returns whether
    a line was written.  Never raises.
    """
    try:
        if exc is None:
            exc = sys.exc_info()[1]
        if exc is None:
            return False
        # Key on *where it was raised*, not on the message: a message that embeds
        # a changing number must not defeat the limiter.
        tb = exc.__traceback__
        while tb is not None and tb.tb_next is not None:
            tb = tb.tb_next
        site = f"{tb.tb_frame.f_code.co_filename}:{tb.tb_lineno}" if tb is not None else "?"
        key = f"{where}|{type(exc).__name__}|{site}"
        now = time.monotonic()
        with _lock:
            if rate_limit and now - _last_logged.get(key, -1e9) < interval:
                return False
            if len(_last_logged) >= _MAX_KEYS:
                _last_logged.clear()
            _last_logged[key] = now
            path = log_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if path.exists() and path.stat().st_size > _MAX_LOG_BYTES:
                    path.replace(path.with_suffix(".log.1"))
            except OSError:
                pass
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(f"[{stamp}] {where}\n{tb}\n")
        return True
    except Exception:  # logging must never take the app down
        return False


def install_excepthook(path: Path | None = None) -> None:
    """Route unhandled exceptions (main thread and worker threads) to the log."""
    global _log_path
    if path is not None:
        _log_path = Path(path)
    ensure_std_streams()
    previous = sys.excepthook

    def _hook(exc_type, exc, tb):
        if issubclass(exc_type, KeyboardInterrupt):
            previous(exc_type, exc, tb)
            return
        if exc is not None and exc.__traceback__ is None:
            exc = exc.with_traceback(tb)
        # Rate-limited: a paintEvent that raises on every repaint must not flood the disk.
        log_exception("unhandled exception", exc, interval=_UNHANDLED_RATE_S)
        try:                                   # console / headless runs keep their traceback
            if sys.stderr is not None and sys.stderr.isatty():
                previous(exc_type, exc, tb)
        except Exception:
            pass

    def _thread_hook(args):
        if args.exc_value is not None:
            log_exception(f"thread {getattr(args.thread, 'name', '?')}", args.exc_value)

    sys.excepthook = _hook
    threading.excepthook = _thread_hook
