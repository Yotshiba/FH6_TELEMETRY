"""Regenerate tests/js/hello.json: the server's real ``hello`` event, used by the front-end smoke tests.

    python tools/dump_hello_fixture.py

tests/test_web_extras.py fails when the committed fixture no longer matches ``protocol.hello()``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fh6_telemetry.web import protocol as P  # noqa: E402

FIXTURE = ROOT / "tests" / "js" / "hello.json"


def build() -> str:
    payload = P.hello(epoch=1, tick_hz=30.0, resume=False, ranges={})
    return json.dumps(payload, indent=1, sort_keys=True) + "\n"


if __name__ == "__main__":
    FIXTURE.write_text(build(), encoding="utf-8", newline="\n")
    print(f"wrote {FIXTURE} ({FIXTURE.stat().st_size} bytes)")
