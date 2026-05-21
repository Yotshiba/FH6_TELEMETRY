"""
ToggleButton — card-style toggle button used in the launcher.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget


class ToggleButton(QFrame):
    """Card-style toggle button with a distinct accent colour when active."""

    toggled = pyqtSignal(bool)

    def __init__(
        self,
        title: str,
        subtitle: str,
        accent: str = "#44CCFF",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._checked = False
        self._accent  = accent
        self.setFixedHeight(72)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        row = QHBoxLayout(self)
        row.setContentsMargins(14, 8, 14, 8)
        row.setSpacing(12)

        self._dot = QLabel("●")
        self._dot.setFixedWidth(14)

        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        self._title_lbl = QLabel(title)
        self._sub_lbl   = QLabel(subtitle)
        text_col.addWidget(self._title_lbl)
        text_col.addWidget(self._sub_lbl)

        row.addWidget(self._dot)
        row.addLayout(text_col, stretch=1)

        self._refresh()

    # ------------------------------------------------------------------

    def _refresh(self) -> None:
        a = self._accent
        if self._checked:
            self.setStyleSheet(
                f"QFrame {{ background: #0d1a2e; border: 2px solid {a};"
                f" border-radius: 8px; }}"
            )
            self._dot.setStyleSheet(f"font-size: 10px; color: {a};")
            self._title_lbl.setStyleSheet(
                f"font-size: 15px; font-weight: bold; color: {a};"
            )
            self._sub_lbl.setStyleSheet("font-size: 11px; color: #aaaacc;")
        else:
            self.setStyleSheet(
                "QFrame { background: #1a1a2e; border: 1px solid #2a2a4a;"
                " border-radius: 8px; }"
            )
            self._dot.setStyleSheet("font-size: 10px; color: #444466;")
            self._title_lbl.setStyleSheet(
                "font-size: 15px; font-weight: bold; color: #888899;"
            )
            self._sub_lbl.setStyleSheet("font-size: 11px; color: #555566;")

    def setChecked(self, checked: bool) -> None:
        if self._checked != checked:
            self._checked = checked
            self._refresh()

    def isChecked(self) -> bool:
        return self._checked

    def mousePressEvent(self, event) -> None:  # type: ignore[override]
        self._checked = not self._checked
        self._refresh()
        self.toggled.emit(self._checked)
