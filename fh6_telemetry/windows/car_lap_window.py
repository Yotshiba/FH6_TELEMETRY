"""
CarLapWindow — car info, lap times, inputs, and FH6 extras.
"""

from __future__ import annotations

from .category_window import CategoryWindow
from ..widgets.left_info_panel import LeftInfoPanel


class CarLapWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Car & Lap")
        self.setMinimumSize(300, 520)
        self._panel = LeftInfoPanel()
        self.setCentralWidget(self._panel)

    def update_data(self, t: dict) -> None:
        self._panel.update_data(t)
