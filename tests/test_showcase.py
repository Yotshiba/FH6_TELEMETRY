"""The 'showcase' simulator: a coherent session the web UI features can be built against."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from fh6_telemetry.core.frames import make_frame
from fh6_telemetry.telemetry import parse_packet
from fh6_telemetry.web import protocol as P
from tools.fake_forza import ShowcaseCar, Simulator, _Track, build_packet

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


def _lap_counter(rows):
    """The LapNumber column with consecutive repeats collapsed, e.g. [0, 1, 2, 3, 4, 0, 1]."""
    seq: list[int] = []
    for r in rows:
        if not seq or seq[-1] != r["LapNumber"]:
            seq.append(r["LapNumber"])
    return seq


def test_laps_count_up_through_the_last_lap_and_back_to_zero(rows):
    """Lap 3 must complete: the counter ticks over to 4 (the game's 'lap finished' edge) before it drops to 0."""
    assert _lap_counter(rows) == [0, 1, 2, 3, 4, 0, 1]            # one full cycle, then the next one begins
    i4 = next(i for i, r in enumerate(rows) if r["LapNumber"] == 4)
    shown = [r for r in rows[i4:] if r["LapNumber"] == 4]
    assert len(shown) / HZ >= 0.3                                 # long enough for a 10 Hz client to see it
    assert all(r["CurrentLap"] == 0.0 and 35 < r["LastLap"] < 65 for r in shown)


def test_best_lap_is_recorded_and_stale_lap_times_do_not_leak_into_the_next_session(rows):
    first_cycle = rows[: HZ * 200]
    assert 35 < max(r["BestLap"] for r in first_cycle) < 65
    assert max(r["BestLap"] for r in first_cycle) <= max(r["LastLap"] for r in first_cycle) + 25
    # The next run starts with a clean slate: LapNumber 0 -> 1 with LastLap = BestLap = 0 (a stale LastLap on
    # that edge reads as a finished "lap 0" to the web client's lap tracker).
    starts = [i for i in range(1, len(rows)) if rows[i - 1]["LapNumber"] == 0 and rows[i]["LapNumber"] == 1]
    assert len(starts) == 2
    for i in starts:
        assert rows[i]["LastLap"] == 0.0 and rows[i]["BestLap"] == 0.0 and rows[i]["CurrentLap"] == 0.0


def test_speed_is_continuous_while_the_race_is_on(rows):
    """The car launches from rest at the start of the drag run and of the laps (no teleport to 65 km/h)."""
    worst = 0.0
    for a, b in zip(rows, rows[1:]):
        if a["IsRaceOn"] and b["IsRaceOn"]:
            worst = max(worst, abs(b["Speed"] - a["Speed"]))
    assert worst < 0.5                                            # 14 m/s^2 braking at 75 Hz is 0.19 m/s per row


def test_scene_changes_happen_while_the_race_is_off(rows):
    for a, b in zip(rows, rows[1:]):
        jump = math.hypot(b["PositionX"] - a["PositionX"], b["PositionZ"] - a["PositionZ"])
        if jump > 20:
            assert not (a["IsRaceOn"] and b["IsRaceOn"]), "the car teleported with IsRaceOn = 1"


def test_a_lap_starts_from_a_standstill_with_a_launch_ramp(rows):
    i = next(i for i, r in enumerate(rows) if r["LapNumber"] == 1)
    assert rows[i]["Speed"] == 0.0 and rows[i]["IsRaceOn"] == 0
    go = next(j for j in range(i, len(rows)) if rows[j]["Speed"] > 0.0)
    assert rows[go]["IsRaceOn"] == 1 and rows[go]["Speed"] < 0.5
    t = next(j for j in range(go, len(rows)) if rows[j]["Speed"] > 100 / 3.6)
    assert 2.5 < (t - go) / HZ < 5.0                              # a believable standing start, not 1.2 s


def test_launch_keeps_its_revs_until_the_road_speed_catches_up(rows):
    """No 6100 -> 900 rpm cliff at 1 m/s: the launch revs are held in first gear (drag run and lap start)."""
    for lo, hi in ((0, HZ * 30), (next(i for i, r in enumerate(rows) if r["LapNumber"] == 1), HZ * 60)):
        launch = [r for r in rows[lo:hi] if r["IsRaceOn"] and 0.3 < r["Speed"] < 12.0 and r["Accel"] > 250]
        assert len(launch) > HZ                                   # ~1.5 s of it
        assert min(r["CurrentEngineRpm"] for r in launch) > 6000
    for a, b in zip(rows, rows[1:]):                               # and nothing else falls off a cliff while on throttle
        if a["IsRaceOn"] and b["IsRaceOn"] and a["Gear"] == b["Gear"] and min(a["Accel"], b["Accel"]) > 250:
            assert abs(b["CurrentEngineRpm"] - a["CurrentEngineRpm"]) < 400


def test_no_phantom_slip_angle_outside_the_laps(rows):
    for r in rows:
        if r["LapNumber"] not in (1, 2, 3):
            assert all(r[f"TireSlipAngle{w}"] == 0.0 for w in ("FL", "FR", "RL", "RR"))


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
    assert all(b >= a for a, b in zip(ts, ts[1:]))            # never backwards...
    assert sum(1 for a, b in zip(ts, ts[1:]) if a == b) > len(ts) * 0.1   # ...with realistic duplicates
    assert all(b - a <= 32 for a, b in zip(ts, ts[1:]))
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


# --- long runs: tyres, fuel -------------------------------------------------------------------------------------


def _celsius(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


@pytest.fixture(scope="module")
def long_rows():
    car = ShowcaseCar(seed=1)
    return [car.values(i / HZ) for i in range(HZ * 400)]          # two full cycles


def test_tyres_heat_up_but_stay_in_a_believable_band(long_rows):
    """The comment promises ~65-115 C; the red band (> 110 C) used to be reached by t = 100 s and never left."""
    for w in ("FL", "FR", "RL", "RR"):
        temps = [_celsius(r[f"TireTemp{w}"]) for r in long_rows]
        assert 40 < min(temps) < 70 and 85 < max(temps) < 120, (w, min(temps), max(temps))
        assert sum(1 for c in temps if c > 115) == 0
        assert sum(1 for c in temps if c > 110) / HZ < 30         # the red band is at most brushed
    # the front tyres keep a visible story: cold -> warm -> hot, not a flat line
    fl = [_celsius(r["TireTempFL"]) for r in long_rows]
    assert fl[HZ * 30] < 65 and max(fl[HZ * 150: HZ * 190]) > 90
    # the rears slide more and so run hotter
    assert sum(r["TireTempRL"] for r in long_rows) > sum(r["TireTempFL"] for r in long_rows)


def test_the_endless_showcase_refuels_and_the_odometer_only_grows():
    car = ShowcaseCar(seed=1)
    hz = 20                                                       # coarse steps are enough for fuel and distance
    fuel, odo = [], []
    for i in range(hz * 1250):                                    # > 20 minutes: used to run dry after ~17
        r = car.values(i / hz)
        fuel.append(r["Fuel"])
        odo.append(r["DistanceTraveled"])
    assert min(fuel) > 0.2                                        # never close to empty
    assert any(b > a + 0.3 for a, b in zip(fuel, fuel[1:]))       # a pit stop happened
    assert any(b < a for a, b in zip(fuel, fuel[1:]))             # ...and it burns in between
    assert all(b >= a for a, b in zip(odo, odo[1:]))              # DistanceTraveled never goes back to 0 at the refuel
    assert odo[-1] > 20000


# --- replay through the real front-end modules (node) ------------------------------------------------------------

STATIC = Path(__file__).resolve().parent.parent / "fh6_telemetry" / "web" / "static"

_REPLAY_JS = """
import { readFileSync } from 'node:fs';
import { PerfMeter } from './perf.mjs';
import { LapDelta } from './lap.mjs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const perf = new PerfMeter({ F: data.F, S: data.S });
const perfEvents = [];
data.fast.forEach((row, i) => { perf.feed(row); for (const e of perf.drain()) perfEvents.push({ i, ...e }); });
const lap = new LapDelta({ S: data.S });
const lapEvents = [];
data.slow.forEach(([i, row]) => { lap.feedSlow(row); for (const e of lap.drain()) lapEvents.push({ i, ...e }); });
process.stdout.write(JSON.stringify({ perf: perfEvents, laps: lapEvents }));
"""


@pytest.fixture(scope="module")
def replay(long_rows, tmp_path_factory):
    """The sim as the web server would send it, fed to the real PerfMeter and LapDelta (perf.js, lap.js)."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    prev = None
    fast, slow, last_slow, last_t = [], [], None, -1.0
    for i, values in enumerate(long_rows):
        prev = make_frame(parse_packet(build_packet(values)), prev)
        fast.append(P.fast_row(prev))
        t = i / HZ
        if t - last_t >= 0.1:                                     # the server's ~10 Hz slow snapshot of the newest frame
            last_t = t
            srow = P.slow_row(prev)
            if srow != last_slow:
                slow.append([i, srow])
                last_slow = srow
    tmp = tmp_path_factory.mktemp("replay")
    for name in ("perf", "lap"):                                  # .mjs copies: loadable by any Node with ES modules
        shutil.copy(STATIC / f"{name}.js", tmp / f"{name}.mjs")
    (tmp / "replay.mjs").write_text(_REPLAY_JS, encoding="utf-8")
    (tmp / "in.json").write_text(
        json.dumps({"F": P.FAST_INDEX, "S": P.SLOW_INDEX, "fast": fast, "slow": slow}), encoding="utf-8")
    res = subprocess.run([node, str(tmp / "replay.mjs"), str(tmp / "in.json")],
                         capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stderr[-2000:]
    return json.loads(res.stdout)


def test_the_lap_start_does_not_fake_a_standing_start_for_the_drag_meter(long_rows, replay):
    """The lap used to begin at 65 km/h with IsRaceOn = 1: PerfMeter was armed, wiped the drag run and logged a
    1.2 s 0-100 (which also unlocked 'Hole Shot' and overwrote the personal bests)."""
    events = replay["perf"]
    # every time the car sets off from rest, in the drag run (LapNumber 0) or at a lap start (LapNumber 1)
    launches = [i for i in range(1, len(long_rows))
                if long_rows[i - 1]["Speed"] == 0.0 < long_rows[i]["Speed"] and long_rows[i]["IsRaceOn"]]
    drags = [i for i in launches if long_rows[i]["LapNumber"] == 0]
    assert len(drags) == 3 and len(launches) == 3 + 2             # 3 drag runs, 2 lap starts in 400 s
    starts = [e for e in events if e["type"] == "perf_start"]
    assert len(starts) == len(drags)                              # a run per drag launch, none at a lap start
    for e in starts:
        assert long_rows[e["i"]]["LapNumber"] == 0
    t100 = [e["value"] for e in events if e["type"] == "perf" and e["key"] == "t100"]
    t60 = [e["value"] for e in events if e["type"] == "perf" and e["key"] == "t60mph"]
    assert len(t100) == len(t60) == len(drags)
    assert all(2.4 < v < 3.6 for v in t100), t100                 # the sim's drag run, never a 1.2 s fantasy
    assert all(2.2 < v < 3.4 for v in t60) and all(a < b for a, b in zip(t60, t100)), t60
    qmile = [e["value"]["time"] for e in events if e["type"] == "perf" and e["key"] == "qmile"]
    assert len(qmile) == len(drags) and all(8 < v < 12 for v in qmile)
    assert not any(e["type"] == "perf_abort" and e["reason"] in ("gap", "creep") for e in events)
    # nothing but (cancelled) braking measurements happens while the laps are being driven
    for e in events:
        if long_rows[e["i"]]["LapNumber"] in (1, 2, 3):
            assert e["type"] == "perf_abort" and e["reason"] == "brake-cancel", e


def test_every_lap_is_reported_once_and_there_is_no_phantom_lap_zero(long_rows, replay):
    """lap.js sees the 10 Hz slow rows: laps 1, 2 and 3 of every cycle complete, and the stale LastLap of the
    previous cycle must not produce a 'lap 0' when LapNumber goes 0 -> 1."""
    laps = replay["laps"]
    assert [e["number"] for e in laps] == [1, 2, 3, 1, 2, 3]
    assert all(e["type"] == "lap" for e in laps)
    expected = []                                                 # the sim's own lap times, from the LastLap column
    for a, b in zip(long_rows, long_rows[1:]):
        if b["LapNumber"] == a["LapNumber"] + 1 and a["LapNumber"] >= 1:
            expected.append((a["LapNumber"], round(b["LastLap"] * 1000)))
    assert [(e["number"], e["timeMs"]) for e in laps] == expected
    assert [e["best"] for e in laps[:3]][0] is True               # the first lap of a session is a best lap
    assert all(35_000 < e["timeMs"] < 65_000 for e in laps)


def test_gear_codes_are_one_based_with_the_games_one_packet_neutral_at_each_shift(rows):
    """Forward gears are 1-based (1 = first); every shift sends a single neutral (11) packet, like the real game."""
    gears = [r["Gear"] for r in rows if r["IsRaceOn"]]
    forward = [g for g in gears if g != 11]
    assert min(forward) == 1 and max(forward) <= 6 and 0 not in forward
    # neutral is only ever a lone packet between two forward gears, and each lone neutral is a real change of gear
    for i, g in enumerate(gears):
        if g == 11 and 0 < i < len(gears) - 1:
            assert gears[i - 1] != 11 and gears[i + 1] != 11, i
            assert gears[i - 1] != gears[i + 1], "a neutral packet only appears at a shift"
    assert gears.count(11) >= 20


def test_the_shift_neutral_never_reaches_the_screen_in_either_front_end(rows):
    from fh6_telemetry.core.derive import GearDisplay

    d = GearDisplay()
    shown = []
    for r in rows:
        if r["IsRaceOn"]:
            shown.append(d.update(r["Gear"], r["TimestampMS"]))
    assert "N" not in shown and "11" not in shown
