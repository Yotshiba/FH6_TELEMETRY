"""
FH6 Telemetry — headless entry point (console build, no Qt).

Usage:  python headless_ui.py [--udp-host H] [--udp-port P] [--http-port P]

PyInstaller cannot use ``fh6_telemetry/__main__.py`` as an entry script because
of its relative imports, so (like ``dashboard_multi_ui.py``) this thin shim
calls into the package.
"""

from fh6_telemetry.headless import main

if __name__ == "__main__":
    raise SystemExit(main())
