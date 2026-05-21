"""
TyreWidget — displays all telemetry for one wheel corner.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ..constants import _BAR_CONFIGS, WHEEL_COLORS
from ..style import get_temp_color
from .bar_indicator import BarIndicator


class TyreWidget(QFrame):
    """Displays all tyre telemetry for one wheel corner."""

    _CARD_STYLE = """
        QFrame {{
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 8px;
        }}
    """
    _TEMP_LBL_STYLE = """
        QLabel {{
            background: {bg};
            color: {fg};
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 28px;
            font-weight: bold;
            font-family: monospace;
        }}
    """
    _BADGE_ON  = (
        "background: {color}; color: #fff; border-radius: 4px;"
        " padding: 1px 6px; font-size: 10px; font-weight: bold;"
    )
    _BADGE_OFF = (
        "background: #1e1e1e; color: #444444; border-radius: 4px;"
        " padding: 1px 6px; font-size: 10px;"
    )

    def __init__(self, wheel: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._wheel = wheel
        self.setStyleSheet(self._CARD_STYLE)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(6)

        # Header row
        header = QHBoxLayout()
        header.setSpacing(6)
        wheel_lbl = QLabel(wheel)
        wheel_lbl.setStyleSheet(
            f"color: {WHEEL_COLORS[wheel]}; font-size: 18px; font-weight: bold;"
        )
        self._rumble_badge = QLabel("RUMBLE")
        self._puddle_badge = QLabel("PUDDLE")
        self._set_badge(self._rumble_badge, False, "#FF6600")
        self._set_badge(self._puddle_badge, False, "#0088FF")
        header.addWidget(wheel_lbl)
        header.addStretch()
        header.addWidget(self._rumble_badge)
        header.addWidget(self._puddle_badge)
        root.addLayout(header)

        # Temperature display
        self._temp_lbl = QLabel("--.- °C")
        self._temp_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._temp_lbl.setMinimumHeight(54)
        root.addWidget(self._temp_lbl)
        self._set_temp(0.0)

        # Slip / suspension bars
        self._bars: dict[str, BarIndicator] = {}
        for key, label, max_val, danger in _BAR_CONFIGS:
            bar = BarIndicator(label, max_val, danger, self)
            self._bars[key] = bar
            root.addWidget(bar)

        # Text rows
        text_layout = QGridLayout()
        text_layout.setContentsMargins(0, 2, 0, 0)
        text_layout.setHorizontalSpacing(8)
        text_layout.setVerticalSpacing(2)

        def _mk_key(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
            lbl.setAlignment(
                Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
            )
            return lbl

        def _mk_val() -> QLabel:
            lbl = QLabel("--")
            lbl.setStyleSheet(
                "color: #eeeeee; font-size: 11px; font-family: monospace;"
            )
            lbl.setAlignment(
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter
            )
            return lbl

        self._susp_m_lbl    = _mk_val()
        self._wheel_spd_lbl = _mk_val()
        text_layout.addWidget(_mk_key("Susp (m):"),  0, 0)
        text_layout.addWidget(self._susp_m_lbl,      0, 1)
        text_layout.addWidget(_mk_key("Wheel spd:"), 1, 0)
        text_layout.addWidget(self._wheel_spd_lbl,   1, 1)
        root.addLayout(text_layout)
        root.addStretch()

    # ------------------------------------------------------------------

    def _set_badge(self, badge: QLabel, active: bool, color: str) -> None:
        badge.setStyleSheet(
            self._BADGE_ON.format(color=color) if active else self._BADGE_OFF
        )

    def _set_temp(self, temp: float) -> None:
        bg = get_temp_color(temp)
        r, g, b = int(bg[1:3], 16), int(bg[3:5], 16), int(bg[5:7], 16)
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        fg = "#ffffff" if brightness < 128 else "#111111"
        self._temp_lbl.setText(f"{temp:.1f} °C")
        self._temp_lbl.setStyleSheet(self._TEMP_LBL_STYLE.format(bg=bg, fg=fg))

    def update_data(self, t: dict) -> None:
        w = self._wheel
        self._set_temp(t.get(f"TireTemp{w}", 0.0))
        self._set_badge(self._rumble_badge, bool(t.get(f"WheelOnRumble{w}", 0)), "#FF6600")
        self._set_badge(self._puddle_badge, bool(t.get(f"WheelInPuddle{w}", 0)), "#0088FF")
        self._bars["TireSlipRatio"].update_value(t.get(f"TireSlipRatio{w}", 0.0))
        self._bars["TireSlipAngle"].update_value(t.get(f"TireSlipAngle{w}", 0.0))
        self._bars["TireCombinedSlip"].update_value(t.get(f"TireCombinedSlip{w}", 0.0))
        self._bars["SuspNorm"].update_value(t.get(f"SuspNorm{w}", 0.0))
        self._susp_m_lbl.setText(f"{t.get(f'SuspTravelM{w}', 0.0):.4f} m")
        self._wheel_spd_lbl.setText(f"{t.get(f'WheelRotSpeed{w}', 0.0):.1f} rad/s")
