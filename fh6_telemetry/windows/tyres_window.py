"""
TyresWindow — tyre widgets + temperature history.
"""

from __future__ import annotations

from .category_window import CategoryWindow
from ..tabs.tyres_tab import TyresTab


class TyresWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Tyres")
        self.setMinimumSize(640, 460)
        self._tab = TyresTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)
