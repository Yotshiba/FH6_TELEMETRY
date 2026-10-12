"""Run the JavaScript unit tests (node:test) for the web front-end's pure-logic modules."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
JS_TESTS = ROOT / "tests" / "js"

# The tests (.mjs) import the front-end's plain ``.js`` files, which are ES modules but have no package.json
# saying so.  Node only loads those once it detects the module syntax (on by default since Node 22.7 and 20.19;
# before that they fail with "Named export ... not found ... is a CommonJS module").  Probe the capability itself
# instead of parsing version numbers, so a back-ported or flag-enabled Node is handled too.
_PROBE_DEP = "export const answer = 42;\n"
_PROBE_MAIN = "import { answer } from './dep.js';\nif (answer !== 42) process.exit(2);\n"
_NEEDS = "needs Node >= 20.19 or >= 22.7 (ES-module syntax detection for .js files)"


@lru_cache(maxsize=None)
def _esm_detection(node_args: tuple[str, ...] = ()) -> tuple[bool, str]:
    """(supported, description of the Node found); never raises."""
    node = shutil.which("node")
    if node is None:
        return False, "node is not installed"
    try:
        version = subprocess.run(
            [node, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        ).stdout.strip() or "unknown version"
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "dep.js").write_text(_PROBE_DEP, encoding="utf-8")
            (Path(tmp) / "probe.mjs").write_text(_PROBE_MAIN, encoding="utf-8")
            res = subprocess.run(
                [node, *node_args, str(Path(tmp) / "probe.mjs")], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
    except (OSError, subprocess.SubprocessError):
        return False, "node could not be run"
    return res.returncode == 0, f"Node {version}"


def test_node_unit_tests_pass():
    ok, found = _esm_detection()
    if not ok:
        pytest.skip(f"{found}: {_NEEDS}" if shutil.which("node") else found)
    files = sorted(str(p) for p in JS_TESTS.glob("*.test.mjs"))
    if not files:
        pytest.skip("no JS tests yet")
    res = subprocess.run(
        ["node", "--test", *files], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    assert res.returncode == 0, res.stdout[-4000:] + res.stderr[-2000:]


def test_the_node_gate_rejects_a_node_without_module_detection():
    """With detection switched off (or an option too old to know) the probe must say 'unsupported', not crash."""
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    ok, found = _esm_detection(("--no-experimental-detect-module",))
    assert ok is False and found.startswith("Node")
