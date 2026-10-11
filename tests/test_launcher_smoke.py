"""Launcher + windows under Qt's offscreen platform: connect, tick, survive junk."""

from __future__ import annotations

import socket
import time

import pytest

from fh6_telemetry.core.udp_source import UdpSource
from tests.conftest import free_udp_port
from tools.fake_forza import Simulator, build_packet


def _pump(app, seconds: float) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        app.processEvents()
        time.sleep(0.005)


def _send_all(port: int, datagrams: list[bytes]) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for d in datagrams:
        s.sendto(d, ("127.0.0.1", port))
    s.close()


@pytest.fixture()
def launcher(qapp, tmp_config):
    from fh6_telemetry.launcher import LauncherWindow

    port = free_udp_port()
    tmp_config.set("udp_port", port)
    win = LauncherWindow(tmp_config)
    win.show()
    win._open_all()
    yield win, port
    win.close()


def test_connects_and_updates_every_window(qapp, launcher):
    win, port = launcher
    sim = Simulator("fluct", seed=2)
    _send_all(port, [sim.datagram(i / 75.0) for i in range(40)])
    _pump(qapp, 0.6)
    assert "Connected" in win._conn_lbl.text()
    assert f":{port}" in win._conn_lbl.text()          # the real address, not a constant
    assert win._ts_lbl.text().startswith("TimestampMS:")


def test_nan_and_pause_packets_do_not_crash_or_kill_the_ui(qapp, launcher):
    win, port = launcher
    datagrams = []
    for scenario in ("nan", "pause", "carchange"):
        sim = Simulator(scenario, seed=5)
        datagrams += [sim.datagram(i / 75.0) for i in range(120)]
    _send_all(port, datagrams)
    _pump(qapp, 1.0)
    assert win.isVisible()
    assert win._hub.status().packets >= 100            # the receiver is alive and counting


def test_hostile_input_never_makes_a_window_raise(qapp, launcher, tmp_path, monkeypatch):
    """Frames are sanitised in the hub, so no window update should throw at all."""
    from fh6_telemetry.core import diagnostics

    log = tmp_path / "e.log"
    monkeypatch.setattr(diagnostics, "_log_path", log)
    monkeypatch.setattr(diagnostics, "_last_logged", {})
    win, port = launcher
    sim = Simulator("nan", seed=3)
    for i in range(300):
        win._hub.ingest(sim.datagram(i / 75.0) if len(sim.datagram(0)) == 324 else b"")
        if i % 3 == 0:
            win._on_tick()
    win._on_tick()
    assert not log.exists() or "Traceback" not in log.read_text(encoding="utf-8")


def test_wrong_packet_size_is_explained(qapp, launcher):
    win, port = launcher
    _send_all(port, [b"\x00" * 232 for _ in range(5)])
    _pump(qapp, 0.4)
    win._poll_status()
    assert "232-byte" in win._conn_lbl.text() and "324" in win._conn_lbl.text()


def test_busy_port_shows_an_error_instead_of_raising(qapp, tmp_config):
    from fh6_telemetry.launcher import LauncherWindow

    blocker = UdpSource("127.0.0.1", 0, lambda d: None)
    blocker.start()
    try:
        tmp_config.set("udp_port", blocker.bound[1])
        win = LauncherWindow(tmp_config)
        try:
            assert win._hub.status().state == "error"
            assert "Cannot listen" in win._conn_lbl.text()
            free = free_udp_port()                     # fix the port and connect: recovers
            win._port_edit.setText(str(free))
            win._connect()
            assert win._hub.status().bound[1] == free
            assert tmp_config["udp_port"] == free
        finally:
            win.close()
    finally:
        blocker.stop()


def test_test_button_recognises_its_own_address(qapp, launcher):
    win, port = launcher
    win._ip_edit.setText("127.0.0.1")
    win._port_edit.setText(str(port))
    win._test_connection()
    assert "already listening" in win._conn_lbl.text()
    win._port_edit.setText(str(free_udp_port()))
    win._test_connection()
    assert "is available" in win._conn_lbl.text()


def test_fuel_bar_is_red_when_nearly_empty(qapp, launcher):
    win, port = launcher
    bar = win._windows[4]._tab._bars["Fuel"]          # Inputs window
    bar.update_value(5.0)
    assert bar._bar.color == "#DD2200"
    bar.update_value(90.0)
    assert bar._bar.color == "#22BB44"


# ---------------------------------------------------------------------------
# Render tick behaviour
# ---------------------------------------------------------------------------


def _feed_hub(win, n: int, scenario: str = "fluct", start: int = 0) -> None:
    sim = Simulator(scenario, seed=4)
    for i in range(start, start + n):
        win._hub.ingest(sim.datagram(i / 75.0))


def _chart_counts(win) -> list[int]:
    return [c._ring.count for w in win._windows for c in w.charts]


def test_tick_feeds_every_frame_to_the_charts_even_when_windows_are_hidden(qapp, tmp_config):
    from fh6_telemetry.launcher import LauncherWindow

    tmp_config.set("udp_port", free_udp_port())
    win = LauncherWindow(tmp_config)                  # no windows opened/shown
    try:
        win._on_tick()                                # adopt the hub session
        _feed_hub(win, 120)
        win._on_tick()
        assert all(not w.isVisible() for w in win._windows)
        counts = _chart_counts(win)
        assert len(counts) == 6 and all(c == 120 for c in counts)   # nothing was dropped
    finally:
        win.close()


def test_a_slow_ui_loses_no_chart_history_unlike_a_per_packet_design(qapp, launcher):
    win, _ = launcher
    win._on_tick()
    for burst in range(5):                            # 5 ticks' worth arrive while "busy"
        _feed_hub(win, 30, start=burst * 30)
    win._on_tick()
    assert all(c == 150 for c in _chart_counts(win))


def test_minimized_windows_get_history_but_are_not_redrawn(qapp, launcher, monkeypatch):
    from fh6_telemetry.widgets.rolling_chart import RollingChart

    win, _ = launcher
    win._on_tick()
    refreshed = []
    orig = RollingChart.refresh
    monkeypatch.setattr(RollingChart, "refresh", lambda self: (refreshed.append(self), orig(self))[1])

    engine = win._windows[3]
    engine.showMinimized()
    qapp.processEvents()
    assert engine.isVisible() and engine.isMinimized() and not engine.is_on_screen()

    _feed_hub(win, 20)
    win._on_tick()
    engine_charts = set(map(id, engine.charts))
    assert not engine_charts & set(map(id, refreshed))            # skipped
    assert all(c._ring.count == 20 for c in engine.charts)       # but still recorded
    other = [c for w in win._windows if w is not engine for c in w.charts]
    assert set(map(id, other)) <= set(map(id, refreshed))        # visible windows redrawn

    engine.showNormal()
    qapp.processEvents()
    refreshed.clear()
    _feed_hub(win, 5, start=20)
    win._on_tick()
    assert engine_charts <= set(map(id, refreshed))               # redrawn after restore


def test_new_session_clears_chart_history(qapp, launcher):
    win, port = launcher
    win._on_tick()
    _feed_hub(win, 50)
    win._on_tick()
    assert all(c == 50 for c in _chart_counts(win))
    win._port_edit.setText(str(free_udp_port()))
    win._connect()                                    # new source -> new session
    win._on_tick()
    assert all(c == 0 for c in _chart_counts(win))
    assert "Listening" in win._conn_lbl.text()


def test_tick_without_new_frames_does_no_work(qapp, launcher, monkeypatch):
    win, _ = launcher
    win._on_tick()
    _feed_hub(win, 5)
    win._on_tick()
    calls = []
    for w in win._windows:
        monkeypatch.setattr(type(w), "update_data", lambda self, t, _c=calls: _c.append(1))
    for _ in range(50):
        win._on_tick()
    assert calls == []


def test_signal_loss_is_reported_and_recovery_clears_it(qapp, launcher):
    win, _ = launcher
    win._on_tick()
    _feed_hub(win, 5)
    win._on_tick()
    assert "Connected" in win._conn_lbl.text()
    win._hub._last_rx = time.monotonic() - 5.0        # pretend packets stopped 5 s ago
    win._poll_status()
    assert "No signal" in win._conn_lbl.text()
    _feed_hub(win, 3, start=10)
    win._on_tick()
    assert "Connected" in win._conn_lbl.text()


def test_refresh_rate_changes_the_timer_and_is_persisted(qapp, launcher):
    win, _ = launcher
    assert win._tick_timer.interval() == 50           # default 20 Hz
    win._rate_combo.setCurrentIndex(3)                # 30 Hz
    assert win._tick_timer.interval() == 33
    assert win._config["refresh_hz"] == 30
    win._rate_combo.setCurrentIndex(0)                # 10 Hz
    assert win._tick_timer.interval() == 100


def test_status_bar_shows_cpu_and_measured_rates(qapp, launcher):
    win, _ = launcher
    win._poll_status()
    assert win._cpu_lbl.text().startswith("CPU ")
    win._on_tick()
    _feed_hub(win, 30)
    for _ in range(4):
        win._on_tick()
        _feed_hub(win, 5)
    time.sleep(0.1)
    win._poll_status()
    assert "display" in win._cpu_lbl.text() and "pkt/s" in win._cpu_lbl.text()


def test_closing_stops_timers_and_the_hub(qapp, tmp_config):
    from fh6_telemetry.launcher import LauncherWindow

    tmp_config.set("udp_port", free_udp_port())
    win = LauncherWindow(tmp_config)
    assert win._tick_timer.isActive() and win._hub.status().state == "listening"
    win.close()
    assert not win._tick_timer.isActive()
    assert not win._status_timer.isActive()
    assert win._hub.status().state == "stopped"
