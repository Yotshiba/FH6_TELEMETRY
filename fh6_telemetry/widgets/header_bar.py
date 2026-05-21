"""
HeaderBar — single-row strip showing race state, speed, gear, lap, RPM, car,
boost/fuel, and race time.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QWidget

from ..constants import CAR_CLASS, DRIVETRAIN, GEAR_MAP
from ..telemetry import secs_to_time


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
