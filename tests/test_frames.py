"""make_frame: °C temps, finite floats, display channels."""

from __future__ import annotations

import math

import pytest

from fh6_telemetry.core.frames import make_frame
from fh6_telemetry.telemetry import parse_packet
from tools.fake_forza import build_packet


def _raw(**kw):
    return parse_packet(build_packet(kw))


def test_temps_are_converted_to_celsius():
    f = make_frame(_raw(TireTempFL=212.0, TireTempFR=122.0, TireTempRL=50.0, TireTempRR=32.5))
    assert f["TireTempFL"] == pytest.approx(100.0)
    assert f["TireTempFR"] == pytest.approx(50.0)
    assert f["TireTempRL"] == pytest.approx(10.0)
    assert f["TireTempRR"] == pytest.approx(0.2777778, rel=1e-4)


def test_zero_and_negative_temps_keep_the_display_clamp():
    f = make_frame(_raw(TireTempFL=0.0, TireTempFR=32.0, TireTempRL=-40.0))
    assert f["TireTempFL"] == 0.1 and f["TireTempFR"] == 0.1 and f["TireTempRL"] == 0.1


def test_display_channels_are_included():
    f = make_frame(_raw(Speed=10.0, Accel=255, Power=100_000.0))
    assert f["SpeedKmh"] == pytest.approx(36.0)
    assert f["AccelPct"] == pytest.approx(100.0)
    assert f["PowerHp"] == pytest.approx(134.102)


def test_raw_input_is_not_mutated():
    raw = _raw(TireTempFL=100.0)
    before = dict(raw)
    make_frame(raw)
    assert raw == before


def test_non_finite_floats_repeat_the_previous_frame_or_become_zero():
    first = make_frame(_raw(CurrentEngineRpm=5000.0, Speed=20.0, TireTempFL=150.0))
    bad = make_frame(
        _raw(CurrentEngineRpm=math.nan, Speed=math.inf, TireTempFL=-math.inf), prev=first
    )
    assert bad["CurrentEngineRpm"] == 5000.0
    assert bad["Speed"] == 20.0
    assert bad["TireTempFL"] == first["TireTempFL"]
    assert bad["SpeedKmh"] == pytest.approx(72.0)        # derived from the repaired value

    no_prev = make_frame(_raw(CurrentEngineRpm=math.nan, TireTempFL=math.nan))
    assert no_prev["CurrentEngineRpm"] == 0.0 and no_prev["TireTempFL"] == 0.1


def test_every_float_in_a_frame_is_finite_for_hostile_input():
    prev = None
    from tools.fake_forza import Simulator

    sim = Simulator("nan", seed=11)
    for i in range(800):
        f = make_frame(parse_packet(sim.datagram(i / 75.0)) or _raw(), prev)
        assert all(math.isfinite(v) for v in f.values() if isinstance(v, float))
        prev = f
