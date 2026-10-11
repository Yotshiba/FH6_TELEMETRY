"""
TyresTab — TyrePanelGrid (top) + tyre temperature rolling chart (bottom).
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QSplitter, QVBoxLayout, QWidget

from ..core.charts import CHARTS
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
        self._temp_chart = RollingChart(CHARTS["tyre_temp"])

        split.addWidget(self._grid)
        split.addWidget(self._temp_chart)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 1)
        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._grid.update_data(t)
