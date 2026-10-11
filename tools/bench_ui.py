"""
bench_ui — black-box CPU / latency benchmark of the real dashboard UI.

It starts ``fake_forza.py`` as a *separate process* (so it does not steal this
process's GIL), builds the real launcher + all six windows under Qt's
``offscreen`` platform, connects to the generator over loopback UDP on a
private port, and measures for ``--seconds`` after a warm-up:

* process CPU (``time.process_time`` / wall — all threads of this process)
* event-loop lateness (a 4 ms heartbeat timer; exposes GUI-thread stalls and
  the unbounded signal backlog of the original design)
* the per-packet / per-tick handler cost
* call counts and cumulative time of the suspected hot spots
  (``setStyleSheet``, ``setText``, ``setValue``, ``setData``, ``setYRange`` …)

Offscreen has no GDI / DWM / GPU cost, so this gives *relative CPU and call
counts*, not a game-FPS number.  Use PresentMon for that (docs/perf-measurement.md).

Compare two code bases (e.g. the tagged baseline in a git worktree):

    git worktree add ../fh6-baseline perf-baseline
    python tools/bench_ui.py --repo ../fh6-baseline --label baseline --json base.json
    python tools/bench_ui.py --label new --json new.json
    python tools/bench_ui.py --compare base.json new.json

Add ``--profile`` for a separate cProfile attribution pass (timings are
distorted by the profiler; use it to rank, not to measure).
"""

from __future__ import annotations

import argparse
import cProfile
import ctypes
import faulthandler
import io
import json
import os
import pstats
import statistics
import subprocess
import sys
import time
from pathlib import Path

_TOOLS = Path(__file__).resolve().parent
_DEFAULT_REPO = _TOOLS.parent


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def _peak_working_set_mb() -> float:
    if os.name != "nt":
        return 0.0

    class PMC(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(PMC), ctypes.c_ulong]
    pmc = PMC()
    pmc.cb = ctypes.sizeof(PMC)
    psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
    return pmc.PeakWorkingSetSize / (1024 * 1024)


class Probe:
    """Counts calls and accumulates time of monkeypatched callables."""

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}
        self.secs: dict[str, float] = {}
        self.maxes: dict[str, float] = {}
        self.samples: dict[str, list[float]] = {}   # only for "handler" probes
        self._patched: list[str] = []

    def wrap(self, owner, attr: str, name: str, keep_samples: bool = False,
             post=None) -> bool:
        orig = getattr(owner, attr, None)
        if orig is None:
            return False
        self.calls[name] = 0
        self.secs[name] = 0.0
        self.maxes[name] = 0.0
        if keep_samples:
            self.samples[name] = []
        calls, secs, maxes, samples = self.calls, self.secs, self.maxes, self.samples
        pc = time.perf_counter

        def wrapper(*a, **kw):
            t0 = pc()
            try:
                return orig(*a, **kw)
            finally:
                dt = pc() - t0
                calls[name] += 1
                secs[name] += dt
                if dt > maxes[name]:
                    maxes[name] = dt
                if keep_samples:
                    samples[name].append(dt)
                if post is not None:
                    post()

        wrapper.__name__ = getattr(orig, "__name__", attr)
        setattr(owner, attr, wrapper)
        self._patched.append(name)
        return True

    def snapshot(self) -> dict:
        return {
            "calls": dict(self.calls), "secs": dict(self.secs),
            "samples": {k: len(v) for k, v in self.samples.items()},
        }


def run_benchmark(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo))
    if not args.onscreen:
        os.environ["QT_QPA_PLATFORM"] = "offscreen"
    # If the GUI thread is so saturated that the run can never finish (the
    # original design's unbounded backlog), dump the stack instead of hanging.
    faulthandler.dump_traceback_later(
        int(args.warmup + args.seconds * args.repeats) + 120, exit=True)
    if os.name == "nt" and not args.normal_priority:
        # Be a good citizen: do not steal CPU from a game running on this PC.
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL

    import pyqtgraph as pg
    from PyQt6.QtCore import Qt, QTimer
    from PyQt6.QtWidgets import QApplication, QLabel, QProgressBar, QWidget

    from fh6_telemetry import launcher as L

    probe = Probe()
    # Generic hot spots (present in every version of the code base)
    probe.wrap(QWidget, "setStyleSheet", "QWidget.setStyleSheet")
    probe.wrap(QLabel, "setText", "QLabel.setText")
    probe.wrap(QProgressBar, "setValue", "QProgressBar.setValue")
    probe.wrap(pg.PlotDataItem, "setData", "PlotDataItem.setData")
    probe.wrap(pg.PlotCurveItem, "setData", "PlotCurveItem.setData")
    probe.wrap(pg.ViewBox, "setYRange", "ViewBox.setYRange")
    probe.wrap(pg.ViewBox, "setRange", "ViewBox.setRange")
    probe.wrap(pg.ViewBox, "updateAutoRange", "ViewBox.updateAutoRange")
    probe.wrap(pg.AxisItem, "generateDrawSpecs", "AxisItem.generateDrawSpecs")
    probe.wrap(pg.PlotCurveItem, "paint", "PlotCurveItem.paint")
    # Per-packet / per-tick handlers (names differ between phases)
    # ``poll`` drives the measurement phases.  It is called from the heartbeat
    # timer *and* from the handlers, because with the original design the GUI
    # thread is so saturated that Qt timers can starve for seconds.
    poll_hook = [lambda: None]
    handler_names = [n for n in ("_on_telemetry", "_on_tick")
                     if probe.wrap(L.LauncherWindow, n, f"handler:{n}", keep_samples=True,
                                   post=lambda: poll_hook[0]())]

    pg.setConfigOptions(antialias=True, foreground="#cccccc", background="#0d0d1a")
    if hasattr(L, "setup_pyqtgraph"):          # later phases centralise this
        L.setup_pyqtgraph()

    app = QApplication(sys.argv[:1])
    app.setStyle("Fusion")

    gen = subprocess.Popen(
        [sys.executable, str(_TOOLS / "fake_forza.py"), "--port", str(args.port),
         "--hz", str(args.hz), "--scenario", args.scenario, "--seed", "1",
         "--duration", str(int(args.warmup + args.seconds * args.repeats) + 60)],
        stderr=subprocess.PIPE, text=True,
    )
    time.sleep(0.3)

    # Never listen on the real Data Out port: a running game would feed the
    # benchmark live packets.  The launcher reads these module globals when it
    # starts its receiver.
    L.HOST, L.PORT = "127.0.0.1", args.port
    win = L.LauncherWindow()
    win.show()
    if args.windows == "all":
        win._open_all()
    else:
        for i in (int(x) for x in args.windows.split(",")):
            win._buttons[i].setChecked(True)
            win._windows[i].show()
    app.processEvents()

    # Event-loop heartbeat
    beats: list[float] = []
    last = [time.perf_counter()]

    def beat() -> None:
        now = time.perf_counter()
        beats.append(now - last[0])
        last[0] = now
        poll_hook[0]()

    hb = QTimer()
    hb.setTimerType(Qt.TimerType.PreciseTimer)
    hb.setInterval(4)
    hb.timeout.connect(beat)
    hb.start()

    grab_secs = [0.0]
    if args.grab_hz > 0:
        def do_grab() -> None:
            t0 = time.perf_counter()
            for w in win._windows:
                if w.isVisible():
                    w.grab()
            grab_secs[0] += time.perf_counter() - t0

        gt = QTimer()
        gt.setInterval(int(1000 / args.grab_hz))
        gt.timeout.connect(do_grab)
        gt.start()

    results: list[dict] = []
    profiler = cProfile.Profile() if args.profile else None
    state = {"repeat": 0, "phase": "warmup",
             "deadline": time.perf_counter() + args.warmup}

    def poll() -> None:
        ph = state["phase"]
        if ph == "done" or time.perf_counter() < state["deadline"]:
            return
        if ph == "warmup":
            begin_measure()
        elif ph == "measure":
            end_measure()

    poll_hook[0] = poll

    def begin_measure() -> None:
        print(f"[bench] measure #{state['repeat'] + 1} start", file=sys.stderr, flush=True)
        beats.clear()
        last[0] = time.perf_counter()
        grab_secs[0] = 0.0
        for v in probe.samples.values():
            v.clear()
        state["snap0"] = probe.snapshot()
        state["cpu0"] = time.process_time()
        state["wall0"] = time.perf_counter()
        if profiler:
            profiler.enable()
        state["phase"] = "measure"
        state["deadline"] = time.perf_counter() + args.seconds

    def end_measure() -> None:
        print(f"[bench] measure #{state['repeat'] + 1} end", file=sys.stderr, flush=True)
        state["phase"] = "collect"
        if profiler:
            profiler.disable()
        cpu = time.process_time() - state["cpu0"]
        wall = time.perf_counter() - state["wall0"]
        snap0, snap1 = state["snap0"], probe.snapshot()
        counters = {}
        for name in snap1["calls"]:
            n = snap1["calls"][name] - snap0["calls"][name]
            s = snap1["secs"][name] - snap0["secs"][name]
            if n:
                counters[name] = {"calls_per_s": round(n / wall, 1),
                                  "ms_per_s": round(s * 1000 / wall, 2)}
        hb_ms = sorted(b * 1000 for b in beats)
        handler = {}
        for hn in handler_names:
            name = f"handler:{hn}"
            smp = sorted(x * 1000 for x in probe.samples.get(name, []))
            if smp:
                handler = {
                    "name": hn, "calls_per_s": round(len(smp) / wall, 1),
                    "mean_ms": round(statistics.fmean(smp), 3),
                    "p95_ms": round(_percentile(smp, 95), 3),
                    "max_ms": round(smp[-1], 3),
                }
        results.append({
            "cpu_pct_of_one_core": round(100.0 * cpu / wall, 1),
            "handler": handler,
            "loop_gap_ms": {
                "p50": round(_percentile(hb_ms, 50), 2), "p95": round(_percentile(hb_ms, 95), 2),
                "p99": round(_percentile(hb_ms, 99), 2), "max": round(hb_ms[-1], 2) if hb_ms else 0,
            },
            "grab_ms_per_s": round(grab_secs[0] * 1000 / wall, 1),
            "counters": counters,
        })
        state["repeat"] += 1
        if state["repeat"] < args.repeats:
            begin_measure()
        else:
            state["phase"] = "done"
            finalize()

    def finalize() -> None:
        # The original design can leave the event loop with a huge backlog, so
        # ``quit()`` may take minutes to take effect.  Finish from here and exit
        # the process hard — a benchmark does not need a graceful shutdown.
        gen.kill()
        if profiler:
            buf = io.StringIO()
            pstats.Stats(profiler, stream=buf).sort_stats("tottime").print_stats(30)
            print(buf.getvalue())
        res = build_result()
        print_report(res)
        if args.json:
            Path(args.json).write_text(json.dumps(res, indent=2))
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)

    def build_result() -> dict:
        return _result(args, repo, results)

    app.exec()


def _result(args: argparse.Namespace, repo: Path, results: list[dict]) -> dict:
    cpus = [r["cpu_pct_of_one_core"] for r in results]
    return {
        "label": args.label, "repo": str(repo), "scenario": args.scenario, "hz": args.hz,
        "seconds": args.seconds, "repeats": args.repeats, "grab_hz": args.grab_hz,
        "windows": args.windows,
        "median_cpu_pct": round(statistics.median(cpus), 1) if cpus else None,
        "cpu_spread_pct": round((max(cpus) - min(cpus)) / max(statistics.median(cpus), 0.1) * 100, 1)
        if cpus else None,
        "peak_working_set_mb": round(_peak_working_set_mb(), 1),
        "runs": results,
    }


def print_report(res: dict) -> None:
    print(f"\n=== {res['label']}  ({res['repo']})")
    print(f"scenario={res['scenario']} hz={res['hz']} seconds={res['seconds']} "
          f"repeats={res['repeats']} grab_hz={res['grab_hz']}")
    print(f"median CPU: {res['median_cpu_pct']}% of one core "
          f"(spread {res['cpu_spread_pct']}%)   peak WS: {res['peak_working_set_mb']} MB")
    last = res["runs"][-1] if res["runs"] else {}
    print("handler:", last.get("handler"))
    print("event-loop gap (ms):", last.get("loop_gap_ms"))
    print(f"{'counter':34s} {'calls/s':>10s} {'ms/s':>9s}")
    for name, c in sorted(last.get("counters", {}).items(),
                          key=lambda kv: -kv[1]["ms_per_s"]):
        print(f"{name:34s} {c['calls_per_s']:10.1f} {c['ms_per_s']:9.2f}")


def compare(a_path: str, b_path: str) -> None:
    a, b = json.loads(Path(a_path).read_text()), json.loads(Path(b_path).read_text())
    print(f"{a['label']}: {a['median_cpu_pct']}%   {b['label']}: {b['median_cpu_pct']}%   "
          f"(x{(a['median_cpu_pct'] or 0) / max(b['median_cpu_pct'] or 0.1, 0.1):.1f} lower)")
    for key in ("QWidget.setStyleSheet", "ViewBox.setYRange", "AxisItem.generateDrawSpecs",
                "PlotDataItem.setData", "PlotCurveItem.setData", "QProgressBar.setValue"):
        ca = a["runs"][-1]["counters"].get(key, {}).get("calls_per_s", 0)
        cb = b["runs"][-1]["counters"].get(key, {}).get("calls_per_s", 0)
        print(f"  {key:30s} {ca:9.1f}/s -> {cb:9.1f}/s")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", default=str(_DEFAULT_REPO), help="code base to benchmark")
    ap.add_argument("--label", default="run")
    ap.add_argument("--scenario", default="fluct")
    ap.add_argument("--hz", type=float, default=75.0,
                    help="packet rate; the real game was measured at ~75 Hz")
    ap.add_argument("--port", type=int, default=20999)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--warmup", type=float, default=3.0)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--windows", default="all",
                    help="'all' or comma list of launcher indices: "
                         "0 Race Status, 1 Car&Lap, 2 Tyres, 3 Engine, 4 Inputs, 5 Motion")
    ap.add_argument("--grab-hz", type=float, default=0.0,
                    help="also call window.grab() at this rate (paint upper bound)")
    ap.add_argument("--normal-priority", action="store_true",
                    help="do not lower the benchmark process priority")
    ap.add_argument("--onscreen", action="store_true", help="use the real Windows platform plugin")
    ap.add_argument("--profile", action="store_true", help="cProfile pass (distorts timing)")
    ap.add_argument("--json", help="write results to this file")
    ap.add_argument("--compare", nargs=2, metavar=("A.json", "B.json"))
    args = ap.parse_args(argv)

    if args.compare:
        compare(*args.compare)
        return 0
    if args.profile:
        args.repeats = 1
    run_benchmark(args)   # reports and exits the process itself (see finalize)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
