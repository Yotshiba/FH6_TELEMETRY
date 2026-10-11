# Measuring the dashboard's cost

Two different questions need two different tools:

| Question | Tool | Answers |
|---|---|---|
| How much CPU / latency does the dashboard itself use? | `tools/bench_ui.py` | relative CPU, call counts, event-loop stalls |
| How much FPS does it cost the *game*? | PresentMon / CapFrameX | the only real answer |

`bench_ui.py` runs under Qt's `offscreen` platform, so it contains **no** GDI / DWM /
GPU cost. It tells you whether the dashboard's own code got cheaper, not what
happens to your frame rate.

## 1. Dashboard benchmark (`tools/bench_ui.py`)

```bash
# compare against the tagged baseline (exported without git metadata)
git archive perf-baseline --prefix=baseline/ | tar -x -C ../fh6-baseline-parent
python tools/bench_ui.py --repo ../fh6-baseline-parent/baseline --label baseline \
       --windows 2,3 --seconds 12 --repeats 2 --json base.json
python tools/bench_ui.py --label new --windows 2,3 --seconds 12 --repeats 2 --json new.json
python tools/bench_ui.py --compare base.json new.json
```

* `--windows` takes launcher indices: `0` Race Status, `1` Car & Lap, `2` Tyres,
  `3` Engine, `4` Inputs, `5` Motion (or `all`).
* The generator (`tools/fake_forza.py`) runs in a separate process on a private
  port (`--port`, default 20999) so a running game never feeds the benchmark.
* The benchmark process runs at BELOW_NORMAL priority so it doesn't disturb a
  game running on the same PC (`--normal-priority` to disable).
* `--profile` adds a cProfile pass (the profiler distorts timing; use it to rank).

### Baseline (tag `perf-baseline`, scenario `fluct`, **75 Hz** — the rate measured from the real game)

| Windows open | CPU (of one core) | handler / packet | event-loop gap p50 / p95 | `setStyleSheet`/s | `QProgressBar.setValue`/s | `setData`/s |
|---|---:|---:|---:|---:|---:|---:|
| Engine | 71 % | 0.7 ms | 3.9 / 9.9 ms | 0 | 0 | 300 |
| Tyres + Engine | **119 %** | 5.7 ms | 15.8 / 29.6 ms | 2,098 | 1,199 | 600 |
| All six | **112 %** | 8.6 ms | **70 / 114 ms** | 3,302 | 2,251 | 1,126 |

Reading it: a value above 100 % means the GUI thread is saturated (plus the
receiver thread). Once the per-packet work exceeds the packet interval
(13.3 ms at 75 Hz), the original design queues one signal per packet without
bound and the UI falls behind; with all six windows the event loop only turns
over about 14 times a second. Everything above is **per packet**; none of it
is throttled.

Measured on the development PC while the game itself was running, so absolute
numbers carry some noise (spread between repeats was 2–5 %).

## 2. Real FPS impact (PresentMon / CapFrameX)

You need this because the dashboard can cost FPS in ways a CPU profile cannot
see (window composition by the compositor, power/thermal sharing, core
placement). Use **PresentMon** (or **CapFrameX**, which is built on it). Avoid
overlay-based tools (RTSS / Afterburner overlay) as the primary measurement:
their hook changes presentation behaviour and costs about 1 %.

**Setup (once):** fix graphics settings, power plan, Game Mode, V-Sync; close
browsers/launchers/overlays. Note CPU model (hybrid Intel P/E-core?), laptop vs
desktop, GPU, monitor count, and the game's display mode.

**Scene:** the in-game benchmark, or a stationary free-roam / photo-mode scene.
To drive the dashboard deterministically, turn the game's **Data Out OFF** and
feed the dashboard with `tools/fake_forza.py` instead (otherwise two sources hit
the same port).

**Protocol:** one warm-up run, then **≥ 5 runs of 90–120 s per condition**,
interleaved (A B C D A B C D …) to cancel thermal drift. Record average FPS and
the 1 % / 0.1 % lows, **and the `PresentMode` column**:

* `Hardware: Independent Flip` — best; nothing is composing over the game.
* `Composed: Flip` — the window manager is compositing: a window is interfering.
* `Hardware Composed: Independent Flip` — an overlay plane keeps the cost low.

**Conditions (this separates CPU work from composition and placement):**

| | Condition | Isolates |
|---|---|---|
| a | dashboard not running | reference |
| b | windows open over the game, **no** packets flowing | window-composition cost |
| c | full dashboard + `fake_forza` feed | the whole cost |
| d | (c) with Task Manager → Details → *Efficiency mode* on the dashboard process | does priority/EcoQoS help? |
| e | (c) with all windows minimised | cost of the data path without painting |
| f | (c) with the windows on a second monitor | placement |
| g | game Data Out ON vs OFF, dashboard closed | cost of the game's own telemetry |
| h | headless / web-only build (after Phase 6) | the lightest option |

Treat differences below about **2× the run-to-run standard deviation** of
condition (a) as noise. Capture CPU/GPU clocks, power and temperatures (HWiNFO)
to catch power-limit shifts on laptops.

## 3. Notes on the data

* The game was measured sending **~75 packets/s** (arrival gap 13.4 ms;
  `TimestampMS` deltas 0 / 15 / 16), not 60 — treat the rate as variable.
* `Gear` shows a one-packet transient (code 11) at each shift.
* A 2-second slice of the real capture lives in `tests/data/real_sample.fh6rec`;
  record your own with `tools/record_udp.py` and replay it with
  `tools/fake_forza.py --replay`.
