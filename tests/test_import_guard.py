"""The Qt-free core must import without PyQt6 / pyqtgraph / numpy."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MODULES = [
    "fh6_telemetry.constants",
    "fh6_telemetry.telemetry",
    "fh6_telemetry.core.charts",
    "fh6_telemetry.core.config",
    "fh6_telemetry.core.derive",
    "fh6_telemetry.core.diagnostics",
    "fh6_telemetry.core.frames",
    "fh6_telemetry.core.hub",
    "fh6_telemetry.core.lowimpact",
    "fh6_telemetry.core.netinfo",
    "fh6_telemetry.core.range_smoother",
    "fh6_telemetry.core.udp_source",
    "fh6_telemetry.web.protocol",
    "fh6_telemetry.web.server",
    "fh6_telemetry.headless",
]


def test_core_imports_are_free_of_gui_and_numpy():
    code = (
        "import sys\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"   # -I ignores PYTHONPATH and cwd
        + "".join(f"import {m}\n" for m in MODULES)
        + "bad = [m for m in ('PyQt6', 'pyqtgraph', 'numpy') if m in sys.modules]\n"
        "print(','.join(bad))\n"
        "sys.exit(1 if bad else 0)\n"
    )
    env = {"SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
    res = subprocess.run(
        [sys.executable, "-I", "-c", code], cwd=ROOT, capture_output=True, text=True, env=env
    )
    assert res.returncode == 0, f"GUI/numpy leaked into core: {res.stdout} {res.stderr}"
