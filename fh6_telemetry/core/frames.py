"""
Frame building: one parsed packet → one immutable-by-convention *frame* dict.

A frame is what every consumer (desktop windows, web clients) sees:

* all floats are finite — a NaN / inf from the game is replaced by the same
  field's value in the previous frame (or 0.0), so neither Qt's ``setRange``
  nor ``json.dumps`` can ever be handed one;
* tyre temperatures are in °C (FH6 broadcasts Fahrenheit), with the long-standing
  ``<= 0 → 0.1`` display clamp that keeps paused/zero packets from reading as
  −17.8 °C;
* the display channels (km/h, hp, %, …) from :func:`core.derive.display_channels`
  are included.

Consumers must treat frames as read-only (they are shared between threads).
"""

from __future__ import annotations

import math

from ..constants import WHEELS
from .derive import display_channels

_TEMP_KEYS = tuple(f"TireTemp{w}" for w in WHEELS)


def make_frame(raw: dict, prev: dict | None = None) -> dict:
    """Build a frame from a parsed packet; *prev* is the previous frame (or None)."""
    t = dict(raw)
    isfinite = math.isfinite

    # Tyre temps first (°F → °C); a non-finite one repeats the previous frame.
    for key in _TEMP_KEYS:
        v = t.get(key, 0.0)
        if isfinite(v):
            c = (v - 32.0) * 5.0 / 9.0
            t[key] = c if c > 0.0 else 0.1
        else:
            t[key] = prev[key] if prev is not None and key in prev else 0.1

    # Any other non-finite float repeats its previous value (or becomes 0.0).
    bad = [k for k, v in t.items() if v.__class__ is float and not isfinite(v)]
    for k in bad:
        t[k] = prev.get(k, 0.0) if prev is not None else 0.0

    t.update(display_channels(t))
    return t
