"""Static consistency checks for the 'web improvement' front-end (cockpit, map, lab, themes, PWA ...).

No browser needed: these catch the integration slips that unit tests of single modules cannot -- an import of a
name that is not exported, a column the server never sends, a theme without CSS, a missing icon.
"""

from __future__ import annotations

import json
import re
import struct
from pathlib import Path

from fh6_telemetry.web import protocol as P

STATIC = Path(__file__).resolve().parent.parent / "fh6_telemetry" / "web" / "static"
WHEELS = ("FL", "FR", "RL", "RR")


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def _exports(text: str) -> set[str]:
    names = set(re.findall(r"^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+(\w+)", text, re.M))
    for block in re.findall(r"^export\s*\{([^}]*)\}", text, re.M):
        for part in block.split(","):
            part = part.strip()
            if part:
                names.add(part.split(" as ")[-1].strip())
    return names


def test_named_imports_are_exported_by_the_target_module():
    exports = {js.name: _exports(js.read_text(encoding="utf-8")) for js in STATIC.glob("*.js")}
    checked = 0
    for js in STATIC.glob("*.js"):
        text = js.read_text(encoding="utf-8")
        for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*'\./([\w.-]+)'", text):
            for part in m.group(1).split(","):
                name = part.strip().split(" as ")[0].strip()
                if not name:
                    continue
                checked += 1
                assert name in exports.get(m.group(2), set()), (
                    f"{js.name} imports {name!r} which {m.group(2)} does not export"
                )
    assert checked > 50


def _columns(text: str, kind: str) -> set[str]:
    """Column keys a module reads: store.f('X'), store.f('X' + w), F.X (kind 'f') or the slow equivalents."""
    letter = "f" if kind == "f" else "s"
    big = "F" if kind == "f" else "S"
    keys = set(re.findall(rf"(?:store|st)\.{letter}\('(\w+)'\)", text))
    for prefix in re.findall(rf"(?:store|st)\.{letter}\('(\w+)' \+ \w+\)", text):
        keys |= {prefix + w for w in WHEELS}
    keys |= set(re.findall(rf"\b(?:store\.)?{big}\.(\w+)\b", text))
    return {k for k in keys if k[:1].isupper()}


def test_extra_modules_only_read_columns_the_server_sends():
    fast, slow = set(P.FAST_INDEX), set(P.SLOW_INDEX)
    seen = 0
    for js in STATIC.glob("*.js"):
        if js.name == "views.js":                                  # covered by test_web_static.py
            continue
        text = js.read_text(encoding="utf-8")
        used_f, used_s = _columns(text, "f"), _columns(text, "s")
        seen += len(used_f) + len(used_s)
        assert used_f <= fast, f"{js.name} reads unknown fast columns: {sorted(used_f - fast)}"
        assert used_s <= slow, f"{js.name} reads unknown slow columns: {sorted(used_s - slow)}"
    assert seen > 20


def test_every_theme_has_css():
    block = _read("settings.js").split("export const THEMES")[1].split("];")[0]
    themes = re.findall(r"id: '(\w+)'", block)
    assert len(themes) >= 6
    css = _read("themes.css")
    for tid in [*themes, "hyperdrive"]:
        if tid == "neon":
            continue                                                # the default theme lives in :root
        assert f'data-theme="{tid}"' in css, f"themes.css has no rule for {tid}"


def test_the_new_views_are_built_and_registered():
    """The import line alone does not make a tab: the view must be *built* (``buildX(ctx)``) in app.js."""
    app = _read("app.js")
    for view in ("buildCockpit", "buildMap", "buildLab", "buildCar", "buildTimeline"):
        assert re.search(rf"\bimport\s*\{{[^}}]*\b{view}\b[^}}]*\}}", app), f"app.js does not import {view}"
        assert re.search(rf"\b{view}\(ctx\)", app), f"app.js imports {view} but never builds it (no {view}(ctx))"


def test_trophy_badges_do_not_clobber_the_tyre_badges():
    """Both once used '.badge': the tyre RUMBLE / PUDDLE chips turned into 44 px squares."""
    assert re.search(r"^\.badge\b", _read("app.css"), re.M)
    for css in ("extras.css", "themes.css"):
        assert not re.search(r"^\.badge\b", _read(css), re.M), css


def test_manifest_and_icons_are_installable():
    manifest = json.loads(_read("manifest.webmanifest"))
    assert manifest["display"] in {"standalone", "fullscreen"}
    assert manifest["start_url"] == "/"
    sizes = set()
    for icon in manifest["icons"]:
        path = STATIC / icon["src"].removeprefix("/static/")
        assert path.is_file(), icon
        if icon["type"] == "image/png":
            data = path.read_bytes()
            assert data[:8] == b"\x89PNG\r\n\x1a\n"
            w, h = struct.unpack(">II", data[16:24])
            assert f"{w}x{h}" == icon["sizes"], icon
            sizes.add(icon["sizes"])
    assert {"192x192", "512x512"} <= sizes
    html = _read("index.html")
    assert 'rel="manifest"' in html and "manifest.webmanifest" in html
    assert (STATIC / "apple-touch-icon.png").is_file() and "apple-touch-icon" in html


def test_hello_fixture_matches_the_server_payload():
    """tests/js/hello.json feeds the view smoke tests; refresh it with `python tools/dump_hello_fixture.py`."""
    from tools.dump_hello_fixture import FIXTURE, build

    assert FIXTURE.read_text(encoding="utf-8") == build(), "stale tests/js/hello.json: run tools/dump_hello_fixture.py"
