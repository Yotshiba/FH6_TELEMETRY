"""Hold the parser to a short slice of a *real* FH6 capture (free roam, ~75 Hz)."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from fh6_telemetry.constants import FIELDS, PACKET_SIZE
from fh6_telemetry.telemetry import parse_packet
from tools.fake_forza import read_recording

SAMPLE = Path(__file__).parent / "data" / "real_sample.fh6rec"


@pytest.fixture(scope="module")
def frames():
    recs = list(read_recording(SAMPLE))
    return [(t, parse_packet(p)) for t, p in recs]


def test_sample_is_present_and_full_size(frames):
    assert len(frames) > 100
    assert all(set(f) == set(FIELDS) for _, f in frames)
    assert PACKET_SIZE == 324


def test_real_packets_are_finite_and_race_on(frames):
    for _, f in frames:
        assert all(math.isfinite(v) for v in f.values() if isinstance(v, float))
        assert f["IsRaceOn"] == 1


def test_real_rate_is_about_75_hz_not_60(frames):
    ts = [t for t, _ in frames]
    rate = (len(ts) - 1) / (ts[-1] - ts[0])
    assert 65 < rate < 85  # measured ~75 Hz; the charts must not assume 60


def test_timestamps_are_monotonic_with_duplicates(frames):
    ms = [f["TimestampMS"] for _, f in frames]
    assert all(b >= a for a, b in zip(ms, ms[1:]))


def test_gear_has_a_one_packet_transient_during_a_shift(frames):
    """Gear 5 -> (single 11) -> 6: code 11 is not a real gear and must not be
    shown as one (see core.derive.gear_label in a later phase)."""
    gears = [f["Gear"] for _, f in frames]
    assert 11 in gears
    assert gears.count(11) == 1
