"""
``python -m fh6_telemetry``           desktop dashboard (Qt)
``python -m fh6_telemetry --headless`` hub + LAN web dashboard only (no Qt)

The GUI and headless modules are imported lazily so a headless run never loads
PyQt6, pyqtgraph or numpy.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--headless" in args:
        args.remove("--headless")
        from .headless import main as headless_main

        return headless_main(args)
    from .launcher import main as gui_main

    gui_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
