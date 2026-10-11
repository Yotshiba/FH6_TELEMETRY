"""Diagnostics: errors are logged (rate-limited) and never raised."""

from __future__ import annotations

import sys
import threading

from fh6_telemetry.core import diagnostics


def test_log_exception_writes_once_per_30s(tmp_path, monkeypatch):
    log = tmp_path / "error.log"
    monkeypatch.setattr(diagnostics, "_log_path", log)
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    try:
        raise ValueError("bad frame")
    except ValueError as exc:
        assert diagnostics.log_exception("unit", exc) is True
        assert diagnostics.log_exception("unit", exc) is False        # rate limited
        assert diagnostics.log_exception("unit", exc, rate_limit=False) is True
    text = log.read_text(encoding="utf-8")
    assert "ValueError: bad frame" in text and text.count("bad frame") >= 2


def test_log_exception_without_active_exception_is_a_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    assert diagnostics.log_exception("nothing") is False


def test_excepthooks_route_to_the_log(tmp_path, monkeypatch):
    log = tmp_path / "e.log"
    monkeypatch.setattr(diagnostics, "_log_path", None)
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    old_hook, old_thook = sys.excepthook, threading.excepthook
    try:
        diagnostics.install_excepthook(log)
        try:
            raise RuntimeError("in main")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())

        def worker():
            raise KeyError("in thread")

        t = threading.Thread(target=worker)
        t.start()
        t.join()
    finally:
        sys.excepthook, threading.excepthook = old_hook, old_thook
    text = log.read_text(encoding="utf-8")
    assert "in main" in text and "in thread" in text


def test_ensure_std_streams_replaces_none(monkeypatch):
    monkeypatch.setattr(sys, "stderr", None)
    diagnostics.ensure_std_streams()
    assert sys.stderr is not None
    sys.stderr.write("ok")   # must not raise
