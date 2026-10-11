"""
BarIndicator — a labelled progress bar row.

The bar itself is custom painted.  The original used a ``QProgressBar`` and
called ``setStyleSheet`` on every update just to change its colour; each call
re-polishes the widget, and ``QProgressBar.setValue`` repaints synchronously
through the style sheet.  Here a value change that doesn't move the bar by at
least one pixel (or change its colour) costs almost nothing, and repaints are
coalesced by Qt's normal ``update()``.
"""

from __future__ import annotations

import math

from PyQt6.QtCore import QRectF, Qt
from PyQt6.QtGui import QBrush, QColor, QPainter, QPen
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QSizePolicy, QWidget

from ..core.derive import bar_color


class BarWidget(QWidget):
    """The painted track + fill.  ``set_state`` is the only mutator."""

    _BG = QBrush(QColor("#1e1e1e"))
    _BORDER = QPen(QColor("#3a3a3a"), 1)
    _BRUSHES: dict[str, QBrush] = {}

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(14)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.fraction = 0.0
        self.color = "#22BB44"
        self._px = 0

    # -- state -------------------------------------------------------------
    def _pixels(self, fraction: float) -> int:
        return int(fraction * max(0, self.width() - 2))

    def set_state(self, fraction: float, color: str) -> bool:
        """Set fill (0..1) and colour; returns True if a repaint was scheduled."""
        px = self._pixels(fraction)
        self.fraction = fraction
        if px == self._px and color == self.color:
            return False
        self._px = px
        self.color = color
        self.update()
        return True

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        self._px = self._pixels(self.fraction)
        super().resizeEvent(event)

    # -- painting ----------------------------------------------------------
    def paintEvent(self, event) -> None:  # type: ignore[override]
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        h = self.height()
        p.setPen(self._BORDER)
        p.setBrush(self._BG)
        p.drawRoundedRect(QRectF(0.5, 0.5, self.width() - 1.0, h - 1.0), 3, 3)
        if self._px > 0:
            brush = self._BRUSHES.get(self.color)
            if brush is None:
                brush = self._BRUSHES[self.color] = QBrush(QColor(self.color))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(brush)
            p.drawRoundedRect(QRectF(1.0, 1.0, self._px, h - 2.0), 2, 2)
        p.end()


class BarIndicator(QWidget):
    """One row: [name label] [bar] [value label]"""

    def __init__(
        self,
        name: str,
        max_val: float,
        danger: float,
        parent: QWidget | None = None,
        *,
        invert: bool = False,
    ) -> None:
        super().__init__(parent)
        self._max_val = max_val
        self._danger  = danger
        self._invert  = invert   # True: low values are bad (fuel)
        self._text    = "0.000"

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 1, 0, 1)
        layout.setSpacing(6)

        name_lbl = QLabel(name)
        name_lbl.setFixedWidth(80)
        name_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        name_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        self._bar = BarWidget()

        self._val_lbl = QLabel(self._text)
        self._val_lbl.setFixedWidth(46)
        self._val_lbl.setStyleSheet(
            "color: #eeeeee; font-size: 11px; font-family: monospace;"
        )
        self._val_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        )

        layout.addWidget(name_lbl)
        layout.addWidget(self._bar)
        layout.addWidget(self._val_lbl)
        self._bar.set_state(0.0, bar_color(0.0, danger, invert))

    def update_value(self, value: float) -> None:
        if not math.isfinite(value):
            value = 0.0
        clamped = max(0.0, min(value, self._max_val))
        self._bar.set_state(
            clamped / self._max_val, bar_color(abs(value), self._danger, self._invert)
        )
        text = f"{value:+.3f}" if abs(value) < 10 else f"{value:.1f}"
        if text != self._text:
            self._text = text
            self._val_lbl.setText(text)
