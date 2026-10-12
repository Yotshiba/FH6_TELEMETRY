"""
WebServer — serves the dashboard page and streams telemetry to browsers.

Design (see ``web/protocol.py`` for the wire format):

* standard-library ``ThreadingHTTPServer``; one thread per connection (a handful
  of phones/tablets), requests are tiny except ``/stream`` which stays open;
* **one broadcaster thread** reads the hub with its own cursor at ``tick_hz``,
  encodes each message **once** and ``put_nowait``s the bytes into every
  client's bounded queue; a client whose queue stays full is dropped (the
  browser reconnects and resumes) so a stuck phone can never stall the others
  or grow memory;
* the broadcaster **parks** (sleeps) while nobody is connected — a running
  server with no viewers costs essentially nothing;
* static files come from an in-memory allowlist read once at start (no
  directory listing, no path traversal), no CORS headers are sent, and only
  private / loopback / link-local peers are served;
* the TCP port is bound exclusively and synchronously: a busy port raises
  :class:`WebBindError` immediately instead of failing inside a thread.
"""

from __future__ import annotations

import hashlib
import ipaddress
import mimetypes
import os
import queue
import select
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ..constants import HISTORY_LEN
from ..core.diagnostics import log_exception
from ..core.hub import TelemetryHub
from . import protocol as P

DEFAULT_PORT = 8077
_SENTINEL = object()
_STREAM_SEND_TIMEOUT = 5.0
_KEEPALIVE_S = 10.0

_SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy",
     "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
     "connect-src 'self'; base-uri 'none'; form-action 'none'"),
)

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class WebBindError(OSError):
    """The HTTP port could not be bound; ``str()`` is a user-facing message."""

    def __init__(self, host: str, port: int, cause: OSError) -> None:
        code = getattr(cause, "winerror", None) or cause.errno
        if code in (10048, 10013, 98, 48, 13):
            msg = f"port {port} is already in use by another program"
        elif code in (10049, 99, 49):
            msg = f"address {host} is not available on this PC"
        else:
            msg = cause.strerror or str(cause)
        super().__init__(cause.errno, msg)
        self.host, self.port = host, port

    def __str__(self) -> str:
        return str(self.strerror)


class _Client:
    __slots__ = ("q", "ip", "dropped", "full_since")

    def __init__(self, ip: str) -> None:
        self.q: queue.Queue = queue.Queue(maxsize=8)
        self.ip = ip
        self.dropped = False
        self.full_since: float | None = None


_CGNAT = ipaddress.ip_network("100.64.0.0/10")      # Tailscale & friends


def _allowed_peer(ip: str) -> bool:
    """Serve only LAN-ish peers: private, loopback, link-local or CGNAT/VPN.

    Anything arriving with a public source address (e.g. a router that
    port-forwards the web port to the Internet) is refused.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.version != 4:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr in _CGNAT


def _parse_event_id(raw: str | None) -> tuple[int, int] | None:
    """``"<epoch>:<seq>"`` → ``(epoch, seq)``; anything else → None."""
    if not raw:
        return None
    try:
        e, _, s = raw.partition(":")
        return int(e), int(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------


class _HTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 32

    def server_bind(self) -> None:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if excl is not None:                 # Windows: nobody may share this port
            self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)         # HTTPServer.server_bind would call getfqdn()
        self.server_port = port

    def process_request(self, request, client_address) -> None:
        if not self.web._slots.acquire(blocking=False):      # too many open requests
            try:
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.web._slots.release()


class _Handler(BaseHTTPRequestHandler):
    timeout = 10                       # reading the request
    server_version = "FH6Telemetry"
    sys_version = ""

    def log_message(self, format, *args) -> None:   # noqa: A002 - stdlib signature
        pass                           # also keeps a windowed exe (stderr=None) safe

    # -- helpers ----------------------------------------------------------
    @property
    def web(self) -> "WebServer":
        return self.server.web         # type: ignore[attr-defined]

    def _headers(self, extra=()) -> None:
        for k, v in _SECURITY_HEADERS:
            self.send_header(k, v)
        for k, v in extra:
            self.send_header(k, v)

    def _plain(self, status: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8",
               head_only: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._headers()
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    # -- routing ----------------------------------------------------------
    def do_HEAD(self) -> None:
        self._route(head_only=True)

    def do_GET(self) -> None:
        self._route(head_only=False)

    def _route(self, head_only: bool) -> None:
        if not _allowed_peer(self.client_address[0]):
            self._plain(403, b"forbidden: LAN clients only", head_only=head_only)
            return
        try:
            url = urlsplit(self.path)
        except ValueError:                              # e.g. an invalid IPv6 literal in the request target
            self._plain(400, b"bad request", head_only=head_only)
            return
        path = url.path
        if path == "/stream":
            if head_only:
                self._plain(405, b"", head_only=True)
            else:
                self._stream(url.query)
        elif path == "/healthz":
            self._plain(200, b"ok", head_only=head_only)
        elif path == "/api/snapshot":
            self._plain(200, self.web.snapshot_json().encode(), "application/json",
                        head_only=head_only)
        else:
            asset = self.web.get_asset("/index.html" if path == "/" else path)
            if asset is None:
                self._plain(404, b"not found", head_only=head_only)
                return
            body, ctype, etag = asset
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self._headers()
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")      # always revalidate
            self._headers()
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

    # -- SSE ---------------------------------------------------------------
    def _peer_gone(self) -> bool:
        """True once the browser closed the connection (EOF is readable)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if readable:
                return self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True
        return False

    def _stream(self, query: str) -> None:
        web = self.web
        qs = parse_qs(query)
        since = _parse_event_id(self.headers.get("Last-Event-ID") or (qs.get("since") or [None])[0])
        reg = web.register(self.client_address[0])
        if reg is None:
            self._plain(503, b"too many viewers")
            return
        client, cursor, epoch = reg
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self._headers()
            self.end_headers()
            self.connection.settimeout(_STREAM_SEND_TIMEOUT)    # a stalled phone can't hang us
            self.wfile.write(b"retry: 1500\n\n")
            for chunk in web.initial_chunks(cursor, epoch, since):
                self.wfile.write(chunk)
            last_write = last_check = time.monotonic()
            while not web.stopping and not client.dropped:
                if time.monotonic() - last_check >= 1.0:       # notice a closed tab promptly
                    last_check = time.monotonic()
                    if self._peer_gone():
                        break
                try:
                    item = client.q.get(timeout=1.0)
                except queue.Empty:
                    if time.monotonic() - last_write >= _KEEPALIVE_S:
                        self.wfile.write(b": ka\n\n")
                        last_write = time.monotonic()
                    continue
                if item is _SENTINEL:
                    break
                self.wfile.write(item)
                last_write = time.monotonic()
                if item.startswith(b"event: reset"):
                    break
        except (OSError, ValueError):
            pass                        # client went away / send timed out
        except Exception as exc:        # pragma: no cover - defensive
            log_exception("web stream", exc)
        finally:
            web.unregister(client)


# ---------------------------------------------------------------------------
# The server
# ---------------------------------------------------------------------------


class WebServer:
    def __init__(
        self,
        hub: TelemetryHub,
        *,
        static_dir: Path | None = None,
        tick_hz: float = 30.0,
        max_clients: int = 8,
        max_per_ip: int = 4,
        history_len: int = HISTORY_LEN,
    ) -> None:
        self.hub = hub
        self.tick_hz = float(tick_hz)
        self.max_clients = max_clients
        self.max_per_ip = max_per_ip
        self.history_len = history_len
        self.static_dir = Path(static_dir) if static_dir else Path(__file__).parent / "static"
        self.assets: dict[str, tuple[bytes, str, str]] = {}
        # FH6_WEB_DEV=1: re-read files from disk on every request (edit, reload, repeat)
        self.dev = bool(os.environ.get("FH6_WEB_DEV"))

        self._lock = threading.Lock()
        self._clients: list[_Client] = []
        self._cursor = 0
        self._epoch = 0
        self._ranges = P.RangeTracker(history_len)
        self._slow_last: list | None = None
        self._slow_t = 0.0
        self._st_t = 0.0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._slots = threading.BoundedSemaphore(32)
        self._httpd: _HTTPServer | None = None
        self._threads: list[threading.Thread] = []

    # -- state ------------------------------------------------------------
    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    @property
    def running(self) -> bool:
        return self._httpd is not None and not self._stop.is_set()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def bound(self) -> tuple[str, int] | None:
        return self._httpd.server_address[:2] if self._httpd is not None else None

    # -- lifecycle --------------------------------------------------------
    def _load_assets(self) -> None:
        assets: dict[str, tuple[bytes, str, str]] = {}
        root = self.static_dir
        if root.is_dir():
            for path in sorted(p for p in root.rglob("*") if p.is_file()):
                rel = path.relative_to(root).as_posix()
                body = path.read_bytes()
                ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype in ("application/json", "application/manifest+json"):
                    ctype += "; charset=utf-8"
                etag = '"' + hashlib.sha1(body).hexdigest()[:16] + '"'
                key = "/index.html" if rel == "index.html" else f"/static/{rel}"
                assets[key] = (body, ctype, etag)
        self.assets = assets

    def get_asset(self, key: str):
        """The (body, content-type, etag) for a URL path, or None."""
        if self.dev:
            self._load_assets()
        return self.assets.get(key)

    def start(self, host: str = "0.0.0.0", port: int = DEFAULT_PORT) -> int:
        """Bind and serve.  Returns the bound port.  Raises :class:`WebBindError`."""
        if self._httpd is not None:
            raise RuntimeError("already started")
        self._load_assets()
        try:
            httpd = _HTTPServer((host, port), _Handler)
        except OSError as exc:
            raise WebBindError(host, port, exc) from exc
        httpd.web = self                                   # type: ignore[attr-defined]
        self._httpd = httpd
        self._stop.clear()
        self._cursor = self.hub.seq
        self._epoch = self.hub.session
        serve = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1},
                                 name="fh6-web-http", daemon=True)
        bcast = threading.Thread(target=self._broadcast_loop, name="fh6-web-bcast", daemon=True)
        self._threads = [serve, bcast]
        serve.start()
        bcast.start()
        return httpd.server_address[1]

    def stop(self) -> None:
        httpd, self._httpd = self._httpd, None
        if httpd is None:
            return
        self._stop.set()
        self._wake.set()
        with self._lock:
            for c in self._clients:
                c.dropped = True
                try:
                    while True:
                        c.q.get_nowait()
                except queue.Empty:
                    pass
                c.q.put_nowait(_SENTINEL)
        httpd.shutdown()
        httpd.server_close()
        for t in self._threads:
            t.join(timeout=1.5)
        self._threads = []

    # -- clients ----------------------------------------------------------
    def register(self, ip: str):
        """Add a viewer.  Returns ``(client, cursor, epoch)`` or None if full."""
        with self._lock:
            if len(self._clients) >= self.max_clients:
                return None
            if sum(1 for c in self._clients if c.ip == ip) >= self.max_per_ip:
                return None
            if not self._clients:                     # waking from the parked state
                self._cursor = self.hub.seq
                self._epoch = self.hub.session
                self._ranges.reset()
                rows = [P.fast_row(f) for f in self.hub.history(self.history_len)]
                self._ranges.feed(rows)
                self._ranges.update(time.monotonic())
                self._slow_last = None
            client = _Client(ip)
            self._clients.append(client)
            result = (client, self._cursor, self._epoch)
        self._wake.set()
        return result

    def unregister(self, client: _Client) -> None:
        with self._lock:
            if client in self._clients:
                self._clients.remove(client)

    def initial_chunks(self, cursor: int, epoch: int, since: tuple[int, int] | None) -> list[bytes]:
        """hello + history (or a resume delta) + latest slow snapshot + status."""
        hub = self.hub
        resume = False
        start = max(0, cursor - self.history_len)
        if since is not None and since[0] == epoch and 0 <= since[1] <= cursor \
                and cursor - since[1] <= hub.capacity:
            resume, start = True, since[1]
        cur, frames, _dropped = hub.frames_since(start)
        keep = len(frames) - (cur - cursor)           # frames up to `cursor` only
        frames = frames[:keep] if keep > 0 else []
        rows = [P.fast_row(f) for f in frames]
        with self._lock:
            ranges = {k: list(v) for k, v in self._ranges.current.items()}
        out = [P.sse("hello", P.dumps(P.hello(
            epoch=epoch, tick_hz=self.tick_hz, resume=resume, ranges=ranges,
            hist_len=self.history_len)))]
        event_id = f"{epoch}:{cursor}"
        if resume:
            if rows:
                out.append(P.sse("f", P.dumps({"s": cursor, "r": rows}), event_id))
        else:
            out.append(P.sse("hist", P.dumps({"s": cursor - len(rows) + 1, "r": rows}), event_id))
        head = hub.head()
        if head is not None:
            out.append(P.sse("s", P.dumps(P.slow_row(head[1]))))
        out.append(self._status_event())
        return out

    # -- broadcasting -----------------------------------------------------
    def _status_event(self) -> bytes:
        st = self.hub.status()
        age = st.last_rx_age
        return P.sse("st", P.dumps({
            "sig": 1 if (age is not None and age < 1.5) else 0,
            "pps": st.pps, "age": None if age is None else round(age, 2),
            "n": len(self._clients), "epoch": st.session,
        }))

    def _dispatch(self, payload: bytes, now: float) -> None:
        """Queue *payload* for every client (caller holds the lock)."""
        for c in self._clients:
            try:
                c.q.put_nowait(payload)
                c.full_since = None
            except queue.Full:
                if c.full_since is None:
                    c.full_since = now
                elif now - c.full_since > 2.0:
                    c.dropped = True               # too slow: it will reconnect and resume

    def _broadcast_loop(self) -> None:
        period = 1.0 / self.tick_hz
        nxt = time.monotonic()
        while not self._stop.is_set():
            if not self._clients:                  # parked: no viewers, no work
                self._wake.wait(0.5)
                self._wake.clear()
                nxt = time.monotonic()
                continue
            delay = nxt - time.monotonic()
            if delay > 0 and self._stop.wait(delay):
                break
            nxt += period
            if nxt < time.monotonic() - 1.0:       # fell far behind: don't spiral
                nxt = time.monotonic()
            try:
                self._tick()
            except Exception as exc:
                log_exception("web broadcaster", exc)

    def _tick(self) -> None:
        hub = self.hub
        now = time.monotonic()
        with self._lock:
            cursor, epoch = self._cursor, self._epoch
        if hub.session != epoch:                   # the telemetry source changed
            with self._lock:
                self._dispatch(P.sse("reset", P.dumps({"epoch": hub.session})), now)
                self._epoch = hub.session
                self._cursor = hub.seq
                self._ranges.reset()
                self._slow_last = None
            return
        new_seq, frames, _dropped = hub.frames_since(cursor)
        events: list[bytes] = []
        if frames:
            rows = [P.fast_row(f) for f in frames]
            self._ranges.feed(rows)
            events.append(P.sse("f", P.dumps({"s": new_seq, "r": rows}), f"{epoch}:{new_seq}"))
            if now - self._slow_t >= 0.1:
                srow = P.slow_row(frames[-1])
                if srow != self._slow_last:
                    events.append(P.sse("s", P.dumps(srow)))
                    self._slow_last = srow
                self._slow_t = now
            changed = self._ranges.update(now)
            if changed:
                events.append(P.sse("rg", P.dumps(changed)))
        if now - self._st_t >= 1.0:
            events.append(self._status_event())
            self._st_t = now
        with self._lock:
            for ev in events:
                self._dispatch(ev, now)
            self._cursor = new_seq

    # -- debug endpoint ---------------------------------------------------
    def snapshot_json(self) -> str:
        head = self.hub.head()
        st = self.hub.status()
        body: dict = {
            "seq": self.hub.seq, "session": st.session, "state": st.state,
            "pps": st.pps, "viewers": len(self._clients),
        }
        if head is not None:
            f = head[1]
            body["F"] = dict(zip((k for k, _d, _u in P.FAST), P.fast_row(f)))
            body["S"] = dict(zip((k for k, _d, _g in P.SLOW), P.slow_row(f)))
        return P.dumps(body)
