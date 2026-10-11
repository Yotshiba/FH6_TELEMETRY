"""Packet layout, parser and the synthetic-packet generator agree."""

from __future__ import annotations

import math
import re

import pytest

from fh6_telemetry.constants import FIELDS, PACKET_FORMAT, PACKET_SIZE
from fh6_telemetry.telemetry import parse_packet
from tools.fake_forza import SCENARIOS, Simulator, build_packet


def test_packet_size_is_324():
    assert PACKET_SIZE == 324


def test_fields_match_format_value_count():
    count = 0
    for m in re.finditer(r"(\d*)([a-zA-Z?])", PACKET_FORMAT.lstrip("<>=!@")):
        if m.group(2) != "x":
            count += int(m.group(1) or 1)
    assert count == len(FIELDS) == 88


def test_build_and_parse_round_trip():
    pkt = build_packet({
        "IsRaceOn": 1, "TimestampMS": 123456, "CurrentEngineRpm": 5432.5,
        "Speed": 33.25, "Accel": 255, "Brake": 0, "Gear": 4, "Steer": -127,
        "TireTempFL": 180.5, "LapNumber": 7,
    })
    assert len(pkt) == PACKET_SIZE
    t = parse_packet(pkt)
    assert t["IsRaceOn"] == 1
    assert t["TimestampMS"] == 123456
    assert t["CurrentEngineRpm"] == pytest.approx(5432.5)
    assert t["Speed"] == pytest.approx(33.25)
    assert t["Accel"] == 255 and t["Brake"] == 0
    assert t["Gear"] == 4
    assert t["Steer"] == -127
    assert t["TireTempFL"] == pytest.approx(180.5)
    assert t["LapNumber"] == 7


def test_short_packet_is_rejected_and_long_accepted():
    pkt = build_packet({"Speed": 10.0})
    assert parse_packet(pkt[:-1]) == {}
    assert parse_packet(pkt + b"\x00" * 8)["Speed"] == pytest.approx(10.0)


def test_integer_fields_are_clamped_not_errors():
    pkt = build_packet({"Accel": 999, "Steer": -999, "Gear": -5})
    t = parse_packet(pkt)
    assert t["Accel"] == 255 and t["Steer"] == -128 and t["Gear"] == 0


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_every_scenario_produces_parseable_packets(scenario):
    sim = Simulator(scenario, seed=3)
    full = 0
    for i in range(1500):  # 25 s at 60 Hz covers pause / car-change windows
        data = sim.datagram(i / 60.0)
        if len(data) == PACKET_SIZE:
            full += 1
            t = parse_packet(data)
            assert set(t) == set(FIELDS)
        else:
            assert scenario == "short"
            assert parse_packet(data) == {}
    assert full > 1000


def test_nan_scenario_really_injects_non_finite_values():
    sim = Simulator("nan", seed=1)
    bad = 0
    for i in range(600):
        t = parse_packet(sim.datagram(i / 60.0))
        bad += sum(1 for v in t.values() if isinstance(v, float) and not math.isfinite(v))
    assert bad > 0


def test_pause_scenario_emits_race_off_packets():
    sim = Simulator("pause", seed=1)
    flags = {parse_packet(sim.datagram(i / 60.0))["IsRaceOn"] for i in range(60 * 10)}
    assert flags == {0, 1}
