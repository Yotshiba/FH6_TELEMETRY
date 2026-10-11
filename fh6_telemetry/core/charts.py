"""
Chart registry — which rolling charts exist, what they plot and how their Y
axis behaves.  Qt-free so the desktop widgets and the web server share one
definition (no duplicated lambdas or JavaScript tables to drift apart).

Lines refer to **display channels** (see ``core.derive.display_channels``):
values already in display units (km/h, hp, %, °C …).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..constants import WHEEL_COLORS


@dataclass(frozen=True)
class LineDef:
    channel: str
    label: str
    color: str


@dataclass(frozen=True)
class ChartDef:
    id: str
    title: str
    unit: str
    lines: tuple[LineDef, ...]
    y_fixed: tuple[float, float] | None = None   # never changes (pedals 0-100 %)
    y_floor: tuple[float, float] | None = None   # at least this; grows with the data
    y_min: float | None = None                   # lower clamp for auto-ranged charts

    @property
    def channels(self) -> tuple[str, ...]:
        return tuple(line.channel for line in self.lines)


def _wheels(prefix: str) -> tuple[LineDef, ...]:
    return tuple(LineDef(f"{prefix}{w}", w, WHEEL_COLORS[w]) for w in ("FL", "FR", "RL", "RR"))


CHARTS: dict[str, ChartDef] = {c.id: c for c in (
    ChartDef(
        "engine_rpm", "RPM", "rpm",
        (LineDef("CurrentEngineRpm", "RPM", "#FFDD44"),
         LineDef("EngineMaxRpm", "Max RPM", "#FF4444")),
        y_floor=(0.0, 10000.0),
    ),
    ChartDef(
        "engine_power_torque", "Power & Torque", "hp / Nm",
        (LineDef("PowerHp", "Power (hp)", "#44CCFF"),
         LineDef("Torque", "Torque (Nm)", "#FF9900")),
        y_min=0.0,
    ),
    ChartDef("tyre_temp", "Tyre Temp", "°C", _wheels("TireTemp"), y_min=0.0),
    ChartDef(
        "inputs_throttle_brake", "Throttle & Brake", "%",
        (LineDef("AccelPct", "Throttle", "#22BB44"),
         LineDef("BrakePct", "Brake", "#DD2200")),
        y_fixed=(0.0, 100.0),
    ),
    ChartDef("motion_suspension", "Suspension", "norm", _wheels("SuspNorm"),
             y_fixed=(0.0, 1.0)),
    ChartDef(
        "motion_speed", "Speed", "km/h",
        (LineDef("SpeedKmh", "Speed", "#44CCFF"),),
        y_floor=(0.0, 350.0),
    ),
)}
