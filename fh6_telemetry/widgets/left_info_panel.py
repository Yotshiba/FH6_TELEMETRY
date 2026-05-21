"""
LeftInfoPanel — scrollable panel with car info, lap times, inputs, and FH6 extras.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..constants import CAR_CLASS, CAR_GROUP_MAP, DRIVETRAIN
from ..style import _divider, _key_label, _section_label, _val_label
from ..telemetry import secs_to_time
from .bar_indicator import BarIndicator


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
