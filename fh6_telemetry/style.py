"""
Visual style constants and shared UI factory helpers.
"""

from __future__ import annotations

from typing import Callable

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QFrame, QLabel

from .constants import _TEMP_COLORS

# ---------------------------------------------------------------------------
# Type alias used by RollingChart
# ---------------------------------------------------------------------------

LineSpec = tuple[str, str, str, Callable[[float], float] | None]

# ---------------------------------------------------------------------------
# Global dark stylesheet
# ---------------------------------------------------------------------------

_DARK_STYLE = """
QMainWindow, QWidget {
    background-color: #0d0d1a;
    color: #dddddd;
    font-family: "Segoe UI", "Helvetica Neue", sans-serif;
}
QStatusBar {
    background: #111122;
    color: #aaaaaa;
    font-size: 11px;
    border-top: 1px solid #2a2a4a;
}
QSplitter::handle {
    background: #2a2a4a;
}
QSplitter::handle:horizontal {
    width: 3px;
}
QSplitter::handle:vertical {
    height: 3px;
}
QScrollBar:vertical {
    background: #1a1a2e;
    width: 8px;
    border: none;
}
QScrollBar::handle:vertical {
    background: #2a2a4a;
    border-radius: 4px;
    min-height: 20px;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0;
}
"""

# ---------------------------------------------------------------------------
# Label factory helpers
# ---------------------------------------------------------------------------

def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        "color: #666688; font-size: 10px; font-weight: bold;"
        " letter-spacing: 1px; padding-top: 6px;"
    )
    return lbl


def _key_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
    lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
    return lbl


def _val_label(text: str = "--") -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet("color: #eeeeee; font-size: 11px; font-family: monospace;")
    lbl.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
    return lbl


def _divider() -> QFrame:
    line = QFrame()
    line.setFrameShape(QFrame.Shape.HLine)
    line.setStyleSheet("color: #2a2a4a; margin: 2px 0;")
    return line

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

def get_temp_color(temp: float) -> str:
    """Return a hex colour string for the given tyre temperature."""
    for threshold, colour in _TEMP_COLORS:
        if temp < threshold:
            return colour
    return _TEMP_COLORS[-1][1]


def _bar_color(value: float, danger: float) -> str:
    """Green → amber → red progress-bar colour based on value vs danger threshold."""
    ratio = value / danger if danger > 0 else 0.0
    if ratio < 0.6:
        return "#22BB44"
    if ratio < 1.0:
        return "#FF9900"
    return "#DD2200"
