"""Config: defaults, validation, atomic save, corrupt-file recovery."""

from __future__ import annotations

import json

from fh6_telemetry.core.config import DEFAULTS, Config


def test_missing_file_gives_defaults(tmp_path):
    cfg = Config.load(tmp_path / "nope.json")
    assert cfg.values == DEFAULTS


def test_round_trip(tmp_path):
    p = tmp_path / "c.json"
    cfg = Config(p)
    assert cfg.set("udp_host", "192.168.1.10") and cfg.set("udp_port", 20123)
    assert cfg.set("web_enabled", True) and cfg.set("refresh_hz", 30)
    assert cfg.save()
    again = Config.load(p)
    assert again["udp_host"] == "192.168.1.10" and again["udp_port"] == 20123
    assert again["web_enabled"] is True and again["refresh_hz"] == 30


def test_invalid_values_are_rejected_and_defaults_kept(tmp_path):
    cfg = Config(tmp_path / "c.json")
    assert not cfg.set("udp_port", 70000)
    assert not cfg.set("udp_port", True)          # bool is not a port
    assert not cfg.set("refresh_hz", 17)
    assert not cfg.set("nonsense", 1)
    assert cfg["udp_port"] == DEFAULTS["udp_port"]


def test_unknown_and_invalid_keys_in_file_are_ignored(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"udp_port": "abc", "evil": 1, "udp_host": "10.0.0.5"}))
    cfg = Config.load(p)
    assert cfg["udp_port"] == DEFAULTS["udp_port"] and cfg["udp_host"] == "10.0.0.5"
    assert "evil" not in cfg.values


def test_corrupt_file_is_moved_aside(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("{not json")
    cfg = Config.load(p)
    assert cfg.values == DEFAULTS
    assert (tmp_path / "c.json.bak").exists() and not p.exists()


def test_non_object_json_is_treated_as_corrupt(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("[1,2,3]")
    assert Config.load(p).values == DEFAULTS


def test_save_failure_returns_false_instead_of_raising(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    cfg = Config(blocker / "sub" / "c.json")   # parent is a file -> cannot mkdir
    assert cfg.save() is False
