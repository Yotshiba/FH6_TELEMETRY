"""
Forza Horizon 6 — Tabbed Telemetry Dashboard
Same data as dashboard_ui.py but arranged in 5 tabs.

Tabs
----
  Overview   — Car info / lap times / FH6 extras + full motion readout
  Tyres      — 2×2 tyre widget cards + tyre temperature history chart
  Engine     — Stats strip + RPM chart + Power & Torque chart
  Inputs     — Input bars + steer indicator + Throttle/Brake chart
  Motion     — Motion readout + Suspension + Speed charts

The HeaderBar strip is always visible above the tab widget.

Usage:  python dashboard_tabs_ui.py
"""

from __future__ import annotations

import sys

import pyqtgraph as pg
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QScrollArea,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from main import (
    CAR_CLASS,
    DRIVETRAIN,
    GEAR_MAP,
    HOST,
    PACKET_SIZE,
    PORT,
    secs_to_time,
)
from tyre_ui import (
    HISTORY_LEN,
    WHEEL_COLORS,
    WHEELS,
    BarIndicator,
    TelemetryReceiver,
)
from dashboard_ui import (
    CAR_GROUP_MAP,
    LineSpec,
    RollingChart,
    HeaderBar,
    LeftInfoPanel,
    TyrePanelGrid,
    MotionPanel,
    _DARK_STYLE,
    _section_label,
    _key_label,
    _val_label,
    _divider,
)

# ---------------------------------------------------------------------------
# Tab stylesheet (appended to _DARK_STYLE)
# ---------------------------------------------------------------------------

_TAB_STYLE = """
QTabWidget::pane {
    border: none;
    background: #0d0d1a;
}
QTabBar::tab {
    background: #1a1a2e;
    color: #888899;
    border: 1px solid #2a2a4a;
    padding: 7px 18px;
    border-radius: 4px 4px 0 0;
    margin-right: 2px;
}
QTabBar::tab:selected {
    background: #0d0d1a;
    color: #44CCFF;
    border-color: #44CCFF;
    border-bottom-color: #0d0d1a;
}
QTabBar::tab:hover:!selected {
    background: #1e1e3a;
    color: #cccccc;
}
"""


# ---------------------------------------------------------------------------
# Tab 1: Overview
# ---------------------------------------------------------------------------

class OverviewTab(QWidget):
    """LeftInfoPanel + MotionPanel side by side."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        self._left = LeftInfoPanel()
        self._motion = MotionPanel()

        split.addWidget(self._left)
        split.addWidget(self._motion)
        split.setStretchFactor(0, 2)
        split.setStretchFactor(1, 3)

        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._left.update_data(t)
        self._motion.update_data(t)


# ---------------------------------------------------------------------------
# Tab 2: Tyres
# ---------------------------------------------------------------------------

class TyresTab(QWidget):
    """TyrePanelGrid (top) + tyre temperature rolling chart (bottom)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Vertical)
        split.setChildrenCollapsible(False)

        self._grid = TyrePanelGrid()
        self._temp_chart = RollingChart(
            "Tyre Temp", "°C",
            [
                ("TireTempFL", "FL", WHEEL_COLORS["FL"], None),
                ("TireTempFR", "FR", WHEEL_COLORS["FR"], None),
                ("TireTempRL", "RL", WHEEL_COLORS["RL"], None),
                ("TireTempRR", "RR", WHEEL_COLORS["RR"], None),
            ],
            y_min=0.0,
        )

        split.addWidget(self._grid)
        split.addWidget(self._temp_chart)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 1)

        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._grid.update_data(t)
        self._temp_chart.append(t)


# ---------------------------------------------------------------------------
# Tab 3: Engine
# ---------------------------------------------------------------------------

class EngineTab(QWidget):
    """Stats strip + RPM chart + Power & Torque chart."""

    _STAT_BOLD = "font-size: 24px; font-weight: bold; font-family: monospace;"
    _STAT_KEY  = "font-size: 10px; color: #888899; letter-spacing: 1px;"

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        # ── Stats strip ───────────────────────────────────────────────────
        strip = QFrame()
        strip.setFixedHeight(90)
        strip.setStyleSheet(
            "QFrame { background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }"
        )
        strip_row = QHBoxLayout(strip)
        strip_row.setContentsMargins(16, 6, 16, 6)
        strip_row.setSpacing(0)

        def _stat(label: str, color: str) -> QLabel:
            """Large coloured value label."""
            lbl = QLabel("--")
            lbl.setStyleSheet(self._STAT_BOLD + f" color: {color};")
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            return lbl

        def _key(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setStyleSheet(self._STAT_KEY)
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            return lbl

        def _vline() -> QFrame:
            vl = QFrame()
            vl.setFrameShape(QFrame.Shape.VLine)
            vl.setStyleSheet("color: #2a2a4a; margin: 4px 12px;")
            return vl

        def _stat_group(key_text: str, color: str) -> tuple[QLabel, QVBoxLayout]:
            grp = QVBoxLayout()
            grp.setSpacing(2)
            val_lbl = _stat(key_text, color)
            grp.addWidget(val_lbl)
            grp.addWidget(_key(key_text))
            return val_lbl, grp

        self._rpm_val,     rpm_grp     = _stat_group("RPM",     "#FFDD44")
        self._maxrpm_val,  maxrpm_grp  = _stat_group("MAX RPM", "#FF4444")
        self._power_val,   power_grp   = _stat_group("POWER",   "#44CCFF")
        self._torque_val,  torque_grp  = _stat_group("TORQUE",  "#FF9900")
        self._boost_val,   boost_grp   = _stat_group("BOOST",   "#44FF88")
        self._fuel_val,    fuel_grp    = _stat_group("FUEL",    "#FFAA44")
        self._gear_val,    gear_grp    = _stat_group("GEAR",    "#FFFFFF")

        for i, (grp, stretch) in enumerate([
            (rpm_grp, 3), (maxrpm_grp, 3), (power_grp, 3), (torque_grp, 3),
            (boost_grp, 2), (fuel_grp, 2), (gear_grp, 1),
        ]):
            if i > 0:
                strip_row.addWidget(_vline())
            strip_row.addLayout(grp, stretch=stretch)

        outer.addWidget(strip)

        # ── Charts ────────────────────────────────────────────────────────
        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        self._rpm_chart = RollingChart(
            "RPM", "rpm",
            [
                ("CurrentEngineRpm", "RPM",     "#FFDD44", None),
                ("EngineMaxRpm",     "Max RPM", "#FF4444", None),
            ],
            y_range=(0.0, 10000.0),
        )
        self._pt_chart = RollingChart(
            "Power & Torque", "kW / Nm",
            [
                ("Power",  "Power (kW)",  "#44CCFF", lambda v: v / 1000.0),
                ("Torque", "Torque (Nm)", "#FF9900", None),
            ],
            y_min=0.0,
        )

        split.addWidget(self._rpm_chart)
        split.addWidget(self._pt_chart)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 1)

        outer.addWidget(split, stretch=1)

    def update_data(self, t: dict) -> None:
        rpm     = t.get("CurrentEngineRpm", 0.0)
        max_rpm = t.get("EngineMaxRpm", 0.0)
        power   = t.get("Power", 0.0) / 1000.0
        torque  = t.get("Torque", 0.0)
        boost   = t.get("Boost", 0.0)
        fuel    = t.get("Fuel", 0.0) * 100.0
        gear    = GEAR_MAP.get(t.get("Gear", 0), "?")

        self._rpm_val.setText(f"{rpm:.0f}")
        self._maxrpm_val.setText(f"{max_rpm:.0f}")
        self._power_val.setText(f"{power:.1f} kW")
        self._torque_val.setText(f"{torque:.1f} Nm")
        self._boost_val.setText(f"{boost:.2f} PSI")
        self._fuel_val.setText(f"{fuel:.1f}%")
        self._gear_val.setText(gear)

        self._rpm_chart.append(t)
        self._pt_chart.append(t)


# ---------------------------------------------------------------------------
# Tab 4: Inputs
# ---------------------------------------------------------------------------

class InputsTab(QWidget):
    """Input bars + steer direction label (left) + Throttle/Brake chart (right)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        # ── Left: bars + steer indicator ─────────────────────────────────
        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)
        left_layout.setContentsMargins(12, 8, 12, 8)
        left_layout.setSpacing(4)

        left_layout.addWidget(_section_label("INPUTS"))

        self._bars: dict[str, BarIndicator] = {}
        for name, max_v, danger in [
            ("Throttle",  100.0, 90.0),
            ("Brake",     100.0, 90.0),
            ("Clutch",    100.0, 90.0),
            ("Handbrake", 100.0, 90.0),
            ("Boost",      30.0, 20.0),
            ("Fuel",      100.0, 20.0),
        ]:
            bar = BarIndicator(name, max_v, danger)
            self._bars[name] = bar
            left_layout.addWidget(bar)

        left_layout.addWidget(_divider())
        left_layout.addWidget(_section_label("STEERING"))

        # Steer bar (absolute)
        self._steer_bar = BarIndicator("Steer (abs)", 100.0, 80.0)
        left_layout.addWidget(self._steer_bar)

        # Directional indicator
        self._steer_dir = QLabel("─  STRAIGHT  ─")
        self._steer_dir.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._steer_dir.setStyleSheet(
            "color: #888899; font-size: 13px; font-family: monospace; padding: 4px;"
        )
        left_layout.addWidget(self._steer_dir)

        left_layout.addStretch()

        # ── Right: Throttle/Brake chart ───────────────────────────────────
        self._tb_chart = RollingChart(
            "Throttle & Brake", "%",
            [
                ("Accel", "Throttle", "#22BB44", lambda v: v / 255.0 * 100.0),
                ("Brake", "Brake",    "#DD2200", lambda v: v / 255.0 * 100.0),
            ],
            y_range=(0.0, 100.0),
        )

        split.addWidget(left_widget)
        split.addWidget(self._tb_chart)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 2)

        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._bars["Throttle"].update_value( t.get("Accel",     0) / 255 * 100)
        self._bars["Brake"].update_value(    t.get("Brake",     0) / 255 * 100)
        self._bars["Clutch"].update_value(   t.get("Clutch",    0) / 255 * 100)
        self._bars["Handbrake"].update_value(t.get("HandBrake", 0) / 255 * 100)
        self._bars["Boost"].update_value(    t.get("Boost",     0.0))
        self._bars["Fuel"].update_value(     t.get("Fuel",      0.0) * 100)

        raw_steer = t.get("Steer", 0)
        steer_pct = raw_steer / 127 * 100
        self._steer_bar.update_value(abs(steer_pct))

        if raw_steer < -5:
            self._steer_dir.setText(f"◄  LEFT  {abs(steer_pct):.0f}%")
            self._steer_dir.setStyleSheet(
                "color: #44CCFF; font-size: 13px; font-family: monospace; padding: 4px;"
            )
        elif raw_steer > 5:
            self._steer_dir.setText(f"RIGHT  {steer_pct:.0f}%  ►")
            self._steer_dir.setStyleSheet(
                "color: #FF9900; font-size: 13px; font-family: monospace; padding: 4px;"
            )
        else:
            self._steer_dir.setText("─  STRAIGHT  ─")
            self._steer_dir.setStyleSheet(
                "color: #888899; font-size: 13px; font-family: monospace; padding: 4px;"
            )

        self._tb_chart.append(t)


# ---------------------------------------------------------------------------
# Tab 5: Motion
# ---------------------------------------------------------------------------

class MotionTab(QWidget):
    """MotionPanel (left) + Suspension + Speed charts stacked (right)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        self._motion = MotionPanel()

        right_split = QSplitter(Qt.Orientation.Vertical)
        right_split.setChildrenCollapsible(False)

        self._susp_chart = RollingChart(
            "Suspension", "norm",
            [
                ("SuspNormFL", "FL", WHEEL_COLORS["FL"], None),
                ("SuspNormFR", "FR", WHEEL_COLORS["FR"], None),
                ("SuspNormRL", "RL", WHEEL_COLORS["RL"], None),
                ("SuspNormRR", "RR", WHEEL_COLORS["RR"], None),
            ],
            y_range=(0.0, 1.0),
        )
        self._speed_chart = RollingChart(
            "Speed", "km/h",
            [("Speed", "Speed", "#44CCFF", lambda v: v * 3.6)],
            y_range=(0.0, 350.0),
        )

        right_split.addWidget(self._susp_chart)
        right_split.addWidget(self._speed_chart)
        right_split.setStretchFactor(0, 1)
        right_split.setStretchFactor(1, 1)

        split.addWidget(self._motion)
        split.addWidget(right_split)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 2)

        layout.addWidget(split)

    def update_data(self, t: dict) -> None:
        self._motion.update_data(t)
        self._susp_chart.append(t)
        self._speed_chart.append(t)


# ---------------------------------------------------------------------------
# TabbedDashboardWindow
# ---------------------------------------------------------------------------

class TabbedDashboardWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FH6 Telemetry — Tabbed Dashboard")
        self.setMinimumSize(1100, 700)
        self.setStyleSheet(_DARK_STYLE + _TAB_STYLE)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Header strip (always visible) ─────────────────────────────────
        self._header = HeaderBar()
        root.addWidget(self._header)

        # ── Tab widget ────────────────────────────────────────────────────
        self._tabs = QTabWidget()
        self._tabs.setDocumentMode(True)
        root.addWidget(self._tabs)

        self._overview_tab = OverviewTab()
        self._tyres_tab    = TyresTab()
        self._engine_tab   = EngineTab()
        self._inputs_tab   = InputsTab()
        self._motion_tab   = MotionTab()

        self._tabs.addTab(self._overview_tab, "Overview")
        self._tabs.addTab(self._tyres_tab,    "Tyres")
        self._tabs.addTab(self._engine_tab,   "Engine")
        self._tabs.addTab(self._inputs_tab,   "Inputs")
        self._tabs.addTab(self._motion_tab,   "Motion")

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

        # ── UDP receiver thread ───────────────────────────────────────────
        self._receiver = TelemetryReceiver(HOST, PORT)
        self._receiver.data_ready.connect(self._on_telemetry)
        self._receiver.start()

    # ── Telemetry slot ────────────────────────────────────────────────────

    def _on_telemetry(self, t: dict) -> None:
        # FH6 sends tyre temperatures in Fahrenheit; convert to °C
        t = dict(t)
        for wheel in WHEELS:
            key = f"TireTemp{wheel}"
            t[key] = (t[key] - 32.0) * 5.0 / 9.0

        if not self._connected:
            self._connected = True
            self._conn_lbl.setText(
                f"⬤  Connected  —  {HOST}:{PORT}  —  {PACKET_SIZE} bytes/packet"
            )
            self._conn_lbl.setStyleSheet("color: #22BB44;")

        # Dispatch to header + all tabs
        self._header.update_data(t)
        self._overview_tab.update_data(t)
        self._tyres_tab.update_data(t)
        self._engine_tab.update_data(t)
        self._inputs_tab.update_data(t)
        self._motion_tab.update_data(t)

        self._ts_lbl.setText(f"TimestampMS: {t.get('TimestampMS', 0)}")

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
    win = TabbedDashboardWindow()
    win.showMaximized()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
