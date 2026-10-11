"""
RollingChart — a pyqtgraph PlotWidget with one or more scrolling lines.

Cost model (compare the original, which rebuilt everything per packet):

* ``ingest(t)`` only appends one row to a NumPy ring buffer — no Qt calls;
* ``refresh()`` does one ``setData`` per line and, for auto-ranged charts,
  consults a :class:`RangeSmoother` so the Y axis only changes when it must;
* curves are plain ``PlotCurveItem``s (no per-call style re-send, no finite
  scan), both axes have auto-range off, the Y axis has no SI-prefix relabelling
  and a fixed width, and lines are 1 px (cosmetic fast path) by default.
"""

from __future__ import annotations

import math
import time

import numpy as np
import pyqtgraph as pg
from PyQt6.QtWidgets import QWidget

from ..constants import HISTORY_LEN
from ..core.charts import ChartDef
from ..core.diagnostics import log_exception
from ..core.range_smoother import RangeSmoother
from ..gui.ringbuffer import RingBuffer

# name -> (pen width, antialias).  Wide antialiased pens fall off Qt's fast
# stroker, so "bold" trades antialiasing for width instead.
PEN_STYLES: dict[str, tuple[int, bool]] = {"thin": (1, True), "bold": (2, False)}
_default_style = "thin"


def set_default_style(style: str) -> None:
    """Pen style used by charts created afterwards (``thin`` or ``bold``)."""
    global _default_style
    if style in PEN_STYLES:
        _default_style = style


class RollingChart(pg.PlotWidget):
    """Rolling history chart with one or more lines, driven by a ChartDef."""

    def __init__(
        self,
        definition: ChartDef,
        history_len: int = HISTORY_LEN,
        style: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent, background="#0d0d1a")
        self.definition = definition
        self._channels = definition.channels
        self._n = history_len

        width, antialias = PEN_STYLES[style if style in PEN_STYLES else _default_style]

        plot = self.getPlotItem()
        self.setLabel("left", definition.title, units=definition.unit, color="#aaaaaa")
        axis = self.getAxis("left")
        axis.setTextPen(pg.mkPen("#aaaaaa"))
        # Must happen while the range is still [0, 1] so the scale stays 1:
        # auto-SI-prefix rebuilds an HTML label on every range change.
        axis.enableAutoSIPrefix(False)
        axis.setWidth(64)
        self.showGrid(x=False, y=True, alpha=0.15)
        self.getAxis("bottom").hide()
        self.setMenuEnabled(False)
        self.setMouseEnabled(x=False, y=False)
        self.setMinimumHeight(100)
        plot.hideButtons()

        vb = self.getViewBox()
        vb.setDefaultPadding(0.0)
        vb.disableAutoRange()                       # before any curve is added
        vb.setXRange(0, history_len - 1, padding=0)

        legend = self.addLegend(offset=(10, 10))
        legend.setLabelTextColor("#cccccc")

        self._curves: list[pg.PlotCurveItem] = []
        for line in definition.lines:
            curve = pg.PlotCurveItem(
                pen=pg.mkPen(color=line.color, width=width),
                antialias=antialias,
                name=line.label,
            )
            self.addItem(curve)
            self._curves.append(curve)

        self._ring = RingBuffer(len(definition.lines), history_len)
        self._x = np.arange(history_len, dtype=np.float64)
        self._last = [0.0] * len(definition.lines)
        self._row = [0.0] * len(definition.lines)

        # Y axis policy
        self._smoother: RangeSmoother | None = None
        if definition.y_fixed is not None:
            self.setYRange(*definition.y_fixed, padding=0.05)
        else:
            self._smoother = RangeSmoother(
                y_min=definition.y_min, floor=definition.y_floor
            )
            lo, hi = definition.y_floor or (definition.y_min or 0.0, 1.0)
            self.setYRange(lo, hi, padding=0)

    # ------------------------------------------------------------------
    # Data in
    # ------------------------------------------------------------------

    def ingest(self, t: dict) -> None:
        """Buffer one sample (no drawing).  Non-finite values repeat the last one."""
        row, last = self._row, self._last
        for i, ch in enumerate(self._channels):
            try:
                v = float(t.get(ch, last[i]))
            except (TypeError, ValueError):
                v = last[i]
            if math.isfinite(v):
                last[i] = v
            else:
                v = last[i]
            row[i] = v
        self._ring.append(row)

    def ingest_frames(self, frames: list[dict]) -> None:
        """Buffer a batch of frames.

        Frames with ``IsRaceOn == 0`` (menus / pause) are not plotted: they
        carry zeros or frozen values that would drag the Y range around.
        """
        for t in frames:
            if t.get("IsRaceOn", 1):
                self.ingest(t)

    def reset(self) -> None:
        """Forget the history (e.g. after connecting to a different source)."""
        self._ring.clear()
        if self._smoother is not None:
            self._smoother.reset()

    # ------------------------------------------------------------------
    # Drawing
    # ------------------------------------------------------------------

    def refresh(self) -> None:
        """Redraw from the buffered samples."""
        n = self._ring.count
        if n == 0:
            return
        window = np.array(self._ring.window())      # private copy; curves keep it
        x = self._x[self._n - n:]                   # newest sample on the right edge
        for i, curve in enumerate(self._curves):
            curve.setData(x, window[i])

        if self._smoother is not None:
            new = self._smoother.update(float(window.min()), float(window.max()),
                                        time.monotonic())
            if new is not None:
                try:
                    self.setYRange(new[0], new[1], padding=0)
                except Exception as exc:    # never let one bad range kill the UI
                    log_exception(f"chart {self.definition.id} setYRange", exc)

    def append(self, t: dict) -> None:
        """Ingest and draw immediately (the original per-packet behaviour)."""
        self.ingest(t)
        self.refresh()
