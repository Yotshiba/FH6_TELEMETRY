# FH6 Telemetry Dashboard

A multi-window real-time telemetry dashboard for **Forza Horizon 6**, built with Python, PyQt6, and pyqtgraph.

Each category opens as an independent floating window that can be freely moved and resized. The launcher lets you toggle any combination of windows.

---

## Download

| File | Size | Platform |
|---|---|---|
| [`FH6_Telemetry.exe`](https://github.com/Yotshiba/FH6_TELEMETRY/releases/latest) | 50.7 MB | Windows 64-bit |

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

- **Unit conversions**: boost in bar, power in hp, speed in km/h + mph, tyre temps in °C (converted from FH6's Fahrenheit broadcast)
- **Dark theme** throughout
- Configurable UDP IP and port from the launcher UI

---

## Requirements

- Windows 10/11 64-bit
- Forza Horizon 6 with **Data Out** enabled (Settings → HUD and gameplay → Data Out)  
  Set the output IP to your PC's IP (or `127.0.0.1` for same machine) and port to `20077`

---

## Quick Start (exe)

1. Download `FH6_Telemetry.exe` from the [releases page](https://github.com/Yotshiba/FH6_TELEMETRY/releases/latest)
2. Run it
3. Enter your IP/port in the Launcher (default `127.0.0.1:20077`) and click **Connect**
4. Toggle any category window and start a race in FH6 — data streams in live

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
python dashboard_multi_ui.py
```

To rebuild the `.exe`:
```bash
pip install pyinstaller
python -m PyInstaller --onefile --windowed --name FH6_Telemetry --collect-all pyqtgraph dashboard_multi_ui.py
# Output: dist\FH6_Telemetry.exe
```

---

## Project Structure

```
FH6_TELEMETRY/
├── dashboard_multi_ui.py      # Entry point (thin shim)
├── requirements.txt
└── fh6_telemetry/             # Main package
    ├── constants.py           # UDP config, packet format, all mappings
    ├── telemetry.py           # parse_packet, secs_to_time, TelemetryReceiver
    ├── style.py               # Dark stylesheet, label helpers, colour utilities
    ├── launcher.py            # LauncherWindow + main()
    ├── widgets/
    │   ├── bar_indicator.py   # Labelled progress bar row
    │   ├── rolling_chart.py   # Scrolling pyqtgraph chart
    │   ├── tyre_widget.py     # Single-wheel tyre card
    │   ├── tyre_panel_grid.py # 2×2 tyre card grid
    │   ├── header_bar.py      # Single-row telemetry strip
    │   ├── left_info_panel.py # Scrollable car/lap/input panel
    │   ├── motion_panel.py    # Speed display + motion data grid
    │   └── toggle_button.py   # Card-style launcher toggle button
    ├── tabs/
    │   ├── tyres_tab.py
    │   ├── engine_tab.py
    │   ├── inputs_tab.py
    │   └── motion_tab.py
    └── windows/
        ├── category_window.py # Base class (hide-on-close)
        ├── car_lap_window.py
        ├── tyres_window.py
        ├── engine_window.py
        ├── inputs_window.py
        ├── motion_window.py
        └── race_status_window.py
```

---

## Packet Format

The dashboard listens for the standard **Forza Data Out** UDP packet (324 bytes). The full field list is defined in [`fh6_telemetry/constants.py`](fh6_telemetry/constants.py).
