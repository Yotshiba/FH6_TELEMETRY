"""
Telemetry parsing — pure Python, no Qt (importable by the headless build).
"""

from __future__ import annotations

import math
import struct

from .constants import FIELDS, PACKET_FORMAT, PACKET_SIZE

_STRUCT = struct.Struct(PACKET_FORMAT)


def parse_packet(data: bytes) -> dict:
    """Unpack a raw UDP datagram into a named-field dict.

    Datagrams shorter than a full packet yield ``{}``; longer ones are
    accepted (only the leading ``PACKET_SIZE`` bytes are used).
    """
    if len(data) < PACKET_SIZE:
        return {}
    return dict(zip(FIELDS, _STRUCT.unpack_from(data)))


def secs_to_time(s: float) -> str:
    """Format a float number of seconds as M:SS.mmm (``--:--.---`` if unset)."""
    if not isinstance(s, (int, float)) or not math.isfinite(s) or s <= 0:
        return "--:--.---"
    # Round to whole milliseconds first so 59.9996 s can't print as "0:60.000".
    minutes, millis = divmod(int(round(s * 1000.0)), 60_000)
    return f"{minutes}:{millis / 1000.0:06.3f}"
