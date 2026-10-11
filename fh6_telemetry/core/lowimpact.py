"""
Low-impact mode — be a polite neighbour to the game on the same PC.

What it does (Windows only, never raises):

* ``SetPriorityClass(BELOW_NORMAL)`` — the scheduler prefers the game's threads;
* ``SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED)`` — the same
  "EcoQoS" hint Task Manager's *Efficiency mode* sets.  On Windows 11 the
  scheduler steers such a process to efficiency cores (hybrid CPUs) / lower
  clocks instead of the cores the game is using.

What it does **not** do: reduce the amount of work.  The code fixes in the
rest of this branch do that; this only reduces *interference*.  It helps most
on hybrid CPUs and under contention, and it is not a promise of FPS.

Turning it off hands control back to the system (normal priority, no forced
throttling state) rather than forcing "high performance", so it never fights a
user who set Efficiency mode by hand.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from dataclasses import dataclass

from .diagnostics import log_exception

# Priority classes (processthreadsapi.h)
IDLE_PRIORITY_CLASS = 0x00000040
NORMAL_PRIORITY_CLASS = 0x00000020
BELOW_NORMAL_PRIORITY_CLASS = 0x00004000

# PROCESS_INFORMATION_CLASS::ProcessPowerThrottling
PROCESS_POWER_THROTTLING = 4
PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4   # Windows 11

WINDOWS_11_BUILD = 22000


class PowerThrottlingState(ctypes.Structure):
    """PROCESS_POWER_THROTTLING_STATE — three 32-bit fields, 12 bytes."""

    _fields_ = [
        ("Version", wintypes.DWORD),
        ("ControlMask", wintypes.DWORD),
        ("StateMask", wintypes.DWORD),
    ]


@dataclass(frozen=True)
class Result:
    ok: bool
    priority_set: bool = False
    throttling_set: bool = False
    error: str | None = None


def supported() -> bool:
    return sys.platform == "win32"


def windows_build() -> int | None:
    if not supported():
        return None
    try:
        return sys.getwindowsversion().build  # type: ignore[attr-defined]
    except Exception:
        return None


def default_enabled() -> bool:
    """On by default only where EcoQoS really steers scheduling (Windows 11)."""
    build = windows_build()
    return build is not None and build >= WINDOWS_11_BUILD


def effective(setting: bool | None) -> bool:
    """Resolve the config value (None = automatic) to on/off."""
    return default_enabled() if setting is None else bool(setting)


class _Api:
    """Thin, typed wrapper over the three kernel32 calls (replaceable in tests)."""

    def __init__(self) -> None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.GetCurrentProcess.argtypes = []
        k32.SetPriorityClass.restype = wintypes.BOOL
        k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.GetPriorityClass.restype = wintypes.DWORD
        k32.GetPriorityClass.argtypes = [wintypes.HANDLE]
        k32.SetProcessInformation.restype = wintypes.BOOL
        k32.SetProcessInformation.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
        ]
        self._k32 = k32

    def current_process(self):
        return self._k32.GetCurrentProcess()

    def set_priority_class(self, handle, cls: int) -> bool:
        return bool(self._k32.SetPriorityClass(handle, cls))

    def get_priority_class(self, handle) -> int:
        return int(self._k32.GetPriorityClass(handle))

    def set_power_throttling(self, handle, control: int, state: int) -> bool:
        st = PowerThrottlingState(PROCESS_POWER_THROTTLING_CURRENT_VERSION, control, state)
        return bool(
            self._k32.SetProcessInformation(
                handle, PROCESS_POWER_THROTTLING, ctypes.byref(st), ctypes.sizeof(st)
            )
        )

    def last_error(self) -> int:
        return ctypes.get_last_error()


def apply(enable: bool, *, ignore_timer_resolution: bool = False, api: _Api | None = None) -> Result:
    """Switch low-impact mode on or off for this process.  Never raises."""
    if api is None:
        if not supported():
            return Result(ok=False, error="Windows only")
        try:
            api = _Api()
        except Exception as exc:
            log_exception("lowimpact: load kernel32", exc)
            return Result(ok=False, error=str(exc))
    try:
        handle = api.current_process()
        if enable:
            prio_cls = BELOW_NORMAL_PRIORITY_CLASS
            control = PROCESS_POWER_THROTTLING_EXECUTION_SPEED
            if ignore_timer_resolution:
                control |= PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
            state = control
        else:
            prio_cls = NORMAL_PRIORITY_CLASS
            control = state = 0           # hand control back to the system
        prio_ok = api.set_priority_class(handle, prio_cls)
        if not prio_ok:
            log_exception_msg(f"SetPriorityClass failed (error {api.last_error()})")
        thr_ok = api.set_power_throttling(handle, control, state)
        if not thr_ok:
            # Older Windows 10 builds / policy: priority alone is still useful.
            log_exception_msg(f"SetProcessInformation failed (error {api.last_error()})")
        return Result(ok=prio_ok or thr_ok, priority_set=prio_ok, throttling_set=thr_ok)
    except Exception as exc:
        log_exception("lowimpact.apply", exc)
        return Result(ok=False, error=str(exc))


def log_exception_msg(message: str) -> None:
    try:
        raise OSError(message)
    except OSError as exc:
        log_exception("lowimpact", exc)


def current_priority_class() -> int | None:
    """Priority class of this process (for tests and diagnostics)."""
    if not supported():
        return None
    try:
        api = _Api()
        return api.get_priority_class(api.current_process())
    except Exception:
        return None
