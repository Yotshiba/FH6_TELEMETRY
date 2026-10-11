"""Regression tests for the concurrency/core review findings."""

from __future__ import annotations

import socket
import threading
import time

import pytest

from fh6_telemetry.core import diagnostics
from fh6_telemetry.core.config import DEFAULTS, Config
from fh6_telemetry.core.hub import TelemetryHub
from fh6_telemetry.core.udp_source import UdpBindError, UdpSource
from tests.conftest import free_udp_port
from tools.fake_forza import build_packet


def _pkt(i):
    return build_packet({"TimestampMS": i, "Speed": float(i), "IsRaceOn": 1})


def _wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


# ---- UdpSource ---------------------------------------------------------------

def test_an_oversized_datagram_does_not_kill_the_receive_thread():
    got = []
    src = UdpSource("127.0.0.1", 0, got.append)
    src.start()
    try:
        port = src.bound[1]
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.sendto(b"\x00" * 5000, ("127.0.0.1", port))      # > the old 4096-byte recv buffer
        s.sendto(_pkt(1), ("127.0.0.1", port))
        s.close()
        # (a datagram >= 324 bytes is accepted as before; what matters is the thread lives on)
        assert _wait(lambda: any(len(d) == 324 for d in got))
        assert src.running
    finally:
        src.stop()


@pytest.mark.parametrize("host,port", [("127.0.0.1", 70000), ("127.0.0.1", -1), ("not.an.ip", 20077)])
def test_invalid_address_or_port_is_a_bind_error_not_a_crash(host, port):
    src = UdpSource(host, port, lambda d: None)
    with pytest.raises(UdpBindError):
        src.start()
    assert not src.running


def test_a_hostname_is_reported_as_an_invalid_address():
    with pytest.raises(UdpBindError) as ei:
        UdpSource("no-such-host.invalid", 20077, lambda d: None).start()
    assert "not a valid IPv4 address" in str(ei.value)


# ---- hub ----------------------------------------------------------------------

def test_a_stale_source_cannot_publish_into_a_newer_session():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    old_token = hub._token
    base = hub.start("127.0.0.1", 0)                       # supersede it
    assert hub.ingest(_pkt(111), old_token) is False        # the slow old callback arrives late
    assert hub.seq == base
    live_token = hub._token
    assert hub.ingest(_pkt(222), live_token) is True
    hub.stop()
    assert hub.ingest(_pkt(333), live_token) is False       # stopped: its late frames are dropped


def test_history_and_cursors_never_include_an_earlier_session():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    for i in range(1, 6):
        hub.ingest(_pkt(i))
    base = hub.start("127.0.0.1", 0)
    assert hub.history() == []
    assert hub.frames_since(0) == (5, [], 0)                # an old cursor starts at the boundary
    hub.ingest(_pkt(6))
    assert [f["TimestampMS"] for f in hub.history()] == [6]
    assert [f["TimestampMS"] for f in hub.frames_since(0)[1]] == [6]
    assert hub.status().session_packets == 1 and base == 5
    hub.stop()


def test_session_is_published_before_the_first_packet_can_arrive():
    hub = TelemetryHub()
    seen = []

    def watcher():
        end = time.monotonic() + 3
        while time.monotonic() < end:
            st = hub.status()
            if hub.seq > 0:
                seen.append((st.session, st.state))
                return
            time.sleep(0.0005)

    hub.start("127.0.0.1", 0)
    port = hub.status().bound[1]
    hub.start("127.0.0.1", 0)
    port = hub.status().bound[1]
    t = threading.Thread(target=watcher)
    t.start()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(_pkt(1), ("127.0.0.1", port))
    s.close()
    t.join(5)
    assert seen and seen[0] == (2, "listening")
    hub.stop()


def test_a_failed_receive_loop_is_reported_as_an_error_state():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    hub._source.failure = "socket error: boom"
    st = hub.status()
    assert st.state == "error" and "boom" in st.error
    hub.stop()


# ---- config -------------------------------------------------------------------

def test_utf8_bom_config_is_read_not_discarded(tmp_path):
    p = tmp_path / "c.json"
    p.write_bytes(b"\xef\xbb\xbf" + b'{"udp_port": 20123}')
    assert Config.load(p)["udp_port"] == 20123


@pytest.mark.parametrize("payload", [
    "{}".encode("utf-16"), b"\xff\xfe\x00garbage\x80\x81", b"[" * 100_000,
], ids=["utf16", "binary-garbage", "deeply-nested"])
def test_undecodable_or_pathological_config_loads_as_defaults(tmp_path, payload):
    p = tmp_path / "c.json"
    p.write_bytes(payload)
    assert Config.load(p).values == DEFAULTS                # never raises


def test_hostname_in_config_is_rejected():
    cfg = Config()
    assert not cfg.set("udp_host", "some.host.lan")
    assert not cfg.set("udp_host", "127.1")
    assert cfg.set("udp_host", "192.168.1.5") and cfg.set("udp_host", "0.0.0.0")


def test_stale_tmp_files_are_swept_on_save(tmp_path):
    import os

    cfg = Config(tmp_path / "c.json")
    stale = tmp_path / "tmpabc.tmp"
    stale.write_text("x")
    old = time.time() - 3600
    os.utime(stale, (old, old))
    fresh = tmp_path / "tmpnew.tmp"
    fresh.write_text("x")                                   # maybe another saver's: kept
    assert cfg.save()
    assert not stale.exists() and fresh.exists()


# ---- diagnostics ---------------------------------------------------------------

def test_varying_messages_from_one_place_are_rate_limited(tmp_path, monkeypatch):
    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    written = 0
    for i in range(500):
        try:
            raise ValueError(f"bad value {i}")             # same line, different text
        except ValueError as exc:
            written += diagnostics.log_exception("loop", exc)
    assert written == 1


def test_the_limiter_table_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    for i in range(1000):
        try:
            raise ValueError("x")
        except ValueError as exc:
            diagnostics.log_exception(f"where-{i}", exc)
    assert len(diagnostics._last_logged) <= diagnostics._MAX_KEYS


def test_the_unhandled_hook_is_rate_limited_too(tmp_path, monkeypatch):
    import sys

    log = tmp_path / "e.log"
    monkeypatch.setattr(diagnostics, "_log_path", None)
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    old_hook, old_thook = sys.excepthook, threading.excepthook
    try:
        diagnostics.install_excepthook(log)
        for i in range(50):
            try:
                raise RuntimeError(f"paint {i}")
            except RuntimeError:
                sys.excepthook(*sys.exc_info())
    finally:
        sys.excepthook, threading.excepthook = old_hook, old_thook
    assert log.read_text(encoding="utf-8").count("RuntimeError") == 1 * 2 or log.read_text(encoding="utf-8").count("paint") <= 3


# ---- chart reset ----------------------------------------------------------------

def test_chart_reset_clears_the_drawn_lines(qapp):
    from fh6_telemetry.core.charts import CHARTS
    from fh6_telemetry.widgets.rolling_chart import RollingChart

    chart = RollingChart(CHARTS["motion_speed"])
    for i in range(20):
        chart.ingest({"SpeedKmh": float(i)})
    chart.refresh()
    assert len(chart._curves[0].getData()[1]) == 20
    chart.reset()
    xs, ys = chart._curves[0].getData()
    assert ys is None or len(ys) == 0
