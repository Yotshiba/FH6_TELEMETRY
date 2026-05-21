"""
MotionWindow — velocity, position, suspension, and speed charts.
"""

from __future__ import annotations

from .category_window import CategoryWindow
from ..tabs.motion_tab import MotionTab


class MotionWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Motion")
        self.setMinimumSize(800, 520)
        self._tab = MotionTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)
