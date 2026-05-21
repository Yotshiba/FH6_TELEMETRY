"""
TyresTab — TyrePanelGrid (top) + tyre temperature rolling chart (bottom).
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QSplitter, QVBoxLayout, QWidget

from ..constants import WHEEL_COLORS
from ..widgets.rolling_chart import RollingChart
from ..widgets.tyre_panel_grid import TyrePanelGrid


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
