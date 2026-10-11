"""setStyleSheet re-polishes a widget — it must only run when the look changes."""

from __future__ import annotations

import pytest
from PyQt6.QtWidgets import QWidget

from tests.conftest import free_udp_port
from tools.fake_forza import Simulator
from fh6_telemetry.core.derive import display_channels
from fh6_telemetry.telemetry import parse_packet


@pytest.fixture()
def count_style(monkeypatch):
    calls = []
    orig = QWidget.setStyleSheet

    def wrapper(self, sheet):
        calls.append((type(self).__name__, sheet))
        return orig(self, sheet)

    monkeypatch.setattr(QWidget, "setStyleSheet", wrapper)
    return calls


def _frame(**over):
    t = parse_packet(Simulator("steady", 1).datagram(1.0))
    for w in ("FL", "FR", "RL", "RR"):
        t[f"TireTemp{w}"] = (t[f"TireTemp{w}"] - 32.0) * 5.0 / 9.0
    t.update(over)
    t.update(display_channels(t))
    return t


def test_tyre_widget_restyles_only_on_bucket_or_flag_change(qapp, count_style):
    from fh6_telemetry.widgets.tyre_widget import TyreWidget

    w = TyreWidget("FL")
    count_style.clear()
    f = _frame(TireTempFL=75.0, WheelOnRumbleFL=0, WheelInPuddleFL=0)
    for _ in range(300):
        w.update_data(f)
    assert len(count_style) == 1                        # first real bucket only (0 -> 75 °C)
    count_style.clear()
    for temp in (75.1, 76.0, 79.9, 85.0):               # same bucket
        w.update_data(_frame(TireTempFL=temp, WheelOnRumbleFL=0, WheelInPuddleFL=0))
    assert count_style == []
    w.update_data(_frame(TireTempFL=95.0, WheelOnRumbleFL=0, WheelInPuddleFL=0))   # new bucket
    assert len(count_style) == 1
    count_style.clear()
    w.update_data(_frame(TireTempFL=95.0, WheelOnRumbleFL=1, WheelInPuddleFL=0))   # badge on
    assert len(count_style) == 1
    w.update_data(_frame(TireTempFL=95.0, WheelOnRumbleFL=1, WheelInPuddleFL=0))
    assert len(count_style) == 1
    assert w._temp_lbl.text() == "95.0 °C"


def test_tyre_widget_keeps_the_exact_style_strings(qapp):
    from fh6_telemetry.widgets.tyre_widget import TyreWidget

    w = TyreWidget("FR")
    w.update_data(_frame(TireTempFR=60.0))
    s = w._temp_lbl.styleSheet()
    assert "#00AACC" in s and "font-size: 28px" in s and "color: #ffffff" in s


def test_steer_label_restyles_only_when_direction_flips(qapp, count_style):
    from fh6_telemetry.tabs.inputs_tab import InputsTab

    tab = InputsTab()
    count_style.clear()
    for steer in (60, 61, 62, 100, 127):                # all "right"
        tab.update_data(_frame(Steer=steer))
    assert sum(1 for kind, _ in count_style if kind == "QLabel") == 1
    count_style.clear()
    tab.update_data(_frame(Steer=-80))                  # flips to left
    assert sum(1 for kind, _ in count_style if kind == "QLabel") == 1
    tab.update_data(_frame(Steer=0))
    assert "STRAIGHT" in tab._steer_dir.text()


def test_inputs_tab_does_no_styling_for_a_steady_frame(qapp, count_style):
    from fh6_telemetry.tabs.inputs_tab import InputsTab

    tab = InputsTab()
    f = _frame(Steer=0)
    tab.update_data(f)
    count_style.clear()
    for _ in range(300):
        tab.update_data(f)
    assert count_style == []


def test_race_status_banner_restyles_only_on_state_change(qapp, count_style):
    from fh6_telemetry.windows.race_status_window import RaceStatusWindow

    win = RaceStatusWindow()
    count_style.clear()
    for _ in range(200):
        win.update_data(_frame(IsRaceOn=1))
    assert len(count_style) == 1
    win.update_data(_frame(IsRaceOn=0))
    assert len(count_style) == 2
    assert "PAUSED" in win._race_lbl.text()


def test_whole_launcher_is_style_quiet_for_steady_input(qapp, tmp_config, count_style):
    from fh6_telemetry.launcher import LauncherWindow

    tmp_config.set("udp_port", free_udp_port())
    win = LauncherWindow(tmp_config)
    try:
        win.show()
        win._open_all()
        qapp.processEvents()
        win._on_tick()                                  # adopt the hub session
        pkt = Simulator("steady", 1).datagram(1.0)
        win._hub.ingest(pkt)
        win._on_tick()                                  # settle first-time buckets
        count_style.clear()
        for _ in range(100):
            win._hub.ingest(pkt)
            win._on_tick()
        assert count_style == []
    finally:
        win.close()
