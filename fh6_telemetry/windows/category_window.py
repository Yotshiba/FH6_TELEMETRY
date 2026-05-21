"""
CategoryWindow — base class for all floating category windows.
"""

from __future__ import annotations

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QMainWindow

from ..style import _DARK_STYLE


class CategoryWindow(QMainWindow):
    """Base class for all category windows.

    Closing via the title-bar X hides the window and emits ``window_hidden``.
    Call ``force_close()`` to actually destroy the window on app exit.
    """

    window_hidden = pyqtSignal()

    def __init__(self) -> None:
        super().__init__()
        self._force = False
        self.setStyleSheet(_DARK_STYLE)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._force:
            super().closeEvent(event)
        else:
            event.ignore()
            self.hide()
            self.window_hidden.emit()

    def force_close(self) -> None:
        """Really close — called when the launcher exits."""
        self._force = True
        self.close()

    def update_data(self, t: dict) -> None:
        """Override in subclasses to receive telemetry packets."""
