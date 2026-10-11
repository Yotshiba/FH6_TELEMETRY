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

## Limitations of plain HTTP on a LAN address

Browsers treat `http://192.168.x.x` as an *insecure context*, which disables a few features
on the phone: the **Screen Wake Lock** (the screen may dim — raise the device's auto-lock
time or use its "keep screen on while charging" option), **Add to Home Screen as an
installable app**, and clipboard access. The dashboard itself is unaffected.

## How it works (for the curious)

* A tiny standard-library HTTP server streams telemetry as **Server-Sent Events** (one-way,
  auto-reconnecting). Every packet is delivered (full chart fidelity), batched about 30
  times per second.
* A phone that locks its screen or loses Wi-Fi reconnects and **resumes** from where it
  stopped. The page also reloads cleanly when you switch to another game session.
* Nothing is downloaded from the internet: the page, script and styles are served by the app
  itself, so it works on a LAN without internet access.
* Protocol details: `fh6_telemetry/web/protocol.py`.
