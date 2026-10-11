"""Shared pytest fixtures."""

from __future__ import annotations

import os
import socket

# Must be set before Qt is imported anywhere.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest


def free_udp_port() -> int:
    """A currently unused UDP port on loopback."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(autouse=True, scope="session")
def _isolate_error_log(tmp_path_factory):
    """Never write test failures into the user's real %LOCALAPPDATA% log."""
    from fh6_telemetry.core import diagnostics

    diagnostics._log_path = tmp_path_factory.mktemp("logs") / "error.log"
    yield


@pytest.fixture(scope="session")
def qapp():
    from PyQt6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    app.setStyle("Fusion")
    yield app


@pytest.fixture()
def tmp_config(tmp_path):
    from fh6_telemetry.core.config import Config

    return Config(tmp_path / "config.json")
