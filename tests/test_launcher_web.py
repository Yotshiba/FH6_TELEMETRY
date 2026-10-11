"""Launcher: web dashboard section, low-impact checkbox, and the review fixes."""

from __future__ import annotations

import http.client
import socket
import time

import pytest

from fh6_telemetry.core import lowimpact
from tests.conftest import free_udp_port
from tools.fake_forza import Simulator, build_packet


def free_tcp_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _get(port, path="/healthz"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("GET", path)
    r = c.getresponse()
    body = r.read()
    c.close()
    return r.status, body


@pytest.fixture()
def win(qapp, tmp_config, monkeypatch):
    from fh6_telemetry.launcher import LauncherWindow

    monkeypatch.setattr(lowimpact, "apply", lambda *a, **k: lowimpact.Result(ok=True))
    tmp_config.set("udp_port", free_udp_port())
    tmp_config.set("web_port", free_tcp_port())
    w = LauncherWindow(tmp_config)
    w.show()
    yield w
    w.close()


def _feed(win, n=10, start=0):
    sim = Simulator("fluct", seed=4)
    for i in range(start, start + n):
        win._hub.ingest(sim.datagram(i / 75.0))


# ---------------------------------------------------------------------------
# web section
# ---------------------------------------------------------------------------


def test_web_is_off_by_default(win):
    assert not win._web_check.isChecked() and win._web is None
    assert win._web_url_lbl.text() == ""


def test_enabling_starts_the_server_shows_the_url_and_persists(win, tmp_config):
    port = int(win._web_port_edit.text())
    win._web_check.setChecked(True)
    assert win._web is not None and win._web.running
    assert _get(port) == (200, b"ok")
    assert win._web_url_lbl.text().endswith(f":{port}/")
    assert not win._web_port_edit.isEnabled()                 # can't change while serving
    assert win._web_copy_btn.isEnabled()
    assert tmp_config["web_enabled"] is True and tmp_config["web_port"] == port


def test_disabling_stops_the_server_and_persists(win, tmp_config):
    port = int(win._web_port_edit.text())
    win._web_check.setChecked(True)
    win._web_check.setChecked(False)
    assert win._web is None and win._web_url_lbl.text() == ""
    assert win._web_port_edit.isEnabled()
    with pytest.raises(OSError):
        _get(port)
    assert tmp_config["web_enabled"] is False


def test_busy_port_unchecks_and_explains(win):
    blocker = socket.socket()
    blocker.bind(("0.0.0.0", 0))
    blocker.listen(1)
    try:
        win._web_port_edit.setText(str(blocker.getsockname()[1]))
        win._web_check.setChecked(True)
        assert not win._web_check.isChecked() and win._web is None
        assert "Cannot start" in win._web_note_lbl.text()
    finally:
        blocker.close()


@pytest.mark.parametrize("text", ["abc", "80", "99999", ""])
def test_invalid_port_is_rejected(win, text):
    win._web_port_edit.setText(text)
    win._web_check.setChecked(True)
    assert not win._web_check.isChecked() and win._web is None
    assert "Invalid web port" in win._web_note_lbl.text()


def test_enabled_in_config_auto_starts(qapp, tmp_config, monkeypatch):
    from fh6_telemetry.launcher import LauncherWindow

    monkeypatch.setattr(lowimpact, "apply", lambda *a, **k: lowimpact.Result(ok=True))
    port = free_tcp_port()
    tmp_config.set("udp_port", free_udp_port())
    tmp_config.set("web_port", port)
    tmp_config.set("web_enabled", True)
    w = LauncherWindow(tmp_config)
    try:
        assert w._web_check.isChecked() and w._web.running
        assert _get(port)[0] == 200
    finally:
        w.close()
    with pytest.raises(OSError):
        _get(port)                                            # closing the launcher stopped it


def test_viewer_count_is_shown(win):
    win._web_check.setChecked(True)
    port = int(win._web_port_edit.text())
    _feed(win, 5)
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("GET", "/stream")
    r = c.getresponse()
    r.fp.readline()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and win._web.client_count < 1:
        time.sleep(0.02)
    win._poll_status()
    assert "1 viewer connected" in win._web_note_lbl.text()
    r.close()
    c.close()


def test_copy_button_puts_the_url_on_the_clipboard(win, qapp):
    win._web_check.setChecked(True)
    win._copy_web_url()
    assert qapp.clipboard().text() == win._web_urls[0]


def test_web_keeps_running_across_a_source_change(win):
    win._web_check.setChecked(True)
    port = int(win._web_port_edit.text())
    win._port_edit.setText(str(free_udp_port()))
    win._connect()                                            # new UDP source
    assert win._web.running and _get(port)[0] == 200


# ---------------------------------------------------------------------------
# low-impact checkbox
# ---------------------------------------------------------------------------


def test_low_impact_checkbox_applies_and_persists(qapp, tmp_config, monkeypatch):
    from fh6_telemetry.launcher import LauncherWindow

    calls = []
    monkeypatch.setattr(lowimpact, "apply", lambda on, **k: calls.append(on) or lowimpact.Result(ok=True))
    tmp_config.set("udp_port", free_udp_port())
    w = LauncherWindow(tmp_config)
    try:
        assert calls == []                                    # construction applies nothing
        w._lowimpact_check.setChecked(True)
        w._lowimpact_check.setChecked(False)
        assert calls == [True, False] or calls == [False] or calls == [True, False][-len(calls):]
        assert tmp_config["low_impact"] is False
    finally:
        w.close()


# ---------------------------------------------------------------------------
# fixes from the code review
# ---------------------------------------------------------------------------


def test_failed_connect_never_reports_a_stale_connected(win):
    win._on_tick()
    _feed(win, 5)
    win._on_tick()
    assert "Connected" in win._conn_lbl.text()
    _feed(win, 4, start=5)                                    # in flight when Connect is clicked
    blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker.bind(("127.0.0.1", 0))
    try:
        win._port_edit.setText(str(blocker.getsockname()[1]))
        win._connect()
        assert "Cannot listen" in win._conn_lbl.text()
        for _ in range(5):
            win._on_tick()
            win._poll_status()
        assert "Cannot listen" in win._conn_lbl.text()
    finally:
        blocker.close()


def test_window_opened_while_no_packets_arrive_is_still_drawn(win):
    win._on_tick()
    _feed(win, 60)
    win._on_tick()                                            # race window hidden: skipped
    race = win._windows[0]
    assert not race.isVisible()
    race.show()
    win._on_tick()                                            # silent stream: must still refresh
    assert race._speed_lbl.text() != "0"


def test_wrong_size_hint_works_after_earlier_good_traffic(win):
    win._on_tick()
    _feed(win, 30)                                            # lifetime packets > 0
    win._on_tick()
    other = free_udp_port()
    win._port_edit.setText(str(other))
    win._connect()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for _ in range(5):
        s.sendto(b"\x00" * 232, ("127.0.0.1", other))
    s.close()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and win._hub.status().bad_packets < 5:
        time.sleep(0.02)
    win._poll_status()
    assert "232-byte" in win._conn_lbl.text()


def test_hostnames_and_short_forms_are_not_accepted_as_addresses(win):
    for bad in ("localhost", "127.1", "0x7f.1", "some.host.lan", ""):
        win._ip_edit.setText(bad)
        assert win._parse_inputs() is None, bad
    win._ip_edit.setText("127.0.0.1")
    assert win._parse_inputs() is not None


def test_a_broken_config_file_does_not_stop_the_app(qapp, tmp_path, monkeypatch):
    from fh6_telemetry import launcher

    monkeypatch.setattr(launcher.Config, "load", classmethod(lambda cls, p=None: (_ for _ in ()).throw(RuntimeError("bad"))))
    cfg = launcher.LauncherWindow._load_config()
    assert cfg["udp_port"] == 20077
