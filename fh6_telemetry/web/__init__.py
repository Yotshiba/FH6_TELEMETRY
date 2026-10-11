"""
LAN web dashboard — a read-only Server-Sent-Events stream plus a static page.

Everything here is standard library only (no Qt, no numpy) so the headless
build stays small.  ``tests/test_import_guard.py`` enforces that.
"""
