"""
RollingChart — a pyqtgraph PlotWidget with one or more scrolling data lines.
"""

from __future__ import annotations

from collections import deque
from typing import Callable

import numpy as np
import pyqtgraph as pg
from PyQt6.QtWidgets import QWidget

from ..constants import HISTORY_LEN
from ..style import LineSpec


class RollingChart(pg.PlotWidget):
    """Rolling history chart with one or more lines."""

    def __init__(
        self,
        title: str,
        unit: str,
        lines: list[LineSpec],
        history_len: int = HISTORY_LEN,
        y_range: tuple[float, float] | None = None,
        y_min: float | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent, background="#0d0d1a")
        self._lines_cfg   = lines
        self._history_len = history_len
        self._fixed_y     = y_range
        self._y_min       = y_min

        self.setLabel("left", title, units=unit, color="#aaaaaa")
        self.showGrid(x=False, y=True, alpha=0.15)
        self.getAxis("left").setTextPen(pg.mkPen("#aaaaaa"))
        self.getAxis("bottom").hide()
        self.setMenuEnabled(False)
        self.setMouseEnabled(x=False, y=False)
        self.setMinimumHeight(100)

        self._buffers: dict[str, deque[float]] = {
            key: deque([0.0] * history_len, maxlen=history_len)
            for key, *_ in lines
        }
        self._transforms: dict[str, Callable[[float], float] | None] = {
            key: transform for key, _lbl, _col, transform in lines
        }
        self._x = np.arange(history_len)

        legend = self.addLegend(offset=(10, 10))
        legend.setLabelTextColor("#cccccc")

        self._curves: dict[str, pg.PlotDataItem] = {}
        for key, label, color, _ in lines:
            pen = pg.mkPen(color=color, width=2)
            self._curves[key] = self.plot(
                self._x, np.zeros(history_len), pen=pen, name=label
            )

        if y_range is not None:
            self.setYRange(*y_range, padding=0.05)

    def append(self, t: dict) -> None:
        for key, *_ in self._lines_cfg:
            raw = t.get(key, 0.0)
            fn  = self._transforms.get(key)
            val = fn(float(raw)) if fn is not None else float(raw)
            self._buffers[key].append(val)
            self._curves[key].setData(self._x, np.array(self._buffers[key]))

        if self._fixed_y is None:
            all_vals = [v for buf in self._buffers.values() for v in buf if v != 0.0]
            if all_vals:
                lo       = min(all_vals)
                hi       = max(all_vals)
                margin   = max((hi - lo) * 0.1, 1.0)
                lo_bound = lo - margin
                if self._y_min is not None:
                    lo_bound = max(self._y_min, lo_bound)
                self.setYRange(lo_bound, hi + margin, padding=0)
