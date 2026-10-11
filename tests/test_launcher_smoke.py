"""Launcher + windows under Qt's offscreen platform: connect, feed, survive junk."""

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
    # the receiver is still alive and still counting
    assert win._receiver is not None and win._receiver.packets >= 100


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
            assert win._receiver is None
            assert "Cannot listen" in win._conn_lbl.text()
            # fix the port and connect: recovers
            free = free_udp_port()
            win._port_edit.setText(str(free))
            win._connect()
            assert win._receiver is not None and win._receiver.bound[1] == free
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
    inputs = win._windows[4]                      # Inputs window
    bar = inputs._tab._bars["Fuel"]
    bar.update_value(5.0)
    assert bar._bar.color == "#DD2200"
    bar.update_value(90.0)
    assert bar._bar.color == "#22BB44"
