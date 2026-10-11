# -*- mode: python ; coding: utf-8 -*-
#
# Console build of the headless mode: UDP hub + LAN web dashboard, no Qt, no NumPy.
#
#   python -m PyInstaller FH6_Telemetry_Headless.spec
#   -> dist/FH6_Telemetry_Headless.exe
#
# The entry point is the thin shim headless_ui.py (PyInstaller cannot use a package
# __main__.py because of its relative imports).

a = Analysis(
    ['headless_ui.py'],
    pathex=[],
    binaries=[],
    # The web page is served from files next to the package, so they must be bundled.
    datas=[('fh6_telemetry/web/static', 'fh6_telemetry/web/static')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # The headless path never imports these; excluding them keeps the exe small and
    # makes an accidental import fail loudly at build/test time.
    excludes=['PyQt6', 'pyqtgraph', 'numpy', 'tkinter', 'unittest', 'pydoc'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='FH6_Telemetry_Headless',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
