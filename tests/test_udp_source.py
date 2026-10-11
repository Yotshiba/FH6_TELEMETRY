"""UdpSource: synchronous bind, exclusivity, bad-packet accounting, fast stop."""

from __future__ import annotations

import socket
import threading
import time

import pytest

from fh6_telemetry.constants import PACKET_SIZE
from fh6_telemetry.core.udp_source import UdpBindError, UdpSource, describe_bind_error
from tools.fake_forza import build_packet


def _send(port: int, data: bytes) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(data, ("127.0.0.1", port))
    s.close()


def _wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def test_receives_valid_packets_and_counts_short_ones():
    got: list[bytes] = []
    src = UdpSource("127.0.0.1", 0, got.append)
    src.start()
    try:
        port = src.bound[1]
        _send(port, build_packet({"Speed": 12.0}))
        _send(port, b"\x00" * 100)
        assert _wait(lambda: len(got) == 1 and src.bad_packets == 1)
        assert len(got[0]) == PACKET_SIZE
        assert src.last_bad_len == 100 and src.packets == 1
    finally:
        src.stop()


def test_stop_returns_quickly_and_is_idempotent():
    src = UdpSource("127.0.0.1", 0, lambda d: None)
    src.stop()  # before start: no-op
    src.start()
    t0 = time.monotonic()
    src.stop()
    src.stop()
    assert time.monotonic() - t0 < 1.0
    assert src.bound is None and not src.running
    assert not any(t.name == "fh6-udp" and t.is_alive() for t in threading.enumerate())


def test_second_listener_on_same_port_fails_with_friendly_error():
    a = UdpSource("127.0.0.1", 0, lambda d: None)
    a.start()
    try:
        port = a.bound[1]
        b = UdpSource("127.0.0.1", port, lambda d: None)
        with pytest.raises(UdpBindError) as ei:
            b.start()
        assert "in use by another" in str(ei.value) or "already in use" in str(ei.value)
        assert not b.running
    finally:
        a.stop()


def test_port_can_be_rebound_right_after_stop():
    a = UdpSource("127.0.0.1", 0, lambda d: None)
    a.start()
    port = a.bound[1]
    a.stop()
    b = UdpSource("127.0.0.1", port, lambda d: None)
    b.start()
    try:
        assert b.bound[1] == port
    finally:
        b.stop()


def test_callback_exception_does_not_kill_the_thread(tmp_path, monkeypatch):
    from fh6_telemetry.core import diagnostics

    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    seen: list[int] = []

    def cb(data: bytes) -> None:
        seen.append(len(data))
        if len(seen) == 1:
            raise RuntimeError("boom")

    src = UdpSource("127.0.0.1", 0, cb)
    src.start()
    try:
        port = src.bound[1]
        _send(port, build_packet({}))
        assert _wait(lambda: len(seen) == 1)
        _send(port, build_packet({}))
        assert _wait(lambda: len(seen) == 2)
    finally:
        src.stop()


def test_unusable_address_is_reported_not_raised_in_a_thread():
    src = UdpSource("203.0.113.77", 20077, lambda d: None)  # TEST-NET-3, not ours
    with pytest.raises(UdpBindError) as ei:
        src.start()
    assert "not available" in str(ei.value)


@pytest.mark.parametrize(
    "code,needle",
    [(10048, "already in use"), (10013, "in use by another"), (10049, "not available")],
)
def test_describe_bind_error_maps_windows_codes(code, needle):
    msg = describe_bind_error("127.0.0.1", 20077, OSError(code, "raw"))
    assert needle in msg
