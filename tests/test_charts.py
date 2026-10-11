"""Chart registry and display channels stay consistent with each other."""

from __future__ import annotations

import re

import pytest

from fh6_telemetry.core.charts import CHARTS
from fh6_telemetry.core.derive import display_channels
from fh6_telemetry.telemetry import parse_packet
from tools.fake_forza import Simulator, build_packet


def _sample_t():
    t = parse_packet(Simulator("fluct", 1).datagram(3.0))
    for w in ("FL", "FR", "RL", "RR"):                # launcher converts °F -> °C
        t[f"TireTemp{w}"] = (t[f"TireTemp{w}"] - 32.0) * 5.0 / 9.0
    t.update(display_channels(t))
    return t


def test_every_chart_channel_exists_in_a_converted_packet():
    t = _sample_t()
    for chart in CHARTS.values():
        for ch in chart.channels:
            assert ch in t, f"{chart.id}: channel {ch!r} not produced"


def test_chart_definitions_are_well_formed():
    assert len(CHARTS) == 6
    for cid, c in CHARTS.items():
        assert c.id == cid and c.title and c.lines
        assert len(set(c.channels)) == len(c.channels)
        assert all(re.fullmatch(r"#[0-9a-fA-F]{6}", line.color) for line in c.lines)
        assert sum(x is not None for x in (c.y_fixed, c.y_floor)) <= 1


def test_display_channel_conversions():
    t = parse_packet(build_packet({
        "Speed": 10.0, "Power": 100_000.0, "Boost": 14.5038, "Fuel": 0.25,
        "Accel": 255, "Brake": 51, "Clutch": 0, "HandBrake": 255, "Steer": -127,
    }))
    d = display_channels(t)
    assert d["SpeedKmh"] == pytest.approx(36.0)
    assert d["SpeedMph"] == pytest.approx(22.3694)
    assert d["PowerHp"] == pytest.approx(134.102)
    assert d["BoostBar"] == pytest.approx(1.0, rel=1e-3)
    assert d["FuelPct"] == pytest.approx(25.0)
    assert d["AccelPct"] == pytest.approx(100.0) and d["BrakePct"] == pytest.approx(20.0)
    assert d["HandBrakePct"] == pytest.approx(100.0) and d["ClutchPct"] == 0.0
    assert d["SteerPct"] == pytest.approx(-100.0)


def test_steer_minus_128_is_clamped():
    t = parse_packet(build_packet({"Steer": -128}))
    assert display_channels(t)["SteerPct"] == -100.0


def test_derived_keys_do_not_collide_with_raw_fields():
    from fh6_telemetry.constants import FIELDS

    assert not set(display_channels({})) & set(FIELDS)
