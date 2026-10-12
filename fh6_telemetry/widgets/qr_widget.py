"""A QR code as a small widget (black modules on a white quiet zone, so a phone camera reads it on any theme)."""

from __future__ import annotations

from PyQt6.QtCore import QRect, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QMouseEvent, QPainter
from PyQt6.QtWidgets import QWidget

from ..core import qr

_QUIET = 3          # modules of white around the symbol (the specification asks for 4; the widget is on a small square)


class QrWidget(QWidget):
    """Shows the QR code of a text; clicking it emits ``clicked`` (the launcher cycles through its addresses)."""

    clicked = pyqtSignal()

    def __init__(self, parent: QWidget | None = None, size: int = 112) -> None:
        super().__init__(parent)
        self.setFixedSize(size, size)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._code: qr.QrCode | None = None

    @property
    def code(self) -> qr.QrCode | None:
        return self._code

    def set_text(self, text: str | None) -> None:
        """Show the QR code for `text` (None / empty / too long: show nothing)."""
        code = None
        if text:
            try:
                code = qr.encode(text, "M")
            except ValueError:
                try:
                    code = qr.encode(text, "L")
                except ValueError:
                    code = None
        self._code = code
        self.update()

    def _geometry(self) -> tuple[int, int, int]:
        """(pixels per module, left offset, top offset): a whole number of pixels per module keeps the edges crisp."""
        n = (self._code.size if self._code else 21) + 2 * _QUIET
        scale = max(1, min(self.width(), self.height()) // n)
        side = scale * n
        return scale, (self.width() - side) // 2 + _QUIET * scale, (self.height() - side) // 2 + _QUIET * scale

    def module_rect(self, x: int, y: int) -> QRect:
        """The pixel rectangle of the module at column x, row y."""
        scale, ox, oy = self._geometry()
        return QRect(ox + x * scale, oy + y * scale, scale, scale)

    def paintEvent(self, event) -> None:      # noqa: N802 - Qt API
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#ffffff"))
        code = self._code
        if code is None:
            return
        scale, ox, oy = self._geometry()
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#000000"))
        for y, row in enumerate(code.modules):
            x = 0
            while x < code.size:                  # one rectangle per run of dark modules
                if row[x]:
                    start = x
                    while x < code.size and row[x]:
                        x += 1
                    p.drawRect(ox + start * scale, oy + y * scale, (x - start) * scale, scale)
                else:
                    x += 1

    def mousePressEvent(self, event: QMouseEvent) -> None:      # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()
        super().mousePressEvent(event)
