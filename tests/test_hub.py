"""TelemetryHub: sequence numbers, independent cursors, restart, concurrency."""

from __future__ import annotations

import socket
import threading
import time

import pytest

from fh6_telemetry.core.hub import TelemetryHub
from fh6_telemetry.core.udp_source import UdpBindError
from tests.conftest import free_udp_port
from tools.fake_forza import build_packet


def _pkt(i: int) -> bytes:
    return build_packet({"TimestampMS": i, "Speed": float(i), "IsRaceOn": 1})


def _wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def test_ingest_assigns_increasing_sequence_numbers():
    hub = TelemetryHub(capacity=8)
    assert hub.seq == 0 and hub.head() is None
    for i in range(1, 6):
        assert hub.ingest(_pkt(i))
        assert hub.seq == i
    seq, latest = hub.head()
    assert seq == 5 and latest["TimestampMS"] == 5


def test_short_datagrams_are_rejected_without_a_frame():
    hub = TelemetryHub()
    assert hub.ingest(b"\x00" * 100) is False
    assert hub.seq == 0


def test_frames_since_returns_exactly_the_new_frames():
    hub = TelemetryHub(capacity=16)
    for i in range(1, 6):
        hub.ingest(_pkt(i))
    seq, frames, dropped = hub.frames_since(0)
    assert seq == 5 and dropped == 0
    assert [f["TimestampMS"] for f in frames] == [1, 2, 3, 4, 5]
    hub.ingest(_pkt(6))
    hub.ingest(_pkt(7))
    seq, frames, dropped = hub.frames_since(5)
    assert seq == 7 and [f["TimestampMS"] for f in frames] == [6, 7] and dropped == 0
    assert hub.frames_since(7) == (7, [], 0)
    assert hub.frames_since(99) == (7, [], 0)      # a cursor from the future yields nothing


def test_a_lagging_consumer_gets_the_newest_frames_and_a_dropped_count():
    hub = TelemetryHub(capacity=4)
    for i in range(1, 11):
        hub.ingest(_pkt(i))
    seq, frames, dropped = hub.frames_since(0)
    assert seq == 10 and dropped == 6
    assert [f["TimestampMS"] for f in frames] == [7, 8, 9, 10]
    seq, frames, dropped = hub.frames_since(8)
    assert [f["TimestampMS"] for f in frames] == [9, 10] and dropped == 0


def test_consumers_have_independent_cursors():
    hub = TelemetryHub()
    for i in range(1, 4):
        hub.ingest(_pkt(i))
    a_seq, a_frames, _ = hub.frames_since(0)
    b_seq, b_frames, _ = hub.frames_since(0)          # reading again loses nothing
    assert len(a_frames) == len(b_frames) == 3
    hub.ingest(_pkt(4))
    assert [f["TimestampMS"] for f in hub.frames_since(a_seq)[1]] == [4]
    assert [f["TimestampMS"] for f in hub.frames_since(0)[1]] == [1, 2, 3, 4]


def test_history_returns_the_newest_k_oldest_first():
    hub = TelemetryHub(capacity=5)
    for i in range(1, 9):
        hub.ingest(_pkt(i))
    assert [f["TimestampMS"] for f in hub.history()] == [4, 5, 6, 7, 8]
    assert [f["TimestampMS"] for f in hub.history(2)] == [7, 8]
    assert TelemetryHub().history() == []


def test_frames_are_converted_and_finite():
    hub = TelemetryHub()
    hub.ingest(build_packet({"TireTempFL": 212.0, "Speed": float("nan"), "IsRaceOn": 1}))
    f = hub.head()[1]
    assert f["TireTempFL"] == pytest.approx(100.0) and f["Speed"] == 0.0


def test_listening_receives_over_udp_and_reports_status():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    try:
        st = hub.status()
        assert st.state == "listening" and st.session == 1 and st.error is None
        port = st.bound[1]
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for i in range(1, 31):
            s.sendto(_pkt(i), ("127.0.0.1", port))
            time.sleep(0.002)
        s.sendto(b"\x01" * 10, ("127.0.0.1", port))
        s.close()
        assert _wait(lambda: hub.seq == 30 and hub.status().bad_packets == 1)
        st = hub.status()
        assert st.packets == 30 and st.last_bad_len == 10
        assert st.last_rx_age is not None and st.last_rx_age < 2.0
        assert st.pps > 0
    finally:
        hub.stop()
    assert hub.status().state == "stopped"


def test_restart_keeps_seq_monotonic_and_bumps_the_session():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    p1 = hub.status().bound[1]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(_pkt(1), ("127.0.0.1", p1))
    assert _wait(lambda: hub.seq == 1)
    hub.start("127.0.0.1", 0)                         # a different source
    st = hub.status()
    assert st.session == 2 and hub.seq == 1           # seq NOT reset
    s.sendto(_pkt(2), ("127.0.0.1", st.bound[1]))
    assert _wait(lambda: hub.seq == 2)
    assert hub.frames_since(1)[1][0]["TimestampMS"] == 2
    s.close()
    hub.stop()


def test_failed_start_reports_the_error_and_keeps_the_hub_usable():
    port = free_udp_port()
    blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker.bind(("127.0.0.1", port))
    hub = TelemetryHub()
    try:
        with pytest.raises(UdpBindError):
            hub.start("127.0.0.1", port)
        st = hub.status()
        assert st.state == "error" and "in use" in st.error
        assert st.session == 0
    finally:
        blocker.close()
    hub.start("127.0.0.1", port)                      # now free: recovers
    assert hub.status().state == "listening"
    hub.stop()


def test_stop_is_fast_and_idempotent():
    hub = TelemetryHub()
    hub.stop()
    hub.start("127.0.0.1", 0)
    t0 = time.monotonic()
    hub.stop()
    hub.stop()
    assert time.monotonic() - t0 < 1.0


def test_stale_source_cannot_publish_after_restart():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    old_port = hub.status().bound[1]
    hub.start("127.0.0.1", 0)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(_pkt(1), ("127.0.0.1", old_port))        # nobody listens there any more
    time.sleep(0.2)
    s.close()
    assert hub.seq == 0
    hub.stop()


def test_concurrent_writer_and_readers_see_consistent_gapless_data():
    """One writer, three readers with their own cursors: every frame is internally
    consistent, sequences are gapless (or reported as dropped), nothing duplicates."""
    hub = TelemetryHub(capacity=64)
    total = 6000
    stop = threading.Event()
    errors: list[str] = []
    seen_counts: list[int] = []

    def reader() -> None:
        cursor = 0
        got = 0
        last_ts = 0
        while not stop.is_set() or cursor < hub.seq:
            cursor2, frames, dropped = hub.frames_since(cursor)
            got += len(frames) + dropped
            if cursor2 - cursor != len(frames) + dropped:
                errors.append("count mismatch")
            for f in frames:
                if f["TimestampMS"] != int(f["Speed"]):
                    errors.append("torn frame")
                if f["TimestampMS"] <= last_ts:
                    errors.append("out of order / duplicate")
                last_ts = f["TimestampMS"]
            cursor = cursor2
            if not frames:
                time.sleep(0.0005)
        seen_counts.append(got)

    readers = [threading.Thread(target=reader) for _ in range(3)]
    for r in readers:
        r.start()
    for i in range(1, total + 1):
        hub.ingest(_pkt(i))
    stop.set()
    for r in readers:
        r.join(10)
    assert not errors, errors[:3]
    assert seen_counts == [total, total, total]


def test_start_returns_the_session_boundary_so_no_new_frame_is_missed():
    hub = TelemetryHub()
    hub.start("127.0.0.1", 0)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(_pkt(1), ("127.0.0.1", hub.status().bound[1]))
    assert _wait(lambda: hub.seq == 1)
    base = hub.start("127.0.0.1", 0)                  # switch source
    assert base == 1
    s.sendto(_pkt(2), ("127.0.0.1", hub.status().bound[1]))
    assert _wait(lambda: hub.seq == 2)
    _, frames, _ = hub.frames_since(base)
    assert [f["TimestampMS"] for f in frames] == [2]  # only the new source's frame
    s.close()
    hub.stop()
