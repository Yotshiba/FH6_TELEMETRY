"""
Headless mode — the telemetry hub plus the LAN web dashboard, with no Qt.

    python -m fh6_telemetry --headless
    python -m fh6_telemetry --headless --udp-host 0.0.0.0 --http-port 8077

This is the lightest way to run the dashboard next to the game: no windows to
paint, no pyqtgraph, no NumPy — just a UDP socket and a tiny web server.  It
can also run on *another* PC/Raspberry Pi when FH6's "Data Out IP" points there.

Nothing in this module may import PyQt6, pyqtgraph or numpy
(``tests/test_import_guard.py`` enforces it).
"""

from __future__ import annotations

import argparse
import sys
import threading
import time

from .core import lowimpact, netinfo
from .core.config import Config
from .core.diagnostics import install_excepthook
from .core.hub import TelemetryHub
from .core.udp_source import UdpBindError
from .web.server import DEFAULT_PORT, WebBindError, WebServer


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="fh6_telemetry --headless",
        description="FH6 telemetry hub + LAN web dashboard without the desktop UI.",
    )
    ap.add_argument("--udp-host", help="address to receive Data Out on (default: saved setting, 127.0.0.1)")
    ap.add_argument("--udp-port", type=int, help="UDP port (default: saved setting, 20077)")
    ap.add_argument("--bind", default="0.0.0.0", help="address for the web server (default: all interfaces)")
    ap.add_argument("--http-port", type=int, help=f"web port (default: saved setting or {DEFAULT_PORT})")
    ap.add_argument("--rate", type=int, choices=(15, 30, 60), help="web update rate in Hz (default 30)")
    ap.add_argument("--no-web", action="store_true", help="receive only; do not start the web server")
    ap.add_argument("--no-low-impact", action="store_true",
                    help="do not lower this process's priority / enable Windows Efficiency QoS")
    return ap


def main(argv: list[str] | None = None, stop: threading.Event | None = None) -> int:
    args = build_parser().parse_args(argv)
    install_excepthook()
    cfg = Config.load()

    udp_host = args.udp_host or str(cfg["udp_host"])
    udp_port = args.udp_port or int(cfg["udp_port"])
    http_port = args.http_port or int(cfg["web_port"])
    rate = args.rate or int(cfg["web_rate_hz"])

    if not args.no_low_impact and lowimpact.effective(cfg["low_impact"]):
        lowimpact.apply(True)

    hub = TelemetryHub()
    try:
        hub.start(udp_host, udp_port)
    except UdpBindError as exc:
        print(f"Cannot listen for telemetry on {udp_host}:{udp_port} — {exc}", file=sys.stderr)
        return 2
    print(f"FH6 Telemetry (headless)\n  telemetry : listening on UDP {udp_host}:{udp_port}")

    web: WebServer | None = None
    if not args.no_web:
        web = WebServer(hub, tick_hz=rate)
        try:
            port = web.start(args.bind, http_port)
        except WebBindError as exc:
            print(f"Cannot start the web server on {args.bind}:{http_port} — {exc}", file=sys.stderr)
            hub.stop()
            return 2
        urls = [c.url(port) for c in netinfo.lan_candidates()] or [f"http://127.0.0.1:{port}/"]
        print(f"  dashboard : {urls[0]}")
        for extra in urls[1:3]:
            print(f"              (also {extra})")
        print("  Open that address in a browser on your phone / tablet (same Wi-Fi).")
        print("  If it does not load: allow the app through Windows Firewall (Private networks).")
    print("Press Ctrl+C to quit.\n")

    stop = stop or threading.Event()
    state = None
    try:
        # A bare Event.wait() is not interruptible by Ctrl+C on Windows: poll.
        while not stop.wait(0.5):
            st = hub.status()
            now = ("receiving" if st.last_rx_age is not None and st.last_rx_age < 1.5
                   else "waiting" if st.packets == 0 else "no signal")
            if now != state:
                state = now
                extra = f" ({st.pps:.0f} packets/s)" if now == "receiving" else ""
                viewers = f", {web.client_count} viewer(s)" if web else ""
                print(f"[{time.strftime('%H:%M:%S')}] {now}{extra}{viewers}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        if web:
            web.stop()
        hub.stop()
    print("bye")
    return 0


if __name__ == "__main__":     # pragma: no cover
    raise SystemExit(main())
