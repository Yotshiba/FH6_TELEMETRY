"""The 'showcase' simulator: a coherent session the web UI features can be built against."""

from __future__ import annotations

import math

import pytest

from fh6_telemetry.core.frames import make_frame
from fh6_telemetry.telemetry import parse_packet
from tools.fake_forza import ShowcaseCar, Simulator, _Track

HZ = 75


@pytest.fixture(scope="module")
def rows():
    car = ShowcaseCar(seed=1)
    return [car.values(i / HZ) for i in range(HZ * 235)]      # one full cycle + a bit


def _first(rows, cond):
    for i, r in enumerate(rows):
        if cond(r):
            return i / HZ
    return None


def test_is_deterministic():
    a = [ShowcaseCar(3).values(i / HZ) for i in range(300)]
    b = [ShowcaseCar(3).values(i / HZ) for i in range(300)]
    assert a[-1] == b[-1]


def test_launch_hits_realistic_standing_start_times(rows):
    go = _first(rows, lambda r: r["Speed"] > 0.3)
    t100 = _first(rows, lambda r: r["Speed"] > 100 / 3.6)
    t200 = _first(rows, lambda r: r["Speed"] > 200 / 3.6)
    assert 2.4 < t100 - go < 3.6
    assert 5.5 < t200 - go < 8.5
    assert 270 < max(r["Speed"] for r in rows[: HZ * 30]) * 3.6 < 310


def test_braking_test_stops_in_a_sane_distance(rows):
    i0 = next(i for i, r in enumerate(rows) if r["Brake"] > 200)
    j = next(i for i in range(i0, len(rows)) if rows[i]["Speed"] < 0.5)
    t_stop = (j - i0) / HZ
    assert 5 < t_stop < 9                                     # ~290 km/h to 0 at ~1.2 g


def test_velocity_is_in_car_space_and_matches_speed(rows):
    for r in rows[::37]:
        assert math.hypot(r["VelocityX"], r["VelocityZ"]) == pytest.approx(r["Speed"], rel=1e-6, abs=1e-6)


def test_laps_count_up_and_best_lap_is_recorded(rows):
    assert sorted({r["LapNumber"] for r in rows}) == [0, 1, 2, 3]
    assert 35 < rows[-1]["BestLap"] < 65


def test_cornering_forces_are_plausible(rows):
    assert max(abs(r["AccelerationX"]) for r in rows) / 9.80665 < 1.7
    assert max(-r["AccelerationZ"] for r in rows) / 9.80665 > 0.9
    assert max(r["AccelerationZ"] for r in rows) / 9.80665 > 1.0


def test_drift_angle_is_produced_in_hairpins(rows):
    ang = [abs(math.degrees(math.atan2(r["VelocityX"], r["VelocityZ"]))) for r in rows if r["Speed"] > 10]
    assert max(ang) > 25


def test_one_jump_per_lap_with_all_four_wheels_off_the_ground(rows):
    airborne = [max(r[f"SuspNorm{w}"] for w in ("FL", "FR", "RL", "RR")) < 0.05 for r in rows]
    episodes = sum(1 for i in range(1, len(airborne)) if airborne[i] and not airborne[i - 1])
    assert episodes == 3
    assert 3.0 < sum(airborne) / HZ < 3.8                    # ~1.1 s each


def test_positions_are_continuous_except_at_scene_changes(rows):
    big = [i for i in range(1, len(rows))
           if math.hypot(rows[i]["PositionX"] - rows[i - 1]["PositionX"],
                         rows[i]["PositionZ"] - rows[i - 1]["PositionZ"]) > 20]
    assert 1 <= len(big) <= 4                                 # teleports between strip and circuit


def test_heading_matches_the_direction_of_travel_on_the_circuit(rows):
    lap = [i for i, r in enumerate(rows) if r["LapNumber"] == 1 and r["Speed"] > 15]
    errs = []
    for i in lap[::15]:
        if i + 10 >= len(rows):
            break
        dx = rows[i + 10]["PositionX"] - rows[i]["PositionX"]
        dz = rows[i + 10]["PositionZ"] - rows[i]["PositionZ"]
        d = math.atan2(dx, dz) - rows[i + 5]["Yaw"]
        errs.append(abs((d + math.pi) % (2 * math.pi) - math.pi))
    assert sorted(errs)[len(errs) // 2] < 0.6                 # yaw = travel direction + drift offset


def test_timestamps_increase_and_values_are_finite(rows):
    ts = [r["TimestampMS"] for r in rows]
    assert all(b > a for a, b in zip(ts, ts[1:]))
    assert all(math.isfinite(v) for r in rows[::50] for v in r.values())


def test_track_curvature_has_no_seam_artifact():
    tr = _Track()
    assert max(abs(k) for k in tr.kappa) < 0.08               # a 12 m-radius hairpin at worst
    assert abs(tr.kappa[0]) < 0.05 and abs(tr.kappa[-1]) < 0.05


def test_simulator_wrapper_produces_full_packets():
    sim = Simulator("showcase", seed=1)
    for i in range(300):
        data = sim.datagram(i / HZ)
        t = parse_packet(data)
        assert len(t) == 88
        make_frame(t)                                         # converts cleanly into a frame
