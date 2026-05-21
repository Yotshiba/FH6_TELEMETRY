"""
Telemetry parsing and UDP receiver thread.
"""

from __future__ import annotations

import socket
import struct

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import QWidget

from .constants import FIELDS, PACKET_FORMAT, PACKET_SIZE


def parse_packet(data: bytes) -> dict:
    """Unpack a raw UDP datagram into a named-field dict."""
    if len(data) < PACKET_SIZE:
        return {}
    return dict(zip(FIELDS, struct.unpack_from(PACKET_FORMAT, data)))


def secs_to_time(s: float) -> str:
    """Format a float number of seconds as MM:SS.mmm."""
    if s <= 0:
        return "--:--.---"
    minutes = int(s // 60)
    seconds = s % 60
    return f"{minutes}:{seconds:06.3f}"


class TelemetryReceiver(QThread):
    """Receives FH6 UDP telemetry packets on a background thread and emits
    parsed dicts via ``data_ready``."""

    data_ready = pyqtSignal(dict)

    def __init__(
        self, host: str, port: int, parent: QWidget | None = None
    ) -> None:
        super().__init__(parent)
        self._host    = host
        self._port    = port
        self._running = True

    def stop(self) -> None:
        self._running = False

    def run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(1.0)
        sock.bind((self._host, self._port))
        while self._running:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(data) >= PACKET_SIZE:
                telemetry = parse_packet(data)
                if telemetry:
                    self.data_ready.emit(telemetry)
        sock.close()
