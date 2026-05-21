"""
EngineTab — stats strip + RPM chart + Power & Torque chart.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..constants import GEAR_MAP
from ..widgets.rolling_chart import RollingChart


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
        _gv     = t.get("Gear", 0)
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
