"""
MotionPanel — oversized speed/gear display plus a scrollable motion data grid.
"""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..constants import GEAR_MAP
from ..style import _divider, _key_label, _section_label, _val_label


class MotionPanel(QWidget):
    """Right panel: oversized speed/gear display + scrollable motion data grid."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(230)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(4)

        # Speed frame
        speed_frame = QFrame()
        speed_frame.setStyleSheet(
            "QFrame { background: #1a1a2e; border: 1px solid #2a2a4a;"
            " border-radius: 8px; }"
        )
        sf_layout = QVBoxLayout(speed_frame)
        sf_layout.setContentsMargins(8, 6, 8, 6)
        sf_layout.setSpacing(2)

        self._speed_kmh_lbl = QLabel("0")
        self._speed_kmh_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_kmh_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 42px; font-weight: bold; font-family: monospace;"
            " background: transparent; border: none;"
        )
        self._speed_unit_lbl = QLabel("km/h")
        self._speed_unit_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_unit_lbl.setStyleSheet(
            "color: #666688; font-size: 12px; background: transparent; border: none;"
        )

        bottom_row = QHBoxLayout()
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 32px; font-weight: bold; font-family: monospace;"
            " background: #111122; border: 1px solid #2a2a4a; border-radius: 6px;"
            " padding: 4px 12px;"
        )
        self._mph_lbl = QLabel("0 mph")
        self._mph_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        )
        self._mph_lbl.setStyleSheet(
            "color: #888899; font-size: 13px; font-family: monospace;"
            " background: transparent; border: none;"
        )
        bottom_row.addWidget(self._gear_lbl)
        bottom_row.addStretch()
        bottom_row.addWidget(self._mph_lbl)

        sf_layout.addWidget(self._speed_kmh_lbl)
        sf_layout.addWidget(self._speed_unit_lbl)
        sf_layout.addLayout(bottom_row)
        outer.addWidget(speed_frame)

        # Scrollable data grid
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")
        data_widget = QWidget()
        data_widget.setStyleSheet("background: transparent;")
        data_layout = QVBoxLayout(data_widget)
        data_layout.setContentsMargins(0, 0, 0, 0)
        data_layout.setSpacing(2)
        scroll.setWidget(data_widget)
        outer.addWidget(scroll, stretch=1)

        def _section(title: str, rows: list[str]) -> dict[str, QLabel]:
            data_layout.addWidget(_section_label(title))
            grid = QGridLayout()
            grid.setHorizontalSpacing(8)
            grid.setVerticalSpacing(2)
            grid.setColumnStretch(1, 1)
            vals: dict[str, QLabel] = {}
            for i, name in enumerate(rows):
                k = _key_label(name + ":")
                v = _val_label()
                grid.addWidget(k, i, 0)
                grid.addWidget(v, i, 1)
                vals[name] = v
            data_layout.addLayout(grid)
            data_layout.addWidget(_divider())
            return vals

        self._vel_vals = _section("VELOCITY (m/s)",      ["Vel X", "Vel Y", "Vel Z"])
        self._acc_vals = _section("ACCELERATION (g)",    ["Acc X", "Acc Y", "Acc Z"])
        self._ang_vals = _section("ANGULAR VEL (rad/s)", ["AngVel X", "AngVel Y", "AngVel Z"])
        self._ori_vals = _section("ORIENTATION (rad)",   ["Yaw", "Pitch", "Roll"])
        self._pos_vals = _section("POSITION (m)",        ["Pos X", "Pos Y", "Pos Z"])
        data_layout.addStretch()

    def update_data(self, t: dict) -> None:
        speed_kmh = t.get("Speed", 0.0) * 3.6
        speed_mph = t.get("Speed", 0.0) * 2.23694
        self._speed_kmh_lbl.setText(f"{speed_kmh:.0f}")
        self._mph_lbl.setText(f"{speed_mph:.0f} mph")
        _g = t.get("Gear", 0)
        self._gear_lbl.setText(GEAR_MAP.get(_g, str(_g)))

        _G = 9.80665
        self._vel_vals["Vel X"].setText(f"{t.get('VelocityX',       0.0):+.2f}")
        self._vel_vals["Vel Y"].setText(f"{t.get('VelocityY',       0.0):+.2f}")
        self._vel_vals["Vel Z"].setText(f"{t.get('VelocityZ',       0.0):+.2f}")
        self._acc_vals["Acc X"].setText(f"{t.get('AccelerationX',   0.0) / _G:+.3f}")
        self._acc_vals["Acc Y"].setText(f"{t.get('AccelerationY',   0.0) / _G:+.3f}")
        self._acc_vals["Acc Z"].setText(f"{t.get('AccelerationZ',   0.0) / _G:+.3f}")
        self._ang_vals["AngVel X"].setText(f"{t.get('AngularVelocityX', 0.0):+.3f}")
        self._ang_vals["AngVel Y"].setText(f"{t.get('AngularVelocityY', 0.0):+.3f}")
        self._ang_vals["AngVel Z"].setText(f"{t.get('AngularVelocityZ', 0.0):+.3f}")
        self._ori_vals["Yaw"].setText(  f"{t.get('Yaw',   0.0):+.4f}")
        self._ori_vals["Pitch"].setText(f"{t.get('Pitch', 0.0):+.4f}")
        self._ori_vals["Roll"].setText( f"{t.get('Roll',  0.0):+.4f}")
        self._pos_vals["Pos X"].setText(f"{t.get('PositionX', 0.0):.1f}")
        self._pos_vals["Pos Y"].setText(f"{t.get('PositionY', 0.0):.1f}")
        self._pos_vals["Pos Z"].setText(f"{t.get('PositionZ', 0.0):.1f}")
