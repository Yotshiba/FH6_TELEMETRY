"""
LauncherWindow — compact control panel to toggle category windows and monitor
the UDP connection.
"""

from __future__ import annotations

import socket
import sys

import pyqtgraph as pg
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from .constants import HOST, PACKET_SIZE, PORT, WHEELS
from .style import _DARK_STYLE
from .telemetry import TelemetryReceiver
from .windows.car_lap_window import CarLapWindow
from .windows.category_window import CategoryWindow
from .windows.engine_window import EngineWindow
from .windows.inputs_window import InputsWindow
from .windows.motion_window import MotionWindow
from .windows.race_status_window import RaceStatusWindow
from .windows.tyres_window import TyresWindow
from .widgets.toggle_button import ToggleButton

# ---------------------------------------------------------------------------
# Category registry — (title, subtitle, accent_colour, window_class)
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

        # Content area
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

        # Connection input
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

        # Toggle buttons
        self._buttons: list[ToggleButton] = []
        self._windows: list[CategoryWindow] = []

        for title, subtitle, accent, WindowClass in _CATEGORIES:
            btn = ToggleButton(title, subtitle, accent)
            win = WindowClass()

            win.window_hidden.connect(lambda b=btn: b.setChecked(False))
            btn.toggled.connect(
                lambda checked, w=win: w.show() if checked else w.hide()
            )

            self._buttons.append(btn)
            self._windows.append(win)
            body.addWidget(btn)

        body.addSpacing(4)

        # Open All / Close All
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

        # Status bar
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

        # UDP receiver
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ------------------------------------------------------------------
    # Button factories
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Window control
    # ------------------------------------------------------------------

    def _open_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(True)
            win.show()

    def _close_all(self) -> None:
        for btn, win in zip(self._buttons, self._windows):
            btn.setChecked(False)
            win.hide()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------

    def _parse_inputs(self) -> tuple[str, int] | None:
        """Validate IP/port fields; return (ip, port) or None on error."""
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
        """Try to bind a UDP socket and report whether the port is available."""
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
        """Stop the current receiver and restart it with the new IP/port."""
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

    # ------------------------------------------------------------------
    # Telemetry slot
    # ------------------------------------------------------------------

    def _on_telemetry(self, t: dict) -> None:
        # FH6 broadcasts tyre temps in Fahrenheit — convert to °C
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0
            if t[key] <= 0.0:
                t[key] = 0.1  # avoid zero/negative values skewing charts

        if not self._connected:
            self._connected = True
            self._conn_lbl.setText(
                f"⬤  Connected  —  {HOST}:{PORT}  —  {PACKET_SIZE} bytes/packet"
            )
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        self._ts_lbl.setText(f"TimestampMS: {t.get('TimestampMS', 0)}")

        for win in self._windows:
            if win.isVisible():
                win.update_data(t)

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def closeEvent(self, event) -> None:  # type: ignore[override]
        for win in self._windows:
            win.force_close()
        self._receiver.stop()
        self._receiver.wait(2000)
        super().closeEvent(event)


def main() -> None:
    pg.setConfigOptions(antialias=True, foreground="#cccccc", background="#0d0d1a")
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    launcher = LauncherWindow()
    launcher.show()
    sys.exit(app.exec())
