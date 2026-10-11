"""Run the JavaScript unit tests (node:test) for the web front-end's pure-logic modules."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
JS_TESTS = ROOT / "tests" / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_node_unit_tests_pass():
    files = sorted(str(p) for p in JS_TESTS.glob("*.test.mjs"))
    if not files:
        pytest.skip("no JS tests yet")
    res = subprocess.run(
        ["node", "--test", *files], cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert res.returncode == 0, res.stdout[-4000:] + res.stderr[-2000:]
