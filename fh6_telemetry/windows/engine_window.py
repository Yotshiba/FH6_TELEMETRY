"""
EngineWindow — RPM, power, torque charts.
"""

from __future__ import annotations

from .category_window import CategoryWindow
from ..tabs.engine_tab import EngineTab


class EngineWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Engine")
        self.setMinimumSize(700, 500)
        self._tab = EngineTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)
