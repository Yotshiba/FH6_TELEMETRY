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

DRIVETRAIN: dict[int, str] = {0: "FWD", 1: "RWD", 2: "AWD"}

GEAR_MAP: dict[int, str] = {
    0: "R", 1: "N", 2: "1", 3: "2", 4: "3", 5: "4",
    6: "5", 7: "6", 8: "7", 9: "8", 10: "9",
}

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
