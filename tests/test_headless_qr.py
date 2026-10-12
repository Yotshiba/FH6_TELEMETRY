"""Headless mode prints a QR code for the dashboard address (and degrades gracefully on a legacy console)."""

from __future__ import annotations

import io
import socket
import sys
import threading

import pytest

from fh6_telemetry import headless
from fh6_telemetry.core import qr


def _free_port(kind: int) -> int:
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_qr_art_uses_blocks_where_the_console_can_print_them():
    art = headless.qr_art("http://192.168.1.101:8077/", "utf-8")
    lines = art.split("\n")
    code = qr.encode("http://192.168.1.101:8077/", "M")
    assert len(lines) == (code.size + 4 + 1) // 2
    assert {len(x) for x in lines} == {code.size + 4}
    assert set("".join(lines)) <= set("█▀▄ ")


def test_qr_art_falls_back_to_plain_ascii_on_a_legacy_console():
    art = headless.qr_art("http://192.168.1.101:8077/", "cp1252")
    assert art and all(ord(c) < 128 for c in art)
    assert set(art) <= set("# \n")


def test_qr_art_never_raises():
    assert headless.qr_art("x" * 5000, "utf-8") == ""         # too long for a QR code: no art, no exception


def test_print_qr_retries_in_ascii_when_the_console_rejects_the_blocks(monkeypatch):
    raw = io.BytesIO()
    legacy = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", newline="\n")
    monkeypatch.setattr(sys, "stdout", legacy)
    real = qr.can_print_blocks
    monkeypatch.setattr(qr, "can_print_blocks", lambda enc: True if enc == "cp1252" else real(enc))   # claims it can, cannot
    headless.print_qr("http://192.168.1.101:8077/")
    legacy.flush()
    text = raw.getvalue().decode("cp1252")
    assert "scan this with your phone" in text and "##" in text and "█" not in text


@pytest.mark.parametrize("flag, expect_qr", [([], True), (["--no-qr"], False)])
def test_main_prints_the_address_and_the_qr_code(monkeypatch, tmp_path, capsys, flag, expect_qr):
    monkeypatch.setenv("APPDATA", str(tmp_path))                     # never read or write the user's real config
    stop = threading.Event()
    stop.set()                                                       # start, print the banner, shut down at once
    rc = headless.main(
        ["--udp-host", "127.0.0.1", "--udp-port", str(_free_port(socket.SOCK_DGRAM)),
         "--bind", "127.0.0.1", "--http-port", str(_free_port(socket.SOCK_STREAM)), "--no-low-impact", *flag],
        stop=stop,
    )
    out = capsys.readouterr().out
    assert rc == 0
    assert "dashboard : http://" in out and "Press Ctrl+C" in out
    assert ("scan this with your phone" in out) == expect_qr
    if expect_qr:
        banner_end = out.index("Press Ctrl+C")
        art = out[out.index("scan this"):banner_end]
        assert art.count("\n") > 12                                  # a whole symbol
