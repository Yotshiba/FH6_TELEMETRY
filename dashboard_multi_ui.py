"""
Forza Horizon 6 — Multi-Window Telemetry Dashboard
A compact launcher lets you open any combination of category windows.
Each window is fully independent and can be freely moved and resized.

Categories
----------
  Car & Lap  — Car info, lap times, input bars, FH6 extras
  Tyres      — 2×2 tyre widget cards + tyre temperature history
  Engine     — Stats strip + RPM chart + Power & Torque chart
  Inputs     — Input bars + steer indicator + Throttle/Brake chart
  Motion     — Motion readout + Suspension + Speed charts

Usage:  python dashboard_multi_ui.py
"""

from __future__ import annotations

import socket
import sys

import pyqtgraph as pg
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from main import CAR_CLASS, DRIVETRAIN, GEAR_MAP, HOST, PACKET_SIZE, PORT, secs_to_time
from tyre_ui import WHEELS, TelemetryReceiver
from dashboard_ui import (
    _DARK_STYLE,
    _divider,
    _key_label,
    _section_label,
    _val_label,
    LeftInfoPanel,
)
from dashboard_tabs_ui import TyresTab, EngineTab, InputsTab, MotionTab


# ---------------------------------------------------------------------------
# ToggleButton — clickable card with title, subtitle, and checked state
# ---------------------------------------------------------------------------

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
        self._accent = accent
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

    # ── Style ──────────────────────────────────────────────────────────────

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

    # ── Public API ─────────────────────────────────────────────────────────

    def setChecked(self, checked: bool) -> None:
        if self._checked != checked:
            self._checked = checked
            self._refresh()

    def isChecked(self) -> bool:
        return self._checked

    # ── Mouse event ────────────────────────────────────────────────────────

    def mousePressEvent(self, event) -> None:  # type: ignore[override]
        self._checked = not self._checked
        self._refresh()
        self.toggled.emit(self._checked)


# ---------------------------------------------------------------------------
# CategoryWindow — floating window that hides on close instead of quitting
# ---------------------------------------------------------------------------

class CategoryWindow(QMainWindow):
    """Base class for all category windows.

    Closing via the title-bar X hides the window and emits ``window_hidden``.
    Call ``force_close()`` to actually destroy the window (used on app exit).
    """

    window_hidden = pyqtSignal()

    def __init__(self) -> None:
        super().__init__()
        self._force = False
        self.setStyleSheet(_DARK_STYLE)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._force:
            super().closeEvent(event)
        else:
            event.ignore()
            self.hide()
            self.window_hidden.emit()

    def force_close(self) -> None:
        """Really close — called when the launcher exits."""
        self._force = True
        self.close()

    def update_data(self, t: dict) -> None:
        """Override in subclasses to receive telemetry packets."""


# ---------------------------------------------------------------------------
# Category windows (each wraps the matching tab widget)
# ---------------------------------------------------------------------------

class CarLapWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Car & Lap")
        self.setMinimumSize(300, 520)
        self._panel = LeftInfoPanel()
        self.setCentralWidget(self._panel)

    def update_data(self, t: dict) -> None:
        self._panel.update_data(t)


class TyresWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Tyres")
        self.setMinimumSize(640, 460)
        self._tab = TyresTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class EngineWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Engine")
        self.setMinimumSize(700, 500)
        self._tab = EngineTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class InputsWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Inputs")
        self.setMinimumSize(700, 420)
        self._tab = InputsTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class MotionWindow(CategoryWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Motion")
        self.setMinimumSize(800, 520)
        self._tab = MotionTab()
        self.setCentralWidget(self._tab)

    def update_data(self, t: dict) -> None:
        self._tab.update_data(t)


class RaceStatusWindow(CategoryWindow):
    """Vertical race-status panel — all header data in a readable grid."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 — Race Status")
        self.setMinimumSize(260, 480)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")
        self.setCentralWidget(scroll)

        content = QWidget()
        content.setStyleSheet("background: transparent;")
        lay = QVBoxLayout(content)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.setSpacing(2)
        scroll.setWidget(content)

        # ── Race state banner ─────────────────────────────────────────────
        self._race_lbl = QLabel("⬤  NO SIGNAL")
        self._race_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._race_lbl.setStyleSheet(
            "color: #664444; font-size: 14px; font-weight: bold;"
            " background: #1a1a2e; border: 1px solid #2a2a4a;"
            " border-radius: 6px; padding: 6px;"
        )
        lay.addWidget(self._race_lbl)
        lay.addSpacing(6)

        # ── Speed + gear display ──────────────────────────────────────────
        sg_row = QHBoxLayout()
        sg_row.setSpacing(10)

        speed_col = QVBoxLayout()
        speed_col.setSpacing(1)
        self._speed_lbl = QLabel("0")
        self._speed_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._speed_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 38px; font-weight: bold; font-family: monospace;"
        )
        kmh_lbl = QLabel("km/h")
        kmh_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        kmh_lbl.setStyleSheet("color: #666688; font-size: 11px;")
        self._mph_lbl = QLabel("0 mph")
        self._mph_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._mph_lbl.setStyleSheet(
            "color: #555566; font-size: 11px; font-family: monospace;"
        )
        speed_col.addWidget(self._speed_lbl)
        speed_col.addWidget(kmh_lbl)
        speed_col.addWidget(self._mph_lbl)

        gear_col = QVBoxLayout()
        gear_col.setSpacing(1)
        self._gear_lbl = QLabel("N")
        self._gear_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._gear_lbl.setStyleSheet(
            "color: #FFDD44; font-size: 38px; font-weight: bold; font-family: monospace;"
            " background: #111122; border: 1px solid #2a2a4a; border-radius: 6px;"
            " padding: 6px 14px;"
        )
        gear_key = QLabel("GEAR")
        gear_key.setAlignment(Qt.AlignmentFlag.AlignCenter)
        gear_key.setStyleSheet("color: #666688; font-size: 11px;")
        gear_col.addWidget(self._gear_lbl)
        gear_col.addWidget(gear_key)

        sg_row.addLayout(speed_col, stretch=2)
        sg_row.addLayout(gear_col, stretch=1)
        lay.addLayout(sg_row)
        lay.addWidget(_divider())

        # Helper — build a named section and return its value labels
        def _sec(title: str, rows: list[tuple[str, str]]) -> dict[str, QLabel]:
            lay.addWidget(_section_label(title))
            grid = QGridLayout()
            grid.setHorizontalSpacing(8)
            grid.setVerticalSpacing(3)
            grid.setColumnStretch(1, 1)
            vals: dict[str, QLabel] = {}
            for i, (key, init) in enumerate(rows):
                grid.addWidget(_key_label(key), i, 0)
                v = _val_label(init)
                grid.addWidget(v, i, 1)
                vals[key] = v
            lay.addLayout(grid)
            lay.addWidget(_divider())
            return vals

        self._race_vals = _sec("LAP & RACE", [
            ("Lap:",       "--"),
            ("Position:",  "--"),
            ("Race Time:", "--:--.---"),
            ("Best Lap:",  "--:--.---"),
            ("Last Lap:",  "--:--.---"),
        ])
        self._eng_vals = _sec("ENGINE", [
            ("RPM:",     "--"),
            ("Max RPM:", "--"),
        ])
        self._car_vals = _sec("CAR", [
            ("Class:",      "--"),
            ("PI:",         "--"),
            ("Drivetrain:", "--"),
            ("Cylinders:",  "--"),
        ])
        self._status_vals = _sec("STATUS", [
            ("Boost:", "--"),
            ("Fuel:",  "--"),
        ])

        lay.addStretch()

    def update_data(self, t: dict) -> None:
        is_on = bool(t.get("IsRaceOn", 0))
        if is_on:
            self._race_lbl.setText("⬤  RACE ON")
            self._race_lbl.setStyleSheet(
                "color: #22BB44; font-size: 14px; font-weight: bold;"
                " background: #0a2010; border: 1px solid #22BB44;"
                " border-radius: 6px; padding: 6px;"
            )
        else:
            self._race_lbl.setText("⬤  PAUSED")
            self._race_lbl.setStyleSheet(
                "color: #664444; font-size: 14px; font-weight: bold;"
                " background: #1a1a2e; border: 1px solid #2a2a4a;"
                " border-radius: 6px; padding: 6px;"
            )

        self._speed_lbl.setText(f"{t.get('Speed', 0.0) * 3.6:.0f}")
        self._mph_lbl.setText(f"{t.get('Speed', 0.0) * 2.23694:.0f} mph")
        self._gear_lbl.setText(GEAR_MAP.get(t.get("Gear", 0), "?"))

        self._race_vals["Lap:"].setText(str(t.get("LapNumber", 0)))
        self._race_vals["Position:"].setText(str(t.get("RacePosition", 0)))
        self._race_vals["Race Time:"].setText(secs_to_time(t.get("CurrentRaceTime", 0.0)))
        self._race_vals["Best Lap:"].setText(secs_to_time(t.get("BestLap", 0.0)))
        self._race_vals["Last Lap:"].setText(secs_to_time(t.get("LastLap", 0.0)))

        rpm     = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 1.0) or 1.0
        self._eng_vals["RPM:"].setText(f"{rpm:.0f}  ({rpm / max_rpm * 100:.0f}%)")
        self._eng_vals["Max RPM:"].setText(f"{max_rpm:.0f}")

        self._car_vals["Class:"].setText(CAR_CLASS.get(t.get("CarClass", -1), "?"))
        self._car_vals["PI:"].setText(str(t.get("CarPerformanceIndex", 0)))
        self._car_vals["Drivetrain:"].setText(DRIVETRAIN.get(t.get("DrivetrainType", -1), "?"))
        self._car_vals["Cylinders:"].setText(str(t.get("NumCylinders", 0)))

        self._status_vals["Boost:"].setText(f"{t.get('Boost', 0.0):.2f} PSI")
        self._status_vals["Fuel:"].setText(f"{t.get('Fuel', 0.0) * 100:.1f}%")


# ---------------------------------------------------------------------------
# Category registry
# (title, subtitle, accent_color, window_class)
# ---------------------------------------------------------------------------

_CATEGORIES: list[tuple[str, str, str, type[CategoryWindow]]] = [
    (
        "Race Status",
        "Speed  ·  gear  ·  lap  ·  RPM  ·  car  ·  fuel",
        "#CC88FF",
        RaceStatusWindow,
    ),
    (
        "Car & Lap",
        "Car info  ·  lap times  ·  FH6 extras",
        "#44CCFF",
        CarLapWindow,
    ),
    (
        "Tyres",
        "Tyre widgets  ·  temperature history",
        "#FF4444",
        TyresWindow,
    ),
    (
        "Engine",
        "RPM  ·  power  ·  torque charts",
        "#FFDD44",
        EngineWindow,
    ),
    (
        "Inputs",
        "Throttle  ·  brake  ·  steer  ·  clutch",
        "#22BB44",
        InputsWindow,
    ),
    (
        "Motion",
        "Velocity  ·  position  ·  suspension  ·  speed",
        "#FF9900",
        MotionWindow,
    ),
]


# ---------------------------------------------------------------------------
# LauncherWindow
# ---------------------------------------------------------------------------

class LauncherWindow(QMainWindow):
    """Compact control panel — toggle category windows, monitor connection."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 Telemetry — Launcher")
        self.setFixedWidth(430)
        self.setStyleSheet(_DARK_STYLE)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Content area ──────────────────────────────────────────────────
        content = QWidget()
        body = QVBoxLayout(content)
        body.setContentsMargins(16, 16, 16, 16)
        body.setSpacing(8)

        title_lbl = QLabel("FH6 TELEMETRY")
        title_lbl.setStyleSheet(
            "color: #44CCFF; font-size: 22px; font-weight: bold;"
            " letter-spacing: 3px; font-family: monospace;"
        )
        sub_lbl = QLabel("Multi-Window Dashboard")
        sub_lbl.setStyleSheet(
            "color: #555566; font-size: 12px; margin-bottom: 4px;"
        )
        body.addWidget(title_lbl)
        body.addWidget(sub_lbl)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("color: #2a2a4a; margin: 4px 0 8px 0;")
        body.addWidget(sep)

        # ── Connection input ──────────────────────────────────────────────
        conn_lbl = QLabel("CONNECTION")
        conn_lbl.setStyleSheet(
            "color: #666688; font-size: 10px; font-weight: bold; letter-spacing: 1px;"
        )
        body.addWidget(conn_lbl)

        addr_row = QHBoxLayout()
        addr_row.setSpacing(6)

        ip_lbl = QLabel("IP:")
        ip_lbl.setStyleSheet("color: #888899; font-size: 12px;")
        ip_lbl.setFixedWidth(20)
        self._ip_edit = QLineEdit(HOST)
        self._ip_edit.setPlaceholderText("e.g. 127.0.0.1")
        self._ip_edit.setStyleSheet(
            "QLineEdit { background: #111122; color: #ccccdd;"
            "  border: 1px solid #2a2a4a; border-radius: 4px;"
            "  padding: 4px 8px; font-size: 12px; font-family: monospace; }"
            "QLineEdit:focus { border: 1px solid #44CCFF; }"
        )

        port_lbl = QLabel("Port:")
        port_lbl.setStyleSheet("color: #888899; font-size: 12px;")
        port_lbl.setFixedWidth(28)
        self._port_edit = QLineEdit(str(PORT))
        self._port_edit.setPlaceholderText("1024-65535")
        self._port_edit.setFixedWidth(70)
        self._port_edit.setStyleSheet(
            "QLineEdit { background: #111122; color: #ccccdd;"
            "  border: 1px solid #2a2a4a; border-radius: 4px;"
            "  padding: 4px 8px; font-size: 12px; font-family: monospace; }"
            "QLineEdit:focus { border: 1px solid #44CCFF; }"
        )

        addr_row.addWidget(ip_lbl)
        addr_row.addWidget(self._ip_edit, stretch=1)
        addr_row.addWidget(port_lbl)
        addr_row.addWidget(self._port_edit)
        body.addLayout(addr_row)

        conn_btn_row = QHBoxLayout()
        conn_btn_row.setSpacing(8)
        test_btn    = self._accent_button("Test",    "#FFDD44")
        connect_btn = self._accent_button("Connect", "#22BB44")
        test_btn.clicked.connect(self._test_connection)
        connect_btn.clicked.connect(self._connect)
        conn_btn_row.addWidget(test_btn)
        conn_btn_row.addWidget(connect_btn)
        body.addLayout(conn_btn_row)

        sep2 = QFrame()
        sep2.setFrameShape(QFrame.Shape.HLine)
        sep2.setStyleSheet("color: #2a2a4a; margin: 4px 0 8px 0;")
        body.addWidget(sep2)

        windows_lbl = QLabel("SELECT WINDOWS")
        windows_lbl.setStyleSheet(
            "color: #666688; font-size: 10px; font-weight: bold; letter-spacing: 1px;"
        )
        body.addWidget(windows_lbl)

        # ── Toggle buttons ────────────────────────────────────────────────
        self._buttons: list[ToggleButton] = []
        self._windows: list[CategoryWindow] = []

        for title, subtitle, accent, WindowClass in _CATEGORIES:
            btn = ToggleButton(title, subtitle, accent)
            win = WindowClass()

            # X on the category window → uncheck the launcher button
            win.window_hidden.connect(lambda b=btn: b.setChecked(False))
            # Clicking the button → show or hide the window
            btn.toggled.connect(
                lambda checked, w=win: w.show() if checked else w.hide()
            )

            self._buttons.append(btn)
            self._windows.append(win)
            body.addWidget(btn)

        body.addSpacing(4)

        # ── Open All / Close All ──────────────────────────────────────────
        ctrl_row = QHBoxLayout()
        ctrl_row.setSpacing(8)

        open_all_btn  = self._ctrl_button("Open All")
        close_all_btn = self._ctrl_button("Close All")
        open_all_btn.clicked.connect(self._open_all)
        close_all_btn.clicked.connect(self._close_all)
        ctrl_row.addWidget(open_all_btn)
        ctrl_row.addWidget(close_all_btn)
        body.addLayout(ctrl_row)

        body.addStretch()
        root.addWidget(content)

        # ── Status bar ────────────────────────────────────────────────────
        sb = QStatusBar()
        self.setStatusBar(sb)
        self._conn_lbl = QLabel("⬤  Waiting for telemetry …")
        self._conn_lbl.setStyleSheet("color: #888866;")
        self._ts_lbl = QLabel("")
        self._ts_lbl.setStyleSheet("color: #555566;")
        sb.addWidget(self._conn_lbl)
        sb.addPermanentWidget(self._ts_lbl)

        self._connected = False
        self.adjustSize()

        # ── UDP receiver ──────────────────────────────────────────────────
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ── Helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _accent_button(text: str, accent: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setStyleSheet(
            f"QPushButton {{ background: #0d1a2e; color: {accent};"
            f"  border: 1px solid {accent}; border-radius: 5px;"
            f"  padding: 6px 14px; font-size: 12px; font-weight: bold; }}"
            f"QPushButton:hover {{ background: #1e1e3a; }}"
            f"QPushButton:pressed {{ background: #0a1020; }}"
        )
        return btn

    @staticmethod
    def _ctrl_button(text: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setStyleSheet(
            "QPushButton { background: #1a1a2e; color: #888899;"
            "  border: 1px solid #2a2a4a; border-radius: 5px;"
            "  padding: 6px 14px; font-size: 12px; }"
            "QPushButton:hover { background: #1e1e3a; color: #cccccc; }"
            "QPushButton:pressed { background: #0d1a2e; }"
        )
        return btn

    def _open_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(True)
            win.show()

    def _close_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(False)
            win.hide()

    # ── Connection helpers ────────────────────────────────────────────────

    def _parse_inputs(self) -> tuple[str, int] | None:
        """Validate and return (ip, port), or show an error and return None."""
        ip = self._ip_edit.text().strip()
        port_text = self._port_edit.text().strip()
        try:
            socket.inet_aton(ip)
        except OSError:
            self._conn_lbl.setText(f"⬤  Invalid IP address: '{ip}'")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
            return None
        try:
            port = int(port_text)
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            self._conn_lbl.setText(f"⬤  Invalid port: '{port_text}' (must be 1–65535)")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
            return None
        return ip, port

    def _test_connection(self) -> None:
        """Try to bind a UDP socket to the given address and report result."""
        parsed = self._parse_inputs()
        if parsed is None:
            return
        ip, port = parsed
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((ip, port))
            self._conn_lbl.setText(f"⬤  OK — {ip}:{port} is available")
            self._conn_lbl.setStyleSheet("color: #FFDD44;")
        except OSError as exc:
            self._conn_lbl.setText(f"⬤  Bind failed: {exc.strerror}")
            self._conn_lbl.setStyleSheet("color: #FF4444;")
        finally:
            sock.close()

    def _connect(self) -> None:
        """Stop the current receiver and restart with the new IP/port."""
        parsed = self._parse_inputs()
        if parsed is None:
            return
        ip, port = parsed
        self._receiver.stop()
        self._receiver.wait(2000)
        self._connected = False
        self._receiver = TelemetryReceiver(ip, port)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()
        self._conn_lbl.setText(f"⬤  Listening on {ip}:{port} …")
        self._conn_lbl.setStyleSheet("color: #888866;")

    # ── Telemetry slot ────────────────────────────────────────────────────

    def _on_telemetry(self, t: dict) -> None:
        # FH6 broadcasts tyre temps in Fahrenheit — convert to °C
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0
            if t[key] <= 0.0:
                t[key] = 0.1  # Avoid zero or negative temps messing with charts

        if not self._connected:
            self._connected = True
            self._conn_lbl.setText(
                f"⬤  Connected  —  {HOST}:{PORT}  —  {PACKET_SIZE} bytes/packet"
            )
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        self._ts_lbl.setText(f"TimestampMS: {t.get('TimestampMS', 0)}")

        # Only push data to windows that are currently visible
        for win in self._windows:
            if win.isVisible():
                win.update_data(t)

    # ── Cleanup ───────────────────────────────────────────────────────────

    def closeEvent(self, event) -> None:  # type: ignore[override]
        for win in self._windows:
            win.force_close()
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
    launcher = LauncherWindow()
    launcher.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
