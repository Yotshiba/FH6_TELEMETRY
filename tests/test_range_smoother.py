"""RangeSmoother: snapping, instant expansion, lazy shrink, no flip-flop."""

from __future__ import annotations

import math
import random

import pytest

from fh6_telemetry.core.range_smoother import RangeSmoother, nice_step


@pytest.mark.parametrize(
    "x,expected",
    [(0.13, 0.2), (1.0, 1.0), (1.01, 2.0), (3.0, 5.0), (7.0, 10.0), (12.0, 20.0),
     (80.0, 100.0), (950.0, 1000.0), (0.0, 1.0), (-3.0, 1.0), (math.nan, 1.0)],
)
def test_nice_step(x, expected):
    assert nice_step(x) == pytest.approx(expected)


def test_first_update_returns_a_snapped_range_that_contains_the_data():
    s = RangeSmoother()
    lo, hi = s.update(40.0, 95.0, now=0.0)
    assert lo <= 40.0 and hi >= 95.0
    step = nice_step((hi - lo) / 8)
    assert lo % step == pytest.approx(0, abs=1e-6) or (lo % step) == pytest.approx(step, abs=1e-6)


def test_unchanged_data_returns_none():
    s = RangeSmoother()
    s.update(40, 95, 0.0)
    for i in range(1, 400):
        assert s.update(40, 95, i * 0.016) is None


def test_expansion_is_immediate_even_between_evaluations():
    s = RangeSmoother(eval_hz=4)
    first = s.update(40, 95, 0.0)
    grown = s.update(40, 400, 0.001)          # 1 ms later: must not wait for the 4 Hz tick
    assert grown is not None and grown[1] >= 400 and grown[0] <= first[0]


def test_no_shrink_before_the_hold_then_shrinks_to_what_was_needed():
    s = RangeSmoother(shrink_delay=2.0, eval_hz=4)
    s.update(40, 400, 0.0)                    # spike
    big = s.current
    # data falls back to 40..95
    assert all(s.update(40, 95, t / 10.0) is None for t in range(1, 20))   # < 2 s: held
    shrunk = None
    for t in range(20, 60):
        r = s.update(40, 95, t / 10.0)
        if r is not None:
            shrunk = r
            break
    assert shrunk is not None and shrunk[1] < big[1] and shrunk[1] >= 95
    assert shrunk == s.target(40, 95)


def test_wobble_around_a_snap_boundary_does_not_flip_flop():
    s = RangeSmoother()
    changes = 0
    for i in range(60 * 60):                    # 60 s at 60 Hz
        t = i / 60.0
        hi = 100.0 + 8.0 * math.sin(t * 7.0)    # target boundary sits inside the wobble
        if s.update(50.0, hi, t) is not None:
            changes += 1
    assert changes <= 4


def test_y_min_is_never_violated():
    s = RangeSmoother(y_min=0.0)
    for t, (lo, hi) in enumerate([(0.2, 3.0), (0.0, 0.5), (0.0, 0.0), (1.0, 1.0)]):
        r = s.update(lo, hi, float(t))
        if r:
            assert r[0] >= 0.0 and r[1] > r[0]
    assert s.current[0] >= 0.0


def test_floor_is_a_minimum_that_grows_but_comes_back():
    s = RangeSmoother(floor=(0.0, 10000.0))
    r = s.update(900, 4000, 0.0)
    assert r[0] <= 0.0 and r[1] >= 10000.0
    grown = s.update(900, 12000, 0.1)
    assert grown[1] >= 12000
    for t in range(3, 80):                      # data back to normal for several seconds
        s.update(900, 4000, float(t))
    assert s.current[1] == pytest.approx(10000.0, rel=0.3) and s.current[1] < 12000


def test_flat_and_zero_windows_give_a_finite_non_degenerate_range():
    s = RangeSmoother()
    lo, hi = s.update(5.0, 5.0, 0.0)
    assert math.isfinite(lo) and math.isfinite(hi) and hi > lo
    s2 = RangeSmoother(y_min=0.0)
    lo, hi = s2.update(0.0, 0.0, 0.0)
    assert hi > lo >= 0.0


def test_non_finite_and_inverted_input_is_ignored():
    s = RangeSmoother()
    assert s.update(math.nan, 5.0, 0.0) is None
    assert s.update(0.0, math.inf, 0.0) is None
    assert s.update(5.0, 1.0, 0.0) is None
    assert s.current is None


def test_range_always_contains_the_data_for_random_walks():
    rng = random.Random(7)
    for y_min in (None, 0.0):
        s = RangeSmoother(y_min=y_min)
        v = 50.0
        for i in range(3000):
            v = max(0.0, v + rng.uniform(-6, 6))
            lo, hi = v - rng.uniform(0, 15), v + rng.uniform(0, 15)
            if y_min is not None:
                lo = max(lo, y_min)
            s.update(lo, hi, i / 60.0)
            cur = s.current
            assert cur[0] <= lo + 1e-9 and cur[1] >= hi - 1e-9


def test_reset_forgets_the_range():
    s = RangeSmoother()
    s.update(0, 10, 0.0)
    s.reset()
    assert s.current is None
