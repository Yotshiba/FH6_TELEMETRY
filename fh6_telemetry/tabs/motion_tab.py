"""
MotionTab — MotionPanel (left) + Suspension + Speed charts stacked (right).
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QSplitter, QVBoxLayout, QWidget

from ..widgets.motion_panel import MotionPanel
from ..widgets.rolling_chart import RollingChart
from ..constants import WHEEL_COLORS


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
