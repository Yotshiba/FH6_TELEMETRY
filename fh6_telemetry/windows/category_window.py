"""
CategoryWindow — base class for all floating category windows.

The launcher drives each window from one render timer:

* ``feed(frames)``    every tick, even while hidden/minimized — buffers the new
                      frames into the window's charts (a few µs of NumPy);
* ``update_data(t)``  only while the window is on screen — labels and bars from
                      the newest frame;
* ``refresh()``       only while on screen — redraws the charts.

So a hidden or minimized window costs almost nothing, and its charts are
complete the moment it is shown again.
"""

from __future__ import annotations

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QMainWindow

from ..style import _DARK_STYLE
from ..widgets.rolling_chart import RollingChart


class CategoryWindow(QMainWindow):
    """Base class for all category windows.

    Closing via the title-bar X hides the window and emits ``window_hidden``.
    Call ``force_close()`` to actually destroy the window on app exit.
    """

    window_hidden = pyqtSignal()

    def __init__(self) -> None:
        super().__init__()
        self._force = False
        self._charts: list[RollingChart] | None = None
        self.setStyleSheet(_DARK_STYLE)

    # ------------------------------------------------------------------
    # Visibility
    # ------------------------------------------------------------------

    def is_on_screen(self) -> bool:
        """Visible and not minimized.

        ``isVisible()`` alone stays true for minimized windows (Qt treats them
        as visible), so minimizing would not stop any work.  Qt cannot tell if
        another window covers this one; that case still renders.
        """
        return self.isVisible() and not self.isMinimized()

    # ------------------------------------------------------------------
    # Render-timer interface
    # ------------------------------------------------------------------

    @property
    def charts(self) -> list[RollingChart]:
        if self._charts is None:
            self._charts = self.findChildren(RollingChart)
        return self._charts

    def feed(self, frames: list[dict]) -> None:
        """Buffer new frames into the charts (no drawing)."""
        for chart in self.charts:
            chart.ingest_frames(frames)

    def update_data(self, t: dict) -> None:
        """Override in subclasses: refresh labels/bars from the newest frame."""

    def refresh(self) -> None:
        """Redraw the charts from their buffers."""
        for chart in self.charts:
            chart.refresh()

    def reset_history(self) -> None:
        """Forget chart history (a new telemetry source was connected)."""
        for chart in self.charts:
            chart.reset()

    # ------------------------------------------------------------------
    # Closing
    # ------------------------------------------------------------------

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
