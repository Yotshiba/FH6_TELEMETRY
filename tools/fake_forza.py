"""
fake_forza — send synthetic Forza "Data Out" UDP packets (324 bytes) so the
dashboard, the benchmark and the tests can run without the game.

Usage examples
--------------
    python tools/fake_forza.py                         # fluct scenario, 60 Hz, 127.0.0.1:20077
    python tools/fake_forza.py --scenario pause --duration 30
    python tools/fake_forza.py --port 20999 --hz 60 --seed 1
    python tools/fake_forza.py --replay session.fh6rec --loop

Scenarios
---------
steady     constant, mid-range values (best case for the UI)
fluct      RPM saw-tooth with gear shifts, power/torque steps, drifting tyre
           temperatures with jumps, noise and spikes (worst case for charts)
pause      like ``fluct`` but alternating 6 s racing / 3 s paused (IsRaceOn=0,
           all-zero payload) — what the game may send in menus
nan        like ``fluct`` with occasional NaN / inf in float fields
carchange  like ``fluct`` but the car (max RPM, class, PI …) changes every 10 s
short      like ``fluct`` but every ~20th datagram is truncated (232 / 311 bytes)
showcase   a coherent, endless session for demoing the web UI: a drag-strip run
           (0-100 / 0-200 / quarter mile / 60-0 braking), then laps of a closed
           circuit with car-space velocity, drift corners, a jump (airtime +
           hard landing), load transfer in the suspension and heating tyres

Packets are built straight from ``fh6_telemetry.constants`` so they stay in
sync with the parser.  Types are respected (B = 0-255, b = -128..127, …).
"""

from __future__ import annotations

import argparse
import math
import random
import re
import socket
import struct
import sys
import time
from pathlib import Path

# Allow ``python tools/fake_forza.py`` from the repo root without installing.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fh6_telemetry.constants import FIELDS, PACKET_FORMAT, PACKET_SIZE  # noqa: E402

SCENARIOS = ("steady", "fluct", "pause", "nan", "carchange", "short", "showcase")

REC_MAGIC = b"FH6REC1\n"
_REC_HDR = struct.Struct("<Id")  # payload length, monotonic seconds

# ---------------------------------------------------------------------------
# Packet construction
# ---------------------------------------------------------------------------


def _type_codes() -> list[str]:
    """One struct type code per field, derived from PACKET_FORMAT."""
    codes: list[str] = []
    for m in re.finditer(r"(\d*)([a-zA-Z?])", PACKET_FORMAT.lstrip("<>=!@")):
        count = int(m.group(1) or 1)
        code = m.group(2)
        if code == "x":
            continue
        codes.extend(code * count)
    if len(codes) != len(FIELDS):  # pragma: no cover - guards constants edits
        raise RuntimeError(
            f"FIELDS ({len(FIELDS)}) and PACKET_FORMAT ({len(codes)}) disagree"
        )
    return codes


_CODES = _type_codes()
_INT_RANGE = {
    "i": (-(2**31), 2**31 - 1),
    "I": (0, 2**32 - 1),
    "H": (0, 65535),
    "B": (0, 255),
    "b": (-128, 127),
}
_STRUCT = struct.Struct(PACKET_FORMAT)


def build_packet(values: dict[str, float]) -> bytes:
    """Pack a field→value dict into a 324-byte datagram.

    Missing fields default to 0; integers are clamped to their wire range and
    floats are passed through unchanged (NaN / inf are legal ``f`` values).
    """
    out: list[float | int] = []
    for name, code in zip(FIELDS, _CODES):
        v = values.get(name, 0)
        if code in _INT_RANGE:
            lo, hi = _INT_RANGE[code]
            if isinstance(v, float) and not math.isfinite(v):
                v = 0
            out.append(max(lo, min(hi, int(v))))
        else:
            out.append(float(v))
    data = _STRUCT.pack(*out)
    assert len(data) == PACKET_SIZE
    return data


# ---------------------------------------------------------------------------
# Scenario simulation
# ---------------------------------------------------------------------------

_GEAR_RATIOS = (3.6, 2.4, 1.75, 1.35, 1.05, 0.85)  # gears 1..6

NEUTRAL_CODE = 11   # what the real game sends for one packet at every shift (and while parked in neutral)


class _GearCodes:
    """Mixin: turns a gear number into the Gear field, with the real game's one-packet neutral at each shift."""

    _prev_gear: int | None = None

    def _gear_code(self, gear: int) -> int:
        prev, self._prev_gear = self._prev_gear, gear
        return NEUTRAL_CODE if prev is not None and gear != prev else gear

_WHEELS = ("FL", "FR", "RL", "RR")


class Simulator(_GearCodes):
    """Deterministic (seeded) telemetry generator."""

    def __init__(self, scenario: str, seed: int = 1) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}")
        self.scenario = scenario
        self.rng = random.Random(seed)
        self._show = ShowcaseCar(seed) if scenario == "showcase" else None
        self.tire_f = [170.0, 172.0, 168.0, 171.0]
        self.car = {"ordinal": 1234, "max_rpm": 8500.0, "klass": 3, "pi": 712,
                    "drive": 2, "cyl": 6, "group": 0}
        self._last_car_slot = -1
        self._n = 0

    # -- helpers -----------------------------------------------------------
    def _noise(self, amp: float) -> float:
        return self.rng.uniform(-amp, amp)

    def _maybe_spike(self, amp: float, prob: float = 0.01) -> float:
        return self.rng.uniform(-amp, amp) if self.rng.random() < prob else 0.0

    def values(self, t: float) -> dict[str, float]:
        """Field values at simulated time *t* (seconds)."""
        self._n += 1
        sc = self.scenario
        if self._show is not None:
            return self._show.values(t)

        # Pause scenario: 6 s racing, 3 s paused
        if sc == "pause" and (t % 9.0) >= 6.0:
            return {"IsRaceOn": 0, "TimestampMS": int(t * 1000) & 0xFFFFFFFF}

        if sc == "carchange":
            slot = int(t // 10)
            if slot != self._last_car_slot:
                self._last_car_slot = slot
                r = random.Random(slot)
                self.car = {
                    "ordinal": 1000 + slot,
                    "max_rpm": r.choice([6500.0, 7500.0, 8500.0, 9500.0]),
                    "klass": r.randint(0, 6), "pi": r.randint(100, 998),
                    "drive": r.randint(0, 2), "cyl": r.choice([4, 6, 8]),
                    "group": r.randint(0, 6),
                }

        max_rpm = self.car["max_rpm"]
        idle = 900.0
        steady = sc == "steady"

        # Driving cycle: 24 s period — accelerate through 6 gears, then brake.
        cycle = 24.0
        ph = (t % cycle) / cycle
        if steady:
            gear, rpm, speed, throttle, brake = 3, 4500.0, 28.0, 0.55, 0.0
        elif ph < 0.75:
            seg = ph / 0.75 * len(_GEAR_RATIOS)
            gi = min(int(seg), len(_GEAR_RATIOS) - 1)
            frac = seg - gi
            gear = gi + 1  # FH gear code: 1-based (1 = first gear, 0 = reverse)
            rpm = idle + (max_rpm - idle) * (0.45 + 0.55 * frac)
            speed = rpm * 0.0075 / max(_GEAR_RATIOS[gi], 0.5)   # m/s: ~18 in 1st .. ~75 in 6th
            throttle = 0.9 + 0.1 * math.sin(t * 3)
            brake = 0.0
        else:
            k = (ph - 0.75) / 0.25
            gear = 3
            rpm = max(idle, 5200.0 * (1 - k) + idle)
            speed = max(2.0, 45.0 * (1 - k))
            throttle = 0.0
            brake = 0.85 * math.sin(math.pi * min(1.0, k * 1.2))
        if not steady:
            rpm += self._noise(60.0) + self._maybe_spike(900.0, 0.004)
            throttle = max(0.0, min(1.0, throttle + self._noise(0.03)))

        torque = 0.0 if steady else (320.0 + 120.0 * math.sin(rpm / 1200.0)
                                     + self._noise(8.0))
        if steady:
            torque = 360.0
        omega = rpm * 2 * math.pi / 60.0
        power = max(0.0, torque * omega * throttle)  # watts
        boost = max(-6.0, 18.0 * throttle * (rpm / max_rpm)) if not steady else 9.0

        # Tyres: slow drift + occasional jumps (curbs / braking)
        for i in range(4):
            drift = 0.02 * (brake * 40 + throttle * 12 - 14)
            jump = self._maybe_spike(9.0, 0.01) if not steady else 0.0
            self.tire_f[i] = max(100.0, min(300.0,
                                            self.tire_f[i] + drift + jump
                                            + self._noise(0.15)))

        lap_len = 60.0
        lap_t = t % lap_len
        lap_no = int(t // lap_len)

        v: dict[str, float] = {
            "IsRaceOn": 1,
            "TimestampMS": int(t * 1000) & 0xFFFFFFFF,
            "EngineMaxRpm": max_rpm,
            "EngineIdleRpm": idle,
            "CurrentEngineRpm": rpm,
            "AccelerationX": 9.8 * 0.8 * math.sin(t * 0.7) + self._noise(0.5),
            "AccelerationY": self._noise(0.4),
            "AccelerationZ": 9.8 * (throttle - brake),
            "VelocityX": speed * math.sin(t * 0.2),
            "VelocityY": self._noise(0.05),
            "VelocityZ": speed * math.cos(t * 0.2),
            "AngularVelocityX": self._noise(0.05),
            "AngularVelocityY": 0.4 * math.sin(t * 0.7),
            "AngularVelocityZ": self._noise(0.05),
            "Yaw": (t * 0.2) % (2 * math.pi) - math.pi,
            "Pitch": 0.03 * math.sin(t),
            "Roll": 0.05 * math.sin(t * 0.7),
            "CarOrdinal": self.car["ordinal"],
            "CarClass": self.car["klass"],
            "CarPerformanceIndex": self.car["pi"],
            "DrivetrainType": self.car["drive"],
            "NumCylinders": self.car["cyl"],
            "CarGroup": self.car["group"],
            "SmashableVelDiff": abs(self._noise(2.0)),
            "SmashableMass": 150.0 if int(t) % 17 == 0 else 0.0,
            "PositionX": 1500.0 * math.sin(t * 0.05),
            "PositionY": 40.0 + 5.0 * math.sin(t * 0.1),
            "PositionZ": 1500.0 * math.cos(t * 0.05),
            "Speed": speed,
            "Power": power,
            "Torque": torque,
            "Boost": boost,
            "Fuel": max(0.0, 1.0 - t * 2e-4),
            "DistanceTraveled": t * 35.0,
            "BestLap": 58.123 if lap_no else 0.0,
            "LastLap": 59.456 if lap_no else 0.0,
            "CurrentLap": lap_t,
            "CurrentRaceTime": t,
            "LapNumber": lap_no,
            "RacePosition": 1 + (int(t) // 20) % 12,
            "Accel": throttle * 255,
            "Brake": brake * 255,
            "Clutch": 0,
            "HandBrake": 255 if (not steady and int(t) % 40 == 39) else 0,
            "Gear": self._gear_code(gear),
            "Steer": 127 * math.sin(t * 0.7) * (0.2 if steady else 1.0),
            "NormalizedDrivingLine": 40 * math.sin(t * 0.5),
            "NormalizedAIBrakeDifference": 20 * math.sin(t * 0.3),
        }
        for i, w in enumerate(_WHEELS):
            v[f"SuspNorm{w}"] = max(0.0, min(1.0, 0.5 + 0.3 * math.sin(t * 2.1 + i)
                                             + (0 if steady else self._noise(0.04))))
            v[f"TireSlipRatio{w}"] = 0.3 * math.sin(t * 1.3 + i) * (0.3 if steady else 1)
            v[f"WheelRotSpeed{w}"] = speed / 0.33
            v[f"WheelOnRumble{w}"] = 1 if (not steady and int(t * 2) % 23 == i) else 0
            v[f"WheelInPuddle{w}"] = 1 if (not steady and int(t) % 31 == i) else 0
            v[f"SurfaceRumble{w}"] = abs(self._noise(0.3))
            v[f"TireSlipAngle{w}"] = 0.5 * math.sin(t * 0.9 + i)
            v[f"TireCombinedSlip{w}"] = abs(0.8 * math.sin(t * 1.1 + i))
            v[f"SuspTravelM{w}"] = 0.05 + 0.04 * math.sin(t * 2.1 + i)
            v[f"TireTemp{w}"] = self.tire_f[i]

        if sc == "nan" and self._n % 97 == 0:
            for key in self.rng.sample(
                ["CurrentEngineRpm", "Speed", "Power", "TireTempFL", "SuspNormFR",
                 "Torque", "TireSlipRatioRL"], 2):
                v[key] = self.rng.choice([float("nan"), float("inf"), float("-inf")])
        return v

    def datagram(self, t: float) -> bytes:
        data = build_packet(self.values(t))
        if self.scenario == "short" and self._n % 20 == 0:
            return data[: self.rng.choice([232, 311])]
        return data


# ---------------------------------------------------------------------------
# Showcase: a coherent, endless session
# ---------------------------------------------------------------------------

_G = 9.80665
_RATIOS = (3.6, 2.4, 1.75, 1.35, 1.05, 0.85)     # speed = rpm * 0.0075 / ratio
_K_SPEED = 0.0075


class _Track:
    """A closed circuit: centreline sampled every ~2 m with heading and curvature."""

    # control points (x, z) in metres, +Z = north; Catmull-Rom closed loop
    POINTS = [(0, 0), (0, 260), (50, 420), (170, 500), (330, 500), (420, 430),
              (430, 300), (350, 230), (250, 250), (200, 170), (270, 60),
              (200, -70), (70, -120), (-60, -70)]

    def __init__(self, origin=(-900.0, 3700.0)) -> None:
        ox, oz = origin
        pts = [(x + ox, z + oz) for x, z in self.POINTS]
        dense: list[tuple[float, float]] = []
        n = len(pts)
        for i in range(n):
            p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
            for k in range(40):
                u = k / 40.0
                u2, u3 = u * u, u * u * u
                dense.append(tuple(
                    0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * u
                           + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2
                           + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3)
                    for c in (0, 1)))
        nd = len(dense)
        seg = [math.hypot(dense[(i + 1) % nd][0] - dense[i][0],
                          dense[(i + 1) % nd][1] - dense[i][1]) for i in range(nd)]
        total = sum(seg)
        self.ds = 2.0
        m = int(total / self.ds)
        self.n = m
        self.length = m * self.ds
        xs, zs = [], []
        acc, j = 0.0, 0
        for i in range(m):
            target = i * total / m
            while acc + seg[j] < target:
                acc += seg[j]
                j = (j + 1) % nd
            f = (target - acc) / seg[j] if seg[j] else 0.0
            a, b = dense[j], dense[(j + 1) % nd]
            xs.append(a[0] + (b[0] - a[0]) * f)
            zs.append(a[1] + (b[1] - a[1]) * f)
        self.xs, self.zs = xs, zs
        # heading (0 = +Z, increases toward +X), unwrapped, and smoothed curvature
        th = [math.atan2(xs[(i + 1) % m] - xs[i], zs[(i + 1) % m] - zs[i]) for i in range(m)]
        for i in range(1, m):
            while th[i] - th[i - 1] > math.pi:
                th[i] -= 2 * math.pi
            while th[i] - th[i - 1] < -math.pi:
                th[i] += 2 * math.pi
        self.th = th
        # the unwrapped heading turns by exactly one full revolution over the loop
        turn = 2 * math.pi * round((th[-1] - th[0]) / (2 * math.pi))
        raw = []
        for i in range(m):
            nxt = th[i + 1] if i + 1 < m else th[0] + turn
            prv = th[i - 1] if i > 0 else th[m - 1] - turn
            raw.append((nxt - prv) / (2 * self.ds))
        w = 6
        self.kappa = [sum(raw[(i + k) % m] for k in range(-w, w + 1)) / (2 * w + 1) for i in range(m)]
        # speed profile: lateral-grip limit, then braking / acceleration limits
        vmax, alat, abrake, aacc = 72.0, 13.5, 12.0, 8.0
        prof = [min(vmax, math.sqrt(alat / max(abs(k), 1e-4))) for k in self.kappa]
        for _ in range(2):
            for i in range(m - 1, -1, -1):
                prof[i] = min(prof[i], math.sqrt(prof[(i + 1) % m] ** 2 + 2 * abrake * self.ds))
            for i in range(m):
                prof[(i + 1) % m] = min(prof[(i + 1) % m], math.sqrt(prof[i] ** 2 + 2 * aacc * self.ds))
        self.profile = prof

    def lerp(self, arr, s, angular=False):
        i = int(s / self.ds) % self.n
        f = (s / self.ds) - int(s / self.ds)
        a, b = arr[i], arr[(i + 1) % self.n]
        if angular and (i + 1) % self.n == 0:
            b += 2 * math.pi * round((a - b) / (2 * math.pi))
        return a + (b - a) * f


class ShowcaseCar(_GearCodes):
    """Deterministic demo session: drag run -> braking test -> N laps -> repeat.

    Scene changes (new phase, teleport between the strip and the circuit) start with ``PAUSE_S`` of
    ``IsRaceOn = 0``, like the game's menus; while ``IsRaceOn`` is 1 the speed is always continuous
    (the car launches from rest at the start of the drag run and of the laps).
    """

    LAPS = 3
    IDLE_S = 3.0
    PAUSE_S = 0.4                # IsRaceOn = 0 at the start of idle / idle2 / lap
    FINISH_S = 0.5               # LapNumber shows LAPS + 1 this long after the chequered flag
    REFUEL_BELOW = 0.3           # pit stop (after the laps) once the tank is below this
    HEAT_MAX = 2.0               # soft cap of the instantaneous tyre load (drift corners would run away)
    SLIP_HEAT = 2.0              # tyre load per radian of slip angle

    def __init__(self, seed: int = 1) -> None:
        self.rng = random.Random(seed)
        self.track = _Track()
        self.last_t = None
        self.phase = "idle"
        self.phase_t = 0.0
        self.v = 0.0
        self.s = 0.0
        self.dist = 0.0              # drag-strip distance
        self.odometer = 0.0          # DistanceTraveled: only ever increases
        self._fuel_odo = 0.0         # odometer at the last refuel (fuel is burnt from here)
        self.gi = 0
        self._launch_rpm = 0.0       # revs held by the slipping clutch while launching in first gear
        self.shift_cut = 0.0
        self.lap = 0
        self.lap_t = 0.0
        self.best_lap = 0.0
        self.last_lap = 0.0
        self.laps_done = 0
        self.delta = 0.0             # smoothed oversteer angle (rad)
        self.air_start = None
        self.landed_at = -9.0
        self.jump_s = 0.62 * self.track.length
        self._prev_s = 0.0
        self.tire_f = [130.0] * 4
        self.steer_f = 0.0
        self.yaw = 0.0
        self.race_time = 0.0

    # -- helpers -------------------------------------------------------------
    def _gear_rpm(self, v: float, throttle: float, braking: bool):
        if v < 1.0:
            self.gi = 0
            self._launch_rpm = 900.0 + 5200.0 * throttle     # revs set by the throttle, clutch slipping
            return 0, self._launch_rpm
        gi = self.gi
        rpm = v * _RATIOS[gi] / _K_SPEED
        while rpm > 8300 and gi < len(_RATIOS) - 1:
            gi += 1
            self.shift_cut = 0.14
            rpm = v * _RATIOS[gi] / _K_SPEED
        while rpm < 3600 and gi > 0 and (braking or rpm < 2800):
            gi -= 1
            rpm = v * _RATIOS[gi] / _K_SPEED
        self.gi = gi
        # A launch holds its revs in first gear until the road speed catches up (no cliff to idle revs
        # at 1 m/s); the hold ends at the first moment the natural revs overtake it or the throttle lifts.
        if self._launch_rpm and gi == 0 and throttle > 0 and not braking:
            if rpm < self._launch_rpm:
                rpm = self._launch_rpm
            else:
                self._launch_rpm = 0.0
        else:
            self._launch_rpm = 0.0
        return gi, min(8500.0, max(900.0, rpm))

    def values(self, t: float) -> dict:
        dt = 0.0 if self.last_t is None else min(0.1, max(0.0, t - self.last_t))
        self.last_t = t
        self.race_time += dt
        self.phase_t += dt
        tr = self.track
        throttle = brake = 0.0
        steer = 0.0
        lat_g = long_g = 0.0
        vx = vy = 0.0
        pitch = 0.0
        slip_ratio = 0.0
        air = False
        rumble = 0

        if self.phase in ("idle", "idle2"):
            self.v = 0.0
            if self.lap and self.phase_t > self.FINISH_S:      # the chequered flag is over
                self.lap = 0
            if self.phase_t > self.IDLE_S:
                nxt = "drag" if self.phase == "idle" else "lap"
                self.phase, self.phase_t = nxt, 0.0
                if nxt == "lap":                              # teleport to the circuit's grid
                    self.s, self.v, self.laps_done, self.lap, self.lap_t = 0.0, 0.0, 0, 1, 0.0
                    self._prev_s = 0.0
                    self.gi = 0
                    self.delta = 0.0
                    # a new session: no lap times from the previous one (a stale LastLap on the
                    # LapNumber 0 -> 1 edge would read as a finished "lap 0")
                    self.last_lap = self.best_lap = 0.0
                else:
                    self.dist = 0.0
        elif self.phase == "drag":
            throttle = 1.0
            a = 11.5 * (1.0 - (self.v / 83.0) ** 1.6)
            if self.shift_cut > 0:
                a *= 0.2
                self.shift_cut -= dt
            slip_ratio = 0.35 * math.exp(-self.phase_t / 1.2)
            a *= 1.0 - 0.3 * slip_ratio
            self.v = min(83.0, self.v + a * dt)
            self.dist += self.v * dt
            long_g = a / _G
            if self.phase_t > 19.0:
                self.phase, self.phase_t = "brake", 0.0
        elif self.phase == "brake":
            brake = 1.0
            a = -11.5
            self.v = max(0.0, self.v + a * dt)
            self.dist += self.v * dt
            long_g = a / _G
            if self.v <= 0.0 and self.phase_t > 0.5:
                self.phase, self.phase_t = "idle2", 0.0
        else:  # lap
            # on the grid with the revs up until the (IsRaceOn = 0) scene change is over, then a
            # standing start: the speed is continuous from 0 and the drag meter never re-arms
            holding = self.phase_t < self.PAUSE_S
            # look a little ahead so braking starts on time (the profile already
            # respects the braking limit, a lagging controller would overshoot corners)
            target = min(tr.lerp(tr.profile, self.s),
                         tr.lerp(tr.profile, self.s + self.v * 0.25),
                         tr.lerp(tr.profile, self.s + self.v * 0.5))
            a = max(-14.0, min(8.0, (target - self.v) / 0.1))
            if holding:
                a, self.v = 0.0, 0.0
            else:
                self.v = max(8.0 if self.v >= 8.0 else 0.0, self.v + a * dt)   # no floor while launching
            if self.shift_cut > 0:
                self.shift_cut -= dt
            self.s += self.v * dt
            if self.s >= tr.length:
                self.s -= tr.length
                self._prev_s = self.s - self.v * dt
                self.laps_done += 1
                self.last_lap = self.lap_t
                if self.best_lap == 0.0 or self.lap_t < self.best_lap:
                    self.best_lap = self.lap_t
                self.lap += 1
                self.lap_t = 0.0
                if self.laps_done >= self.LAPS:
                    # Chequered flag: back to the strip. The counter stays at LAPS + 1 (with LastLap
                    # = the final lap) for FINISH_S, long enough for a 10 Hz client to see the last
                    # lap complete, then drops to 0 in the idle branch.
                    self.phase, self.phase_t = "idle", 0.0
                    self.v, self.dist = 0.0, 0.0
                    if 1.0 - (self.odometer - self._fuel_odo) * 2.5e-5 < self.REFUEL_BELOW:
                        self._fuel_odo = self.odometer                    # pit stop in the paused scene
            if not holding:
                self.lap_t += dt
            kappa = tr.lerp(tr.kappa, self.s)
            throttle = 1.0 if (a > 0.5 or holding) else (0.25 if a > -1.5 else 0.0)
            brake = min(1.0, max(0.0, -a / 12.0)) if a < -1.5 else 0.0
            lat_g = self.v * self.v * kappa / _G
            long_g = a / _G
            steer = max(-1.0, min(1.0, kappa / 0.025))
            # drift zones: oversteer through the tight corners
            want = math.copysign(min(0.55, max(0.0, (abs(kappa) - 0.010) * 45.0)), kappa)
            self.delta += (want - self.delta) * min(1.0, dt / 0.25)
            if self.phase != "lap":
                self.delta = 0.0                                  # chequered flag: no slide at a standstill
            vx = -self.v * math.sin(self.delta)
            # the jump
            if self.air_start is None and self._prev_s < self.jump_s <= self.s:
                self.air_start = t
            if self.air_start is not None:
                tau = t - self.air_start
                if tau <= 1.1:
                    air = True
                    vy = 5.4 * (1.0 - 2.0 * tau / 1.1)
                    pitch = 0.12 * (1.0 - 2.0 * tau / 1.1)
                else:
                    self.air_start, self.landed_at = None, t
            self._prev_s = self.s
            if int(self.s / 60) % 5 == 2:                     # curbs
                rumble = 1
        self.odometer += self.v * dt

        gear_i, rpm = self._gear_rpm(self.v, throttle, brake > 0.1)
        v = self.v
        # --- pose ---------------------------------------------------------------
        if self.phase == "lap":
            px = tr.lerp(tr.xs, self.s)
            pz = tr.lerp(tr.zs, self.s)
            heading = tr.lerp(tr.th, self.s, angular=True)
            yaw_rate = tr.lerp(tr.kappa, self.s) * v
            self.yaw = heading + self.delta
        else:
            px, pz = -1500.0, 3000.0 + self.dist              # a straight, heading north
            yaw_rate = 0.0
            self.yaw = 0.0
        yaw = (self.yaw + math.pi) % (2 * math.pi) - math.pi
        pos_y = 40.0
        if self.air_start is not None:
            tau = t - self.air_start
            pos_y += 5.4 * tau - 4.9 * tau * tau
        # --- suspension: base 0.45, load transfer, jump -----------------------------------
        since_land = t - self.landed_at
        slam = max(0.0, 1.0 - since_land / 0.45) if 0 <= since_land < 0.45 else 0.0
        susp = {}
        for w, (side, front) in {"FL": (-1, 1), "FR": (1, 1), "RL": (-1, -1), "RR": (1, -1)}.items():
            base = 0.45 + 0.20 * (-side) * lat_g + 0.06 * long_g * front
            base += 0.015 * math.sin(t * 9 + side + front)
            if air:
                base = self.rng.uniform(0, 0.012)
            base += 0.55 * slam
            susp[w] = max(0.0, min(1.0, base))
        # --- tyres ------------------------------------------------------------------
        drift = abs(self.delta)
        slip_angle = {w: 0.08 * lat_g * (1.0 if w[0] == "F" else 0.9)
                      + drift * (1.6 if w[0] == "R" else 0.5) for w in _WHEELS}
        for i, w in enumerate(_WHEELS):
            heat = abs(lat_g) * 0.9 + abs(slip_angle[w]) * self.SLIP_HEAT + slip_ratio * 5 + brake * 0.8
            heat = self.HEAT_MAX * math.tanh(heat / self.HEAT_MAX)      # soft cap: big slides don't run away
            # settles near 125 °F + 90 °F per unit of average load: ~55 °C cold, ~105 °C (front) to ~110 °C
            # (rear, which slides more) after a few laps; the red band (>110 °C) is only brushed
            self.tire_f[i] += (heat * 1.8 - (self.tire_f[i] - 125.0) * 0.02) * dt
        torque = 0.0 if (v < 1 and throttle == 0) else (
            380.0 * (0.55 + 0.45 * math.sin(math.pi * min(1.0, rpm / 9000.0)))
        ) * (1.0 if throttle > 0 else -0.15)
        power = max(0.0, torque * rpm * 2 * math.pi / 60.0)
        self.steer_f += (steer - self.steer_f) * min(1.0, dt / 0.08)

        out: dict = {
            "IsRaceOn": 0 if (self.phase in ("idle", "idle2", "lap") and self.phase_t < self.PAUSE_S) else 1,
            # Like the real game: the stamp follows a ~15.6 ms clock tick while rows arrive every
            # ~13 ms, so equal consecutive timestamps are common.
            "TimestampMS": int(math.floor(t * 1000 / 15.625) * 15.625) & 0xFFFFFFFF,
            "EngineMaxRpm": 8500.0, "EngineIdleRpm": 900.0, "CurrentEngineRpm": rpm,
            "AccelerationX": lat_g * _G + self.rng.uniform(-0.15, 0.15),
            "AccelerationY": (-_G if air else 0.0) + 28.0 * slam + self.rng.uniform(-0.2, 0.2),
            "AccelerationZ": long_g * _G + self.rng.uniform(-0.15, 0.15),
            "VelocityX": vx, "VelocityY": vy, "VelocityZ": math.sqrt(max(0.0, v * v - vx * vx)),
            "AngularVelocityX": 0.0, "AngularVelocityY": yaw_rate, "AngularVelocityZ": 0.0,
            "Yaw": yaw, "Pitch": pitch - 0.01 * long_g, "Roll": 0.02 * lat_g,
            "CarOrdinal": 3141, "CarClass": 4, "CarPerformanceIndex": 811, "DrivetrainType": 2,
            "NumCylinders": 6, "CarGroup": 0,
            "SmashableVelDiff": 0.0, "SmashableMass": 0.0,
            "PositionX": px, "PositionY": pos_y, "PositionZ": pz,
            "Speed": v, "Power": power, "Torque": torque,
            "Boost": 18.0 * throttle * min(1.0, rpm / 6500.0) - (2.0 if throttle == 0 else 0.0),
            "Fuel": max(0.0, 1.0 - (self.odometer - self._fuel_odo) * 2.5e-5),
            "DistanceTraveled": self.odometer,
            "BestLap": self.best_lap, "LastLap": self.last_lap,
            "CurrentLap": self.lap_t if self.phase == "lap" else 0.0,
            "CurrentRaceTime": self.race_time,
            "LapNumber": self.lap, "RacePosition": 3,
            "Accel": throttle * 255, "Brake": brake * 255, "Clutch": 0, "HandBrake": 0,
            "Gear": self._gear_code(gear_i + 1 if v >= 1.0 else 1),
            "Steer": 127 * self.steer_f,
            "NormalizedDrivingLine": 0, "NormalizedAIBrakeDifference": 0,
        }
        for i, w in enumerate(_WHEELS):
            out[f"SuspNorm{w}"] = susp[w]
            out[f"TireSlipRatio{w}"] = slip_ratio + (0.05 * brake if w[0] == "F" else 0.0)
            out[f"WheelRotSpeed{w}"] = v / 0.33 * (1.0 + slip_ratio)
            out[f"WheelOnRumble{w}"] = rumble if w in ("FR", "RR") else 0
            out[f"WheelInPuddle{w}"] = 0
            out[f"SurfaceRumble{w}"] = 0.4 * rumble
            out[f"TireSlipAngle{w}"] = slip_angle[w]
            out[f"TireCombinedSlip{w}"] = math.hypot(slip_angle[w], slip_ratio) * 1.4
            out[f"SuspTravelM{w}"] = (susp[w] - 0.45) * 0.1
            out[f"TireTemp{w}"] = self.tire_f[i]
        return out


# ---------------------------------------------------------------------------
# Recording replay
# ---------------------------------------------------------------------------


def read_recording(path: Path):
    """Yield (relative_seconds, payload) from a ``record_udp.py`` file."""
    with open(path, "rb") as fh:
        if fh.read(len(REC_MAGIC)) != REC_MAGIC:
            raise SystemExit(f"{path}: not an FH6 recording")
        t0 = None
        while True:
            hdr = fh.read(_REC_HDR.size)
            if len(hdr) < _REC_HDR.size:
                return
            length, ts = _REC_HDR.unpack(hdr)
            payload = fh.read(length)
            if len(payload) < length:
                return
            if t0 is None:
                t0 = ts
            yield ts - t0, payload


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run(args: argparse.Namespace) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dest = (args.host, args.port)
    sent = 0
    start = time.perf_counter()
    try:
        if args.replay:
            records = list(read_recording(Path(args.replay)))
            if not records:
                raise SystemExit("recording is empty")
            span = records[-1][0] + 1.0 / args.hz
            round_no = 0
            while True:
                base = start + round_no * span
                for rel, payload in records:
                    delay = base + rel - time.perf_counter()
                    if delay > 0:
                        time.sleep(delay)
                    sock.sendto(payload, dest)
                    sent += 1
                    if args.duration and time.perf_counter() - start >= args.duration:
                        raise KeyboardInterrupt
                round_no += 1
                if not args.loop:
                    break
        else:
            sim = Simulator(args.scenario, args.seed)
            period = 1.0 / args.hz
            n = 0
            while True:
                target = start + n * period
                delay = target - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                sock.sendto(sim.datagram(n * period), dest)
                sent += 1
                n += 1
                if args.duration and (n * period) >= args.duration:
                    break
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
    elapsed = max(time.perf_counter() - start, 1e-9)
    print(f"fake_forza: sent {sent} datagrams in {elapsed:.1f}s "
          f"({sent / elapsed:.1f}/s) to {args.host}:{args.port}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=20077)
    ap.add_argument("--hz", type=float, default=60.0)
    ap.add_argument("--scenario", choices=SCENARIOS, default="fluct")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--duration", type=float, default=0.0,
                    help="seconds to run (0 = until Ctrl+C)")
    ap.add_argument("--replay", help="replay a record_udp.py recording")
    ap.add_argument("--loop", action="store_true", help="loop the recording")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
