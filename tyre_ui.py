"""
Forza Horizon 6 — Tyre Data Telemetry UI
Requires: PyQt6, pyqtgraph, numpy, python-dotenv
Run:  python tyre_ui.py
"""

from __future__ import annotations

import socket
import sys
from collections import deque

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import QThread, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QFont
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QProgressBar,
    QSizePolicy,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from main import HOST, PORT, PACKET_SIZE, parse_packet

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HISTORY_LEN = 300          # ~5 seconds at 60 Hz
WHEELS = ("FL", "FR", "RL", "RR")

# Wheel colours used in the history chart
WHEEL_COLORS: dict[str, str] = {
    "FL": "#FF4444",   # red
    "FR": "#44CCFF",   # cyan
    "RL": "#FF9900",   # orange
    "RR": "#44DD44",   # green
}

# Tyre temperature colour thresholds (°C)
_TEMP_COLORS: list[tuple[float, str]] = [
    (50.0,  "#1a6fb5"),   # cold blue
    (70.0,  "#00AACC"),   # cool cyan
    (90.0,  "#22BB44"),   # optimal green
    (110.0, "#FF9900"),   # warm orange
    (999.0, "#DD2200"),   # overheating red
]

# Bar indicator configs: (key_suffix, label, max_value, danger_threshold)
_BAR_CONFIGS: list[tuple[str, str, float, float]] = [
    ("TireSlipRatio",    "Slip Ratio",  2.0, 0.5),
    ("TireSlipAngle",    "Slip Angle",  2.0, 0.5),
    ("TireCombinedSlip", "Comb. Slip",  3.0, 1.0),
    ("SuspNorm",         "Susp (norm)", 1.0, 0.9),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_temp_color(temp: float) -> str:
    """Return a hex colour string for the given tyre temperature (°C)."""
    for threshold, colour in _TEMP_COLORS:
        if temp < threshold:
            return colour
    return _TEMP_COLORS[-1][1]


def _bar_color(value: float, danger: float) -> str:
    ratio = value / danger if danger > 0 else 0.0
    if ratio < 0.6:
        return "#22BB44"
    if ratio < 1.0:
        return "#FF9900"
    return "#DD2200"


# ---------------------------------------------------------------------------
# UDP Telemetry receiver thread
# ---------------------------------------------------------------------------

class TelemetryReceiver(QThread):
    """Receives FH6 UDP telemetry packets and emits parsed dicts."""

    data_ready = pyqtSignal(dict)

    def __init__(self, host: str, port: int, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._host = host
        self._port = port
        self._running = True

    def stop(self) -> None:
        self._running = False

    def run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(1.0)
        sock.bind((self._host, self._port))

        while self._running:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break

            if len(data) >= PACKET_SIZE:
                telemetry = parse_packet(data)
                if telemetry:
                    self.data_ready.emit(telemetry)

        sock.close()


# ---------------------------------------------------------------------------
# BarIndicator — a labelled progress bar row
# ---------------------------------------------------------------------------

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
        self._danger = danger

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
        self._bar.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed
        )

        self._val_lbl = QLabel("0.000")
        self._val_lbl.setFixedWidth(46)
        self._val_lbl.setStyleSheet("color: #eeeeee; font-size: 11px; font-family: monospace;")
        self._val_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        layout.addWidget(name_lbl)
        layout.addWidget(self._bar)
        layout.addWidget(self._val_lbl)

        self._update_color(0.0)

    def update_value(self, value: float) -> None:
        clamped = max(0.0, min(value, self._max_val))
        bar_val = int(clamped / self._max_val * 1000)
        self._bar.setValue(bar_val)
        self._val_lbl.setText(f"{value:+.3f}" if abs(value) < 10 else f"{value:.1f}")
        self._update_color(abs(value))

    def _update_color(self, value: float) -> None:
        color = _bar_color(value, self._danger)
        self._bar.setStyleSheet(self._BAR_STYLE.format(color=color))


# ---------------------------------------------------------------------------
# TyreWidget — one wheel card
# ---------------------------------------------------------------------------

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
    _BADGE_ON = (
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

        # ── Header row: wheel name + surface badges ──────────────────────
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

        # ── Temperature label ─────────────────────────────────────────────
        self._temp_lbl = QLabel("--.- °C")
        self._temp_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._temp_lbl.setMinimumHeight(54)
        root.addWidget(self._temp_lbl)
        self._set_temp(0.0)

        # ── Bar indicators ────────────────────────────────────────────────
        self._bars: dict[str, BarIndicator] = {}
        for key, label, max_val, danger in _BAR_CONFIGS:
            bar = BarIndicator(label, max_val, danger, self)
            self._bars[key] = bar
            root.addWidget(bar)

        # ── Text rows: suspension metres + wheel speed ────────────────────
        text_layout = QGridLayout()
        text_layout.setContentsMargins(0, 2, 0, 0)
        text_layout.setHorizontalSpacing(8)
        text_layout.setVerticalSpacing(2)

        def _mk_key(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
            lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            return lbl

        def _mk_val() -> QLabel:
            lbl = QLabel("--")
            lbl.setStyleSheet(
                "color: #eeeeee; font-size: 11px; font-family: monospace;"
            )
            lbl.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
            return lbl

        self._susp_m_lbl = _mk_val()
        self._wheel_spd_lbl = _mk_val()

        text_layout.addWidget(_mk_key("Susp (m):"), 0, 0)
        text_layout.addWidget(self._susp_m_lbl,     0, 1)
        text_layout.addWidget(_mk_key("Wheel spd:"), 1, 0)
        text_layout.addWidget(self._wheel_spd_lbl,  1, 1)

        root.addLayout(text_layout)
        root.addStretch()

    # ── Private helpers ───────────────────────────────────────────────────

    def _set_badge(self, badge: QLabel, active: bool, color: str) -> None:
        if active:
            badge.setStyleSheet(self._BADGE_ON.format(color=color))
        else:
            badge.setStyleSheet(self._BADGE_OFF)

    def _set_temp(self, temp: float) -> None:
        bg = get_temp_color(temp)
        # Choose white or near-black text based on perceived brightness
        r, g, b = int(bg[1:3], 16), int(bg[3:5], 16), int(bg[5:7], 16)
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        fg = "#ffffff" if brightness < 128 else "#111111"
        self._temp_lbl.setText(f"{temp:.1f} °C")
        self._temp_lbl.setStyleSheet(self._TEMP_LBL_STYLE.format(bg=bg, fg=fg))

    # ── Public update method ──────────────────────────────────────────────

    def update_data(self, t: dict) -> None:
        w = self._wheel

        # Temperature
        self._set_temp(t.get(f"TireTemp{w}", 0.0))

        # Surface conditions
        self._set_badge(self._rumble_badge, bool(t.get(f"WheelOnRumble{w}", 0)), "#FF6600")
        self._set_badge(self._puddle_badge, bool(t.get(f"WheelInPuddle{w}", 0)), "#0088FF")

        # Bar indicators
        self._bars["TireSlipRatio"].update_value(t.get(f"TireSlipRatio{w}", 0.0))
        self._bars["TireSlipAngle"].update_value(t.get(f"TireSlipAngle{w}", 0.0))
        self._bars["TireCombinedSlip"].update_value(t.get(f"TireCombinedSlip{w}", 0.0))
        self._bars["SuspNorm"].update_value(t.get(f"SuspNorm{w}", 0.0))

        # Text labels
        susp_m = t.get(f"SuspTravelM{w}", 0.0)
        wheel_spd = t.get(f"WheelRotSpeed{w}", 0.0)
        self._susp_m_lbl.setText(f"{susp_m:.4f} m")
        self._wheel_spd_lbl.setText(f"{wheel_spd:.1f} rad/s")


# ---------------------------------------------------------------------------
# TempHistoryPlot — rolling temperature chart
# ---------------------------------------------------------------------------

class TempHistoryPlot(pg.PlotWidget):
    """Rolling line chart showing tyre temperature history for all 4 wheels."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent, background="#0d0d1a")

        self.setLabel("left", "Tyre Temp", units="°C", color="#aaaaaa")
        self.setLabel("bottom", "Samples (newest →)", color="#aaaaaa")
        self.showGrid(x=False, y=True, alpha=0.15)
        self.getAxis("left").setTextPen(pg.mkPen("#aaaaaa"))
        self.getAxis("bottom").setTextPen(pg.mkPen("#aaaaaa"))
        self.setMenuEnabled(False)
        self.setMouseEnabled(x=False, y=False)
        self.setMinimumHeight(160)

        # Rolling data buffers
        self._buffers: dict[str, deque[float]] = {
            w: deque([0.0] * HISTORY_LEN, maxlen=HISTORY_LEN) for w in WHEELS
        }
        self._x = np.arange(HISTORY_LEN)

        # Create legend and plot curves
        legend = self.addLegend(offset=(10, 10))
        legend.setLabelTextColor("#cccccc")

        self._curves: dict[str, pg.PlotDataItem] = {}
        for wheel in WHEELS:
            pen = pg.mkPen(color=WHEEL_COLORS[wheel], width=2)
            curve = self.plot(
                self._x,
                np.zeros(HISTORY_LEN),
                pen=pen,
                name=wheel,
            )
            self._curves[wheel] = curve

        self.setYRange(0, 150, padding=0.05)

    def append(self, t: dict) -> None:
        """Push one sample to each wheel buffer and refresh curves."""
        for wheel in WHEELS:
            self._buffers[wheel].append(t.get(f"TireTemp{wheel}", 0.0))
            self._curves[wheel].setData(
                self._x, np.array(self._buffers[wheel])
            )

        # Auto-scale y based on current range
        all_vals = [v for buf in self._buffers.values() for v in buf if v > 0]
        if all_vals:
            low = max(0, min(all_vals) - 10)
            high = max(all_vals) + 10
            self.setYRange(low, high, padding=0.02)


# ---------------------------------------------------------------------------
# MainWindow
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
QLabel#title {
    color: #eeeeee;
    font-size: 20px;
    font-weight: bold;
    letter-spacing: 2px;
}
QLabel#subtitle {
    color: #666688;
    font-size: 11px;
}
"""


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 Tyre Telemetry")
        self.setMinimumSize(860, 700)
        self.setStyleSheet(_DARK_STYLE)

        # Central widget
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(12, 10, 12, 8)
        root.setSpacing(10)

        # ── Title ─────────────────────────────────────────────────────────
        title_row = QHBoxLayout()

        title_lbl = QLabel("FH6 TYRE TELEMETRY")
        title_lbl.setObjectName("title")

        subtitle_lbl = QLabel(f"UDP  {HOST}:{PORT}   |   {PACKET_SIZE} bytes/packet")
        subtitle_lbl.setObjectName("subtitle")
        subtitle_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        title_row.addWidget(title_lbl)
        title_row.addStretch()
        title_row.addWidget(subtitle_lbl)
        root.addLayout(title_row)

        # ── 2 × 2 tyre grid ──────────────────────────────────────────────
        grid = QGridLayout()
        grid.setSpacing(10)

        self._tyre_widgets: dict[str, TyreWidget] = {}
        positions = {"FL": (0, 0), "FR": (0, 1), "RL": (1, 0), "RR": (1, 1)}
        for wheel, (row, col) in positions.items():
            w = TyreWidget(wheel)
            self._tyre_widgets[wheel] = w
            grid.addWidget(w, row, col)

        grid.setRowStretch(0, 1)
        grid.setRowStretch(1, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        root.addLayout(grid, stretch=3)

        # ── Temperature history chart ─────────────────────────────────────
        chart_header = QLabel("TYRE TEMPERATURE HISTORY")
        chart_header.setStyleSheet(
            "color: #666688; font-size: 10px; font-weight: bold; letter-spacing: 1px;"
        )
        root.addWidget(chart_header)

        self._plot = TempHistoryPlot()
        root.addWidget(self._plot, stretch=2)

        # ── Status bar ────────────────────────────────────────────────────
        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._conn_lbl = QLabel("⬤  Waiting for telemetry …")
        self._conn_lbl.setStyleSheet("color: #888866;")
        self._surface_lbl = QLabel("")
        self._surface_lbl.setStyleSheet("color: #aaaaaa;")
        self._status.addWidget(self._conn_lbl)
        self._status.addPermanentWidget(self._surface_lbl)

        self._connected = False

        # ── Receiver thread ───────────────────────────────────────────────
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ── Slot ──────────────────────────────────────────────────────────────

    def _on_telemetry(self, t: dict) -> None:
        # FH6 broadcasts tyre temps in Fahrenheit despite the field being labelled °C.
        # Convert to Celsius before passing to any widget.
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0

        # Update connection status once
        if not self._connected:
            self._connected = True
            self._conn_lbl.setText("⬤  Connected")
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        # Update tyre widgets
        for wheel, widget in self._tyre_widgets.items():
            widget.update_data(t)

        # Update temperature history
        self._plot.append(t)

        # Update surface conditions in status bar
        rumble_wheels = [w for w in WHEELS if t.get(f"WheelOnRumble{w}", 0)]
        puddle_wheels = [w for w in WHEELS if t.get(f"WheelInPuddle{w}", 0)]
        parts: list[str] = []
        if rumble_wheels:
            parts.append(f"Rumble: {' '.join(rumble_wheels)}")
        if puddle_wheels:
            parts.append(f"Puddle: {' '.join(puddle_wheels)}")
        self._surface_lbl.setText("  |  ".join(parts))

    # ── Cleanup ───────────────────────────────────────────────────────────

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self._receiver.stop()
        self._receiver.wait(2000)
        super().closeEvent(event)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    pg.setConfigOptions(antialias=True, foreground="#cccccc", background="#0d0d1a")

    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
