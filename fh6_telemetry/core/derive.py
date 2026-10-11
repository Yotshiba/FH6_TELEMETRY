"""
Pure, Qt-free helpers shared by the desktop widgets and (later) the web server.

Everything here is a plain function of numbers/strings so it can be unit
tested and imported by a headless build.
"""

from __future__ import annotations

import math

from ..constants import _TEMP_COLORS, GEAR_MAP

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------


def get_temp_color(temp: float) -> str:
    """Hex colour for a tyre temperature in °C (first threshold above wins)."""
    for threshold, colour in _TEMP_COLORS:
        if temp < threshold:
            return colour
    return _TEMP_COLORS[-1][1]


GREEN, AMBER, RED = "#22BB44", "#FF9900", "#DD2200"


def bar_color(value: float, danger: float, invert: bool = False) -> str:
    """Green → amber → red colour of a progress bar.

    Normally the bar gets worse as *value* rises towards ``danger`` (throttle,
    slip …).  With ``invert=True`` it gets worse as *value* falls towards
    ``danger`` (fuel): green above ``danger / 0.6``, amber down to ``danger``,
    red at or below it.
    """
    if not math.isfinite(value) or danger <= 0:
        return GREEN
    if invert:
        if value <= 0:
            return RED
        ratio = danger / value
    else:
        ratio = value / danger
    if ratio < 0.6:
        return GREEN
    if ratio < 1.0:
        return AMBER
    return RED


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------


def gear_label(code: int, previous: str | None = None) -> str:
    """Gear code → label ("R", "N", "1" …).

    The game emits a one-packet transient (code 11) at each shift that is not a
    real gear; unknown codes keep showing the *previous* label when there is
    one, instead of flashing the raw number.
    """
    label = GEAR_MAP.get(code)
    if label is not None:
        return label
    return previous if previous is not None else str(code)
