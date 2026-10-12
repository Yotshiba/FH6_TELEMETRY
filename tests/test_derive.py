"""Qt-free helpers: time formatting, colours, gear labels."""

from __future__ import annotations

import math

import pytest

from fh6_telemetry.constants import GEAR_MAP, NEUTRAL_GEAR_CODE, NEUTRAL_HOLD_MS
from fh6_telemetry.core.derive import GearDisplay, bar_color, display_channels, gear_label, get_temp_color, sideslip_deg
from fh6_telemetry.telemetry import secs_to_time


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "--:--.---"), (-1.0, "--:--.---"),
        (float("nan"), "--:--.---"), (float("inf"), "--:--.---"),
        (0.5, "0:00.500"), (59.0, "0:59.000"), (61.234, "1:01.234"),
        (125.0, "2:05.000"),
        (59.9996, "1:00.000"),   # used to print "0:60.000"
        (59.9994, "0:59.999"),
    ],
)
def test_secs_to_time(value, expected):
    assert secs_to_time(value) == expected


def test_bar_color_normal_goes_green_amber_red():
    assert bar_color(10, 90) == "#22BB44"
    assert bar_color(70, 90) == "#FF9900"
    assert bar_color(95, 90) == "#DD2200"


def test_bar_color_inverted_is_red_when_low():
    """Fuel: danger=20 means *below* 20 % is bad (it used to be the opposite)."""
    assert bar_color(80, 20, invert=True) == "#22BB44"   # lots of fuel
    assert bar_color(25, 20, invert=True) == "#FF9900"   # getting low
    assert bar_color(10, 20, invert=True) == "#DD2200"   # nearly empty
    assert bar_color(0, 20, invert=True) == "#DD2200"


def test_bar_color_is_nan_safe():
    assert bar_color(math.nan, 90) == "#22BB44"
    assert bar_color(math.inf, 90, invert=True) == "#22BB44"
    assert bar_color(5, 0) == "#22BB44"


def test_temp_color_buckets():
    assert get_temp_color(20) == "#1a6fb5"
    assert get_temp_color(60) == "#00AACC"
    assert get_temp_color(80) == "#22BB44"
    assert get_temp_color(100) == "#FF9900"
    assert get_temp_color(150) == "#DD2200"
    assert get_temp_color(10_000) == "#DD2200"


def test_gear_codes_are_one_based_and_reverse_is_zero():
    """Regression: an old table made code 1 "N" and showed every forward gear one too low."""
    assert gear_label(0) == "R"
    for gear in range(1, 11):
        assert gear_label(gear) == str(gear), gear
    assert NEUTRAL_GEAR_CODE not in GEAR_MAP and "N" not in GEAR_MAP.values()


def test_gear_label_holds_previous_for_unknown_transient():
    assert gear_label(NEUTRAL_GEAR_CODE, previous="5") == "5"      # the one-packet neutral of a shift
    assert gear_label(NEUTRAL_GEAR_CODE) == "11"                   # nothing to hold: show raw


def test_gear_display_never_flashes_neutral_during_a_shift_but_shows_a_real_one():
    # the real capture's shape: 5, a single neutral packet, 6
    d = GearDisplay()
    t = 1000
    assert [d.update(5, t + i * 13) for i in range(3)] == ["5", "5", "5"]
    assert d.update(NEUTRAL_GEAR_CODE, t + 50) == "5"
    assert d.update(6, t + 63) == "6"
    # a slow clutch shift: neutral for a few packets still holds the old gear ...
    for i in range(10):
        assert d.update(NEUTRAL_GEAR_CODE, 2000 + i * 13) == "6"
    # ... but parked in neutral it is eventually displayed
    assert d.update(NEUTRAL_GEAR_CODE, 2000 + NEUTRAL_HOLD_MS) == "N"
    assert d.update(NEUTRAL_GEAR_CODE, 3000) == "N"
    assert d.update(1, 3013) == "1"                                 # and a real gear replaces it at once
    assert d.update(0, 3026) == "R"


def test_gear_display_edge_cases():
    d = GearDisplay()
    assert d.update(NEUTRAL_GEAR_CODE, 10) == "N"                   # nothing to hold: neutral at once
    assert d.update(77, 20) == "N"                                  # unknown codes hold what is shown
    assert GearDisplay().update(77) == "77"                         # ... or show raw when nothing is
    d = GearDisplay()
    d.update(3, 100)
    assert d.update(NEUTRAL_GEAR_CODE) == "3"                       # no clock: never promotes to N
    d.update(NEUTRAL_GEAR_CODE, 5000)
    assert d.update(NEUTRAL_GEAR_CODE, 4000) == "3"                 # the clock restarted: the timer restarts
    assert d.update(NEUTRAL_GEAR_CODE, 4000 + NEUTRAL_HOLD_MS) == "N"
    w = GearDisplay()                                               # u32 wrap-around of TimestampMS
    w.update(4, 0xFFFFFF00)
    w.update(NEUTRAL_GEAR_CODE, 0xFFFFFF80)
    assert w.update(NEUTRAL_GEAR_CODE, 0xFFFFFF80 + NEUTRAL_HOLD_MS) == "N"
    w.update(4, 5)
    w.update(NEUTRAL_GEAR_CODE, 0xFFFFFFF0)
    assert w.update(NEUTRAL_GEAR_CODE, (0xFFFFFFF0 + NEUTRAL_HOLD_MS) & 0xFFFFFFFF) == "N"


# --- sideslip (drift angle) ------------------------------------------------------------------------------------

FIRST_GEAR = next(code for code, label in GEAR_MAP.items() if label == "1")
NEUTRAL = NEUTRAL_GEAR_CODE
REVERSE = next(code for code, label in GEAR_MAP.items() if label == "R")


def _car_frame(angle_deg: float, speed: float = 22.0) -> tuple[float, float]:
    """(VelocityX, VelocityZ) of a car travelling *angle_deg* away from where its nose points (+ = to the right)."""
    a = math.radians(angle_deg)
    return speed * math.sin(a), speed * math.cos(a)


@pytest.mark.parametrize("angle", [0, 10, 30, 60, 85, 89, 91, 100, 120, 150, 170, 179])
def test_sideslip_reports_the_whole_range_in_forward_gears(angle):
    """Past 90 degrees it used to snap back to 0, so spin-outs were invisible to the drift scorer."""
    for sign in (1, -1):
        vx, vz = _car_frame(sign * angle)
        assert sideslip_deg(vx, vz, 22.0, FIRST_GEAR) == pytest.approx(sign * angle, abs=1e-9)


def test_sideslip_is_continuous_across_90_degrees():
    below = sideslip_deg(*_car_frame(89.0), 22.0, FIRST_GEAR)
    above = sideslip_deg(*_car_frame(91.0), 22.0, FIRST_GEAR)
    assert below == pytest.approx(89.0) and above == pytest.approx(91.0)


def test_sideslip_is_zero_at_a_standstill_whatever_the_direction():
    for angle in (0, 45, 135, 180):
        vx, vz = _car_frame(angle, 2.9)
        assert sideslip_deg(vx, vz, 2.9, FIRST_GEAR) == 0.0
    assert sideslip_deg(0.0, 0.0, 0.0) == 0.0
    assert sideslip_deg(1.0, 1.0, 3.0, FIRST_GEAR) != 0.0       # 3 m/s is the first speed that counts


def test_sideslip_is_zero_in_reverse_but_not_in_neutral():
    vx, vz = _car_frame(180.0 - 20.0)                           # driving backwards, a little crabbed
    assert sideslip_deg(vx, vz, 22.0, REVERSE) == 0.0
    assert sideslip_deg(vx, vz, 22.0, FIRST_GEAR) == pytest.approx(160.0)
    assert sideslip_deg(vx, vz, 22.0, NEUTRAL) == pytest.approx(160.0)   # rolling backwards in neutral/forward gear
    assert sideslip_deg(*_car_frame(30.0), 22.0, None) == pytest.approx(30.0)   # gear unknown: assume forward


def test_display_channels_passes_the_gear_to_the_sideslip():
    vx, vz = _car_frame(120.0)
    t = {"Speed": 22.0, "VelocityX": vx, "VelocityZ": vz, "Gear": FIRST_GEAR}
    assert display_channels(t)["SideslipDeg"] == pytest.approx(120.0)
    assert display_channels({**t, "Gear": REVERSE})["SideslipDeg"] == 0.0
    assert display_channels({k: v for k, v in t.items() if k != "Gear"})["SideslipDeg"] == pytest.approx(120.0)
    assert display_channels({})["SideslipDeg"] == 0.0           # an empty packet is still safe
