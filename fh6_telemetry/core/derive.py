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


# ---------------------------------------------------------------------------
# Display channels (units conversions, one definition for Qt charts and web)
# ---------------------------------------------------------------------------

KMH_PER_MS = 3.6
MPH_PER_MS = 2.23694
HP_PER_KW = 1.34102
BAR_PER_PSI = 0.0689476
G = 9.80665


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


_REVERSE_GEAR = next(code for code, label in GEAR_MAP.items() if label == "R")


def sideslip_deg(vx: float, vz: float, speed: float, gear: int | None = None) -> float:
    """Angle between the car's nose and its direction of travel (degrees, -180..180).

    ``VelocityX/Z`` are in the car's own frame (X right, Z forward), so this is
    ``atan2(vx, vz)``: 0 when driving straight, large and signed when sliding.
    The whole range is reported for forward gears, so a spin-out (the car
    travelling more than 90 degrees away from where its nose points) reads as
    such instead of snapping back to 0.  Meaningless at a standstill (below
    3 m/s) and when driving in reverse (*gear* is the raw gear code, 0 = "R"),
    where it reads 0.
    """
    if speed < 3.0 or gear == _REVERSE_GEAR:
        return 0.0
    return math.degrees(math.atan2(vx, vz))


def display_channels(t: dict) -> dict[str, float]:
    """Derived values in display units for one telemetry dict.

    *t* is a parsed packet whose tyre temperatures are already in °C (the
    launcher / hub converts them).  Returned keys never collide with raw field
    names, so callers can simply ``t.update(display_channels(t))``.
    """
    speed = t.get("Speed", 0.0)
    return {
        "SpeedKmh": speed * KMH_PER_MS,
        "SpeedMph": speed * MPH_PER_MS,
        "PowerHp": t.get("Power", 0.0) / 1000.0 * HP_PER_KW,
        "BoostBar": t.get("Boost", 0.0) * BAR_PER_PSI,
        "FuelPct": t.get("Fuel", 0.0) * 100.0,
        "AccelPct": t.get("Accel", 0) / 255.0 * 100.0,
        "BrakePct": t.get("Brake", 0) / 255.0 * 100.0,
        "ClutchPct": t.get("Clutch", 0) / 255.0 * 100.0,
        "HandBrakePct": t.get("HandBrake", 0) / 255.0 * 100.0,
        # raw -128 would give -100.8 %; the wire range is -127..127
        "SteerPct": _clamp(t.get("Steer", 0) / 127.0 * 100.0, -100.0, 100.0),
        # car-space accelerations in g (X right, Z forward) and the drift angle
        "AccelGX": t.get("AccelerationX", 0.0) / G,
        "AccelGY": t.get("AccelerationY", 0.0) / G,
        "AccelGZ": t.get("AccelerationZ", 0.0) / G,
        "SideslipDeg": sideslip_deg(
            t.get("VelocityX", 0.0), t.get("VelocityZ", 0.0), speed, t.get("Gear")
        ),
    }
