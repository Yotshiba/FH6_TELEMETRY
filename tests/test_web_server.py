"""WebServer over real sockets (loopback): static files, SSE stream, resume, limits."""

from __future__ import annotations

import http.client
import json
import queue
import threading
import time

import pytest

from fh6_telemetry.core.hub import TelemetryHub
from fh6_telemetry.web import protocol as P
from fh6_telemetry.web import server as S
from fh6_telemetry.web.server import WebBindError, WebServer
from tools.fake_forza import Simulator, build_packet


def _pkt(i: int, **kw) -> bytes:
    kw.setdefault("IsRaceOn", 1)
    return build_packet({"TimestampMS": i, "Speed": float(i), **kw})


class Sse:
    """Minimal SSE reader on top of http.client."""

    def __init__(self, port, headers=None, path="/stream", timeout=5.0):
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        self.conn.request("GET", path, headers=headers or {})
        self.resp = self.conn.getresponse()
        self.raw = b""

    def read(self, count=1, until=None, limit=10.0):
        """Read events until *count* arrived (or `until(event)` is true)."""
        events = []
        end = time.monotonic() + limit
        ev = {"event": "message", "data": "", "id": None}
        while time.monotonic() < end:
            line = self.resp.fp.readline()
            if not line:
                break
            self.raw += line
            line = line.decode("utf-8").rstrip("\r\n")
            if line == "":
                if ev["data"]:
                    events.append(ev)
                    if (until and until(ev)) or (not until and len(events) >= count):
                        return events
                ev = {"event": "message", "data": "", "id": None}
            elif line.startswith("event:"):
                ev["event"] = line[6:].strip()
            elif line.startswith("data:"):
                ev["data"] = line[5:].strip()
            elif line.startswith("id:"):
                ev["id"] = line[3:].strip()
        return events

    def json(self, ev):
        return json.loads(ev["data"])

    def close(self):
        # The response holds a makefile() reference to the socket: close it too,
        # otherwise the TCP connection stays open and the server sees no EOF.
        self.resp.close()
        self.conn.close()


@pytest.fixture()
def static_dir(tmp_path):
    d = tmp_path / "static"
    (d / "vendor").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>t</title>hello", encoding="utf-8")
    (d / "app.js").write_text("console.log(1)", encoding="utf-8")
    (d / "vendor" / "lib.css").write_text("a{}", encoding="utf-8")
    return d


@pytest.fixture()
def hub():
    h = TelemetryHub(capacity=600)
    yield h
    h.stop()


@pytest.fixture()
def web(hub, static_dir):
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0)
    port = w.start("127.0.0.1", 0)
    w.port = port
    yield w
    w.stop()


def _get(port, path, headers=None, method="GET"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, headers=headers or {})
    r = c.getresponse()
    body = r.read()
    c.close()
    return r, body


# ---------------------------------------------------------------------------
# static files
# ---------------------------------------------------------------------------


def test_serves_index_and_assets_with_types_and_security_headers(web):
    r, body = _get(web.port, "/")
    assert r.status == 200 and b"hello" in body
    assert r.getheader("Content-Type").startswith("text/html")
    assert r.getheader("X-Content-Type-Options") == "nosniff"
    assert "default-src 'self'" in r.getheader("Content-Security-Policy")
    assert r.getheader("Access-Control-Allow-Origin") is None          # no CORS
    r, body = _get(web.port, "/static/app.js")
    assert r.status == 200 and r.getheader("Content-Type").startswith("text/javascript")
    r, _ = _get(web.port, "/static/vendor/lib.css")
    assert r.status == 200 and r.getheader("Content-Type").startswith("text/css")


def test_etag_gives_304_and_head_has_no_body(web):
    r, _ = _get(web.port, "/")
    etag = r.getheader("ETag")
    r2, body2 = _get(web.port, "/", headers={"If-None-Match": etag})
    assert r2.status == 304 and body2 == b""
    r3, body3 = _get(web.port, "/", method="HEAD")
    assert r3.status == 200 and body3 == b""


@pytest.mark.parametrize("path", [
    "/nope", "/static/missing.js", "/static/../index.html", "/static/%2e%2e/index.html",
    "/static/..%5cindex.html", "/etc/passwd", "/static/", "//static/app.js/..",
])
def test_unknown_and_traversal_paths_are_404(web, path):
    r, _ = _get(web.port, path)
    assert r.status == 404


@pytest.mark.parametrize("target", ["http://[::1/x", "http://[bad/x", "https://[fe80::1/"])
def test_malformed_request_targets_get_400_not_a_traceback(web, target):
    """urlsplit() raises ValueError on e.g. an unterminated IPv6 literal; that must not escape the handler."""
    import socket

    with socket.create_connection(("127.0.0.1", web.port), timeout=5) as sock:
        crlf = chr(13) + chr(10)
        sock.sendall(("GET " + target + " HTTP/1.0" + crlf + "Host: x" + crlf + crlf).encode())
        data = b""
        while chunk := sock.recv(4096):
            data += chunk
    assert data.startswith(b"HTTP/1.0 400") or data.startswith(b"HTTP/1.1 400"), data[:80]
    # and the server is still healthy afterwards
    r, _ = _get(web.port, "/healthz")
    assert r.status == 200


def test_only_get_and_head_are_supported(web):
    c = http.client.HTTPConnection("127.0.0.1", web.port, timeout=5)
    c.request("POST", "/", body=b"x")
    assert c.getresponse().status in (501, 405)
    c.close()


def test_healthz_and_snapshot(web, hub):
    assert _get(web.port, "/healthz")[1] == b"ok"
    r, body = _get(web.port, "/api/snapshot")
    assert json.loads(body)["seq"] == 0 and "F" not in json.loads(body)
    hub.ingest(_pkt(7, Accel=255))
    snap = json.loads(_get(web.port, "/api/snapshot")[1])
    assert snap["seq"] == 1 and snap["F"]["AccelPct"] == 100.0 and "S" in snap


def test_non_lan_peers_are_refused(web, monkeypatch):
    monkeypatch.setattr(S, "_allowed_peer", lambda ip: False)
    r, _ = _get(web.port, "/")
    assert r.status == 403
    r, _ = _get(web.port, "/stream")
    assert r.status == 403


def test_allowed_peer_rules():
    ok = ["127.0.0.1", "192.168.1.5", "10.1.2.3", "172.20.0.9", "169.254.4.4", "100.101.102.103"]
    bad = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "garbage", "", "::1", "2001:db8::1"]
    assert all(S._allowed_peer(i) for i in ok)
    assert not any(S._allowed_peer(i) for i in bad)


# ---------------------------------------------------------------------------
# stream
# ---------------------------------------------------------------------------


def test_stream_starts_with_hello_hist_slow_and_status(web, hub):
    for i in range(1, 51):
        hub.ingest(_pkt(i, Accel=255))
    c = Sse(web.port)
    try:
        assert c.resp.status == 200
        assert c.resp.getheader("Content-Type").startswith("text/event-stream")
        evs = c.read(4)
        assert [e["event"] for e in evs] == ["hello", "hist", "s", "st"]
        hello = c.json(evs[0])
        assert hello["v"] == 1 and len(hello["F"]) == len(P.FAST) and hello["resume"] is False
        hist = c.json(evs[1])
        assert hist["s"] == 1 and len(hist["r"]) == 50 and len(hist["r"][0]) == len(P.FAST)
        assert evs[1]["id"] == f"{hello['epoch']}:50"
        assert hist["r"][-1][P.FAST_INDEX["SpeedKmh"]] == 50 * 3.6
        assert len(c.json(evs[2])) == len(P.SLOW)
        assert c.json(evs[3])["sig"] == 1
    finally:
        c.close()


def test_history_is_capped_at_300_rows_and_ends_at_the_cursor(web, hub):
    for i in range(1, 501):
        hub.ingest(_pkt(i))
    c = Sse(web.port)
    try:
        evs = c.read(2)
        hist = c.json(evs[1])
        assert len(hist["r"]) == 300 and hist["s"] == 201
        assert hist["r"][-1][P.FAST_INDEX["SpeedKmh"]] == pytest.approx(500 * 3.6, abs=0.1)
    finally:
        c.close()


def test_new_frames_are_streamed_gaplessly_with_increasing_ids(web, hub):
    for i in range(1, 11):
        hub.ingest(_pkt(i))
    c = Sse(web.port)
    try:
        c.read(2)                                            # hello, hist
        seen = []
        for i in range(11, 61):
            hub.ingest(_pkt(i))
            time.sleep(0.003)
        end = time.monotonic() + 5
        last_seq = 10
        while last_seq < 60 and time.monotonic() < end:
            for e in c.read(1, until=lambda e: e["event"] == "f", limit=3):
                if e["event"] != "f":
                    continue
                d = c.json(e)
                n = len(d["r"])
                assert d["s"] - n == last_seq             # contiguous: no gap, no duplicate
                speeds = [r[P.FAST_INDEX["SpeedKmh"]] for r in d["r"]]
                assert speeds == pytest.approx([(d["s"] - n + k + 1) * 3.6 for k in range(n)], abs=0.1)
                assert e["id"].endswith(f":{d['s']}")
                last_seq = d["s"]
        assert last_seq == 60
    finally:
        c.close()


def test_stream_bytes_never_contain_nan_for_hostile_input(web, hub):
    c = Sse(web.port)
    try:
        c.read(2)
        sim = Simulator("nan", seed=4)
        for i in range(300):
            data = sim.datagram(i / 75.0)
            hub.ingest(data)
            time.sleep(0.001)
        c.read(1, until=lambda e: e["event"] == "f", limit=2)
        time.sleep(0.2)
        c.read(1000, limit=0.5)
        assert b"NaN" not in c.raw and b"Infinity" not in c.raw
    finally:
        c.close()


def test_resume_with_last_event_id_sends_only_the_missed_rows(web, hub):
    for i in range(1, 21):
        hub.ingest(_pkt(i))
    c = Sse(web.port)
    evs = c.read(2)
    epoch = c.json(evs[0])["epoch"]
    last_id = evs[1]["id"]                                  # "<epoch>:20"
    c.close()
    for i in range(21, 31):                                 # missed while disconnected
        hub.ingest(_pkt(i))
    time.sleep(0.15)
    c2 = Sse(web.port, headers={"Last-Event-ID": last_id})
    try:
        evs2 = c2.read(2)
        assert c2.json(evs2[0])["resume"] is True and c2.json(evs2[0])["epoch"] == epoch
        assert evs2[1]["event"] == "f"
        d = c2.json(evs2[1])
        assert d["s"] == 30 and len(d["r"]) == 10
    finally:
        c2.close()


def test_resume_with_a_stale_epoch_falls_back_to_full_history(web, hub):
    for i in range(1, 6):
        hub.ingest(_pkt(i))
    c = Sse(web.port, headers={"Last-Event-ID": "999:3"})
    try:
        evs = c.read(2)
        assert c.json(evs[0])["resume"] is False and evs[1]["event"] == "hist"
    finally:
        c.close()


def test_since_query_parameter_also_resumes(web, hub):
    for i in range(1, 11):
        hub.ingest(_pkt(i))
    c = Sse(web.port, path="/stream")
    evs = c.read(2)
    epoch = c.json(evs[0])["epoch"]
    c.close()
    hub.ingest(_pkt(11))
    time.sleep(0.1)
    c2 = Sse(web.port, path=f"/stream?since={epoch}:10")
    try:
        evs2 = c2.read(2)
        assert c2.json(evs2[0])["resume"] is True and c2.json(evs2[1])["r"][0][P.FAST_INDEX["SpeedKmh"]] == pytest.approx(11 * 3.6, abs=0.1)
    finally:
        c2.close()


def test_garbage_last_event_id_is_ignored(web, hub):
    hub.ingest(_pkt(1))
    c = Sse(web.port, headers={"Last-Event-ID": "not-a-number"})
    try:
        assert c.read(2)[0]["event"] == "hello"
    finally:
        c.close()


def test_source_change_sends_reset_and_closes_the_stream(web, hub):
    for i in range(1, 6):
        hub.ingest(_pkt(i))
    c = Sse(web.port)
    try:
        c.read(2)
        hub.start("127.0.0.1", 0)                          # new session
        evs = c.read(10, until=lambda e: e["event"] == "reset", limit=5)
        assert evs and evs[-1]["event"] == "reset"
        assert c.resp.fp.readline() == b""                  # stream was closed by the server
    finally:
        c.close()
    c2 = Sse(web.port)                                      # reconnect: fresh hello, new epoch
    try:
        e = c2.read(1)[0]
        assert e["event"] == "hello" and c2.json(e)["epoch"] == hub.session
    finally:
        c2.close()


def test_range_events_are_sent_and_contain_the_data(web, hub):
    c = Sse(web.port)
    try:
        c.read(2)
        for i in range(120):
            hub.ingest(_pkt(i, Power=(100 + i) * 1000.0))
            time.sleep(0.002)
        ranges = {}
        end = time.monotonic() + 5
        while time.monotonic() < end and "engine_power_torque" not in ranges:
            for e in c.read(1, limit=1):
                if e["event"] == "rg":
                    ranges.update(c.json(e))
        lo, hi = ranges["engine_power_torque"]
        assert lo <= 0 and hi >= 100 * 1.34102
    finally:
        c.close()


# ---------------------------------------------------------------------------
# limits, lifecycle
# ---------------------------------------------------------------------------


def test_per_ip_limit_returns_503(hub, static_dir):
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0, max_per_ip=2, max_clients=8)
    port = w.start("127.0.0.1", 0)
    clients = []
    try:
        for _ in range(2):
            c = Sse(port)
            assert c.resp.status == 200
            clients.append(c)
        c3 = Sse(port)
        assert c3.resp.status == 503
        c3.close()
        clients[0].close()
        deadline = time.monotonic() + 3                     # slot frees up after disconnect
        while time.monotonic() < deadline and w.client_count >= 2:
            time.sleep(0.05)
        c4 = Sse(port)
        assert c4.resp.status == 200
        c4.close()
    finally:
        for c in clients:
            c.close()
        w.stop()


def test_total_client_limit(hub, static_dir):
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0, max_per_ip=10, max_clients=3)
    port = w.start("127.0.0.1", 0)
    cs = [Sse(port) for _ in range(3)]
    try:
        assert all(c.resp.status == 200 for c in cs)
        extra = Sse(port)
        assert extra.resp.status == 503
        extra.close()
    finally:
        for c in cs:
            c.close()
        w.stop()


def test_busy_port_raises_a_friendly_error(hub, static_dir):
    a = WebServer(hub, static_dir=static_dir)
    port = a.start("127.0.0.1", 0)
    try:
        b = WebServer(hub, static_dir=static_dir)
        with pytest.raises(WebBindError) as ei:
            b.start("127.0.0.1", port)
        assert "already in use" in str(ei.value)
        assert not b.running
    finally:
        a.stop()


def test_stop_is_fast_closes_open_streams_and_frees_the_port(hub, static_dir):
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0)
    port = w.start("127.0.0.1", 0)
    c = Sse(port)
    c.read(2)
    t0 = time.monotonic()
    w.stop()
    w.stop()                                                # idempotent
    assert time.monotonic() - t0 < 3.0
    c.resp.fp.readline()                                    # drain; must not hang
    c.close()
    w2 = WebServer(hub, static_dir=static_dir)
    assert w2.start("127.0.0.1", port) == port              # port is free again
    w2.stop()


def test_broadcaster_parks_with_no_viewers_and_resyncs_on_connect(web, hub):
    for i in range(1, 6):
        hub.ingest(_pkt(i))
    time.sleep(0.3)
    cursor_idle = web._cursor
    for i in range(6, 40):
        hub.ingest(_pkt(i))
    time.sleep(0.3)
    assert web._cursor == cursor_idle                       # parked: it did not follow the hub
    c = Sse(web.port)
    try:
        evs = c.read(2)
        hist = c.json(evs[1])
        assert hist["s"] + len(hist["r"]) - 1 == 39         # history ends at the newest frame
    finally:
        c.close()


def test_slow_client_is_dropped_without_affecting_others(hub, static_dir):
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0)
    w.start("127.0.0.1", 0)
    try:
        slow = S._Client("1.2.3.4")
        fast = S._Client("1.2.3.5")
        w._clients.extend([slow, fast])
        t = 100.0
        for k in range(30):                                   # `slow` never drains its queue
            with w._lock:
                w._dispatch(b"x", t + k * 0.2)
            try:
                while True:
                    fast.q.get_nowait()
            except queue.Empty:
                pass
        assert slow.dropped and not fast.dropped
    finally:
        w._clients.clear()
        w.stop()


def test_broadcaster_survives_a_tick_exception(hub, static_dir, monkeypatch, tmp_path):
    from fh6_telemetry.core import diagnostics

    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    w = WebServer(hub, static_dir=static_dir, tick_hz=100.0)
    port = w.start("127.0.0.1", 0)
    c = Sse(port)
    try:
        c.read(2)
        calls = {"n": 0}
        orig = w._tick

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom")
            orig()

        monkeypatch.setattr(w, "_tick", flaky)
        hub.ingest(_pkt(1))
        e = c.read(1, until=lambda e: e["event"] == "f", limit=5)
        assert e and e[-1]["event"] == "f"
    finally:
        c.close()
        w.stop()


def test_many_threads_connecting_and_disconnecting(web, hub):
    for i in range(1, 20):
        hub.ingest(_pkt(i))
    errors = []

    def worker():
        try:
            for _ in range(5):
                c = Sse(web.port)
                if c.resp.status == 200:
                    c.read(1)
                c.close()
        except Exception as exc:                            # pragma: no cover
            errors.append(repr(exc))

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert not errors
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and web.client_count:
        time.sleep(0.05)
    assert web.client_count == 0
