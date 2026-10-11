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

SCENARIOS = ("steady", "fluct", "pause", "nan", "carchange", "short")

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
_WHEELS = ("FL", "FR", "RL", "RR")


class Simulator:
    """Deterministic (seeded) telemetry generator."""

    def __init__(self, scenario: str, seed: int = 1) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}")
        self.scenario = scenario
        self.rng = random.Random(seed)
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
            gear = gi + 2  # FH gear code: 2 -> "1"
            rpm = idle + (max_rpm - idle) * (0.45 + 0.55 * frac)
            speed = rpm / max(_GEAR_RATIOS[gi], 0.5) / 60.0 * 1.9
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
            "Gear": gear,
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
