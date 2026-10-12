# Web dashboard (phone, tablet, another PC)

Open the live telemetry in a browser on any device on your home network — a phone
mounted as a dash, a tablet, a laptop. Nothing is installed on the device.

The page mirrors the desktop windows (Race Status, Car & Lap, Tyres, Engine, Inputs,
Motion) and adds a compact **Dash** view that fits a landscape phone on one screen.

## Turn it on

**With the desktop app:** in the launcher tick **Web dashboard**. The launcher shows the
address to open, for example `http://192.168.1.101:8077/` (with a *Copy* button).
It is **off by default**, and it only accepts connections from your local network.

**Without the desktop windows (lightest on the gaming PC):**

```bash
FH6_Telemetry_Headless.exe
# or, from source:
python -m fh6_telemetry --headless
```

Headless mode runs only the UDP receiver and the web server — no windows, no Qt, no
NumPy. In a test with a browser connected and the game's 75 packets/s it used about
1–2 % of one CPU core (the original desktop UI used 70–120 %). It prints the address to
open. Useful options:

| Option | Meaning |
|---|---|
| `--udp-host 0.0.0.0` | receive Data Out from **another PC** (point FH6's *Data Out IP* at this machine) |
| `--udp-port 20077` | UDP port (default `20077`) |
| `--http-port 8077` | web port (default `8077`) |
| `--rate 30` | web update rate in Hz (15 / 30 / 60) |
| `--no-web` | receive only |
| `--no-low-impact` | do not lower the process priority |

You can also run headless mode on a different machine (a laptop, a Raspberry Pi): set the
game's **Data Out IP Address** to that machine and start it with `--udp-host 0.0.0.0`. The
gaming PC then does no dashboard work at all.

## Open it on the phone

1. Phone/tablet on the **same Wi-Fi / router** as the PC.
2. Open the address shown by the launcher (or printed by headless mode) in the browser.
3. Landscape phone: the **Dash** tab shows speed, gear, RPM, pedals, tyre temperatures and
   three live charts without scrolling. The **⛶** button toggles fullscreen (Android/desktop);
   on iPhone use *Share → Add to Home Screen* for a chrome-less view.

## What's in the page

| Tab | What it does |
|---|---|
| **Cockpit** | Analogue speedo + tacho that glide, 15 F1-style **shift lights**, a **steering wheel that turns**, pedal bars, a big gear read-out and a **live lap delta** vs. your best lap. Portrait phones get a single big rev dial. |
| **Dash** | The compact one-screen landscape view (speed, gear, RPM, pedals, tyres, 3 charts). |
| **Map** | Your **track drawn live from the car's position**, coloured by speed, with lap flags, a scale bar, *Fit / Follow / North-up* and zoom. |
| **Lab** | **Drag meter** (0–60 mph, 0–100, 0–200, 100–200 km/h, ¼ mile with trap speed, 100–0 and 60–0 braking distances — arm by stopping, then launch), a **G-force circle** with peaks, a **drift score** with combo multiplier, **air-time** counter, session / lifetime **records**, an attitude horizon + compass and the **trophy room**. |
| **Chassis** | A top-down car: tyres coloured by temperature, steering angle, suspension bars, a weight-transfer ball, brake lights, exhaust flames at the limiter, a lift-off when airborne. |
| **Rewind** | The last ~5 minutes at full rate in four strips. Drag to look back, wheel/buttons to zoom, tap for a read-out, **★ Mark** a moment, **⬇ CSV** to export the recording. |
| Race Status · Car & Lap · Tyres · Engine · Inputs · Motion | The six desktop windows. |

**Gimmicks (all optional, in ⚙ Settings):** six themes (Neon, Carbon, Retro CRT, Synthwave,
Daylight, Stealth); unit toggles (km/h ⇄ mph, °C ⇄ °F, bar ⇄ psi, hp ⇄ kW ⇄ PS, Nm ⇄ lb-ft, km ⇄ mi);
**engine sound** synthesised from the RPM (plus turbo whistle, blow-off, tyre squeal, kerb rumble and a shift beep);
**voice call-outs** ("Two hundred kilometres an hour", lap times, low fuel, hot tyres); **phone vibration** for
kerbs, impacts and landings; speed-lines, a redline vignette and screen shake; confetti for big unlocks;
a **HUD mirror** mode for a windshield; a **keep-screen-awake** button (on by default: no sleep or screen saver while the page is open); 25 **achievements**; a
**shareable session card** (PNG with your track, records and trophies). Try the Konami code. 😉

Your records, personal bests and trophies are stored **in that browser only** (`localStorage`) and never leave
the device. *Settings → Reset lifetime stats* erases them.

> Browsers only allow **sound and vibration after a tap**, so those start muted — tap *Sound* in the Cockpit.
> iPhones have no Vibration API. Drag-meter times use the game's own clock, so they are accurate even when
> Wi-Fi is jittery.

### Trying it without the game

```bash
python tools/fake_forza.py --scenario showcase      # drag run, braking test, then three drifting laps with jumps
python -m fh6_telemetry --headless                  # in another terminal; then open the URL it prints
```

The `showcase` scenario exercises every tab above (drag meter, lap delta, drift, air-time, track map).

## If the page does not load

The PC must accept the connection, and the phone must be able to reach the PC.

1. **First time:** Windows Defender Firewall asks whether to allow the app — tick
   **Private networks** and click *Allow*. (Do this with the game minimised; the prompt can
   pop up over a fullscreen game.)
2. **Network profile:** *Settings → Network & internet → Wi-Fi/Ethernet → Network profile
   type* must be **Private**. A *Public* profile blocks incoming connections.
3. **Or add a port rule once** (run PowerShell as administrator):

   ```powershell
   New-NetFirewallRule -DisplayName "FH6 Telemetry web" -Direction Inbound -Action Allow `
       -Protocol TCP -LocalPort 8077 -Profile Private
   # remove it later:
   Remove-NetFirewallRule -DisplayName "FH6 Telemetry web"
   ```
4. **Test from the PC first:** `http://localhost:8077/` must work. If it works on the PC but
   not on the phone, it is the firewall profile or the router.
5. **Router "client isolation" / "AP isolation"** (common on guest Wi-Fi and some mesh systems)
   blocks device-to-device traffic. Use the main network.
6. The phone and PC must be in the same subnet (not a double-NAT or a separate extender network).
7. **Port already in use:** the launcher/headless mode says so; pick another port (e.g. 8078).
   It never silently picks a different one.
8. **Wrong address shown?** On a PC with VPN/Hyper-V/WSL adapters the launcher lists the
   other candidates; use the one on your home network (usually `192.168.x.x` or `10.x.x.x`).

## Privacy and security

* Read-only: the page can only *receive* telemetry; it cannot change anything.
* It only answers devices on private/loopback/link-local/VPN (`100.64.0.0/10`) addresses. If
  you ever port-forward the web port on your router, internet visitors are refused.
* There is no password. Anyone on your home network can open the page while the server is
  on. Turn it off when you don't need it.

## Keeping the screen on

The dashboard keeps the device it is open on from dimming, locking or starting its screen saver. It is **on by
default** (the **☀** button in the top bar, or *Settings → Screen*):

| ☀ | Meaning |
|---|---|
| yellow | the screen is being held awake |
| orange, pulsing | waiting: phones only allow it after **one tap anywhere on the page** (or the tab is in the background) |
| orange after a tap + a toast | this browser refused: set the device's auto-lock / screen saver to *Never* (iPhone: *Settings → Display & Brightness → Auto-Lock*; Android: *Display → Screen timeout*; Windows: *Lock screen / Screen saver*) |

How it works: the proper *Screen Wake Lock* API is only offered on `https://` or `localhost`, so over
`http://192.168.x.x` the page plays a tiny, silent, almost invisible looping video instead (the trick browsers
honour for video players). It retries by itself when you return to the tab and re-checks every 20 s. Nothing
is recorded or sent anywhere. This is best-effort and depends on the browser and its battery-saver mode;
a device that is also on battery saver may still dim.

## Limitations of plain HTTP on a LAN address

Browsers treat `http://192.168.x.x` as an *insecure context*, which disables a few features
on the phone: the **Screen Wake Lock** API (the video fallback above covers it), **Add to Home Screen as an
installable app**, and clipboard access. The dashboard itself is unaffected.

## How it works (for the curious)

* A tiny standard-library HTTP server streams telemetry as **Server-Sent Events** (one-way,
  auto-reconnecting). Every packet is delivered (full chart fidelity), batched about 30
  times per second.
* A phone that locks its screen or loses Wi-Fi reconnects and **resumes** from where it
  stopped. If you reconnect the dashboard to a different telemetry source, open pages resync
  automatically.
* Nothing is downloaded from the internet: the page, script and styles are served by the app
  itself, so it works on a LAN without internet access.
* Protocol details: `fh6_telemetry/web/protocol.py`.
