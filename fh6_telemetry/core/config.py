"""
Persisted settings as a small JSON file shared by the desktop app and the
headless mode (``QSettings`` would tie them to Qt).

Location: ``%APPDATA%\\FH6Telemetry\\config.json`` (``~/.config`` elsewhere).
Unknown keys are dropped, invalid values fall back to their default, a corrupt
file is moved aside to ``config.json.bak`` — loading never raises.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from ..constants import HOST, PORT

# key -> (default, validator)
_SCHEMA: dict[str, tuple[Any, Any]] = {
    "udp_host": (HOST, lambda v: isinstance(v, str) and 0 < len(v) <= 255),
    "udp_port": (PORT, lambda v: isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 65535),
    "refresh_hz": (20, lambda v: v in (10, 15, 20, 30, 60)),
    "low_impact": (None, lambda v: v is None or isinstance(v, bool)),  # None = auto
    "chart_style": ("thin", lambda v: v in ("thin", "bold")),
    "web_enabled": (False, lambda v: isinstance(v, bool)),
    "web_port": (8077, lambda v: isinstance(v, int) and not isinstance(v, bool) and 1024 <= v <= 65535),
    "web_rate_hz": (30, lambda v: v in (15, 30, 60)),
}

DEFAULTS: dict[str, Any] = {k: d for k, (d, _) in _SCHEMA.items()}


def config_path() -> Path:
    base = os.environ.get("APPDATA")
    root = Path(base) if base else Path.home() / ".config"
    return root / "FH6Telemetry" / "config.json"


class Config:
    """Dict-like settings object backed by a JSON file."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else config_path()
        self.values: dict[str, Any] = dict(DEFAULTS)

    # -- access ------------------------------------------------------------
    def __getitem__(self, key: str) -> Any:
        return self.values[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)

    def set(self, key: str, value: Any) -> bool:
        """Set a known key; returns False (and ignores it) if invalid."""
        spec = _SCHEMA.get(key)
        if spec is None or not spec[1](value):
            return False
        self.values[key] = value
        return True

    # -- persistence -------------------------------------------------------
    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        cfg = cls(path)
        try:
            raw = cfg.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return cfg
        except OSError:
            return cfg
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("config root must be an object")
        except (ValueError, TypeError):
            try:
                cfg.path.replace(cfg.path.with_suffix(".json.bak"))
            except OSError:
                pass
            return cfg
        for key, value in data.items():
            cfg.set(key, value)
        return cfg

    def save(self) -> bool:
        """Atomically write the file; returns False on failure (never raises)."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self.values, fh, indent=2, sort_keys=True)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            return True
        except Exception:
            return False
