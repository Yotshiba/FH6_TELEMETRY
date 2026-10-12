# FH6 Telemetry Dashboard

A real-time telemetry dashboard for **Forza Horizon 6**, built with Python, PyQt6, and pyqtgraph — on your desktop **and in any browser on your local network** (phone, tablet, another PC).

Each category opens as an independent floating window that can be freely moved and resized. The launcher lets you toggle any combination of windows, and can serve the same data as a web page.

---

## Download

| File | Platform | What it is |
|---|---|---|
| [`FH6_Telemetry.exe`](https://github.com/Yotshiba/FH6_TELEMETRY/releases/latest) | Windows 64-bit | the desktop dashboard (+ optional web dashboard) |
| `FH6_Telemetry_Headless.exe` | Windows 64-bit | web dashboard only — no windows, a few MB, ~1–2 % of one CPU core |

> No Python required. Download and run — Windows may show a SmartScreen prompt; click **More info → Run anyway**.

---

## Features

| Window | Contents |
|---|---|
| **Race Status** | Speed, gear, lap, position, RPM, car info, boost, fuel |
| **Car & Lap** | Car class/PI/drivetrain, lap times, all inputs, FH6 extras |
| **Tyres** | 2×2 tyre cards (temp, slip, suspension) + temperature history chart |
| **Engine** | RPM, power (hp), torque (Nm), boost (bar) + rolling charts |
| **Inputs** | Throttle, brake, clutch, handbrake, steer bars + Throttle/Brake chart |
| **Motion** | Speed/gear display + velocity, acceleration, orientation, position data + suspension & speed charts |

- **Web dashboard** — the same six categories in a browser, plus a compact **Dash** view that fits a landscape phone on one screen ([guide](docs/web-dashboard.md))
- **A bit gimmicky** — in the browser: an analogue **Cockpit** with shift lights and a turning wheel, a live **track map**, a **Lab** (drag meter, G-force circle, drift score, air-time, records, 25 achievements), a top-down **Chassis** view, a 5-minute **Rewind** timeline with CSV export, six themes, unit toggles, synthesised engine sound, voice call-outs, phone haptics and a shareable session card ([tour](docs/web-dashboard.md#whats-in-the-page))
- **Light on your game** — the display refreshes on a timer (10–60 Hz, default 20) instead of per packet; hidden/minimised windows cost almost nothing; optional *low-impact mode* lowers the dashboard's priority
- **Stable charts** — the Y axis only changes when it has to (no constant re-scaling when values fluctuate)
- **Unit conversions**: boost in bar, power in hp, speed in km/h + mph, tyre temps in °C (converted from FH6's Fahrenheit broadcast)
- **Dark theme** throughout
- Configurable UDP IP and port (remembered between runs)

---

## Enabling Data Out in Forza Horizon 6

1. Launch **Forza Horizon 6** and open the **Pause Menu**
2. Go to **Settings → HUD and Gameplay**
3. Scroll down to the **Data Out** section
4. Set **Data Out** to **On**
5. Set **Data Out IP Address** to your PC's local IP address (use `127.0.0.1` if the dashboard is running on the same machine as the game)
6. Set **Data Out IP Port** to `20077` (or match whatever port you enter in the Launcher)
7. Set **Data Out Packet Format** to **Car Dash**

> To find your local IP: open a command prompt and run `ipconfig` — look for the **IPv4 Address** under your active network adapter.

---

## Requirements

- Windows 10/11 64-bit
- Forza Horizon 6 with **Data Out** enabled (see above)

---

## Quick Start (exe)

1. Download `FH6_Telemetry.exe` from the [releases page](https://github.com/Yotshiba/FH6_TELEMETRY/releases/latest)
2. Run it
3. Enter your IP/port in the Launcher (default `127.0.0.1:20077`) and click **Connect**
4. Toggle any category window and start a race in FH6 — data streams in live

---

## Web dashboard (phone / tablet / another PC)

In the launcher tick **Web dashboard**. It shows an address such as `http://192.168.1.101:8077/` — open it in a browser on any device on the same Wi-Fi. It is **off by default** and only answers devices on your local network.

For the lowest impact on the gaming PC, run **headless** (no windows at all):

```bash
FH6_Telemetry_Headless.exe          # or: python -m fh6_telemetry --headless
```

If the page doesn't load, the cause is almost always the Windows firewall profile or router client-isolation — see [docs/web-dashboard.md](docs/web-dashboard.md) (firewall rule, troubleshooting, limitations).

---

## Keeping the dashboard from costing you FPS

* Prefer the **web dashboard on a phone/tablet** (or headless mode) and close the desktop windows: nothing is painted on the gaming PC.
* Lower the **Refresh rate** in the launcher (10–20 Hz is plenty); charts still record every packet.
* **Low-impact mode** (on by default on Windows 11) asks Windows to schedule the dashboard behind your game.
* Never set the windows "always on top" over a full-screen game, and consider putting them on a second monitor.
* The launcher's status bar shows the dashboard's own CPU use. To measure the real FPS effect, see [docs/perf-measurement.md](docs/perf-measurement.md).

---

## Build from Source

```bash
# Clone the repo
git clone https://github.com/Yotshiba/FH6_TELEMETRY.git
cd FH6_TELEMETRY

# Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run directly
python dashboard_multi_ui.py        # desktop (+ optional web dashboard)
python -m fh6_telemetry --headless  # web dashboard only, no Qt
```

Tests and tools:

```bash
pip install -r requirements-dev.txt
python -m pytest                       # unit + UI smoke tests (offscreen)
python tools/fake_forza.py             # synthetic Data Out packets (no game needed)
python tools/bench_ui.py --windows 2,3 # CPU benchmark of the real UI
```

To rebuild the executables (use the spec files — they bundle the web page):

```bash
pip install pyinstaller
python -m PyInstaller FH6_Telemetry.spec            # dist\FH6_Telemetry.exe
python -m PyInstaller FH6_Telemetry_Headless.spec   # dist\FH6_Telemetry_Headless.exe
```

---

## Project Structure

```
FH6_TELEMETRY/
├── dashboard_multi_ui.py      # Desktop entry point (thin shim)
├── headless_ui.py             # Headless entry point (thin shim)
├── FH6_Telemetry*.spec        # PyInstaller specs (desktop / headless)
├── requirements*.txt
├── docs/                      # web-dashboard guide, performance measuring
├── tools/                     # fake_forza (incl. showcase), record_udp, bench_ui, make_icons
├── tests/
└── fh6_telemetry/
    ├── constants.py           # UDP config, packet format, all mappings
    ├── telemetry.py           # parse_packet, secs_to_time (Qt-free)
    ├── style.py               # Dark stylesheet, label helpers
    ├── launcher.py            # LauncherWindow + main()
    ├── headless.py            # hub + web server without Qt
    ├── core/                  # Qt-free: hub, udp_source, frames, derive, charts,
    │                          #   range_smoother, config, diagnostics, lowimpact, netinfo
    ├── gui/                   # NumPy ring buffer for charts
    ├── web/                   # SSE server, protocol, static page (HTML/CSS/JS)
    ├── widgets/               # bar_indicator, rolling_chart, tyre widgets, panels
    ├── tabs/                  # per-window content
    └── windows/               # category windows (hide-on-close base class)
```

---

## Packet Format

The dashboard listens for the standard **Forza Data Out** UDP packet (324 bytes), sent at roughly **75 packets per second** by FH6. The full field list is defined in [`fh6_telemetry/constants.py`](fh6_telemetry/constants.py).
