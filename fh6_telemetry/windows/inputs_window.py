"""
InputsWindow — throttle, brake, steering, clutch charts.
"""

from __future__ import annotations

from .category_window import CategoryWindow
from ..tabs.inputs_tab import InputsTab


class InputsWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Inputs")
        self.setMinimumSize(700, 420)
        self._tab = InputsTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)
