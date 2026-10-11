"""
record_udp — capture a real Forza "Data Out" session to a file so it can be
replayed later with ``fake_forza.py --replay``.

Usage
-----
    python tools/record_udp.py session.fh6rec --duration 180
    python tools/record_udp.py session.fh6rec --port 20077 --forward 127.0.0.1:20078

The recorder binds the Data Out port itself, so close the dashboard first —
or point the game at this recorder and use ``--forward`` to relay every
datagram to the dashboard (listening on another port) while recording.

During the capture, try to exercise: main menu, pause menu, photo mode, a car
swap, a race start, a crash/reset.  The recording is the ground truth for what
the game really sends (e.g. whether packets keep arriving while paused).

File format: ``FH6REC1\\n`` then repeated ``<u32 payload_length><f64 monotonic
seconds><payload bytes>``.
"""

from __future__ import annotations

import argparse
import socket
import struct
import sys
import time
from pathlib import Path

REC_MAGIC = b"FH6REC1\n"
_REC_HDR = struct.Struct("<Id")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("output", help="recording file to write")
    ap.add_argument("--host", default="127.0.0.1", help="address to bind")
    ap.add_argument("--port", type=int, default=20077)
    ap.add_argument("--duration", type=float, default=0.0,
                    help="stop after N seconds (0 = until Ctrl+C)")
    ap.add_argument("--forward", metavar="HOST:PORT",
                    help="relay each datagram to this address as well")
    args = ap.parse_args(argv)

    fwd = None
    if args.forward:
        h, _, p = args.forward.rpartition(":")
        fwd = (h or "127.0.0.1", int(p))

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))
    sock.settimeout(0.5)
    print(f"recording {args.host}:{args.port} -> {args.output} (Ctrl+C to stop)",
          file=sys.stderr)

    n = 0
    sizes: dict[int, int] = {}
    t_start = time.monotonic()
    with open(Path(args.output), "wb") as fh:
        fh.write(REC_MAGIC)
        try:
            while True:
                if args.duration and time.monotonic() - t_start >= args.duration:
                    break
                try:
                    data, _ = sock.recvfrom(4096)
                except socket.timeout:
                    continue
                now = time.monotonic()
                fh.write(_REC_HDR.pack(len(data), now))
                fh.write(data)
                if fwd:
                    sock.sendto(data, fwd)
                n += 1
                sizes[len(data)] = sizes.get(len(data), 0) + 1
        except KeyboardInterrupt:
            pass
    elapsed = time.monotonic() - t_start
    print(f"recorded {n} datagrams in {elapsed:.1f}s; sizes: {sizes}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
