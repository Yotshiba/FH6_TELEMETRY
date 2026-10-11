"""RollingChart (real pyqtgraph, offscreen): data path, axis behaviour, call counts."""

from __future__ import annotations

import math
import random

import numpy as np
import pyqtgraph as pg
import pytest

from fh6_telemetry.core.charts import CHARTS
from fh6_telemetry.widgets.rolling_chart import RollingChart


def _t(ch_values: dict) -> dict:
    return dict(ch_values)


def _feed(chart: RollingChart, n: int, fn, refresh_every: int = 1) -> None:
    for i in range(n):
        chart.ingest(fn(i))
        if i % refresh_every == 0:
            chart.refresh()


@pytest.fixture()
def count_set_y(monkeypatch):
    calls = []
    orig = pg.ViewBox.setYRange

    def wrapper(self, *a, **kw):
        calls.append(a)
        return orig(self, *a, **kw)

    monkeypatch.setattr(pg.ViewBox, "setYRange", wrapper)
    return calls


@pytest.mark.parametrize("cid", list(CHARTS))
def test_builds_with_no_autorange_and_a_legend_entry_per_line(qapp, cid):
    chart = RollingChart(CHARTS[cid])
    vb = chart.getViewBox()
    assert vb.state["autoRange"] == [False, False]
    assert len(chart.getPlotItem().legend.items) == len(CHARTS[cid].lines)
    assert chart.getAxis("left").autoSIPrefix is False


def test_curve_data_is_the_newest_samples_right_aligned(qapp):
    chart = RollingChart(CHARTS["motion_speed"], history_len=50)
    _feed(chart, 30, lambda i: {"SpeedKmh": float(i)})
    x, y = chart._curves[0].getData()
    assert len(x) == len(y) == 30
    assert list(y) == [float(i) for i in range(30)]
    assert x[-1] == 49                                  # newest sample at the right edge
    _feed(chart, 40, lambda i: {"SpeedKmh": float(100 + i)})
    x, y = chart._curves[0].getData()
    assert len(y) == 50
    assert y[0] == 20.0 and y[9] == 29.0 and y[10] == 100.0 and y[-1] == 139.0   # last 50 of 0..29,100..139
    assert list(y[-3:]) == [137.0, 138.0, 139.0]


def test_non_finite_values_repeat_the_last_sample_and_never_raise(qapp):
    chart = RollingChart(CHARTS["engine_power_torque"], history_len=40)
    seq = [100.0, math.nan, math.inf, -math.inf, 120.0]
    for v in seq:
        chart.ingest({"PowerHp": v, "Torque": v})
        chart.refresh()
    _, y = chart._curves[0].getData()
    assert list(y) == [100.0, 100.0, 100.0, 100.0, 120.0]
    assert np.isfinite(y).all()
    chart.ingest({"PowerHp": "garbage", "Torque": None})   # wrong types are tolerated
    chart.refresh()


def test_missing_channels_repeat_the_last_value(qapp):
    chart = RollingChart(CHARTS["engine_rpm"], history_len=10)
    chart.ingest({"CurrentEngineRpm": 3000.0, "EngineMaxRpm": 8000.0})
    chart.ingest({})
    chart.refresh()
    assert list(chart._curves[0].getData()[1]) == [3000.0, 3000.0]


def test_fixed_chart_sets_the_range_once(qapp, count_set_y):
    chart = RollingChart(CHARTS["inputs_throttle_brake"])
    assert len(count_set_y) == 1
    rng = random.Random(1)
    _feed(chart, 600, lambda i: {"AccelPct": rng.uniform(0, 100), "BrakePct": rng.uniform(0, 100)})
    assert len(count_set_y) == 1                         # never re-ranged
    lo, hi = chart.getViewBox().viewRange()[1]
    assert lo < 0 < 100 < hi                             # 0..100 plus padding


def test_steady_data_leaves_the_axis_alone(qapp, count_set_y):
    chart = RollingChart(CHARTS["tyre_temp"])
    n0 = len(count_set_y)
    _feed(chart, 900, lambda i: {f"TireTemp{w}": 80.0 + (i % 5) * 0.1 for w in ("FL", "FR", "RL", "RR")})
    assert len(count_set_y) - n0 <= 3


def test_fluctuating_data_changes_the_axis_far_less_than_once_per_refresh(qapp, count_set_y):
    """The original code called setYRange on every packet."""
    chart = RollingChart(CHARTS["engine_power_torque"])
    rng = random.Random(3)
    n0 = len(count_set_y)
    _feed(chart, 1500, lambda i: {
        "PowerHp": 300 + 150 * math.sin(i / 40.0) + rng.uniform(-25, 25),
        "Torque": 350 + 80 * math.sin(i / 55.0) + rng.uniform(-10, 10),
    })
    changes = len(count_set_y) - n0
    assert changes < 1500 * 0.03, f"{changes} range changes for 1500 refreshes"


def test_y_range_always_contains_the_visible_data(qapp):
    chart = RollingChart(CHARTS["engine_power_torque"], history_len=120)
    rng = random.Random(9)
    v = 200.0
    for i in range(1200):
        v = max(0.0, v + rng.uniform(-30, 32))
        chart.ingest({"PowerHp": v, "Torque": v / 2})
        chart.refresh()
        lo, hi = chart.getViewBox().viewRange()[1]
        w = chart._ring.window()
        assert lo <= float(w.min()) + 1e-6 and hi >= float(w.max()) - 1e-6
        assert lo >= -1e-9                                 # y_min = 0 respected


def test_floor_chart_grows_beyond_the_old_fixed_limit(qapp):
    chart = RollingChart(CHARTS["engine_rpm"])
    _feed(chart, 20, lambda i: {"CurrentEngineRpm": 9000.0, "EngineMaxRpm": 12500.0})
    lo, hi = chart.getViewBox().viewRange()[1]
    assert hi >= 12500.0 and lo <= 0.0


def test_reset_clears_history(qapp):
    chart = RollingChart(CHARTS["motion_speed"], history_len=20)
    _feed(chart, 10, lambda i: {"SpeedKmh": 50.0})
    chart.reset()
    chart.refresh()                                       # nothing buffered: no-op, no error
    chart.ingest({"SpeedKmh": 7.0})
    chart.refresh()
    assert list(chart._curves[0].getData()[1]) == [7.0]


def test_pen_styles_never_combine_wide_pens_with_antialiasing(qapp):
    thin = RollingChart(CHARTS["motion_speed"], style="thin")
    bold = RollingChart(CHARTS["motion_speed"], style="bold")
    assert thin._curves[0].opts["pen"].width() == 1 and thin._curves[0].opts["antialias"]
    assert bold._curves[0].opts["pen"].width() == 2 and not bold._curves[0].opts["antialias"]


def test_axis_label_does_not_use_si_prefix_scaling(qapp):
    chart = RollingChart(CHARTS["engine_rpm"])
    _feed(chart, 5, lambda i: {"CurrentEngineRpm": 7000.0, "EngineMaxRpm": 9000.0})
    assert chart.getAxis("left").autoSIPrefixScale == 1.0
