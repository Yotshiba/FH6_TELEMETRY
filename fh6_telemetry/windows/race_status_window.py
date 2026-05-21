"""
RaceStatusWindow — vertical race-status panel with all header data in a readable grid.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..constants import CAR_CLASS, DRIVETRAIN, GEAR_MAP
from ..style import _divider, _key_label, _section_label, _val_label
from ..telemetry import secs_to_time
from .category_window import CategoryWindow


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

        # Race state banner
        self._race_lbl = QLabel("⬤  NO SIGNAL")
        self._race_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._race_lbl.setStyleSheet(
            "color: #664444; font-size: 14px; font-weight: bold;"
            " background: #1a1a2e; border: 1px solid #2a2a4a;"
            " border-radius: 6px; padding: 6px;"
        )
        lay.addWidget(self._race_lbl)
        lay.addSpacing(6)

        # Speed + gear display
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
        self._car_vals["Drivetrain:"].setText(
            DRIVETRAIN.get(t.get("DrivetrainType", -1), "?")
        )
        self._car_vals["Cylinders:"].setText(str(t.get("NumCylinders", 0)))

        self._status_vals["Boost:"].setText(
            f"{t.get('Boost', 0.0) * 0.0689476:.3f} bar"
        )
        self._status_vals["Fuel:"].setText(f"{t.get('Fuel', 0.0) * 100:.1f}%")
