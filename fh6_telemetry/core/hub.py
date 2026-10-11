"""
TelemetryHub — the single, long-lived, Qt-free owner of the telemetry stream.

* a :class:`~fh6_telemetry.core.udp_source.UdpSource` feeds :meth:`ingest`;
* every valid packet becomes a *frame* (see :mod:`core.frames`) stored in a
  fixed-size ring under a monotonically increasing sequence number;
* any number of consumers (the Qt render timer, each web client, a headless
  logger) read it independently with their **own cursor** via
  :meth:`frames_since` — nobody "steals" frames from anybody else;
* ``seq`` never resets, not even when the user reconnects to another address;
  ``session`` increments instead, so consumers know to clear their history.
  Frames of an earlier session are never returned for the current one.

Thread safety: one writer thread (UDP) and many readers.  A single lock guards
only pointer arithmetic and list slicing; frames are built before the lock is
taken and are never mutated afterwards.  Each source publishes through a token
checked *inside* the lock, so a slow old source can never inject a frame into a
newer session.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass

from ..constants import PACKET_SIZE
from ..telemetry import parse_packet
from .frames import make_frame
from .udp_source import UdpBindError, UdpSource

DEFAULT_CAPACITY = 600     # ~8 s at the ~75 packets/s the game sends

_ANY = object()            # direct ingest() calls (tests, tools) are always accepted


@dataclass(frozen=True)
class HubStatus:
    state: str                      # "stopped" | "listening" | "error"
    error: str | None
    bound: tuple[str, int] | None
    session: int
    packets: int                    # valid frames ingested over the hub's lifetime
    session_packets: int            # … since the current source was started
    bad_packets: int                # datagrams shorter than a full packet (this source)
    last_bad_len: int | None
    last_rx_age: float | None       # seconds since the last valid frame
    pps: float                      # recent packets per second


class TelemetryHub:
    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity < 2:
            raise ValueError("capacity must be >= 2")
        self.capacity = capacity
        self._ring: list[tuple[int, dict] | None] = [None] * capacity
        self._seq = 0
        self._base = 0                        # seq at the start of the current session
        self._head: tuple[int, dict] | None = None
        self._lock = threading.Lock()
        self._ctl = threading.Lock()          # serialises start()/stop()
        self._source: UdpSource | None = None
        self._token: object | None = None
        self._session = 0
        self._error: str | None = None
        self._last_rx: float | None = None
        self._arrivals: deque[float] = deque(maxlen=128)

    # ------------------------------------------------------------------
    # Source control
    # ------------------------------------------------------------------

    def start(self, host: str, port: int) -> int:
        """(Re)start listening on *host*:*port*.  Raises :class:`UdpBindError`.

        The ring and ``seq`` are kept; ``session`` is bumped on success.  If the
        bind fails the previous source has already been stopped and the error
        is available from :meth:`status`.

        Returns the sequence number at the session boundary: every frame with a
        higher number belongs to the new source, so a consumer that starts its
        cursor there misses nothing and sees nothing of the old source.
        """
        with self._ctl:
            self._stop_source()
            token = object()
            src = UdpSource(host, port, lambda data, t=token: self.ingest(data, t))
            try:
                src.bind()
            except UdpBindError as exc:
                self._error = str(exc)
                raise
            # Publish the new session *before* the first packet can arrive, so a
            # consumer never sees new-source frames under the old session number.
            with self._lock:
                self._token = token
                self._source = src
                self._error = None
                self._session += 1
                self._base = self._seq
                base = self._seq
            src.run()
            return base

    def stop(self) -> None:
        with self._ctl:
            self._stop_source()

    def _stop_source(self) -> None:
        with self._lock:
            src, self._source = self._source, None
            self._token = None               # late frames of this source are rejected
        if src is not None:
            src.stop()

    # ------------------------------------------------------------------
    # Producer
    # ------------------------------------------------------------------

    def ingest(self, data: bytes, token: object = _ANY) -> bool:
        """Turn one datagram into a frame and publish it.  Returns False if invalid."""
        raw = parse_packet(data)
        if not raw:
            return False
        head = self._head
        frame = make_frame(raw, head[1] if head is not None else None)
        now = time.monotonic()
        with self._lock:
            if token is not _ANY and token is not self._token:
                return False                  # a stopped / superseded source
            seq = self._seq + 1
            self._ring[seq % self.capacity] = (seq, frame)
            self._seq = seq
            self._head = (seq, frame)
            self._last_rx = now
        self._arrivals.append(now)
        return True

    # ------------------------------------------------------------------
    # Consumers
    # ------------------------------------------------------------------

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def session(self) -> int:
        return self._session

    def head(self) -> tuple[int, dict] | None:
        """``(seq, latest_frame)`` or None before the first packet."""
        return self._head

    def frames_since(self, seq: int) -> tuple[int, list[dict], int]:
        """Frames of the current session after sequence number *seq*.

        Returns ``(new_seq, frames, dropped)``: pass ``new_seq`` next time.
        ``dropped`` counts frames that fell out of the ring before the caller
        came back (it only ever sees the newest ``capacity`` frames).  A cursor
        older than the current session starts at the session boundary.
        """
        with self._lock:
            cur = self._seq
            seq = max(seq, self._base, 0)
            if seq >= cur:
                return cur, [], 0
            n = cur - seq
            dropped = max(0, n - self.capacity)
            n -= dropped
            ring, cap = self._ring, self.capacity
            frames = [ring[s % cap][1] for s in range(cur - n + 1, cur + 1)]
        return cur, frames, dropped

    def history(self, k: int | None = None) -> list[dict]:
        """The newest *k* frames of the current session, oldest first."""
        k = self.capacity if k is None else min(k, self.capacity)
        with self._lock:
            cur = self._seq
            n = min(k, cur - self._base)
            ring, cap = self._ring, self.capacity
            return [ring[s % cap][1] for s in range(cur - n + 1, cur + 1)]

    def status(self) -> HubStatus:
        src = self._source
        now = time.monotonic()
        arrivals = list(self._arrivals)
        recent = [a for a in arrivals if now - a <= 2.0]
        pps = 0.0
        if len(recent) >= 2 and recent[-1] > recent[0]:
            pps = (len(recent) - 1) / (recent[-1] - recent[0])
        error = self._error
        if src is not None and src.failure:
            state, error = "error", src.failure
        elif src is not None:
            state = "listening"
        else:
            state = "error" if error else "stopped"
        return HubStatus(
            state=state,
            error=error,
            bound=src.bound if src is not None else None,
            session=self._session,
            packets=self._seq,
            session_packets=self._seq - self._base,
            bad_packets=src.bad_packets if src is not None else 0,
            last_bad_len=src.last_bad_len if src is not None else None,
            last_rx_age=None if self._last_rx is None else now - self._last_rx,
            pps=round(pps, 1),
        )


__all__ = ["TelemetryHub", "HubStatus", "UdpBindError", "PACKET_SIZE"]
