"""
BarIndicator — a labelled progress bar row.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QProgressBar, QSizePolicy, QWidget

from ..style import _bar_color


class BarIndicator(QWidget):
    """One row: [name label] [progress bar] [value label]"""

    _BAR_STYLE = """
        QProgressBar {{
            background: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 3px;
            height: 14px;
        }}
        QProgressBar::chunk {{
            background: {color};
            border-radius: 2px;
        }}
    """

    def __init__(
        self,
        name: str,
        max_val: float,
        danger: float,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._max_val = max_val
        self._danger  = danger

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 1, 0, 1)
        layout.setSpacing(6)

        name_lbl = QLabel(name)
        name_lbl.setFixedWidth(80)
        name_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        name_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        self._bar = QProgressBar()
        self._bar.setRange(0, 1000)
        self._bar.setValue(0)
        self._bar.setTextVisible(False)
        self._bar.setFixedHeight(14)
        self._bar.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        self._val_lbl = QLabel("0.000")
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
        self._update_color(0.0)

    def update_value(self, value: float) -> None:
        clamped = max(0.0, min(value, self._max_val))
        self._bar.setValue(int(clamped / self._max_val * 1000))
        self._val_lbl.setText(f"{value:+.3f}" if abs(value) < 10 else f"{value:.1f}")
        self._update_color(abs(value))

    def _update_color(self, value: float) -> None:
        self._bar.setStyleSheet(
            self._BAR_STYLE.format(color=_bar_color(value, self._danger))
        )
