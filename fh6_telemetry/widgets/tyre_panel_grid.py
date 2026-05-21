"""
TyrePanelGrid — 2×2 grid of TyreWidget cards.
"""

from __future__ import annotations

from PyQt6.QtWidgets import QGridLayout, QWidget

from .tyre_widget import TyreWidget


class TyrePanelGrid(QWidget):
    """2×2 grid of TyreWidget cards."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setSpacing(8)
        grid.setContentsMargins(4, 4, 4, 4)
        self._tyres: dict[str, TyreWidget] = {}
        for wheel, (row, col) in [
            ("FL", (0, 0)), ("FR", (0, 1)), ("RL", (1, 0)), ("RR", (1, 1))
        ]:
            w = TyreWidget(wheel)
            self._tyres[wheel] = w
            grid.addWidget(w, row, col)
        for i in range(2):
            grid.setRowStretch(i, 1)
            grid.setColumnStretch(i, 1)

    def update_data(self, t: dict) -> None:
        for widget in self._tyres.values():
            widget.update_data(t)
