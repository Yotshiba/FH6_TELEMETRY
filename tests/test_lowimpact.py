"""Low-impact mode: struct layout, exact call arguments, safety, real round trip."""

from __future__ import annotations

import ctypes
import sys

import pytest

from fh6_telemetry.core import lowimpact as li


class FakeApi:
    def __init__(self, prio_ok=True, thr_ok=True, boom=False):
        self.calls = []
        self.prio_ok, self.thr_ok, self.boom = prio_ok, thr_ok, boom

    def current_process(self):
        return 0xFFFFFFFFFFFFFFFF

    def set_priority_class(self, h, cls):
        if self.boom:
            raise RuntimeError("kaboom")
        self.calls.append(("prio", cls))
        return self.prio_ok

    def set_power_throttling(self, h, control, state):
        self.calls.append(("throttle", control, state))
        return self.thr_ok

    def last_error(self):
        return 5


def test_struct_is_three_dwords_12_bytes():
    assert ctypes.sizeof(li.PowerThrottlingState) == 12
    st = li.PowerThrottlingState(1, 1, 1)
    assert (st.Version, st.ControlMask, st.StateMask) == (1, 1, 1)


def test_constants_match_the_windows_headers():
    assert li.BELOW_NORMAL_PRIORITY_CLASS == 0x4000
    assert li.NORMAL_PRIORITY_CLASS == 0x20 and li.IDLE_PRIORITY_CLASS == 0x40
    assert li.PROCESS_POWER_THROTTLING == 4
    assert li.PROCESS_POWER_THROTTLING_EXECUTION_SPEED == 0x1
    assert li.PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION == 0x4


def test_enable_sets_below_normal_and_eco_qos():
    api = FakeApi()
    r = li.apply(True, api=api)
    assert api.calls == [("prio", 0x4000), ("throttle", 0x1, 0x1)]
    assert r.ok and r.priority_set and r.throttling_set


def test_enable_with_timer_resolution_ignore_adds_the_bit():
    api = FakeApi()
    li.apply(True, ignore_timer_resolution=True, api=api)
    assert api.calls[1] == ("throttle", 0x5, 0x5)


def test_disable_hands_control_back_to_the_system():
    api = FakeApi()
    li.apply(False, api=api)
    assert api.calls == [("prio", 0x20), ("throttle", 0, 0)]


def test_partial_failure_is_still_ok_and_reported():
    r = li.apply(True, api=FakeApi(thr_ok=False))
    assert r.ok and r.priority_set and not r.throttling_set
    r = li.apply(True, api=FakeApi(prio_ok=False, thr_ok=False))
    assert not r.ok


def test_apply_never_raises(tmp_path, monkeypatch):
    from fh6_telemetry.core import diagnostics

    monkeypatch.setattr(diagnostics, "_log_path", tmp_path / "e.log")
    r = li.apply(True, api=FakeApi(boom=True))
    assert not r.ok and "kaboom" in r.error


def test_effective_resolves_the_automatic_setting(monkeypatch):
    monkeypatch.setattr(li, "windows_build", lambda: 26300)
    assert li.default_enabled() is True
    assert li.effective(None) is True and li.effective(False) is False and li.effective(True) is True
    monkeypatch.setattr(li, "windows_build", lambda: 19045)       # Windows 10
    assert li.default_enabled() is False and li.effective(None) is False
    monkeypatch.setattr(li, "windows_build", lambda: None)        # not Windows
    assert li.default_enabled() is False


def test_non_windows_is_a_safe_no_op(monkeypatch):
    monkeypatch.setattr(li, "supported", lambda: False)
    r = li.apply(True)
    assert not r.ok and r.error == "Windows only"


@pytest.mark.skipif(sys.platform != "win32", reason="Win32 only")
def test_real_round_trip_changes_and_restores_this_process():
    before = li.current_priority_class()
    try:
        r = li.apply(True)
        assert r.ok and r.priority_set
        assert li.current_priority_class() == li.BELOW_NORMAL_PRIORITY_CLASS
    finally:
        li.apply(False)
        assert li.current_priority_class() == li.NORMAL_PRIORITY_CLASS or before != li.NORMAL_PRIORITY_CLASS
