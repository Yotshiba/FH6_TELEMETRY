"""Web protocol: column tables, encoders, hello, server-side ranges."""

from __future__ import annotations

import json
import math

import pytest

from fh6_telemetry.core.charts import CHARTS
from fh6_telemetry.core.frames import make_frame
from fh6_telemetry.telemetry import parse_packet
from fh6_telemetry.web import protocol as P
from tools.fake_forza import Simulator, build_packet


def _frame(**kw):
    kw.setdefault("IsRaceOn", 1)
    return make_frame(parse_packet(build_packet(kw)))


def test_every_column_key_exists_in_a_frame():
    f = _frame()
    for k, _d, _u in P.FAST:
        assert k in f, k
    for k, _d, get in P.SLOW:
        get(f)                                          # computable from a frame


def test_column_tables_have_unique_keys_and_match_the_index_maps():
    assert len({k for k, _d, _u in P.FAST}) == len(P.FAST) == 31
    assert len({k for k, _d, _g in P.SLOW}) == len(P.SLOW)
    assert P.FAST_INDEX["IsRaceOn"] == 0
    assert all(P.FAST[i][0] == k for k, i in P.FAST_INDEX.items())


def test_fast_row_values_and_rounding():
    f = _frame(Speed=10.0, Power=100_000.0, Accel=255, Brake=51, Gear=4,
               CurrentEngineRpm=5432.6, Boost=14.5038)
    row = P.fast_row(f)
    d = dict(zip((k for k, _d, _u in P.FAST), row))
    assert d["SpeedKmh"] == 36.0 and d["PowerHp"] == 134.1
    assert d["AccelPct"] == 100.0 and d["BrakePct"] == 20.0
    assert d["Gear"] == 4 and isinstance(d["Gear"], int)
    assert d["CurrentEngineRpm"] == 5433 and isinstance(d["CurrentEngineRpm"], int)
    assert d["BoostBar"] == 1.0


def test_integer_columns_encode_without_a_decimal_point():
    text = P.dumps(P.fast_row(_frame(CurrentEngineRpm=7000.2, Gear=3)))
    assert "7000.0" not in text and "7000," in text


def test_slow_row_derived_columns():
    f = _frame(CurrentLap=61.234, BestLap=59.5, LastLap=0.0, CurrentRaceTime=125.0,
               AccelerationX=9.80665, WheelOnRumbleFL=1, WheelOnRumbleRR=1,
               WheelInPuddleFR=1, Boost=12.34)
    d = dict(zip((k for k, _d, _g in P.SLOW), P.slow_row(f)))
    assert d["CurrentLapMs"] == 61234 and d["BestLapMs"] == 59500 and d["LastLapMs"] == 0
    assert d["CurrentRaceTimeMs"] == 125000
    assert d["AccelGX"] == 1.0
    assert d["WheelFlags"] == 0b0010_1001               # rumble FL + RR, puddle FR
    assert d["BoostPsi"] == 12.3


def test_encoders_never_emit_nan_or_infinity_even_for_garbage():
    hostile = {k: math.nan for k, _d, _u in P.FAST}
    hostile.update({"Gear": math.inf, "IsRaceOn": "x", "SpeedKmh": None})
    for row in (P.fast_row(hostile), P.slow_row(hostile)):
        assert all(math.isfinite(v) for v in row)
        text = P.dumps(row)
        assert "NaN" not in text and "Infinity" not in text
    with pytest.raises(ValueError):
        P.dumps([math.nan])                            # the guard itself works


def test_simulated_stream_serialises_cleanly():
    sim = Simulator("nan", seed=2)
    prev = None
    for i in range(400):
        raw = parse_packet(sim.datagram(i / 75.0))
        if not raw:
            continue
        prev = make_frame(raw, prev)
        json.loads(P.dumps(P.fast_row(prev)), parse_constant=lambda c: pytest.fail(c))
        json.loads(P.dumps(P.slow_row(prev)), parse_constant=lambda c: pytest.fail(c))


def test_sse_framing():
    msg = P.sse("f", '{"a":1}', "3:99").decode()
    assert msg == 'id: 3:99\nevent: f\ndata: {"a":1}\n\n'
    assert P.sse("st", "{}").decode() == "event: st\ndata: {}\n\n"


def test_hello_describes_the_columns_charts_and_ui_constants():
    h = P.hello(epoch=2, tick_hz=30, resume=False, ranges={"tyre_temp": [0, 120]})
    assert h["v"] == 1 and h["epoch"] == 2 and h["resume"] is False
    assert len(h["F"]) == len(P.FAST) and len(h["S"]) == len(P.SLOW)
    assert h["F"][P.FAST_INDEX["SpeedKmh"]]["k"] == "SpeedKmh"
    assert {c["id"] for c in h["charts"]} == set(CHARTS)
    for c in h["charts"]:
        for line in c["lines"]:
            assert h["F"][line["k"]]["k"] in CHARTS[c["id"]].channels
    assert h["lab"]["gear"]["0"] == "R" and h["lab"]["gear"]["1"] == "1" and h["lab"]["gear"]["6"] == "6"   # 1-based
    assert h["lab"]["neutral"] == {"code": 11, "holdMs": 250} and h["lab"]["cls"]["3"] == "A"
    assert h["ui"]["temp"][0] == [50.0, "#1a6fb5"] and h["ui"]["wheel"]["FL"] == "#FF4444"
    assert any(b["label"] == "Fuel" and b["invert"] for b in h["ui"]["inputs"])
    assert h["rg"] == {"tyre_temp": [0, 120]}
    json.loads(P.dumps(h))                              # serialisable


class TestRangeTracker:
    def _row(self, **kw):
        return P.fast_row(_frame(**kw))

    def test_ranges_follow_the_data_and_contain_it(self):
        rt = P.RangeTracker(history_len=100)
        rows = [self._row(Power=p * 1000.0, Torque=300.0) for p in range(50, 250, 2)]
        rt.feed(rows)
        ch = rt.update(0.0)
        lo, hi = ch["engine_power_torque"]
        assert lo <= 0 and hi >= 250 * 1.34102 * 0.99          # power peaks near 335 hp
        assert "inputs_throttle_brake" not in ch               # fixed charts are not tracked

    def test_unchanged_data_reports_no_change(self):
        rt = P.RangeTracker()
        rt.feed([self._row(Power=100_000.0)] * 50)
        rt.update(0.0)
        assert rt.update(0.5) == {}

    def test_paused_frames_are_ignored(self):
        rt = P.RangeTracker()
        rt.feed([self._row(IsRaceOn=0, Power=900_000.0)] * 20)
        assert rt.update(0.0) == {}                            # nothing plotted -> nothing to range

    def test_reset_forgets(self):
        rt = P.RangeTracker()
        rt.feed([self._row(Power=100_000.0)] * 10)
        rt.update(0.0)
        rt.reset()
        assert rt.current == {} and rt.update(1.0) == {}
