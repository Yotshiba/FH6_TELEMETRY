"""
Qt-free core of the dashboard.

Everything in this package (and in ``fh6_telemetry.web``) must import without
PyQt6, pyqtgraph or numpy so that a headless build can run on its own.  A test
(``tests/test_import_guard.py``) enforces that.
"""
