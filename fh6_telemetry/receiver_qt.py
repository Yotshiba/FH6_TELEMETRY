"""
Qt adapter around :class:`~fh6_telemetry.core.udp_source.UdpSource`.

Emits one ``data_ready(dict)`` signal per valid packet.  (Phase 4 replaces this
per-packet signal with a polled hub; until then it keeps the original behaviour.)
"""

from __future__ import annotations

from PyQt6.QtCore import QObject, pyqtSignal

from .core.udp_source import UdpSource
from .telemetry import parse_packet


class TelemetryReceiver(QObject):
    """Receives FH6 UDP telemetry on a background thread and emits parsed dicts."""

    data_ready = pyqtSignal(dict)

    def __init__(self, host: str, port: int, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._src = UdpSource(host, port, self._on_packet)

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Bind and start.  Raises :class:`UdpBindError` (an ``OSError``)."""
        self._src.start()

    def stop(self) -> None:
        self._src.stop()

    # -- state -------------------------------------------------------------
    @property
    def bound(self) -> tuple[str, int] | None:
        return self._src.bound

    @property
    def packets(self) -> int:
        return self._src.packets

    @property
    def bad_packets(self) -> int:
        return self._src.bad_packets

    @property
    def last_bad_len(self) -> int | None:
        return self._src.last_bad_len

    # -- thread callback ---------------------------------------------------
    def _on_packet(self, data: bytes) -> None:
        telemetry = parse_packet(data)
        if telemetry:
            self.data_ready.emit(telemetry)
