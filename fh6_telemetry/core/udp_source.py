"""
UdpSource — the UDP receive thread, with no Qt dependency.

Differences from the original ``TelemetryReceiver(QThread)``:

* the socket is bound **synchronously in the caller's thread**, so a busy or
  invalid address is reported to the UI instead of dying inside the thread;
* ``SO_REUSEADDR`` is *not* set (on Windows it lets two sockets share a port
  silently, splitting packets between them); ``SO_EXCLUSIVEADDRUSE`` is used
  instead, so a second listener gets a real error;
* a larger receive buffer rides out short GUI stalls;
* ``stop()`` closes the socket to unblock ``recvfrom`` and returns quickly;
* a generation token stops a stale thread from publishing after a restart;
* packets shorter than the expected size (or oversized ones) are counted, not
  silently dropped, and a transient socket error never kills the thread.
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Callable

from ..constants import PACKET_SIZE
from .diagnostics import log_exception

_RCVBUF = 512 * 1024
_POLL_TIMEOUT = 0.25
_MAX_DATAGRAM = 65535          # larger than any UDP payload: oversize is never an error
_MAX_CONSECUTIVE_ERRORS = 40   # ~2 s of back-to-back failures => give up and report


class UdpBindError(OSError):
    """Binding the UDP socket failed; ``str()`` is a user-facing message."""

    def __init__(self, host: str, port: int, cause: OSError) -> None:
        self.host = host
        self.port = port
        self.cause = cause
        super().__init__(cause.errno, describe_bind_error(host, port, cause))

    def __str__(self) -> str:
        return str(self.strerror)


def describe_bind_error(host: str, port: int, exc: OSError) -> str:
    if isinstance(exc, socket.gaierror):
        return f"'{host}' is not a valid IPv4 address"
    code = getattr(exc, "winerror", None) or exc.errno
    if code in (10048, 98, 48):  # WSAEADDRINUSE / EADDRINUSE (linux, mac)
        return f"port {port} is already in use by another program"
    if code in (10013, 13):  # WSAEACCES: exclusive bind refused / blocked
        return f"port {port} is in use by another program (or blocked by Windows)"
    if code in (10049, 99, 49):  # WSAEADDRNOTAVAIL
        return f"address {host} is not available on this PC"
    return exc.strerror or str(exc)


class _Run:
    """One bind()→stop() generation."""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None


class UdpSource:
    """Receives datagrams and hands the *valid* ones to ``on_packet(bytes)``.

    ``on_packet`` runs on the receive thread; keep it short.  ``start()`` is
    ``bind()`` (may raise) followed by ``run()``; callers that must publish
    state *between* a successful bind and the first packet use them separately.
    """

    def __init__(
        self,
        host: str,
        port: int,
        on_packet: Callable[[bytes], None],
        *,
        packet_size: int = PACKET_SIZE,
    ) -> None:
        self.host = host
        self.port = port
        self._on_packet = on_packet
        self._packet_size = packet_size
        self._run: _Run | None = None
        self._lock = threading.Lock()
        self.packets = 0
        self.bad_packets = 0
        self.last_bad_len: int | None = None
        self.failure: str | None = None      # set if the receive loop gave up

    # -- state -------------------------------------------------------------
    @property
    def running(self) -> bool:
        run = self._run
        return run is not None and not run.stop.is_set() and self.failure is None

    @property
    def bound(self) -> tuple[str, int] | None:
        run = self._run
        if run is None or run.stop.is_set():
            return None
        try:
            return run.sock.getsockname()[:2]
        except OSError:
            return None

    # -- lifecycle ---------------------------------------------------------
    def bind(self) -> None:
        """Create and bind the socket.  Raises :class:`UdpBindError`."""
        with self._lock:
            if self._run is not None and not self._run.stop.is_set():
                return
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
                if exclusive is not None:  # Windows
                    sock.setsockopt(socket.SOL_SOCKET, exclusive, 1)
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, _RCVBUF)
                except OSError:
                    pass
                sock.settimeout(_POLL_TIMEOUT)
                sock.bind((self.host, self.port))
            except (OSError, OverflowError, ValueError, UnicodeError, TypeError) as exc:
                sock.close()
                cause = exc if isinstance(exc, OSError) else OSError(0, str(exc))
                raise UdpBindError(self.host, self.port, cause) from exc
            self.failure = None
            self._run = _Run(sock)

    def run(self) -> None:
        """Start the receive thread (after a successful :meth:`bind`)."""
        with self._lock:
            run = self._run
            if run is None or run.thread is not None:
                return
            run.thread = threading.Thread(
                target=self._loop, args=(run,), name="fh6-udp", daemon=True
            )
            run.thread.start()

    def start(self) -> None:
        """Bind and start receiving.  Raises :class:`UdpBindError`."""
        self.bind()
        self.run()

    def stop(self, timeout: float = 1.0) -> None:
        """Stop receiving; returns once the thread has ended (or *timeout*)."""
        with self._lock:
            run, self._run = self._run, None
        if run is None:
            return
        run.stop.set()
        try:
            run.sock.close()  # unblocks a pending recvfrom
        except OSError:
            pass
        thread = run.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)

    # -- thread ------------------------------------------------------------
    def _loop(self, run: _Run) -> None:
        sock = run.sock
        errors = 0
        while not run.stop.is_set():
            try:
                data, _addr = sock.recvfrom(_MAX_DATAGRAM)
            except socket.timeout:
                continue
            except ConnectionResetError:  # ICMP "port unreachable" noise
                continue
            except OSError as exc:
                if run.stop.is_set():
                    break  # closed by stop()
                # A transient error (WSAENOBUFS, …) must not end reception silently.
                errors += 1
                log_exception("udp recvfrom", exc)
                if errors >= _MAX_CONSECUTIVE_ERRORS:
                    self.failure = f"socket error: {exc.strerror or exc}"
                    break
                time.sleep(0.05)
                continue
            errors = 0
            if run.stop.is_set() or self._run is not run:
                break  # stale generation — never publish
            if len(data) < self._packet_size:
                self.bad_packets += 1
                self.last_bad_len = len(data)
                continue
            self.packets += 1
            try:
                self._on_packet(data)
            except Exception as exc:  # a bad frame must not kill the thread
                log_exception("udp on_packet", exc)
