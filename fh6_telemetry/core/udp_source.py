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
* packets shorter than the expected size are counted, not silently dropped.
"""

from __future__ import annotations

import socket
import threading
from typing import Callable

from ..constants import PACKET_SIZE
from .diagnostics import log_exception

_RCVBUF = 512 * 1024
_POLL_TIMEOUT = 0.25


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
    code = getattr(exc, "winerror", None) or exc.errno
    if code in (10048, 98, 48):  # WSAEADDRINUSE / EADDRINUSE (linux, mac)
        return f"port {port} is already in use by another program"
    if code in (10013, 13):  # WSAEACCES: exclusive bind refused / blocked
        return f"port {port} is in use by another program (or blocked by Windows)"
    if code in (10049, 99, 49):  # WSAEADDRNOTAVAIL
        return f"address {host} is not available on this PC"
    return exc.strerror or str(exc)


class _Run:
    """One start()→stop() generation."""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None


class UdpSource:
    """Receives datagrams and hands the *valid* ones to ``on_packet(bytes)``.

    ``on_packet`` runs on the receive thread; keep it short.
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

    # -- state -------------------------------------------------------------
    @property
    def running(self) -> bool:
        run = self._run
        return run is not None and not run.stop.is_set()

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
    def start(self) -> None:
        """Bind and start receiving.  Raises :class:`UdpBindError`."""
        with self._lock:
            if self.running:
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
            except OSError as exc:
                sock.close()
                raise UdpBindError(self.host, self.port, exc) from exc

            run = _Run(sock)
            run.thread = threading.Thread(
                target=self._loop, args=(run,), name="fh6-udp", daemon=True
            )
            self._run = run
            run.thread.start()

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
        while not run.stop.is_set():
            try:
                data, _addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except ConnectionResetError:  # ICMP "port unreachable" noise
                continue
            except OSError:
                break  # socket closed by stop(), or a fatal error
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
