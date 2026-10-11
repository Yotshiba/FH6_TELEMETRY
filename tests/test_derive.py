"""Qt-free helpers: time formatting, colours, gear labels."""

from __future__ import annotations

import math

import pytest

from fh6_telemetry.core.derive import bar_color, gear_label, get_temp_color
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


def test_gear_label_holds_previous_for_unknown_transient():
    assert gear_label(0) == "R" and gear_label(1) == "N" and gear_label(2) == "1"
    assert gear_label(11, previous="5") == "5"      # shift transient
    assert gear_label(11) == "11"                   # nothing to hold: show raw
