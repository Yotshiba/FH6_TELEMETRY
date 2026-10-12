"""
All compile-time constants shared across the fh6_telemetry package.
"""

from __future__ import annotations

import struct

# ---------------------------------------------------------------------------
# UDP connection defaults
# ---------------------------------------------------------------------------

HOST = "127.0.0.1"
PORT = 20077

# ---------------------------------------------------------------------------
# Packet layout
# ---------------------------------------------------------------------------

PACKET_FORMAT = (
    "<iI"      # IsRaceOn (S32), TimestampMS (U32)
    "fff"      # EngineMaxRpm, EngineIdleRpm, CurrentEngineRpm
    "fff"      # AccelerationX/Y/Z
    "fff"      # VelocityX/Y/Z
    "fff"      # AngularVelocityX/Y/Z
    "fff"      # Yaw, Pitch, Roll
    "ffff"     # NormalizedSuspensionTravel FL/FR/RL/RR
    "ffff"     # TireSlipRatio FL/FR/RL/RR
    "ffff"     # WheelRotationSpeed FL/FR/RL/RR (rad/s)
    "iiii"     # WheelOnRumbleStrip FL/FR/RL/RR (S32)
    "iiii"     # WheelInPuddle FL/FR/RL/RR (S32)
    "ffff"     # SurfaceRumble FL/FR/RL/RR
    "ffff"     # TireSlipAngle FL/FR/RL/RR
    "ffff"     # TireCombinedSlip FL/FR/RL/RR
    "ffff"     # SuspensionTravelMeters FL/FR/RL/RR
    "iiiii"    # CarOrdinal, CarClass, CarPerformanceIndex, DrivetrainType, NumCylinders
    "I"        # CarGroup (U32) -- FH6 new
    "ff"       # SmashableVelDiff (m/s), SmashableMass (kg) -- FH6 new
    "fff"      # PositionX/Y/Z (meters)
    "fff"      # Speed (m/s), Power (W), Torque (Nm)
    "ffff"     # TireTemp FL/FR/RL/RR
    "fff"      # Boost (PSI above atm), Fuel (0-1), DistanceTraveled (m)
    "ffff"     # BestLap, LastLap, CurrentLap, CurrentRaceTime (SECONDS)
    "H"        # LapNumber (U16)
    "BBBBBB"   # RacePosition, Accel, Brake, Clutch, HandBrake, Gear (U8 each)
    "bbb"      # Steer, NormalizedDrivingLine, NormalizedAIBrakeDifference (S8 each)
    "x"        # 1 byte trailing alignment padding -> total 324 bytes
)

PACKET_SIZE = struct.calcsize(PACKET_FORMAT)

FIELDS = [
    "IsRaceOn", "TimestampMS",
    "EngineMaxRpm", "EngineIdleRpm", "CurrentEngineRpm",
    "AccelerationX", "AccelerationY", "AccelerationZ",
    "VelocityX", "VelocityY", "VelocityZ",
    "AngularVelocityX", "AngularVelocityY", "AngularVelocityZ",
    "Yaw", "Pitch", "Roll",
    "SuspNormFL", "SuspNormFR", "SuspNormRL", "SuspNormRR",
    "TireSlipRatioFL", "TireSlipRatioFR", "TireSlipRatioRL", "TireSlipRatioRR",
    "WheelRotSpeedFL", "WheelRotSpeedFR", "WheelRotSpeedRL", "WheelRotSpeedRR",
    "WheelOnRumbleFL", "WheelOnRumbleFR", "WheelOnRumbleRL", "WheelOnRumbleRR",
    "WheelInPuddleFL", "WheelInPuddleFR", "WheelInPuddleRL", "WheelInPuddleRR",
    "SurfaceRumbleFL", "SurfaceRumbleFR", "SurfaceRumbleRL", "SurfaceRumbleRR",
    "TireSlipAngleFL", "TireSlipAngleFR", "TireSlipAngleRL", "TireSlipAngleRR",
    "TireCombinedSlipFL", "TireCombinedSlipFR", "TireCombinedSlipRL", "TireCombinedSlipRR",
    "SuspTravelMFL", "SuspTravelMFR", "SuspTravelMRL", "SuspTravelMRR",
    "CarOrdinal", "CarClass", "CarPerformanceIndex", "DrivetrainType", "NumCylinders",
    "CarGroup",
    "SmashableVelDiff", "SmashableMass",
    "PositionX", "PositionY", "PositionZ",
    "Speed", "Power", "Torque",
    "TireTempFL", "TireTempFR", "TireTempRL", "TireTempRR",
    "Boost", "Fuel", "DistanceTraveled",
    "BestLap", "LastLap", "CurrentLap", "CurrentRaceTime",
    "LapNumber", "RacePosition",
    "Accel", "Brake", "Clutch", "HandBrake", "Gear", "Steer",
    "NormalizedDrivingLine", "NormalizedAIBrakeDifference",
]

# ---------------------------------------------------------------------------
# Lookup tables
# ---------------------------------------------------------------------------

CAR_CLASS: dict[int, str] = {
    0: "D", 1: "C", 2: "B", 3: "A", 4: "S1", 5: "S2", 6: "X", 7: "X",
}

# Forza-style class badge colours (by CAR_CLASS label)
CLASS_COLORS: dict[str, str] = {
    "D": "#3DB1E6", "C": "#F2C230", "B": "#F28C1E", "A": "#E3412F",
    "S1": "#9B4DCA", "S2": "#3D6FE0", "X": "#43B04A",
}

DRIVETRAIN: dict[int, str] = {0: "FWD", 1: "RWD", 2: "AWD"}

# The ``Gear`` field is 1-based for forward gears (1 = first gear, 2 = second ...) and 0 is reverse.
# (An earlier table treated code 1 as "N" and shifted every forward gear down by one.)
# Code 11 is *neutral*: the game reports it for a single packet at every shift (see tests/data/real_sample.fh6rec:
# 5, 11, 6), and steadily while parked in neutral. It is deliberately not in GEAR_MAP so that it never replaces a
# real gear on screen for one frame; ``core.derive.GearDisplay`` shows "N" only once it has lasted a while.
GEAR_MAP: dict[int, str] = {
    0: "R", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5",
    6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
}
NEUTRAL_GEAR_CODE = 11
NEUTRAL_HOLD_MS = 250       # neutral must last this long (game clock) before it is displayed as "N"

CAR_GROUP_MAP: dict[int, str] = {
    0: "Cars", 1: "Trucks", 2: "Buggies", 3: "Drift",
    4: "Rally", 5: "Track Day", 6: "Formula",
}

# ---------------------------------------------------------------------------
# Rolling-chart / tyre constants
# ---------------------------------------------------------------------------

HISTORY_LEN = 300

WHEELS: tuple[str, ...] = ("FL", "FR", "RL", "RR")

WHEEL_COLORS: dict[str, str] = {
    "FL": "#FF4444",
    "FR": "#44CCFF",
    "RL": "#FF9900",
    "RR": "#44DD44",
}

# (threshold_°C, hex_colour) — first match wins
_TEMP_COLORS: list[tuple[float, str]] = [
    (50.0,  "#1a6fb5"),
    (70.0,  "#00AACC"),
    (90.0,  "#22BB44"),
    (110.0, "#FF9900"),
    (999.0, "#DD2200"),
]

# (field_prefix, display_label, max_val, danger_val)
_BAR_CONFIGS: list[tuple[str, str, float, float]] = [
    ("TireSlipRatio",    "Slip Ratio",  2.0, 0.5),
    ("TireSlipAngle",    "Slip Angle",  2.0, 0.5),
    ("TireCombinedSlip", "Comb. Slip",  3.0, 1.0),
    ("SuspNorm",         "Susp (norm)", 1.0, 0.9),
]
