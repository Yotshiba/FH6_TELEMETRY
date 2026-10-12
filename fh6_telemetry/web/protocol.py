"""
Wire protocol of the web dashboard (version 1) — pure functions, no sockets.

The stream is Server-Sent Events.  Named events (JSON payloads, always
``allow_nan=False``):

``hello``  once per connection — column tables, lookup labels, UI constants,
           chart definitions and the current Y ranges
``hist``   ``{"s": first_seq, "r": [[...F...], ...]}`` — up to 300 rows
``f``      ``{"s": last_seq,  "r": [[...F...], ...]}`` — rows since the last
           tick (``id:`` = ``<epoch>:<last_seq>``) — full packet-rate fidelity
``s``      ``[...S...]`` — the slow snapshot (laps, car info, slips, motion …)
``rg``     ``{"<chart id>": [lo, hi], ...}`` — smoothed Y ranges that changed
``st``     1 Hz heartbeat ``{"sig":1,"pps":75.0,"age":0.01,"n":2,"epoch":3}``
``reset``  the telemetry source changed: the stream closes, the browser
           reconnects (``retry:``) and gets a fresh ``hello`` + ``hist``

Rows are positional arrays aligned with the ``F`` / ``S`` column tables sent
in ``hello`` (≈3× smaller than dicts).  All values are already in display
units; the client only formats strings and toggles km/h ↔ mph.
"""

from __future__ import annotations

import json
import math
from collections import deque
from typing import Callable

from ..constants import (
    _BAR_CONFIGS,
    _TEMP_COLORS,
    CAR_CLASS,
    CAR_GROUP_MAP,
    CLASS_COLORS,
    DRIVETRAIN,
    GEAR_MAP,
    HISTORY_LEN,
    NEUTRAL_GEAR_CODE,
    NEUTRAL_HOLD_MS,
    WHEEL_COLORS,
    WHEELS,
)
from ..core.charts import CHARTS
from ..core.derive import G
from ..core.range_smoother import RangeSmoother

PROTOCOL_VERSION = 1

# ---------------------------------------------------------------------------
# Column tables
# ---------------------------------------------------------------------------

# (key, decimals, unit) — "F" rows: every packet.  decimals 0 => integer.
FAST: tuple[tuple[str, int, str], ...] = (
    ("IsRaceOn", 0, ""),
    ("CurrentEngineRpm", 0, "rpm"), ("EngineMaxRpm", 0, "rpm"),
    ("SpeedKmh", 1, "km/h"), ("PowerHp", 1, "hp"), ("Torque", 1, "Nm"),
    ("BoostBar", 3, "bar"), ("FuelPct", 1, "%"),
    ("Gear", 0, ""),
    ("AccelPct", 1, "%"), ("BrakePct", 1, "%"), ("ClutchPct", 1, "%"), ("HandBrakePct", 1, "%"),
    ("SteerPct", 1, "%"),
    *((f"TireTemp{w}", 1, "°C") for w in WHEELS),
    *((f"SuspNorm{w}", 3, "norm") for w in WHEELS),
    # --- added for the cockpit / map / lab / timeline views ---
    ("TimestampMS", 0, "ms"),                 # exact game time: precise 0-100 timers, timeline
    ("AccelGX", 2, "g"), ("AccelGZ", 2, "g"),  # lateral / longitudinal g (G-G diagram)
    ("SideslipDeg", 1, "°"),                  # drift angle
    ("Pitch", 3, "rad"), ("Roll", 3, "rad"), ("Yaw", 3, "rad"),
    ("PositionX", 1, "m"), ("PositionZ", 1, "m"),
)

FAST_INDEX = {k: i for i, (k, _d, _u) in enumerate(FAST)}


def _plain(key: str, decimals: int) -> tuple[str, int, Callable[[dict], float]]:
    return key, decimals, lambda f, k=key: f.get(k, 0)


def _ms(key: str) -> Callable[[dict], float]:
    return lambda f, k=key: f.get(k, 0.0) * 1000.0


def _flags(f: dict) -> int:
    """bit 0-3 rumble FL..RR, bit 4-7 puddle FL..RR."""
    v = 0
    for i, w in enumerate(WHEELS):
        if f.get(f"WheelOnRumble{w}"):
            v |= 1 << i
        if f.get(f"WheelInPuddle{w}"):
            v |= 1 << (4 + i)
    return v


def _g(key: str) -> Callable[[dict], float]:
    return lambda f, k=key: f.get(k, 0.0) / G


# (key, decimals, getter) — "S" snapshot: slow-changing values.
SLOW: tuple[tuple[str, int, Callable[[dict], float]], ...] = (
    *(_plain(f"TireSlipRatio{w}", 3) for w in WHEELS),
    *(_plain(f"TireSlipAngle{w}", 3) for w in WHEELS),
    *(_plain(f"TireCombinedSlip{w}", 3) for w in WHEELS),
    *(_plain(f"SuspTravelM{w}", 4) for w in WHEELS),
    *(_plain(f"WheelRotSpeed{w}", 1) for w in WHEELS),
    ("WheelFlags", 0, _flags),
    _plain("LapNumber", 0), _plain("RacePosition", 0),
    ("CurrentLapMs", 0, _ms("CurrentLap")), ("CurrentRaceTimeMs", 0, _ms("CurrentRaceTime")),
    ("BestLapMs", 0, _ms("BestLap")), ("LastLapMs", 0, _ms("LastLap")),
    _plain("DistanceTraveled", 1),
    _plain("CarClass", 0), _plain("CarPerformanceIndex", 0), _plain("DrivetrainType", 0),
    _plain("NumCylinders", 0), _plain("CarGroup", 0),
    _plain("SmashableMass", 0), _plain("SmashableVelDiff", 2),
    ("AccelGX", 3, _g("AccelerationX")), ("AccelGY", 3, _g("AccelerationY")),
    ("AccelGZ", 3, _g("AccelerationZ")),
    _plain("VelocityX", 2), _plain("VelocityY", 2), _plain("VelocityZ", 2),
    _plain("AngularVelocityX", 3), _plain("AngularVelocityY", 3), _plain("AngularVelocityZ", 3),
    _plain("Yaw", 4), _plain("Pitch", 4), _plain("Roll", 4),
    _plain("PositionX", 1), _plain("PositionY", 1), _plain("PositionZ", 1),
    _plain("NormalizedDrivingLine", 0), _plain("NormalizedAIBrakeDifference", 0),
    ("BoostPsi", 1, lambda f: f.get("Boost", 0.0)),
)

SLOW_INDEX = {k: i for i, (k, _d, _g_) in enumerate(SLOW)}


def _enc(v, decimals: int):
    """Round for the wire; non-finite and non-numbers become 0 (never NaN)."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(v):
        return 0
    return int(round(v)) if decimals == 0 else round(v, decimals)


def fast_row(frame: dict) -> list:
    return [_enc(frame.get(k, 0), d) for k, d, _u in FAST]


def slow_row(frame: dict) -> list:
    return [_enc(get(frame), d) for _k, d, get in SLOW]


def dumps(obj) -> str:
    """Compact JSON that can never contain ``NaN`` / ``Infinity``."""
    return json.dumps(obj, separators=(",", ":"), allow_nan=False)


def sse(event: str, payload: str, event_id: str | None = None) -> bytes:
    """One Server-Sent-Events message (payload must be single-line JSON)."""
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {payload}\n\n".encode("utf-8")


# ---------------------------------------------------------------------------
# hello
# ---------------------------------------------------------------------------


def _chart_defs() -> list[dict]:
    out = []
    for c in CHARTS.values():
        y: dict = {}
        if c.y_fixed is not None:
            y["fixed"] = list(c.y_fixed)
        if c.y_floor is not None:
            y["floor"] = list(c.y_floor)
        if c.y_min is not None:
            y["min"] = c.y_min
        out.append({
            "id": c.id, "title": c.title, "unit": c.unit, "y": y,
            "lines": [{"k": FAST_INDEX[l.channel], "label": l.label, "color": l.color}
                      for l in c.lines],
        })
    return out


def static_ui() -> dict:
    """Constants the page needs, generated from ``constants.py`` (no magic numbers in JS)."""
    return {
        "temp": [[t, c] for t, c in _TEMP_COLORS],
        "bars": [{"key": k, "label": label, "max": mx, "danger": dg} for k, label, mx, dg in _BAR_CONFIGS],
        "wheel": dict(WHEEL_COLORS),
        "classColors": dict(CLASS_COLORS),
        "steerDeadPct": round(5 / 127 * 100, 2),     # the desktop UI's ±5 raw dead zone
        "inputs": [
            {"label": "Throttle", "key": "AccelPct", "max": 100, "danger": 90},
            {"label": "Brake", "key": "BrakePct", "max": 100, "danger": 90},
            {"label": "Clutch", "key": "ClutchPct", "max": 100, "danger": 90},
            {"label": "Handbrake", "key": "HandBrakePct", "max": 100, "danger": 90},
            {"label": "Boost", "key": "BoostPsi", "max": 30, "danger": 20, "slow": True},
            {"label": "Fuel", "key": "FuelPct", "max": 100, "danger": 20, "invert": True},
        ],
    }


def lookups() -> dict:
    return {
        "gear": {str(k): v for k, v in GEAR_MAP.items()},
        "neutral": {"code": NEUTRAL_GEAR_CODE, "holdMs": NEUTRAL_HOLD_MS},
        "cls": {str(k): v for k, v in CAR_CLASS.items()},
        "drv": {str(k): v for k, v in DRIVETRAIN.items()},
        "grp": {str(k): v for k, v in CAR_GROUP_MAP.items()},
    }


def hello(
    *, epoch: int, tick_hz: float, resume: bool, ranges: dict[str, list[float]],
    hist_len: int = HISTORY_LEN,
) -> dict:
    return {
        "v": PROTOCOL_VERSION, "epoch": epoch, "tick": tick_hz, "hist": hist_len,
        "resume": resume,
        "F": [{"k": k, "d": d, "u": u} for k, d, u in FAST],
        "S": [{"k": k, "d": d} for k, d, _g_ in SLOW],
        "lab": lookups(), "ui": static_ui(), "charts": _chart_defs(),
        "rg": ranges,
    }


# ---------------------------------------------------------------------------
# Server-side Y ranges (the same RangeSmoother the desktop charts use)
# ---------------------------------------------------------------------------


class RangeTracker:
    """Smoothed Y ranges for the auto-ranged charts, fed with *fast rows*.

    Rows with ``IsRaceOn == 0`` are ignored, exactly like the desktop charts.
    """

    def __init__(self, history_len: int = HISTORY_LEN) -> None:
        self._charts = []
        for c in CHARTS.values():
            if c.y_fixed is not None:
                continue
            idx = [FAST_INDEX[l.channel] for l in c.lines]
            self._charts.append((
                c.id, idx, deque(maxlen=history_len),
                RangeSmoother(y_min=c.y_min, floor=c.y_floor),
            ))
        self.current: dict[str, list[float]] = {}

    def reset(self) -> None:
        for _cid, _idx, window, smoother in self._charts:
            window.clear()
            smoother.reset()
        self.current = {}

    def feed(self, rows: list[list]) -> None:
        race = FAST_INDEX["IsRaceOn"]
        for row in rows:
            if not row[race]:
                continue
            for _cid, idx, window, _s in self._charts:
                vals = [row[i] for i in idx]
                window.append((min(vals), max(vals)))

    def update(self, now: float) -> dict[str, list[float]]:
        """Ranges that changed since the last call."""
        changed: dict[str, list[float]] = {}
        for cid, _idx, window, smoother in self._charts:
            if not window:
                continue
            lo = min(m for m, _ in window)
            hi = max(m for _, m in window)
            new = smoother.update(lo, hi, now)
            if new is not None:
                rng = [new[0], new[1]]
                changed[cid] = rng
                self.current[cid] = rng
        return changed
