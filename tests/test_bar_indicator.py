"""BarIndicator: painted bar, colour buckets, and no needless repaints."""

from __future__ import annotations

import math

import pytest
from PyQt6.QtGui import QColor

from fh6_telemetry.widgets.bar_indicator import BarIndicator, BarWidget


@pytest.fixture()
def bar(qapp):
    b = BarIndicator("Throttle", 100.0, 90.0)
    b.resize(300, 20)
    b.show()
    qapp.processEvents()
    return b


@pytest.fixture()
def count_updates(monkeypatch):
    calls = []
    orig = BarWidget.update

    def wrapper(self, *a):
        calls.append(1)
        return orig(self, *a)

    monkeypatch.setattr(BarWidget, "update", wrapper)
    return calls


def test_colour_buckets(bar):
    bar.update_value(10.0)
    assert bar._bar.color == "#22BB44"
    bar.update_value(70.0)
    assert bar._bar.color == "#FF9900"
    bar.update_value(95.0)
    assert bar._bar.color == "#DD2200"


def test_identical_values_never_schedule_a_repaint(bar, count_updates):
    bar.update_value(42.0)
    count_updates.clear()
    for _ in range(500):
        bar.update_value(42.0)
    assert count_updates == []


def test_sub_pixel_changes_do_not_repaint_but_a_pixel_does(bar, count_updates):
    bar.update_value(50.0)
    count_updates.clear()
    width = bar._bar.width() - 2
    bar.update_value(50.0 + 0.1 / width * 100)        # < 1 px
    assert count_updates == []
    bar.update_value(50.0 + 2.0 / width * 100)        # >= 1 px
    assert len(count_updates) == 1


def test_value_label_is_formatted_like_before(bar):
    bar.update_value(5.0)
    assert bar._val_lbl.text() == "+5.000"
    bar.update_value(55.55)
    assert bar._val_lbl.text() == "55.5" or bar._val_lbl.text() == "55.6"
    bar.update_value(-2.0)
    assert bar._val_lbl.text() == "-2.000"


def test_non_finite_values_are_treated_as_zero(bar):
    bar.update_value(math.nan)
    assert bar._bar.fraction == 0.0 and bar._val_lbl.text() == "+0.000"
    bar.update_value(math.inf)
    assert bar._bar.fraction == 0.0


def test_value_is_clamped_to_the_bar(bar):
    bar.update_value(1000.0)
    assert bar._bar.fraction == 1.0
    bar.update_value(-5.0)
    assert bar._bar.fraction == 0.0 and bar._bar.color == "#22BB44"  # |-5| is small


def test_painting_draws_the_fill_in_the_bucket_colour(qapp, bar):
    bar.update_value(50.0)                              # amber? 50/90 = 0.55 -> green
    bar.update_value(80.0)                              # 0.89 -> amber
    qapp.processEvents()
    img = bar._bar.grab().toImage()
    mid = img.pixelColor(int(img.width() * 0.4), img.height() // 2)
    assert mid.name().lower() == QColor("#FF9900").name().lower()
    right = img.pixelColor(img.width() - 5, img.height() // 2)
    assert right.name().lower() != QColor("#FF9900").name().lower()   # unfilled track


def test_resize_recomputes_the_pixel_width(qapp, bar):
    bar.update_value(50.0)
    w1 = bar._bar._px
    bar.resize(600, 20)
    qapp.processEvents()
    assert bar._bar._px > w1


def test_fuel_inverts_the_colours(qapp):
    b = BarIndicator("Fuel", 100.0, 20.0, invert=True)
    b.update_value(90.0)
    assert b._bar.color == "#22BB44"
    b.update_value(10.0)
    assert b._bar.color == "#DD2200"
