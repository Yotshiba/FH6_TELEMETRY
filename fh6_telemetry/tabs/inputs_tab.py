"""
InputsTab — input bars + steer indicator (left) + Throttle/Brake chart (right).
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QLabel,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..style import _divider, _section_label
from ..widgets.bar_indicator import BarIndicator
from ..widgets.rolling_chart import RollingChart


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
