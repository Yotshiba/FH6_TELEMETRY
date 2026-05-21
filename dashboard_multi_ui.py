"""
Forza Horizon 6 — Multi-Window Telemetry Dashboard
A compact launcher lets you open any combination of category windows.
Each window is fully independent and can be freely moved and resized.

Categories
----------
  Car & Lap  — Car info, lap times, input bars, FH6 extras
  Tyres      — 2×2 tyre widget cards + tyre temperature history
  Engine     — Stats strip + RPM chart + Power & Torque chart
  Inputs     — Input bars + steer indicator + Throttle/Brake chart
  Motion     — Motion readout + Suspension + Speed charts

Usage:  python dashboard_multi_ui.py
"""

from __future__ import annotations

import socket
import struct
import sys
from collections import deque
from typing import Callable

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import QThread, Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)


# ===========================================================================
# Telemetry core (inlined from telemetry_core.py)
# ===========================================================================

HOST = "127.0.0.1"
PORT = 20077

PACKET_FORMAT = (
    "<iI"      # IsRaceOn (S32), TimestampMS (U32)
    "fff"      # EngineMaxRpm, EngineIdleRpm, CurrentEngineRpm
    "fff"      # AccelerationX/Y/Z
    "fff"      # VelocityX/Y/Z
    "fff"      # AngularVelocityX/Y/Z
    "fff"      # Yaw, Pitch, Roll
    "ffff"     # NormalizedSuspensionTravel FL/FR/RL/RR
    "ffff"     # TireSlipRatio FL/FR/RL/RR
    "ffff"     # WheelRotationSpeed FL/FR/RL/RR (rad/s)
    "iiii"     # WheelOnRumbleStrip FL/FR/RL/RR (S32, 0 or 1) -- was F32 in FH5
    "iiii"     # WheelInPuddle FL/FR/RL/RR (S32, 0 or 1)      -- was F32 in FH5
    "ffff"     # SurfaceRumble FL/FR/RL/RR
    "ffff"     # TireSlipAngle FL/FR/RL/RR
    "ffff"     # TireCombinedSlip FL/FR/RL/RR
    "ffff"     # SuspensionTravelMeters FL/FR/RL/RR
    "iiiii"    # CarOrdinal, CarClass, CarPerformanceIndex, DrivetrainType, NumCylinders
    "I"        # CarGroup (U32) -- FH6 new
    "ff"       # SmashableVelDiff (m/s), SmashableMass (kg) -- FH6 new
    "fff"      # PositionX/Y/Z (meters)
    "fff"      # Speed (m/s), Power (W), Torque (Nm)
    "ffff"     # TireTemp FL/FR/RL/RR
    "fff"      # Boost (PSI above atm), Fuel (0-1), DistanceTraveled (m)
    "ffff"     # BestLap, LastLap, CurrentLap, CurrentRaceTime (SECONDS)
    "H"        # LapNumber (U16)
    "BBBBBB"   # RacePosition, Accel, Brake, Clutch, HandBrake, Gear (U8 each)
    "bbb"      # Steer, NormalizedDrivingLine, NormalizedAIBrakeDifference (S8 each)
    "x"        # 1 byte trailing alignment padding -> total 324 bytes
)

PACKET_SIZE = struct.calcsize(PACKET_FORMAT)

FIELDS = [
    "IsRaceOn", "TimestampMS",
    "EngineMaxRpm", "EngineIdleRpm", "CurrentEngineRpm",
    "AccelerationX", "AccelerationY", "AccelerationZ",
    "VelocityX", "VelocityY", "VelocityZ",
    "AngularVelocityX", "AngularVelocityY", "AngularVelocityZ",
    "Yaw", "Pitch", "Roll",
    "SuspNormFL", "SuspNormFR", "SuspNormRL", "SuspNormRR",
    "TireSlipRatioFL", "TireSlipRatioFR", "TireSlipRatioRL", "TireSlipRatioRR",
    "WheelRotSpeedFL", "WheelRotSpeedFR", "WheelRotSpeedRL", "WheelRotSpeedRR",
    "WheelOnRumbleFL", "WheelOnRumbleFR", "WheelOnRumbleRL", "WheelOnRumbleRR",
    "WheelInPuddleFL", "WheelInPuddleFR", "WheelInPuddleRL", "WheelInPuddleRR",
    "SurfaceRumbleFL", "SurfaceRumbleFR", "SurfaceRumbleRL", "SurfaceRumbleRR",
    "TireSlipAngleFL", "TireSlipAngleFR", "TireSlipAngleRL", "TireSlipAngleRR",
    "TireCombinedSlipFL", "TireCombinedSlipFR", "TireCombinedSlipRL", "TireCombinedSlipRR",
    "SuspTravelMFL", "SuspTravelMFR", "SuspTravelMRL", "SuspTravelMRR",
    "CarOrdinal", "CarClass", "CarPerformanceIndex", "DrivetrainType", "NumCylinders",
    "CarGroup",
    "SmashableVelDiff", "SmashableMass",
    "PositionX", "PositionY", "PositionZ",
    "Speed", "Power", "Torque",
    "TireTempFL", "TireTempFR", "TireTempRL", "TireTempRR",
    "Boost", "Fuel", "DistanceTraveled",
    "BestLap", "LastLap", "CurrentLap", "CurrentRaceTime",
    "LapNumber", "RacePosition",
    "Accel", "Brake", "Clutch", "HandBrake", "Gear", "Steer",
    "NormalizedDrivingLine", "NormalizedAIBrakeDifference",
]

CAR_CLASS  = {0: "D", 1: "C", 2: "B", 3: "A", 4: "S1", 5: "S2", 6: "X", 7: "X"}
DRIVETRAIN = {0: "FWD", 1: "RWD", 2: "AWD"}
GEAR_MAP   = {0: "R", 1: "N", 2: "1", 3: "2", 4: "3", 5: "4",
              6: "5", 7: "6", 8: "7", 9: "8", 10: "9"}


def parse_packet(data: bytes) -> dict:
    if len(data) < PACKET_SIZE:
        return {}
    return dict(zip(FIELDS, struct.unpack_from(PACKET_FORMAT, data)))


def secs_to_time(s: float) -> str:
    if s <= 0:
        return "--:--.---"
    minutes = int(s // 60)
    seconds = s % 60
    return f"{minutes}:{seconds:06.3f}"


# ===========================================================================
# Tyre components (inlined from tyre_ui.py)
# ===========================================================================

HISTORY_LEN = 300
WHEELS      = ("FL", "FR", "RL", "RR")
WHEEL_COLORS: dict[str, str] = {
    "FL": "#FF4444",
    "FR": "#44CCFF",
    "RL": "#FF9900",
    "RR": "#44DD44",
}

_TEMP_COLORS: list[tuple[float, str]] = [
    (50.0,  "#1a6fb5"),
    (70.0,  "#00AACC"),
    (90.0,  "#22BB44"),
    (110.0, "#FF9900"),
    (999.0, "#DD2200"),
]

_BAR_CONFIGS: list[tuple[str, str, float, float]] = [
    ("TireSlipRatio",    "Slip Ratio",  2.0, 0.5),
    ("TireSlipAngle",    "Slip Angle",  2.0, 0.5),
    ("TireCombinedSlip", "Comb. Slip",  3.0, 1.0),
    ("SuspNorm",         "Susp (norm)", 1.0, 0.9),
]


def get_temp_color(temp: float) -> str:
    for threshold, colour in _TEMP_COLORS:
        if temp < threshold:
            return colour
    return _TEMP_COLORS[-1][1]


def _bar_color(value: float, danger: float) -> str:
    ratio = value / danger if danger > 0 else 0.0
    if ratio < 0.6:
        return "#22BB44"
    if ratio < 1.0:
        return "#FF9900"
    return "#DD2200"


class TelemetryReceiver(QThread):
    """Receives FH6 UDP telemetry packets and emits parsed dicts."""

    data_ready = pyqtSignal(dict)

    def __init__(self, host: str, port: int, parent: QWidget | None = None) -> None:
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


class BarIndicator(QWidget):
    """One row: [name label] [progress bar] [value label]"""

    _BAR_STYLE = """
        QProgressBar {{
            background: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 3px;
            height: 14px;
        }}
        QProgressBar::chunk {{
            background: {color};
            border-radius: 2px;
        }}
    """

    def __init__(
        self,
        name: str,
        max_val: float,
        danger: float,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._max_val = max_val
        self._danger  = danger

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 1, 0, 1)
        layout.setSpacing(6)

        name_lbl = QLabel(name)
        name_lbl.setFixedWidth(80)
        name_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        name_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        self._bar = QProgressBar()
        self._bar.setRange(0, 1000)
        self._bar.setValue(0)
        self._bar.setTextVisible(False)
        self._bar.setFixedHeight(14)
        self._bar.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        self._val_lbl = QLabel("0.000")
        self._val_lbl.setFixedWidth(46)
        self._val_lbl.setStyleSheet(
            "color: #eeeeee; font-size: 11px; font-family: monospace;"
        )
        self._val_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        )

        layout.addWidget(name_lbl)
        layout.addWidget(self._bar)
        layout.addWidget(self._val_lbl)
        self._update_color(0.0)

    def update_value(self, value: float) -> None:
        clamped = max(0.0, min(value, self._max_val))
        self._bar.setValue(int(clamped / self._max_val * 1000))
        self._val_lbl.setText(f"{value:+.3f}" if abs(value) < 10 else f"{value:.1f}")
        self._update_color(abs(value))

    def _update_color(self, value: float) -> None:
        self._bar.setStyleSheet(
            self._BAR_STYLE.format(color=_bar_color(value, self._danger))
        )


class TyreWidget(QFrame):
    """Displays all tyre telemetry for one wheel corner."""

    _CARD_STYLE = """
        QFrame {{
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 8px;
        }}
    """
    _TEMP_LBL_STYLE = """
        QLabel {{
            background: {bg};
            color: {fg};
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 28px;
            font-weight: bold;
            font-family: monospace;
        }}
    """
    _BADGE_ON  = (
        "background: {color}; color: #fff; border-radius: 4px;"
        " padding: 1px 6px; font-size: 10px; font-weight: bold;"
    )
    _BADGE_OFF = (
        "background: #1e1e1e; color: #444444; border-radius: 4px;"
        " padding: 1px 6px; font-size: 10px;"
    )

    def __init__(self, wheel: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._wheel = wheel
        self.setStyleSheet(self._CARD_STYLE)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(6)

        header = QHBoxLayout()
        header.setSpacing(6)
        wheel_lbl = QLabel(wheel)
        wheel_lbl.setStyleSheet(
            f"color: {WHEEL_COLORS[wheel]}; font-size: 18px; font-weight: bold;"
        )
        self._rumble_badge = QLabel("RUMBLE")
        self._puddle_badge = QLabel("PUDDLE")
        self._set_badge(self._rumble_badge, False, "#FF6600")
        self._set_badge(self._puddle_badge, False, "#0088FF")
        header.addWidget(wheel_lbl)
        header.addStretch()
        header.addWidget(self._rumble_badge)
        header.addWidget(self._puddle_badge)
        root.addLayout(header)

        self._temp_lbl = QLabel("--.- °C")
        self._temp_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._temp_lbl.setMinimumHeight(54)
        root.addWidget(self._temp_lbl)
        self._set_temp(0.0)

        self._bars: dict[str, BarIndicator] = {}
        for key, label, max_val, danger in _BAR_CONFIGS:
            bar = BarIndicator(label, max_val, danger, self)
            self._bars[key] = bar
            root.addWidget(bar)

        text_layout = QGridLayout()
        text_layout.setContentsMargins(0, 2, 0, 0)
        text_layout.setHorizontalSpacing(8)
        text_layout.setVerticalSpacing(2)

        def _mk_key(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
            lbl.setAlignment(
                Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
            )
            return lbl

        def _mk_val() -> QLabel:
            lbl = QLabel("--")
            lbl.setStyleSheet(
                "color: #eeeeee; font-size: 11px; font-family: monospace;"
            )
            lbl.setAlignment(
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter
            )
            return lbl

        self._susp_m_lbl    = _mk_val()
        self._wheel_spd_lbl = _mk_val()
        text_layout.addWidget(_mk_key("Susp (m):"),  0, 0)
        text_layout.addWidget(self._susp_m_lbl,      0, 1)
        text_layout.addWidget(_mk_key("Wheel spd:"), 1, 0)
        text_layout.addWidget(self._wheel_spd_lbl,   1, 1)
        root.addLayout(text_layout)
        root.addStretch()

    def _set_badge(self, badge: QLabel, active: bool, color: str) -> None:
        badge.setStyleSheet(
            self._BADGE_ON.format(color=color) if active else self._BADGE_OFF
        )

    def _set_temp(self, temp: float) -> None:
        bg = get_temp_color(temp)
        r, g, b = int(bg[1:3], 16), int(bg[3:5], 16), int(bg[5:7], 16)
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        fg = "#ffffff" if brightness < 128 else "#111111"
        self._temp_lbl.setText(f"{temp:.1f} °C")
        self._temp_lbl.setStyleSheet(self._TEMP_LBL_STYLE.format(bg=bg, fg=fg))

    def update_data(self, t: dict) -> None:
        w = self._wheel
        self._set_temp(t.get(f"TireTemp{w}", 0.0))
        self._set_badge(self._rumble_badge, bool(t.get(f"WheelOnRumble{w}", 0)), "#FF6600")
        self._set_badge(self._puddle_badge, bool(t.get(f"WheelInPuddle{w}", 0)), "#0088FF")
        self._bars["TireSlipRatio"].update_value(t.get(f"TireSlipRatio{w}", 0.0))
        self._bars["TireSlipAngle"].update_value(t.get(f"TireSlipAngle{w}", 0.0))
        self._bars["TireCombinedSlip"].update_value(t.get(f"TireCombinedSlip{w}", 0.0))
        self._bars["SuspNorm"].update_value(t.get(f"SuspNorm{w}", 0.0))
        self._susp_m_lbl.setText(f"{t.get(f'SuspTravelM{w}', 0.0):.4f} m")
        self._wheel_spd_lbl.setText(f"{t.get(f'WheelRotSpeed{w}', 0.0):.1f} rad/s")


# ===========================================================================
# Dashboard components (inlined from dashboard_ui.py)
# ===========================================================================

CAR_GROUP_MAP: dict[int, str] = {
    0: "Cars", 1: "Trucks", 2: "Buggies", 3: "Drift",
    4: "Rally", 5: "Track Day", 6: "Formula",
}

_DARK_STYLE = """
QMainWindow, QWidget {
    background-color: #0d0d1a;
    color: #dddddd;
    font-family: "Segoe UI", "Helvetica Neue", sans-serif;
}
QStatusBar {
    background: #111122;
    color: #aaaaaa;
    font-size: 11px;
    border-top: 1px solid #2a2a4a;
}
QSplitter::handle {
    background: #2a2a4a;
}
QSplitter::handle:horizontal {
    width: 3px;
}
QSplitter::handle:vertical {
    height: 3px;
}
QScrollBar:vertical {
    background: #1a1a2e;
    width: 8px;
    border: none;
}
QScrollBar::handle:vertical {
    background: #2a2a4a;
    border-radius: 4px;
    min-height: 20px;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0;
}
"""

LineSpec = tuple[str, str, str, Callable[[float], float] | None]


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        "color: #666688; font-size: 10px; font-weight: bold;"
        " letter-spacing: 1px; padding-top: 6px;"
    )
    return lbl


def _key_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
    lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
    return lbl


def _val_label(text: str = "--") -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet("color: #eeeeee; font-size: 11px; font-family: monospace;")
    lbl.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
    return lbl


def _divider() -> QFrame:
    line = QFrame()
    line.setFrameShape(QFrame.Shape.HLine)
    line.setStyleSheet("color: #2a2a4a; margin: 2px 0;")
    return line


class RollingChart(pg.PlotWidget):
    """Rolling history chart with one or more lines."""

    def __init__(
        self,
        title: str,
        unit: str,
        lines: list[LineSpec],
        history_len: int = HISTORY_LEN,
        y_range: tuple[float, float] | None = None,
        y_min: float | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent, background="#0d0d1a")
        self._lines_cfg   = lines
        self._history_len = history_len
        self._fixed_y     = y_range
        self._y_min       = y_min

        self.setLabel("left", title, units=unit, color="#aaaaaa")
        self.showGrid(x=False, y=True, alpha=0.15)
        self.getAxis("left").setTextPen(pg.mkPen("#aaaaaa"))
        self.getAxis("bottom").hide()
        self.setMenuEnabled(False)
        self.setMouseEnabled(x=False, y=False)
        self.setMinimumHeight(100)

        self._buffers: dict[str, deque[float]] = {
            key: deque([0.0] * history_len, maxlen=history_len)
            for key, *_ in lines
        }
        self._transforms: dict[str, Callable[[float], float] | None] = {
            key: transform for key, _lbl, _col, transform in lines
        }
        self._x = np.arange(history_len)

        legend = self.addLegend(offset=(10, 10))
        legend.setLabelTextColor("#cccccc")

        self._curves: dict[str, pg.PlotDataItem] = {}
        for key, label, color, _ in lines:
            pen = pg.mkPen(color=color, width=2)
            self._curves[key] = self.plot(
                self._x, np.zeros(history_len), pen=pen, name=label
            )

        if y_range is not None:
            self.setYRange(*y_range, padding=0.05)

    def append(self, t: dict) -> None:
        for key, *_ in self._lines_cfg:
            raw = t.get(key, 0.0)
            fn  = self._transforms.get(key)
            val = fn(float(raw)) if fn is not None else float(raw)
            self._buffers[key].append(val)
            self._curves[key].setData(self._x, np.array(self._buffers[key]))

        if self._fixed_y is None:
            all_vals = [v for buf in self._buffers.values() for v in buf if v != 0.0]
            if all_vals:
                lo = min(all_vals)
                hi = max(all_vals)
                margin    = max((hi - lo) * 0.1, 1.0)
                lo_bound  = lo - margin
                if self._y_min is not None:
                    lo_bound = max(self._y_min, lo_bound)
                self.setYRange(lo_bound, hi + margin, padding=0)


class HeaderBar(QWidget):
    """Single-row strip: race state · speed · gear · lap/pos · RPM · car · boost/fuel · race time."""

    _RACE_ON_STYLE  = "color: #22BB44; font-size: 13px; font-weight: bold;"
    _RACE_OFF_STYLE = "color: #664444; font-size: 13px; font-weight: bold;"
    _SEP_STYLE      = "color: #2a2a4a; font-size: 16px;"
    _VAL_BOLD       = (
        "color: #eeeeee; font-size: 13px; font-family: monospace; font-weight: bold;"
    )
    _KEY_DIM        = "color: #888899; font-size: 11px;"

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(38)
        self.setStyleSheet("background: #111122; border-bottom: 1px solid #2a2a4a;")

        row = QHBoxLayout(self)
        row.setContentsMargins(12, 0, 12, 0)
        row.setSpacing(6)

        def _sep() -> QLabel:
            s = QLabel("│")
            s.setStyleSheet(self._SEP_STYLE)
            return s

        def _key(text: str) -> QLabel:
            k = QLabel(text)
            k.setStyleSheet(self._KEY_DIM)
            return k

        def _val(text: str = "--", width: int | None = None) -> QLabel:
            v = QLabel(text)
            v.setStyleSheet(self._VAL_BOLD)
            if width:
                v.setFixedWidth(width)
            return v

        self._race_lbl = QLabel("⬤  NO SIGNAL")
        self._race_lbl.setStyleSheet(self._RACE_OFF_STYLE)
        row.addWidget(self._race_lbl)
        row.addWidget(_sep())

        self._speed_lbl = QLabel("0 km/h")
        self._speed_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 18px; font-family: monospace; font-weight: bold;"
        )
        self._speed_lbl.setFixedWidth(130)
        row.addWidget(self._speed_lbl)
        row.addWidget(_sep())

        row.addWidget(_key("GEAR"))
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 16px; font-family: monospace; font-weight: bold;"
        )
        self._gear_lbl.setFixedWidth(32)
        row.addWidget(self._gear_lbl)
        row.addWidget(_sep())

        row.addWidget(_key("LAP"))
        self._lap_lbl = _val(width=24)
        row.addWidget(self._lap_lbl)
        row.addWidget(_key("POS"))
        self._pos_lbl = _val(width=24)
        row.addWidget(self._pos_lbl)
        row.addWidget(_sep())

        row.addWidget(_key("RPM"))
        self._rpm_lbl = _val(width=100)
        row.addWidget(self._rpm_lbl)
        row.addWidget(_sep())

        row.addWidget(_key("CAR"))
        self._car_lbl = _val(width=170)
        row.addWidget(self._car_lbl)
        row.addWidget(_sep())

        row.addWidget(_key("BOOST"))
        self._boost_lbl = _val(width=64)
        row.addWidget(self._boost_lbl)
        row.addWidget(_key("FUEL"))
        self._fuel_lbl = _val(width=46)
        row.addWidget(self._fuel_lbl)

        row.addStretch()
        row.addWidget(_key("RACE"))
        self._race_time_lbl = _val(width=80)
        row.addWidget(self._race_time_lbl)

    def update_data(self, t: dict) -> None:
        is_on = bool(t.get("IsRaceOn", 0))
        if is_on:
            self._race_lbl.setText("⬤  RACE ON")
            self._race_lbl.setStyleSheet(self._RACE_ON_STYLE)
        else:
            self._race_lbl.setText("⬤  PAUSED")
            self._race_lbl.setStyleSheet(self._RACE_OFF_STYLE)

        speed_kmh = t.get("Speed", 0.0) * 3.6
        speed_mph = t.get("Speed", 0.0) * 2.23694
        self._speed_lbl.setText(f"{speed_kmh:.0f} km/h  {speed_mph:.0f} mph")
        _g = t.get("Gear", 0)
        self._gear_lbl.setText(GEAR_MAP.get(_g, str(_g)))
        self._lap_lbl.setText(str(t.get("LapNumber", 0)))
        self._pos_lbl.setText(str(t.get("RacePosition", 0)))

        rpm     = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 1.0) or 1.0
        self._rpm_lbl.setText(f"{rpm:.0f}  ({rpm / max_rpm * 100:.0f}%)")

        car_class = CAR_CLASS.get(t.get("CarClass", -1), "?")
        pi        = t.get("CarPerformanceIndex", 0)
        drv       = DRIVETRAIN.get(t.get("DrivetrainType", -1), "?")
        cyl       = t.get("NumCylinders", 0)
        self._car_lbl.setText(f"{car_class}  PI:{pi}  {drv}  {cyl}cyl")

        self._boost_lbl.setText(f"{t.get('Boost', 0.0) * 0.0689476:.3f} bar")
        self._fuel_lbl.setText(f"{t.get('Fuel', 0.0) * 100:.1f}%")
        self._race_time_lbl.setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))


class LeftInfoPanel(QWidget):
    """Scrollable left panel with four data sections."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(230)

        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")

        content = QWidget()
        content.setStyleSheet("background: transparent;")
        layout = QVBoxLayout(content)
        layout.setContentsMargins(8, 4, 8, 4)
        layout.setSpacing(2)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)
        scroll.setWidget(content)

        layout.addWidget(_section_label("CAR INFO"))
        self._car_vals = self._build_grid(layout, [
            ("Class:",      "--"), ("PI:",         "--"),
            ("Drivetrain:", "--"), ("Cylinders:",  "--"),
            ("Car Group:",  "--"), ("Smash Mass:", "--"),
        ])
        layout.addWidget(_divider())

        layout.addWidget(_section_label("LAP & RACE TIMES"))
        self._lap_vals = self._build_grid(layout, [
            ("Best Lap:",    "--:--.---"), ("Last Lap:",    "--:--.---"),
            ("Current Lap:", "--:--.---"), ("Race Time:",   "--:--.---"),
            ("Distance:",    "--"),
        ])
        layout.addWidget(_divider())

        layout.addWidget(_section_label("INPUTS"))
        self._input_bars: dict[str, BarIndicator] = {}
        for name, max_v, danger in [
            ("Throttle",  100.0, 90.0), ("Brake",     100.0, 90.0),
            ("Clutch",    100.0, 90.0), ("Handbrake", 100.0, 90.0),
            ("Steer",     100.0, 80.0), ("Boost",      30.0, 20.0),
            ("Fuel",      100.0, 20.0),
        ]:
            bar = BarIndicator(name, max_v, danger)
            self._input_bars[name] = bar
            layout.addWidget(bar)
        layout.addWidget(_divider())

        layout.addWidget(_section_label("FH6 EXTRAS"))
        self._extras_vals = self._build_grid(layout, [
            ("Smash ΔVel:", "--"), ("Drive Line:", "--"), ("AI Brake Δ:", "--"),
        ])
        layout.addStretch()

    @staticmethod
    def _build_grid(
        parent_layout: QVBoxLayout,
        rows: list[tuple[str, str]],
    ) -> dict[str, QLabel]:
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(2)
        grid.setColumnStretch(1, 1)
        vals: dict[str, QLabel] = {}
        for i, (key, init) in enumerate(rows):
            grid.addWidget(_key_label(key), i, 0)
            v = _val_label(init)
            grid.addWidget(v, i, 1)
            vals[key] = v
        parent_layout.addLayout(grid)
        return vals

    def update_data(self, t: dict) -> None:
        self._car_vals["Class:"].setText(CAR_CLASS.get(t.get("CarClass", -1), "?"))
        self._car_vals["PI:"].setText(str(t.get("CarPerformanceIndex", 0)))
        self._car_vals["Drivetrain:"].setText(
            DRIVETRAIN.get(t.get("DrivetrainType", -1), "?")
        )
        self._car_vals["Cylinders:"].setText(str(t.get("NumCylinders", 0)))
        self._car_vals["Car Group:"].setText(
            CAR_GROUP_MAP.get(t.get("CarGroup", -1), f"#{t.get('CarGroup', '?')}")
        )
        self._car_vals["Smash Mass:"].setText(f"{t.get('SmashableMass', 0.0):.0f} kg")

        self._lap_vals["Best Lap:"].setText(secs_to_time(t.get("BestLap", 0.0)))
        self._lap_vals["Last Lap:"].setText(secs_to_time(t.get("LastLap", 0.0)))
        self._lap_vals["Current Lap:"].setText(secs_to_time(t.get("CurrentLap", 0.0)))
        self._lap_vals["Race Time:"].setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))
        self._lap_vals["Distance:"].setText(
            f"{t.get('DistanceTraveled', 0.0) / 1000:.2f} km"
        )

        self._input_bars["Throttle"].update_value( t.get("Accel",     0) / 255 * 100)
        self._input_bars["Brake"].update_value(    t.get("Brake",     0) / 255 * 100)
        self._input_bars["Clutch"].update_value(   t.get("Clutch",    0) / 255 * 100)
        self._input_bars["Handbrake"].update_value(t.get("HandBrake", 0) / 255 * 100)
        self._input_bars["Steer"].update_value(abs(t.get("Steer",     0) / 127 * 100))
        self._input_bars["Boost"].update_value(    t.get("Boost",     0.0))
        self._input_bars["Fuel"].update_value(     t.get("Fuel",      0.0) * 100)

        self._extras_vals["Smash ΔVel:"].setText(
            f"{t.get('SmashableVelDiff', 0.0):.2f} m/s"
        )
        self._extras_vals["Drive Line:"].setText(
            f"{t.get('NormalizedDrivingLine', 0):+d}"
        )
        self._extras_vals["AI Brake Δ:"].setText(
            f"{t.get('NormalizedAIBrakeDifference', 0):+d}"
        )


class TyrePanelGrid(QWidget):
    """2×2 grid of TyreWidget cards."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setSpacing(8)
        grid.setContentsMargins(4, 4, 4, 4)
        self._tyres: dict[str, TyreWidget] = {}
        for wheel, (row, col) in [
            ("FL", (0, 0)), ("FR", (0, 1)), ("RL", (1, 0)), ("RR", (1, 1))
        ]:
            w = TyreWidget(wheel)
            self._tyres[wheel] = w
            grid.addWidget(w, row, col)
        for i in range(2):
            grid.setRowStretch(i, 1)
            grid.setColumnStretch(i, 1)

    def update_data(self, t: dict) -> None:
        for widget in self._tyres.values():
            widget.update_data(t)


class MotionPanel(QWidget):
    """Right panel: oversized speed/gear display + scrollable motion data grid."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(230)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(4)

        speed_frame = QFrame()
        speed_frame.setStyleSheet(
            "QFrame { background: #1a1a2e; border: 1px solid #2a2a4a;"
            " border-radius: 8px; }"
        )
        sf_layout = QVBoxLayout(speed_frame)
        sf_layout.setContentsMargins(8, 6, 8, 6)
        sf_layout.setSpacing(2)

        self._speed_kmh_lbl = QLabel("0")
        self._speed_kmh_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_kmh_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 42px; font-weight: bold; font-family: monospace;"
            " background: transparent; border: none;"
        )
        self._speed_unit_lbl = QLabel("km/h")
        self._speed_unit_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_unit_lbl.setStyleSheet(
            "color: #666688; font-size: 12px; background: transparent; border: none;"
        )

        bottom_row = QHBoxLayout()
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 32px; font-weight: bold; font-family: monospace;"
            " background: #111122; border: 1px solid #2a2a4a; border-radius: 6px;"
            " padding: 4px 12px;"
        )
        self._mph_lbl = QLabel("0 mph")
        self._mph_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        )
        self._mph_lbl.setStyleSheet(
            "color: #888899; font-size: 13px; font-family: monospace;"
            " background: transparent; border: none;"
        )
        bottom_row.addWidget(self._gear_lbl)
        bottom_row.addStretch()
        bottom_row.addWidget(self._mph_lbl)

        sf_layout.addWidget(self._speed_kmh_lbl)
        sf_layout.addWidget(self._speed_unit_lbl)
        sf_layout.addLayout(bottom_row)
        outer.addWidget(speed_frame)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")
        data_widget = QWidget()
        data_widget.setStyleSheet("background: transparent;")
        data_layout = QVBoxLayout(data_widget)
        data_layout.setContentsMargins(0, 0, 0, 0)
        data_layout.setSpacing(2)
        scroll.setWidget(data_widget)
        outer.addWidget(scroll, stretch=1)

        def _section(title: str, rows: list[str]) -> dict[str, QLabel]:
            data_layout.addWidget(_section_label(title))
            grid = QGridLayout()
            grid.setHorizontalSpacing(8)
            grid.setVerticalSpacing(2)
            grid.setColumnStretch(1, 1)
            vals: dict[str, QLabel] = {}
            for i, name in enumerate(rows):
                k = _key_label(name + ":")
                v = _val_label()
                grid.addWidget(k, i, 0)
                grid.addWidget(v, i, 1)
                vals[name] = v
            data_layout.addLayout(grid)
            data_layout.addWidget(_divider())
            return vals

        self._vel_vals = _section("VELOCITY (m/s)",      ["Vel X", "Vel Y", "Vel Z"])
        self._acc_vals = _section("ACCELERATION (g)",    ["Acc X", "Acc Y", "Acc Z"])
        self._ang_vals = _section("ANGULAR VEL (rad/s)", ["AngVel X", "AngVel Y", "AngVel Z"])
        self._ori_vals = _section("ORIENTATION (rad)",   ["Yaw", "Pitch", "Roll"])
        self._pos_vals = _section("POSITION (m)",        ["Pos X", "Pos Y", "Pos Z"])
        data_layout.addStretch()

    def update_data(self, t: dict) -> None:
        speed_kmh = t.get("Speed", 0.0) * 3.6
        speed_mph = t.get("Speed", 0.0) * 2.23694
        self._speed_kmh_lbl.setText(f"{speed_kmh:.0f}")
        self._mph_lbl.setText(f"{speed_mph:.0f} mph")
        _g = t.get("Gear", 0)
        self._gear_lbl.setText(GEAR_MAP.get(_g, str(_g)))

        _G = 9.80665
        self._vel_vals["Vel X"].setText(f"{t.get('VelocityX',       0.0):+.2f}")
        self._vel_vals["Vel Y"].setText(f"{t.get('VelocityY',       0.0):+.2f}")
        self._vel_vals["Vel Z"].setText(f"{t.get('VelocityZ',       0.0):+.2f}")
        self._acc_vals["Acc X"].setText(f"{t.get('AccelerationX',   0.0) / _G:+.3f}")
        self._acc_vals["Acc Y"].setText(f"{t.get('AccelerationY',   0.0) / _G:+.3f}")
        self._acc_vals["Acc Z"].setText(f"{t.get('AccelerationZ',   0.0) / _G:+.3f}")
        self._ang_vals["AngVel X"].setText(f"{t.get('AngularVelocityX', 0.0):+.3f}")
        self._ang_vals["AngVel Y"].setText(f"{t.get('AngularVelocityY', 0.0):+.3f}")
        self._ang_vals["AngVel Z"].setText(f"{t.get('AngularVelocityZ', 0.0):+.3f}")
        self._ori_vals["Yaw"].setText(  f"{t.get('Yaw',   0.0):+.4f}")
        self._ori_vals["Pitch"].setText(f"{t.get('Pitch', 0.0):+.4f}")
        self._ori_vals["Roll"].setText( f"{t.get('Roll',  0.0):+.4f}")
        self._pos_vals["Pos X"].setText(f"{t.get('PositionX', 0.0):.1f}")
        self._pos_vals["Pos Y"].setText(f"{t.get('PositionY', 0.0):.1f}")
        self._pos_vals["Pos Z"].setText(f"{t.get('PositionZ', 0.0):.1f}")


# ===========================================================================
# Tab panels (inlined from dashboard_tabs_ui.py)
# ===========================================================================

class TyresTab(QWidget):
    """TyrePanelGrid (top) + tyre temperature rolling chart (bottom)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Vertical)
        split.setChildrenCollapsible(False)

        self._grid = TyrePanelGrid()
        self._temp_chart = RollingChart(
            "Tyre Temp", "°C",
            [
                ("TireTempFL", "FL", WHEEL_COLORS["FL"], None),
                ("TireTempFR", "FR", WHEEL_COLORS["FR"], None),
                ("TireTempRL", "RL", WHEEL_COLORS["RL"], None),
                ("TireTempRR", "RR", WHEEL_COLORS["RR"], None),
            ],
            y_min=0.0,
        )

        split.addWidget(self._grid)
        split.addWidget(self._temp_chart)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 1)
        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._grid.update_data(t)
        self._temp_chart.append(t)


class EngineTab(QWidget):
    """Stats strip + RPM chart + Power & Torque chart."""

    _STAT_BOLD = "font-size: 24px; font-weight: bold; font-family: monospace;"
    _STAT_KEY  = "font-size: 10px; color: #888899; letter-spacing: 1px;"

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        strip = QFrame()
        strip.setFixedHeight(90)
        strip.setStyleSheet(
            "QFrame { background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }"
        )
        strip_row = QHBoxLayout(strip)
        strip_row.setContentsMargins(16, 6, 16, 6)
        strip_row.setSpacing(0)

        def _stat(label: str, color: str) -> QLabel:
            lbl = QLabel("--")
            lbl.setStyleSheet(self._STAT_BOLD + f" color: {color};")
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            return lbl

        def _key(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setStyleSheet(self._STAT_KEY)
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            return lbl

        def _vline() -> QFrame:
            vl = QFrame()
            vl.setFrameShape(QFrame.Shape.VLine)
            vl.setStyleSheet("color: #2a2a4a; margin: 4px 12px;")
            return vl

        def _stat_group(key_text: str, color: str) -> tuple[QLabel, QVBoxLayout]:
            grp = QVBoxLayout()
            grp.setSpacing(2)
            val_lbl = _stat(key_text, color)
            grp.addWidget(val_lbl)
            grp.addWidget(_key(key_text))
            return val_lbl, grp

        self._rpm_val,    rpm_grp    = _stat_group("RPM",     "#FFDD44")
        self._maxrpm_val, maxrpm_grp = _stat_group("MAX RPM", "#FF4444")
        self._power_val,  power_grp  = _stat_group("POWER",   "#44CCFF")
        self._torque_val, torque_grp = _stat_group("TORQUE",  "#FF9900")
        self._boost_val,  boost_grp  = _stat_group("BOOST",   "#44FF88")
        self._fuel_val,   fuel_grp   = _stat_group("FUEL",    "#FFAA44")
        self._gear_val,   gear_grp   = _stat_group("GEAR",    "#FFFFFF")

        for i, (grp, stretch) in enumerate([
            (rpm_grp, 3), (maxrpm_grp, 3), (power_grp, 3), (torque_grp, 3),
            (boost_grp, 2), (fuel_grp, 2), (gear_grp, 1),
        ]):
            if i > 0:
                strip_row.addWidget(_vline())
            strip_row.addLayout(grp, stretch=stretch)

        outer.addWidget(strip)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        self._rpm_chart = RollingChart(
            "RPM", "rpm",
            [
                ("CurrentEngineRpm", "RPM",     "#FFDD44", None),
                ("EngineMaxRpm",     "Max RPM", "#FF4444", None),
            ],
            y_range=(0.0, 10000.0),
        )
        self._pt_chart = RollingChart(
            "Power & Torque", "hp / Nm",
            [
                ("Power",  "Power (hp)",  "#44CCFF", lambda v: v / 1000.0 * 1.34102),
                ("Torque", "Torque (Nm)", "#FF9900", None),
            ],
            y_min=0.0,
        )

        split.addWidget(self._rpm_chart)
        split.addWidget(self._pt_chart)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 1)
        outer.addWidget(split, stretch=1)

    def update_data(self, t: dict) -> None:
        rpm     = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 0.0)
        power   = t.get("Power", 0.0) / 1000.0 * 1.34102
        torque  = t.get("Torque", 0.0)
        boost   = t.get("Boost", 0.0) * 0.0689476
        fuel    = t.get("Fuel", 0.0) * 100.0
        _gv = t.get("Gear", 0)
        gear    = GEAR_MAP.get(_gv, str(_gv))

        self._rpm_val.setText(f"{rpm:.0f}")
        self._maxrpm_val.setText(f"{max_rpm:.0f}")
        self._power_val.setText(f"{power:.1f} hp")
        self._torque_val.setText(f"{torque:.1f} Nm")
        self._boost_val.setText(f"{boost:.3f} bar")
        self._fuel_val.setText(f"{fuel:.1f}%")
        self._gear_val.setText(gear)
        self._rpm_chart.append(t)
        self._pt_chart.append(t)


class InputsTab(QWidget):
    """Input bars + steer direction label (left) + Throttle/Brake chart (right)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)
        left_layout.setContentsMargins(12, 8, 12, 8)
        left_layout.setSpacing(4)

        left_layout.addWidget(_section_label("INPUTS"))
        self._bars: dict[str, BarIndicator] = {}
        for name, max_v, danger in [
            ("Throttle",  100.0, 90.0), ("Brake",     100.0, 90.0),
            ("Clutch",    100.0, 90.0), ("Handbrake", 100.0, 90.0),
            ("Boost",      30.0, 20.0), ("Fuel",      100.0, 20.0),
        ]:
            bar = BarIndicator(name, max_v, danger)
            self._bars[name] = bar
            left_layout.addWidget(bar)

        left_layout.addWidget(_divider())
        left_layout.addWidget(_section_label("STEERING"))

        self._steer_bar = BarIndicator("Steer (abs)", 100.0, 80.0)
        left_layout.addWidget(self._steer_bar)

        self._steer_dir = QLabel("─  STRAIGHT  ─")
        self._steer_dir.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._steer_dir.setStyleSheet(
            "color: #888899; font-size: 13px; font-family: monospace; padding: 4px;"
        )
        left_layout.addWidget(self._steer_dir)
        left_layout.addStretch()

        self._tb_chart = RollingChart(
            "Throttle & Brake", "%",
            [
                ("Accel", "Throttle", "#22BB44", lambda v: v / 255.0 * 100.0),
                ("Brake", "Brake",    "#DD2200", lambda v: v / 255.0 * 100.0),
            ],
            y_range=(0.0, 100.0),
        )

        split.addWidget(left_widget)
        split.addWidget(self._tb_chart)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 2)
        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._bars["Throttle"].update_value( t.get("Accel",     0) / 255 * 100)
        self._bars["Brake"].update_value(    t.get("Brake",     0) / 255 * 100)
        self._bars["Clutch"].update_value(   t.get("Clutch",    0) / 255 * 100)
        self._bars["Handbrake"].update_value(t.get("HandBrake", 0) / 255 * 100)
        self._bars["Boost"].update_value(    t.get("Boost",     0.0))
        self._bars["Fuel"].update_value(     t.get("Fuel",      0.0) * 100)

        raw_steer = t.get("Steer", 0)
        steer_pct = raw_steer / 127 * 100
        self._steer_bar.update_value(abs(steer_pct))

        if raw_steer < -5:
            self._steer_dir.setText(f"◄  LEFT  {abs(steer_pct):.0f}%")
            self._steer_dir.setStyleSheet(
                "color: #44CCFF; font-size: 13px; font-family: monospace; padding: 4px;"
            )
        elif raw_steer > 5:
            self._steer_dir.setText(f"RIGHT  {steer_pct:.0f}%  ►")
            self._steer_dir.setStyleSheet(
                "color: #FF9900; font-size: 13px; font-family: monospace; padding: 4px;"
            )
        else:
            self._steer_dir.setText("─  STRAIGHT  ─")
            self._steer_dir.setStyleSheet(
                "color: #888899; font-size: 13px; font-family: monospace; padding: 4px;"
            )

        self._tb_chart.append(t)


class MotionTab(QWidget):
    """MotionPanel (left) + Suspension + Speed charts stacked (right)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        self._motion = MotionPanel()

        right_split = QSplitter(Qt.Orientation.Vertical)
        right_split.setChildrenCollapsible(False)

        self._susp_chart = RollingChart(
            "Suspension", "norm",
            [
                ("SuspNormFL", "FL", WHEEL_COLORS["FL"], None),
                ("SuspNormFR", "FR", WHEEL_COLORS["FR"], None),
                ("SuspNormRL", "RL", WHEEL_COLORS["RL"], None),
                ("SuspNormRR", "RR", WHEEL_COLORS["RR"], None),
            ],
            y_range=(0.0, 1.0),
        )
        self._speed_chart = RollingChart(
            "Speed", "km/h",
            [("Speed", "Speed", "#44CCFF", lambda v: v * 3.6)],
            y_range=(0.0, 350.0),
        )

        right_split.addWidget(self._susp_chart)
        right_split.addWidget(self._speed_chart)
        right_split.setStretchFactor(0, 1)
        right_split.setStretchFactor(1, 1)

        split.addWidget(self._motion)
        split.addWidget(right_split)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 2)
        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._motion.update_data(t)
        self._susp_chart.append(t)
        self._speed_chart.append(t)


# ---------------------------------------------------------------------------
# ToggleButton — clickable card with title, subtitle, and checked state
# ---------------------------------------------------------------------------

class ToggleButton(QFrame):
    """Card-style toggle button with a distinct accent colour when active."""

    toggled = pyqtSignal(bool)

    def __init__(
        self,
        title: str,
        subtitle: str,
        accent: str = "#44CCFF",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._checked = False
        self._accent = accent
        self.setFixedHeight(72)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        row = QHBoxLayout(self)
        row.setContentsMargins(14, 8, 14, 8)
        row.setSpacing(12)

        self._dot = QLabel("●")
        self._dot.setFixedWidth(14)

        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        self._title_lbl = QLabel(title)
        self._sub_lbl   = QLabel(subtitle)
        text_col.addWidget(self._title_lbl)
        text_col.addWidget(self._sub_lbl)

        row.addWidget(self._dot)
        row.addLayout(text_col, stretch=1)

        self._refresh()

    # ── Style ──────────────────────────────────────────────────────────────

    def _refresh(self) -> None:
        a = self._accent
        if self._checked:
            self.setStyleSheet(
                f"QFrame {{ background: #0d1a2e; border: 2px solid {a};"
                f" border-radius: 8px; }}"
            )
            self._dot.setStyleSheet(f"font-size: 10px; color: {a};")
            self._title_lbl.setStyleSheet(
                f"font-size: 15px; font-weight: bold; color: {a};"
            )
            self._sub_lbl.setStyleSheet("font-size: 11px; color: #aaaacc;")
        else:
            self.setStyleSheet(
                "QFrame { background: #1a1a2e; border: 1px solid #2a2a4a;"
                " border-radius: 8px; }"
            )
            self._dot.setStyleSheet("font-size: 10px; color: #444466;")
            self._title_lbl.setStyleSheet(
                "font-size: 15px; font-weight: bold; color: #888899;"
            )
            self._sub_lbl.setStyleSheet("font-size: 11px; color: #555566;")

    # ── Public API ─────────────────────────────────────────────────────────

    def setChecked(self, checked: bool) -> None:
        if self._checked != checked:
            self._checked = checked
            self._refresh()

    def isChecked(self) -> bool:
        return self._checked

    # ── Mouse event ────────────────────────────────────────────────────────

    def mousePressEvent(self, event) -> None:  # type: ignore[override]
        self._checked = not self._checked
        self._refresh()
        self.toggled.emit(self._checked)


# ---------------------------------------------------------------------------
# CategoryWindow — floating window that hides on close instead of quitting
# ---------------------------------------------------------------------------

class CategoryWindow(QMainWindow):
    """Base class for all category windows.

    Closing via the title-bar X hides the window and emits ``window_hidden``.
    Call ``force_close()`` to actually destroy the window (used on app exit).
    """

    window_hidden = pyqtSignal()

    def __init__(self) -> None:
        super().__init__()
        self._force = False
        self.setStyleSheet(_DARK_STYLE)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._force:
            super().closeEvent(event)
        else:
            event.ignore()
            self.hide()
            self.window_hidden.emit()

    def force_close(self) -> None:
        """Really close — called when the launcher exits."""
        self._force = True
        self.close()

    def update_data(self, t: dict) -> None:
        """Override in subclasses to receive telemetry packets."""


# ---------------------------------------------------------------------------
# Category windows (each wraps the matching tab widget)
# ---------------------------------------------------------------------------

class CarLapWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Car & Lap")
        self.setMinimumSize(300, 520)
        self._panel = LeftInfoPanel()
        self.setCentralWidget(self._panel)

    def update_data(self, t: dict) -> None:
        self._panel.update_data(t)


class TyresWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Tyres")
        self.setMinimumSize(640, 460)
        self._tab = TyresTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class EngineWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Engine")
        self.setMinimumSize(700, 500)
        self._tab = EngineTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class InputsWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Inputs")
        self.setMinimumSize(700, 420)
        self._tab = InputsTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class MotionWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Motion")
        self.setMinimumSize(800, 520)
        self._tab = MotionTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class RaceStatusWindow(CategoryWindow):
    """Vertical race-status panel — all header data in a readable grid."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Race Status")
        self.setMinimumSize(260, 480)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")
        self.setCentralWidget(scroll)

        content = QWidget()
        content.setStyleSheet("background: transparent;")
        lay = QVBoxLayout(content)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.setSpacing(2)
        scroll.setWidget(content)

        # ── Race state banner ─────────────────────────────────────────────
        self._race_lbl = QLabel("⬤  NO SIGNAL")
        self._race_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._race_lbl.setStyleSheet(
            "color: #664444; font-size: 14px; font-weight: bold;"
            " background: #1a1a2e; border: 1px solid #2a2a4a;"
            " border-radius: 6px; padding: 6px;"
        )
        lay.addWidget(self._race_lbl)
        lay.addSpacing(6)

        # ── Speed + gear display ──────────────────────────────────────────
        sg_row = QHBoxLayout()
        sg_row.setSpacing(10)

        speed_col = QVBoxLayout()
        speed_col.setSpacing(1)
        self._speed_lbl = QLabel("0")
        self._speed_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 38px; font-weight: bold; font-family: monospace;"
        )
        kmh_lbl = QLabel("km/h")
        kmh_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        kmh_lbl.setStyleSheet("color: #666688; font-size: 11px;")
        self._mph_lbl = QLabel("0 mph")
        self._mph_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._mph_lbl.setStyleSheet(
            "color: #555566; font-size: 11px; font-family: monospace;"
        )
        speed_col.addWidget(self._speed_lbl)
        speed_col.addWidget(kmh_lbl)
        speed_col.addWidget(self._mph_lbl)

        gear_col = QVBoxLayout()
        gear_col.setSpacing(1)
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 38px; font-weight: bold; font-family: monospace;"
            " background: #111122; border: 1px solid #2a2a4a; border-radius: 6px;"
            " padding: 6px 14px;"
        )
        gear_key = QLabel("GEAR")
        gear_key.setAlignment(Qt.AlignmentFlag.AlignCenter)
        gear_key.setStyleSheet("color: #666688; font-size: 11px;")
        gear_col.addWidget(self._gear_lbl)
        gear_col.addWidget(gear_key)

        sg_row.addLayout(speed_col, stretch=2)
        sg_row.addLayout(gear_col, stretch=1)
        lay.addLayout(sg_row)
        lay.addWidget(_divider())

        # Helper — build a named section and return its value labels
        def _sec(title: str, rows: list[tuple[str, str]]) -> dict[str, QLabel]:
            lay.addWidget(_section_label(title))
            grid = QGridLayout()
            grid.setHorizontalSpacing(8)
            grid.setVerticalSpacing(3)
            grid.setColumnStretch(1, 1)
            vals: dict[str, QLabel] = {}
            for i, (key, init) in enumerate(rows):
                grid.addWidget(_key_label(key), i, 0)
                v = _val_label(init)
                grid.addWidget(v, i, 1)
                vals[key] = v
            lay.addLayout(grid)
            lay.addWidget(_divider())
            return vals

        self._race_vals = _sec("LAP & RACE", [
            ("Lap:",       "--"),
            ("Position:",  "--"),
            ("Race Time:", "--:--.---"),
            ("Best Lap:",  "--:--.---"),
            ("Last Lap:",  "--:--.---"),
        ])
        self._eng_vals = _sec("ENGINE", [
            ("RPM:",     "--"),
            ("Max RPM:", "--"),
        ])
        self._car_vals = _sec("CAR", [
            ("Class:",      "--"),
            ("PI:",         "--"),
            ("Drivetrain:", "--"),
            ("Cylinders:",  "--"),
        ])
        self._status_vals = _sec("STATUS", [
            ("Boost:", "--"),
            ("Fuel:",  "--"),
        ])

        lay.addStretch()

    def update_data(self, t: dict) -> None:
        is_on = bool(t.get("IsRaceOn", 0))
        if is_on:
            self._race_lbl.setText("⬤  RACE ON")
            self._race_lbl.setStyleSheet(
                "color: #22BB44; font-size: 14px; font-weight: bold;"
                " background: #0a2010; border: 1px solid #22BB44;"
                " border-radius: 6px; padding: 6px;"
            )
        else:
            self._race_lbl.setText("⬤  PAUSED")
            self._race_lbl.setStyleSheet(
                "color: #664444; font-size: 14px; font-weight: bold;"
                " background: #1a1a2e; border: 1px solid #2a2a4a;"
                " border-radius: 6px; padding: 6px;"
            )

        self._speed_lbl.setText(f"{t.get('Speed', 0.0) * 3.6:.0f}")
        self._mph_lbl.setText(f"{t.get('Speed', 0.0) * 2.23694:.0f} mph")
        _g = t.get("Gear", 0)
        self._gear_lbl.setText(GEAR_MAP.get(_g, str(_g)))

        self._race_vals["Lap:"].setText(str(t.get("LapNumber", 0)))
        self._race_vals["Position:"].setText(str(t.get("RacePosition", 0)))
        self._race_vals["Race Time:"].setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))
        self._race_vals["Best Lap:"].setText(secs_to_time(t.get("BestLap", 0.0)))
        self._race_vals["Last Lap:"].setText(secs_to_time(t.get("LastLap", 0.0)))

        rpm     = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 1.0) or 1.0
        self._eng_vals["RPM:"].setText(f"{rpm:.0f}  ({rpm / max_rpm * 100:.0f}%)")
        self._eng_vals["Max RPM:"].setText(f"{max_rpm:.0f}")

        self._car_vals["Class:"].setText(CAR_CLASS.get(t.get("CarClass", -1), "?"))
        self._car_vals["PI:"].setText(str(t.get("CarPerformanceIndex", 0)))
        self._car_vals["Drivetrain:"].setText(DRIVETRAIN.get(t.get("DrivetrainType", -1), "?"))
        self._car_vals["Cylinders:"].setText(str(t.get("NumCylinders", 0)))

        self._status_vals["Boost:"].setText(f"{t.get('Boost', 0.0) * 0.0689476:.3f} bar")
        self._status_vals["Fuel:"].setText(f"{t.get('Fuel', 0.0) * 100:.1f}%")


# ---------------------------------------------------------------------------
# Category registry
# (title, subtitle, accent_color, window_class)
# ---------------------------------------------------------------------------

_CATEGORIES: list[tuple[str, str, str, type[CategoryWindow]]] = [
    (
        "Race Status",
        "Speed  ·  gear  ·  lap  ·  RPM  ·  car  ·  fuel",
        "#CC88FF",
        RaceStatusWindow,
    ),
    (
        "Car & Lap",
        "Car info  ·  lap times  ·  FH6 extras",
        "#44CCFF",
        CarLapWindow,
    ),
    (
        "Tyres",
        "Tyre widgets  ·  temperature history",
        "#FF4444",
        TyresWindow,
    ),
    (
        "Engine",
        "RPM  ·  power  ·  torque charts",
        "#FFDD44",
        EngineWindow,
    ),
    (
        "Inputs",
        "Throttle  ·  brake  ·  steer  ·  clutch",
        "#22BB44",
        InputsWindow,
    ),
    (
        "Motion",
        "Velocity  ·  position  ·  suspension  ·  speed",
        "#FF9900",
        MotionWindow,
    ),
]


# ---------------------------------------------------------------------------
# LauncherWindow
# ---------------------------------------------------------------------------

class LauncherWindow(QMainWindow):
    """Compact control panel — toggle category windows, monitor connection."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 Telemetry — Launcher")
        self.setFixedWidth(430)
        self.setStyleSheet(_DARK_STYLE)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Content area ──────────────────────────────────────────────────
        content = QWidget()
        body = QVBoxLayout(content)
        body.setContentsMargins(16, 16, 16, 16)
        body.setSpacing(8)

        title_lbl = QLabel("FH6 TELEMETRY")
        title_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 22px; font-weight: bold;"
            " letter-spacing: 3px; font-family: monospace;"
        )
        sub_lbl = QLabel("Multi-Window Dashboard")
        sub_lbl.setStyleSheet(
            "color: #555566; font-size: 12px; margin-bottom: 4px;"
        )
        body.addWidget(title_lbl)
        body.addWidget(sub_lbl)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("color: #2a2a4a; margin: 4px 0 8px 0;")
        body.addWidget(sep)

        # ── Connection input ──────────────────────────────────────────────
        conn_lbl = QLabel("CONNECTION")
        conn_lbl.setStyleSheet(
            "color: #666688; font-size: 10px; font-weight: bold; letter-spacing: 1px;"
        )
        body.addWidget(conn_lbl)

        addr_row = QHBoxLayout()
        addr_row.setSpacing(6)

        ip_lbl = QLabel("IP:")
        ip_lbl.setStyleSheet("color: #888899; font-size: 12px;")
        ip_lbl.setFixedWidth(20)
        self._ip_edit = QLineEdit(HOST)
        self._ip_edit.setPlaceholderText("e.g. 127.0.0.1")
        self._ip_edit.setStyleSheet(
            "QLineEdit { background: #111122; color: #ccccdd;"
            "  border: 1px solid #2a2a4a; border-radius: 4px;"
            "  padding: 4px 8px; font-size: 12px; font-family: monospace; }"
            "QLineEdit:focus { border: 1px solid #44CCFF; }"
        )

        port_lbl = QLabel("Port:")
        port_lbl.setStyleSheet("color: #888899; font-size: 12px;")
        port_lbl.setFixedWidth(28)
        self._port_edit = QLineEdit(str(PORT))
        self._port_edit.setPlaceholderText("1024-65535")
        self._port_edit.setFixedWidth(70)
        self._port_edit.setStyleSheet(
            "QLineEdit { background: #111122; color: #ccccdd;"
            "  border: 1px solid #2a2a4a; border-radius: 4px;"
            "  padding: 4px 8px; font-size: 12px; font-family: monospace; }"
            "QLineEdit:focus { border: 1px solid #44CCFF; }"
        )

        addr_row.addWidget(ip_lbl)
        addr_row.addWidget(self._ip_edit, stretch=1)
        addr_row.addWidget(port_lbl)
        addr_row.addWidget(self._port_edit)
        body.addLayout(addr_row)

        conn_btn_row = QHBoxLayout()
        conn_btn_row.setSpacing(8)
        test_btn    = self._accent_button("Test",    "#FFDD44")
        connect_btn = self._accent_button("Connect", "#22BB44")
        test_btn.clicked.connect(self._test_connection)
        connect_btn.clicked.connect(self._connect)
        conn_btn_row.addWidget(test_btn)
        conn_btn_row.addWidget(connect_btn)
        body.addLayout(conn_btn_row)

        sep2 = QFrame()
        sep2.setFrameShape(QFrame.Shape.HLine)
        sep2.setStyleSheet("color: #2a2a4a; margin: 4px 0 8px 0;")
        body.addWidget(sep2)

        windows_lbl = QLabel("SELECT WINDOWS")
        windows_lbl.setStyleSheet(
            "color: #666688; font-size: 10px; font-weight: bold; letter-spacing: 1px;"
        )
        body.addWidget(windows_lbl)

        # ── Toggle buttons ────────────────────────────────────────────────
        self._buttons: list[ToggleButton] = []
        self._windows: list[CategoryWindow] = []

        for title, subtitle, accent, WindowClass in _CATEGORIES:
            btn = ToggleButton(title, subtitle, accent)
            win = WindowClass()

            # X on the category window → uncheck the launcher button
            win.window_hidden.connect(lambda b=btn: b.setChecked(False))
            # Clicking the button → show or hide the window
            btn.toggled.connect(
                lambda checked, w=win: w.show() if checked else w.hide()
            )

            self._buttons.append(btn)
            self._windows.append(win)
            body.addWidget(btn)

        body.addSpacing(4)

        # ── Open All / Close All ──────────────────────────────────────────
        ctrl_row = QHBoxLayout()
        ctrl_row.setSpacing(8)

        open_all_btn  = self._ctrl_button("Open All")
        close_all_btn = self._ctrl_button("Close All")
        open_all_btn.clicked.connect(self._open_all)
        close_all_btn.clicked.connect(self._close_all)
        ctrl_row.addWidget(open_all_btn)
        ctrl_row.addWidget(close_all_btn)
        body.addLayout(ctrl_row)

        body.addStretch()
        root.addWidget(content)

        # ── Status bar ────────────────────────────────────────────────────
        sb = QStatusBar()
        self.setStatusBar(sb)
        self._conn_lbl = QLabel("⬤  Waiting for telemetry …")
        self._conn_lbl.setStyleSheet("color: #888866;")
        self._ts_lbl = QLabel("")
        self._ts_lbl.setStyleSheet("color: #555566;")
        sb.addWidget(self._conn_lbl)
        sb.addPermanentWidget(self._ts_lbl)

        self._connected = False
        self.adjustSize()

        # ── UDP receiver ──────────────────────────────────────────────────
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ── Helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _accent_button(text: str, accent: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setStyleSheet(
            f"QPushButton {{ background: #0d1a2e; color: {accent};"
            f"  border: 1px solid {accent}; border-radius: 5px;"
            f"  padding: 6px 14px; font-size: 12px; font-weight: bold; }}"
            f"QPushButton:hover {{ background: #1e1e3a; }}"
            f"QPushButton:pressed {{ background: #0a1020; }}"
        )
        return btn

    @staticmethod
    def _ctrl_button(text: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setStyleSheet(
            "QPushButton { background: #1a1a2e; color: #888899;"
            "  border: 1px solid #2a2a4a; border-radius: 5px;"
            "  padding: 6px 14px; font-size: 12px; }"
            "QPushButton:hover { background: #1e1e3a; color: #cccccc; }"
            "QPushButton:pressed { background: #0d1a2e; }"
        )
        return btn

    def _open_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(True)
            win.show()

    def _close_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(False)
            win.hide()

    # ── Connection helpers ────────────────────────────────────────────────

    def _parse_inputs(self) -> tuple[str, int] | None:
        """Validate and return (ip, port), or show an error and return None."""
        ip = self._ip_edit.text().strip()
        port_text = self._port_edit.text().strip()
        try:
            socket.inet_aton(ip)
        except OSError:
            self._conn_lbl.setText(f"⬤  Invalid IP address: '{ip}'")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
            return None
        try:
            port = int(port_text)
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            self._conn_lbl.setText(f"⬤  Invalid port: '{port_text}' (must be 1–65535)")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
            return None
        return ip, port

    def _test_connection(self) -> None:
        """Try to bind a UDP socket to the given address and report result."""
        parsed = self._parse_inputs()
        if parsed is None:
            return
        ip, port = parsed
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((ip, port))
            self._conn_lbl.setText(f"⬤  OK — {ip}:{port} is available")
            self._conn_lbl.setStyleSheet("color: #FFDD44;")
        except OSError as exc:
            self._conn_lbl.setText(f"⬤  Bind failed: {exc.strerror}")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
        finally:
            sock.close()

    def _connect(self) -> None:
        """Stop the current receiver and restart with the new IP/port."""
        parsed = self._parse_inputs()
        if parsed is None:
            return
        ip, port = parsed
        self._receiver.stop()
        self._receiver.wait(2000)
        self._connected = False
        self._receiver = TelemetryReceiver(ip, port)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()
        self._conn_lbl.setText(f"⬤  Listening on {ip}:{port} …")
        self._conn_lbl.setStyleSheet("color: #888866;")

    # ── Telemetry slot ────────────────────────────────────────────────────

    def _on_telemetry(self, t: dict) -> None:
        # FH6 broadcasts tyre temps in Fahrenheit — convert to °C
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0
            if t[key] <= 0.0:
                t[key] = 0.1  # Avoid zero or negative temps messing with charts

        if not self._connected:
            self._connected = True
            self._conn_lbl.setText(
                f"⬤  Connected  —  {HOST}:{PORT}  —  {PACKET_SIZE} bytes/packet"
            )
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        self._ts_lbl.setText(f"TimestampMS: {t.get('TimestampMS', 0)}")

        # Only push data to windows that are currently visible
        for win in self._windows:
            if win.isVisible():
                win.update_data(t)

    # ── Cleanup ───────────────────────────────────────────────────────────

    def closeEvent(self, event) -> None:  # type: ignore[override]
        for win in self._windows:
            win.force_close()
        self._receiver.stop()
        self._receiver.wait(2000)
        super().closeEvent(event)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    pg.setConfigOptions(antialias=True, foreground="#cccccc", background="#0d0d1a")
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    launcher = LauncherWindow()
    launcher.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
