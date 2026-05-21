"""
Forza Horizon 6 — Full Telemetry Dashboard
Multi-panel PyQt6 window showing every FH6 telemetry field with 6 rolling
history charts and live text readouts.

Layout
------
  [Header bar: race state · speed · gear · lap · car info · boost · fuel]
  ┌──────────────────┬──────────────────────┬──────────────────────────────┐
  │  LEFT PANEL      │  TYRE PANEL (2×2)    │  MOTION PANEL                │
  │  Car info        │  FL | FR             │  Speed (large) + Gear        │
  │  Lap / Race      │  ─── + ───           │  Velocity / Accel / AngVel   │
  │  Inputs          │  RL | RR             │  Yaw / Pitch / Roll          │
  │  FH6 extras      │                      │  Position X/Y/Z              │
  ├──────────────────┴──────────────────────┴──────────────────────────────┤
  │  [Tyre Temp chart] │ [RPM chart]         │ [Throttle & Brake chart]    │
  │  [Speed chart    ] │ [Power+Torque chart]│ [Suspension chart          ]│
  └────────────────────┴─────────────────────┴─────────────────────────────┘

Usage:  python dashboard_ui.py
"""

from __future__ import annotations

import sys
from collections import deque
from typing import Callable

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QScrollArea,
    QSplitter,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from main import (
    CAR_CLASS,
    DRIVETRAIN,
    GEAR_MAP,
    HOST,
    PACKET_SIZE,
    PORT,
    secs_to_time,
)
from tyre_ui import (
    HISTORY_LEN,
    WHEEL_COLORS,
    WHEELS,
    BarIndicator,
    TelemetryReceiver,
    TyreWidget,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CAR_GROUP_MAP: dict[int, str] = {
    0: "Cars",
    1: "Trucks",
    2: "Buggies",
    3: "Drift",
    4: "Rally",
    5: "Track Day",
    6: "Formula",
}

# ---------------------------------------------------------------------------
# Global dark stylesheet
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Small UI helpers
# ---------------------------------------------------------------------------


def _section_label(text: str) -> QLabel:
    """Dim, all-caps section header label."""
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


# ---------------------------------------------------------------------------
# RollingChart — generic multi-line rolling history chart
# ---------------------------------------------------------------------------

# Each line entry: (data_key, legend_label, hex_color, transform_or_None)
LineSpec = tuple[str, str, str, Callable[[float], float] | None]


class RollingChart(pg.PlotWidget):
    """
    Rolling history chart with one or more lines.

    Parameters
    ----------
    title     : Y-axis label / chart title.
    unit      : Unit string appended to the Y-axis label.
    lines     : List of (data_key, legend_label, hex_color, transform).
                *transform* is called on the raw telemetry value before
                appending; pass ``None`` for no transformation.
    history_len : Ring-buffer length (samples).
    y_range   : Fixed (min, max) for the Y axis. Auto-scales when None.
    """

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

        self._lines_cfg = lines
        self._history_len = history_len
        self._fixed_y = y_range
        self._y_min = y_min

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
            key: transform
            for key, _lbl, _col, transform in lines
        }

        self._x = np.arange(history_len)

        legend = self.addLegend(offset=(10, 10))
        legend.setLabelTextColor("#cccccc")

        self._curves: dict[str, pg.PlotDataItem] = {}
        for key, label, color, _ in lines:
            pen = pg.mkPen(color=color, width=2)
            curve = self.plot(self._x, np.zeros(history_len), pen=pen, name=label)
            self._curves[key] = curve

        if y_range is not None:
            self.setYRange(*y_range, padding=0.05)

    def append(self, t: dict) -> None:
        """Push one telemetry sample and redraw all curves."""
        for key, *_ in self._lines_cfg:
            raw = t.get(key, 0.0)
            fn = self._transforms.get(key)
            val = fn(float(raw)) if fn is not None else float(raw)
            self._buffers[key].append(val)
            self._curves[key].setData(self._x, np.array(self._buffers[key]))

        if self._fixed_y is None:
            all_vals = [v for buf in self._buffers.values() for v in buf if v != 0.0]
            if all_vals:
                lo = min(all_vals)
                hi = max(all_vals)
                margin = max((hi - lo) * 0.1, 1.0)
                lo_bound = lo - margin
                if self._y_min is not None:
                    lo_bound = max(self._y_min, lo_bound)
                self.setYRange(lo_bound, hi + margin, padding=0)


# ---------------------------------------------------------------------------
# HeaderBar — compact full-width top strip
# ---------------------------------------------------------------------------

class HeaderBar(QWidget):
    """Single-row strip: race state · speed · gear · lap/pos · RPM · car · boost/fuel · race time."""

    _RACE_ON_STYLE  = "color: #22BB44; font-size: 13px; font-weight: bold;"
    _RACE_OFF_STYLE = "color: #664444; font-size: 13px; font-weight: bold;"
    _SEP_STYLE      = "color: #2a2a4a; font-size: 16px;"
    _VAL_BOLD       = "color: #eeeeee; font-size: 13px; font-family: monospace; font-weight: bold;"
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

        # Race state
        self._race_lbl = QLabel("⬤  NO SIGNAL")
        self._race_lbl.setStyleSheet(self._RACE_OFF_STYLE)
        row.addWidget(self._race_lbl)
        row.addWidget(_sep())

        # Speed  (wider, custom color)
        self._speed_lbl = QLabel("0 km/h")
        self._speed_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 18px; font-family: monospace; font-weight: bold;"
        )
        self._speed_lbl.setFixedWidth(130)
        row.addWidget(self._speed_lbl)
        row.addWidget(_sep())

        # Gear
        row.addWidget(_key("GEAR"))
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 16px; font-family: monospace; font-weight: bold;"
        )
        self._gear_lbl.setFixedWidth(22)
        row.addWidget(self._gear_lbl)
        row.addWidget(_sep())

        # Lap + Position
        row.addWidget(_key("LAP"))
        self._lap_lbl = _val(width=24)
        row.addWidget(self._lap_lbl)
        row.addWidget(_key("POS"))
        self._pos_lbl = _val(width=24)
        row.addWidget(self._pos_lbl)
        row.addWidget(_sep())

        # RPM
        row.addWidget(_key("RPM"))
        self._rpm_lbl = _val(width=100)
        row.addWidget(self._rpm_lbl)
        row.addWidget(_sep())

        # Car class / PI / drivetrain
        row.addWidget(_key("CAR"))
        self._car_lbl = _val(width=170)
        row.addWidget(self._car_lbl)
        row.addWidget(_sep())

        # Boost
        row.addWidget(_key("BOOST"))
        self._boost_lbl = _val(width=64)
        row.addWidget(self._boost_lbl)

        # Fuel
        row.addWidget(_key("FUEL"))
        self._fuel_lbl = _val(width=46)
        row.addWidget(self._fuel_lbl)

        row.addStretch()

        # Race time (right-aligned)
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

        self._gear_lbl.setText(GEAR_MAP.get(t.get("Gear", 0), "?"))

        self._lap_lbl.setText(str(t.get("LapNumber", 0)))
        self._pos_lbl.setText(str(t.get("RacePosition", 0)))

        rpm = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 1.0) or 1.0
        rpm_pct = rpm / max_rpm * 100
        self._rpm_lbl.setText(f"{rpm:.0f}  ({rpm_pct:.0f}%)")

        car_class = CAR_CLASS.get(t.get("CarClass", -1), "?")
        pi        = t.get("CarPerformanceIndex", 0)
        drv       = DRIVETRAIN.get(t.get("DrivetrainType", -1), "?")
        cyl       = t.get("NumCylinders", 0)
        self._car_lbl.setText(f"{car_class}  PI:{pi}  {drv}  {cyl}cyl")

        self._boost_lbl.setText(f"{t.get('Boost', 0.0):.1f} PSI")
        self._fuel_lbl.setText(f"{t.get('Fuel', 0.0) * 100:.1f}%")
        self._race_time_lbl.setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))


# ---------------------------------------------------------------------------
# LeftInfoPanel — car info · lap times · inputs · FH6 extras
# ---------------------------------------------------------------------------

class LeftInfoPanel(QWidget):
    """Scrollable left panel with four data sections."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(230)

        # Scroll area wraps all content so the panel never forces a resize
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

        # ── CAR INFO ─────────────────────────────────────────────────────
        layout.addWidget(_section_label("CAR INFO"))
        car_rows = [
            ("Class:",       "--"),
            ("PI:",          "--"),
            ("Drivetrain:",  "--"),
            ("Cylinders:",   "--"),
            ("Car Group:",   "--"),
            ("Smash Mass:",  "--"),
        ]
        self._car_vals = self._build_grid(layout, car_rows)

        layout.addWidget(_divider())

        # ── LAP & RACE TIMES ─────────────────────────────────────────────
        layout.addWidget(_section_label("LAP & RACE TIMES"))
        lap_rows = [
            ("Best Lap:",    "--:--.---"),
            ("Last Lap:",    "--:--.---"),
            ("Current Lap:", "--:--.---"),
            ("Race Time:",   "--:--.---"),
            ("Distance:",    "--"),
        ]
        self._lap_vals = self._build_grid(layout, lap_rows)

        layout.addWidget(_divider())

        # ── INPUTS ───────────────────────────────────────────────────────
        layout.addWidget(_section_label("INPUTS"))
        self._input_bars: dict[str, BarIndicator] = {}
        for name, max_v, danger in [
            ("Throttle",  100.0, 90.0),
            ("Brake",     100.0, 90.0),
            ("Clutch",    100.0, 90.0),
            ("Handbrake", 100.0, 90.0),
            ("Steer",     100.0, 80.0),
            ("Boost",      30.0, 20.0),
            ("Fuel",      100.0, 20.0),
        ]:
            bar = BarIndicator(name, max_v, danger)
            self._input_bars[name] = bar
            layout.addWidget(bar)

        layout.addWidget(_divider())

        # ── FH6 EXTRAS ───────────────────────────────────────────────────
        layout.addWidget(_section_label("FH6 EXTRAS"))
        extras_rows = [
            ("Smash ΔVel:", "--"),
            ("Drive Line:", "--"),
            ("AI Brake Δ:", "--"),
        ]
        self._extras_vals = self._build_grid(layout, extras_rows)

        layout.addStretch()

    # ── Helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _build_grid(
        parent_layout: QVBoxLayout,
        rows: list[tuple[str, str]],
    ) -> dict[str, QLabel]:
        """Add a two-column key/value grid to *parent_layout*. Returns value labels."""
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(2)
        grid.setColumnStretch(1, 1)
        vals: dict[str, QLabel] = {}
        for i, (key, init) in enumerate(rows):
            k = _key_label(key)
            v = _val_label(init)
            grid.addWidget(k, i, 0)
            grid.addWidget(v, i, 1)
            vals[key] = v
        parent_layout.addLayout(grid)
        return vals

    # ── Data update ───────────────────────────────────────────────────────

    def update_data(self, t: dict) -> None:
        # Car info
        self._car_vals["Class:"].setText(CAR_CLASS.get(t.get("CarClass", -1), "?"))
        self._car_vals["PI:"].setText(str(t.get("CarPerformanceIndex", 0)))
        self._car_vals["Drivetrain:"].setText(DRIVETRAIN.get(t.get("DrivetrainType", -1), "?"))
        self._car_vals["Cylinders:"].setText(str(t.get("NumCylinders", 0)))
        cg = CAR_GROUP_MAP.get(t.get("CarGroup", -1), f"#{t.get('CarGroup', '?')}")
        self._car_vals["Car Group:"].setText(cg)
        self._car_vals["Smash Mass:"].setText(f"{t.get('SmashableMass', 0.0):.0f} kg")

        # Lap times
        self._lap_vals["Best Lap:"].setText(secs_to_time(t.get("BestLap", 0.0)))
        self._lap_vals["Last Lap:"].setText(secs_to_time(t.get("LastLap", 0.0)))
        self._lap_vals["Current Lap:"].setText(secs_to_time(t.get("CurrentLap", 0.0)))
        self._lap_vals["Race Time:"].setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))
        self._lap_vals["Distance:"].setText(f"{t.get('DistanceTraveled', 0.0) / 1000:.2f} km")

        # Inputs — normalise all to a 0–100 % scale for the bar
        self._input_bars["Throttle"].update_value( t.get("Accel",     0) / 255 * 100)
        self._input_bars["Brake"].update_value(    t.get("Brake",     0) / 255 * 100)
        self._input_bars["Clutch"].update_value(   t.get("Clutch",    0) / 255 * 100)
        self._input_bars["Handbrake"].update_value(t.get("HandBrake", 0) / 255 * 100)
        self._input_bars["Steer"].update_value(abs(t.get("Steer",     0) / 127 * 100))
        self._input_bars["Boost"].update_value(    t.get("Boost",     0.0))
        self._input_bars["Fuel"].update_value(     t.get("Fuel",      0.0) * 100)

        # FH6 extras
        self._extras_vals["Smash ΔVel:"].setText(
            f"{t.get('SmashableVelDiff', 0.0):.2f} m/s"
        )
        self._extras_vals["Drive Line:"].setText(
            f"{t.get('NormalizedDrivingLine', 0):+d}"
        )
        self._extras_vals["AI Brake Δ:"].setText(
            f"{t.get('NormalizedAIBrakeDifference', 0):+d}"
        )


# ---------------------------------------------------------------------------
# TyrePanelGrid — 2×2 grid of TyreWidget
# ---------------------------------------------------------------------------

class TyrePanelGrid(QWidget):
    """Wraps 4 TyreWidget cards in a 2×2 grid."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setSpacing(8)
        grid.setContentsMargins(4, 4, 4, 4)

        self._tyres: dict[str, TyreWidget] = {}
        for wheel, (row, col) in [("FL", (0, 0)), ("FR", (0, 1)), ("RL", (1, 0)), ("RR", (1, 1))]:
            w = TyreWidget(wheel)
            self._tyres[wheel] = w
            grid.addWidget(w, row, col)

        for i in range(2):
            grid.setRowStretch(i, 1)
            grid.setColumnStretch(i, 1)

    def update_data(self, t: dict) -> None:
        for widget in self._tyres.values():
            widget.update_data(t)


# ---------------------------------------------------------------------------
# MotionPanel — large speed + all motion / orientation / position readouts
# ---------------------------------------------------------------------------

class MotionPanel(QWidget):
    """Right panel: oversized speed/gear display + scrollable motion data grid."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(230)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(4)

        # ── Speed card ────────────────────────────────────────────────────
        speed_frame = QFrame()
        speed_frame.setStyleSheet(
            "QFrame { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; }"
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
        self._mph_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
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

        # ── Scrollable data grid ──────────────────────────────────────────
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

        # Inner helper: add a named section returning a {name: QLabel} dict
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

        self._vel_vals = _section("VELOCITY (m/s)",        ["Vel X", "Vel Y", "Vel Z"])
        self._acc_vals = _section("ACCELERATION (g)",      ["Acc X", "Acc Y", "Acc Z"])
        self._ang_vals = _section("ANGULAR VEL (rad/s)",   ["AngVel X", "AngVel Y", "AngVel Z"])
        self._ori_vals = _section("ORIENTATION (rad)",     ["Yaw", "Pitch", "Roll"])
        self._pos_vals = _section("POSITION (m)",          ["Pos X", "Pos Y", "Pos Z"])

        data_layout.addStretch()

    def update_data(self, t: dict) -> None:
        speed_kmh = t.get("Speed", 0.0) * 3.6
        speed_mph = t.get("Speed", 0.0) * 2.23694
        self._speed_kmh_lbl.setText(f"{speed_kmh:.0f}")
        self._mph_lbl.setText(f"{speed_mph:.0f} mph")
        self._gear_lbl.setText(GEAR_MAP.get(t.get("Gear", 0), "?"))

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


# ---------------------------------------------------------------------------
# Chart definitions  (6 charts, arranged 3 columns × 2 rows)
# Column order: [Tyre/Speed] | [RPM/PowerTorque] | [Throttle/Suspension]
# ---------------------------------------------------------------------------

_CHART_DEFS: list[tuple[str, str, list[LineSpec], tuple[float, float] | None, float | None]] = [
    # ── Column 1 ─────────────────────────────────────────────────────────
    (
        "Tyre Temp", "°C",
        [
            ("TireTempFL", "FL", WHEEL_COLORS["FL"], None),
            ("TireTempFR", "FR", WHEEL_COLORS["FR"], None),
            ("TireTempRL", "RL", WHEEL_COLORS["RL"], None),
            ("TireTempRR", "RR", WHEEL_COLORS["RR"], None),
        ],
        None,   # y_range
        0.0,    # y_min — floor at 0 °C
    ),
    (
        "Speed", "km/h",
        [("Speed", "Speed", "#44CCFF", lambda v: v * 3.6)],
        (0.0, 350.0),
        None,
    ),
    # ── Column 2 ─────────────────────────────────────────────────────────
    (
        "RPM", "rpm",
        [
            ("CurrentEngineRpm", "RPM",     "#FFDD44", None),
            ("EngineMaxRpm",     "Max RPM", "#FF4444", None),
        ],
        (0.0, 10000.0),
        None,
    ),
    (
        "Power & Torque", "kW / Nm",
        [
            ("Power",  "Power (kW)",  "#44CCFF", lambda v: v / 1000.0),
            ("Torque", "Torque (Nm)", "#FF9900", None),
        ],
        None,
        None,
    ),
    # ── Column 3 ─────────────────────────────────────────────────────────
    (
        "Throttle & Brake", "%",
        [
            ("Accel", "Throttle", "#22BB44", lambda v: v / 255.0 * 100.0),
            ("Brake", "Brake",    "#DD2200", lambda v: v / 255.0 * 100.0),
        ],
        (0.0, 100.0),
        None,
    ),
    (
        "Suspension", "norm",
        [
            ("SuspNormFL", "FL", WHEEL_COLORS["FL"], None),
            ("SuspNormFR", "FR", WHEEL_COLORS["FR"], None),
            ("SuspNormRL", "RL", WHEEL_COLORS["RL"], None),
            ("SuspNormRR", "RR", WHEEL_COLORS["RR"], None),
        ],
        (0.0, 1.0),
        None,
    ),
]


# ---------------------------------------------------------------------------
# DashboardWindow
# ---------------------------------------------------------------------------

class DashboardWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 Telemetry Dashboard")
        self.setMinimumSize(1200, 750)
        self.setStyleSheet(_DARK_STYLE)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Header strip ──────────────────────────────────────────────────
        self._header = HeaderBar()
        root.addWidget(self._header)

        # ── Main vertical splitter (top panels | bottom charts) ───────────
        main_split = QSplitter(Qt.Orientation.Vertical)
        main_split.setChildrenCollapsible(False)
        root.addWidget(main_split)

        # ── Top: three info panels ────────────────────────────────────────
        top_split = QSplitter(Qt.Orientation.Horizontal)
        top_split.setChildrenCollapsible(False)

        self._left_panel   = LeftInfoPanel()
        self._tyre_panel   = TyrePanelGrid()
        self._motion_panel = MotionPanel()

        top_split.addWidget(self._left_panel)
        top_split.addWidget(self._tyre_panel)
        top_split.addWidget(self._motion_panel)
        top_split.setStretchFactor(0, 2)   # LeftInfoPanel
        top_split.setStretchFactor(1, 4)   # TyrePanelGrid (largest)
        top_split.setStretchFactor(2, 3)   # MotionPanel

        main_split.addWidget(top_split)

        # ── Bottom: 3 chart columns, each with 2 stacked charts ───────────
        chart_split = QSplitter(Qt.Orientation.Horizontal)
        chart_split.setChildrenCollapsible(False)

        self._charts: list[RollingChart] = []
        for col in range(3):
            col_split = QSplitter(Qt.Orientation.Vertical)
            col_split.setChildrenCollapsible(False)
            for row in range(2):
                idx = col * 2 + row
                title, unit, lines, y_range, y_min = _CHART_DEFS[idx]
                chart = RollingChart(title, unit, lines, y_range=y_range, y_min=y_min)
                self._charts.append(chart)
                col_split.addWidget(chart)
            chart_split.addWidget(col_split)

        main_split.addWidget(chart_split)
        main_split.setStretchFactor(0, 5)   # panels taller
        main_split.setStretchFactor(1, 3)   # charts shorter

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

        # ── UDP receiver thread ───────────────────────────────────────────
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ── Telemetry slot ────────────────────────────────────────────────────

    def _on_telemetry(self, t: dict) -> None:
        # FH6 sends tyre temperatures in Fahrenheit; convert to °C
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0

        if not self._connected:
            self._connected = True
            self._conn_lbl.setText(
                f"⬤  Connected  —  {HOST}:{PORT}  —  {PACKET_SIZE} bytes/packet"
            )
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        # Dispatch to all panels
        self._header.update_data(t)
        self._left_panel.update_data(t)
        self._tyre_panel.update_data(t)
        self._motion_panel.update_data(t)

        # Append to all history charts
        for chart in self._charts:
            chart.append(t)

        self._ts_lbl.setText(f"TimestampMS: {t.get('TimestampMS', 0)}")

    # ── Cleanup ───────────────────────────────────────────────────────────

    def closeEvent(self, event) -> None:  # type: ignore[override]
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
    win = DashboardWindow()
    win.showMaximized()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
