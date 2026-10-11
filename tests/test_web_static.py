"""The static front-end stays consistent with the server's protocol (no browser needed)."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from fh6_telemetry.core.charts import CHARTS
from fh6_telemetry.web import protocol as P

STATIC = Path(__file__).resolve().parent.parent / "fh6_telemetry" / "web" / "static"
WHEELS = ("FL", "FR", "RL", "RR")


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_index_references_only_existing_assets():
    html = _read("index.html")
    refs = re.findall(r'(?:src|href)="(/static/[^"]+)"', html)
    assert refs, "index.html should load its css/js"
    for ref in refs:
        assert (STATIC / ref.removeprefix("/static/")).is_file(), ref


def test_every_static_file_is_served_text_utf8():
    for path in STATIC.rglob("*"):
        if path.suffix in {".html", ".css", ".js"}:
            path.read_text(encoding="utf-8")                  # must be valid UTF-8


def test_js_module_imports_resolve():
    for js in STATIC.glob("*.js"):
        for m in re.finditer(r"from '\./([\w.-]+)'", js.read_text(encoding="utf-8")):
            assert (STATIC / m.group(1)).is_file(), f"{js.name} imports missing {m.group(1)}"


def _keys(pattern: str, text: str) -> set[str]:
    return set(re.findall(pattern, text))


def test_views_only_read_columns_the_server_actually_sends():
    text = _read("views.js")
    fast, slow = set(P.FAST_INDEX), set(P.SLOW_INDEX)
    used_f = _keys(r"\bF\('(\w+)'\)", text) | _keys(r"store\.f\('(\w+)'\)", text)
    used_s = _keys(r"\bS\('(\w+)'\)", text) | _keys(r"store\.s\('(\w+)'\)", text)
    # 'Prefix' + w  (per wheel)
    for prefix in _keys(r"\bF\('(\w+)' \+ w\)", text):
        used_f |= {prefix + w for w in WHEELS}
    for prefix in _keys(r"\bS\('(\w+)' \+ w\)", text):
        used_s |= {prefix + w for w in WHEELS}
    for prefix in _keys(r"\bS\(b\.key \+ w\)", text):          # bars: slip ratio/angle/combined
        pass
    assert used_f and used_s
    assert used_f <= fast, f"views.js reads unknown fast columns: {sorted(used_f - fast)}"
    assert used_s <= slow, f"views.js reads unknown slow columns: {sorted(used_s - slow)}"


def test_bar_and_input_definitions_from_the_server_resolve_to_columns():
    ui = P.static_ui()
    for b in ui["bars"]:                                       # tyre bars: <key><wheel>
        src = P.FAST_INDEX if b["key"] == "SuspNorm" else P.SLOW_INDEX
        for w in WHEELS:
            assert b["key"] + w in src, b
    for i in ui["inputs"]:
        assert i["key"] in (P.SLOW_INDEX if i.get("slow") else P.FAST_INDEX), i


def test_chart_ids_used_by_the_views_exist():
    ids = set(re.findall(r"chartCard\(store, charts, '(\w+)'", _read("views.js")))
    assert ids and ids <= set(CHARTS), ids - set(CHARTS)
    assert set(CHARTS) <= ids, "every desktop chart should appear somewhere on the web"


def test_stream_handles_every_event_the_server_can_send():
    events = set(re.findall(r"'(\w+)'", re.search(r"const EVENTS = \[(.*?)\]", _read("stream.js"), re.S).group(1)))
    assert events == {"hello", "hist", "f", "s", "rg", "st", "reset"}
    app = _read("app.js")
    for ev in ("hello", "hist", "f", "s", "rg", "st", "reset"):
        assert re.search(rf"\b{ev}:", app), f"app.js does not handle '{ev}'"


def test_views_use_namespaced_root_classes():
    """A root class equal to an inner class (e.g. 'tyres') once overrode display:none."""
    assert "'view v-' + id" in _read("views.js")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_javascript_parses(tmp_path):
    for js in sorted(STATIC.glob("*.js")):
        mjs = tmp_path / (js.stem + ".mjs")
        shutil.copy(js, mjs)
        res = subprocess.run(["node", "--check", str(mjs)], capture_output=True, text=True)
        assert res.returncode == 0, f"{js.name}: {res.stderr}"
