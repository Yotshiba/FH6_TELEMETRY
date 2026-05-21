"""
Forza Horizon 6 - UDP Telemetry Receiver
Data Out: 127.0.0.1:50099
Packet format: Forza Horizon 6 Car Dash (324 bytes)

Changes from FH5:
  - WheelOnRumbleStrip and WheelInPuddle changed from F32 to S32
  - New fields after NumCylinders: CarGroup (U32), SmashableVelDiff (F32), SmashableMass (F32)
  - LapNumber is U16
  - Lap/race times are in SECONDS (not milliseconds)
  - Packet size: 324 bytes (1 byte trailing alignment padding)
"""

import socket
import struct
import dotenv
import os

dotenv.load_dotenv()

HOST = os.getenv("HOST")
PORT = int(os.getenv("PORT"))   

# FH6 packet format — 324 bytes total (little-endian)
# x = 1 byte trailing padding so struct size aligns to 4 bytes (323 data -> 324 with pad)
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
    "iiii"     # WheelOnRumbleStrip FL/FR/RL/RR (S32, 0 or 1) -- was F32 in FH5
    "iiii"     # WheelInPuddle FL/FR/RL/RR (S32, 0 or 1)      -- was F32 in FH5
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
PACKET_SIZE = struct.calcsize(PACKET_FORMAT)  # 324

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

CAR_CLASS = {0: "D", 1: "C", 2: "B", 3: "A", 4: "S1", 5: "S2", 6: "X", 7: "X"}
DRIVETRAIN = {0: "FWD", 1: "RWD", 2: "AWD"}
GEAR_MAP = {0: "R", 1: "N", 2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9"}


def parse_packet(data: bytes) -> dict:
    if len(data) < PACKET_SIZE:
        return {}
    values = struct.unpack_from(PACKET_FORMAT, data)
    return dict(zip(FIELDS, values))


def secs_to_time(s: float) -> str:
    """Convert seconds (float) to M:SS.mmm string."""
    if s <= 0:
        return "--:--.---"
    minutes = int(s // 60)
    seconds = s % 60
    return f"{minutes}:{seconds:06.3f}"


def display(t: dict) -> None:
    speed_kmh = t["Speed"] * 3.6
    speed_mph = t["Speed"] * 2.23694
    rpm_pct = (t["CurrentEngineRpm"] / t["EngineMaxRpm"] * 100) if t["EngineMaxRpm"] > 0 else 0
    gear_str = GEAR_MAP.get(t["Gear"], str(t["Gear"]))
    car_class = CAR_CLASS.get(t["CarClass"], "?")
    drivetrain = DRIVETRAIN.get(t["DrivetrainType"], "?")
    accel_pct = t["Accel"] / 255 * 100
    brake_pct = t["Brake"] / 255 * 100
    clutch_pct = t["Clutch"] / 255 * 100
    steer_pct = t["Steer"] / 127 * 100
    on_rumble = any(t[f"WheelOnRumble{w}"] for w in ("FL", "FR", "RL", "RR"))
    in_puddle = any(t[f"WheelInPuddle{w}"] for w in ("FL", "FR", "RL", "RR"))

    os.system("cls")
    print("=" * 55)
    print("       FORZA HORIZON 6 — TELEMETRY DASHBOARD")
    print("=" * 55)
    print(f"  Race On : {'YES' if t['IsRaceOn'] else 'NO':>6}   "
          f"Position : {t['RacePosition']:>3}   Lap: {t['LapNumber']}")
    print(f"  Car PI  : {t['CarPerformanceIndex']:>6}   Class    : {car_class:>3}   "
          f"Drive: {drivetrain}   Cyl: {t['NumCylinders']}")
    print(f"  Surface : {'RUMBLE' if on_rumble else '------'}  "
          f"{'PUDDLE' if in_puddle else '------'}")
    print("-" * 55)
    print(f"  Speed   : {speed_kmh:>7.1f} km/h  ({speed_mph:.1f} mph)")
    print(f"  Gear    : {gear_str:>7}        Boost : {t['Boost']:>6.2f} PSI")
    print(f"  RPM     : {t['CurrentEngineRpm']:>7.0f} / {t['EngineMaxRpm']:.0f}  ({rpm_pct:.1f}%)")
    print(f"  Power   : {t['Power']/1000:>7.1f} kW   Torque: {t['Torque']:.1f} Nm")
    print(f"  Fuel    : {t['Fuel']*100:>6.1f} %")
    print("-" * 55)
    print(f"  Accel   : {accel_pct:>5.1f}%   Brake : {brake_pct:>5.1f}%")
    print(f"  Clutch  : {clutch_pct:>5.1f}%   Steer : {steer_pct:>+6.1f}%")
    print("-" * 55)
    print(f"  Tire Temps (°C)   FL:{t['TireTempFL']:>6.1f}  FR:{t['TireTempFR']:>6.1f}")
    print(f"                    RL:{t['TireTempRL']:>6.1f}  RR:{t['TireTempRR']:>6.1f}")
    print(f"  Tire Slip Ratio   FL:{t['TireSlipRatioFL']:>6.3f}  FR:{t['TireSlipRatioFR']:>6.3f}")
    print(f"                    RL:{t['TireSlipRatioRL']:>6.3f}  RR:{t['TireSlipRatioRR']:>6.3f}")
    print("-" * 55)
    print(f"  Best Lap  : {secs_to_time(t['BestLap'])}")
    print(f"  Last Lap  : {secs_to_time(t['LastLap'])}")
    print(f"  Curr Lap  : {secs_to_time(t['CurrentLap'])}")
    print(f"  Race Time : {secs_to_time(t['CurrentRaceTime'])}")
    print(f"  Distance  : {t['DistanceTraveled']/1000:.2f} km")
    print("-" * 55)
    print(f"  Pos  X={t['PositionX']:>9.1f}  Y={t['PositionY']:>9.1f}  Z={t['PositionZ']:>9.1f}")
    print("=" * 55)
    print(f"  Packet: {PACKET_SIZE} bytes   Listening on {HOST}:{PORT}   [Ctrl+C to quit]")


def main() -> None:
    print(f"FH6 Telemetry — packet size check: {PACKET_SIZE} bytes (expected 324)")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((HOST, PORT))
    sock.settimeout(2.0)
    print(f"Waiting for Forza Horizon 6 telemetry on {HOST}:{PORT} ...")
    print("In-game: Settings > HUD and Gameplay > Data Out = ON")
    print(f"         Data Out IP Address : {HOST}")
    print(f"         Data Out IP Port    : {PORT}")
    print("Press Ctrl+C to quit.\n")

    try:
        while True:
            try:
                data, addr = sock.recvfrom(4096)
                print(f"[DEBUG] Received {len(data)} bytes from {addr}", flush=True)
                telemetry = parse_packet(data)
                if telemetry:
                    display(telemetry)
                else:
                    print(f"[DEBUG] Packet too small ({len(data)} bytes, need {PACKET_SIZE})", flush=True)
            except socket.timeout:
                pass  # no packet yet, keep waiting
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        sock.close()


if __name__ == "__main__":
    main()
