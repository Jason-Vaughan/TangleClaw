#!/usr/bin/env python3
"""Backward-compat shim — delegates to prawduct-setup.py.

Existing product-hooks reference this file by name for CLI invocation.
Test files and other scripts may also import from this module.
After one sync cycle, product-hook updates to call prawduct-setup.py directly.
"""

import importlib.util as _ilu
import sys as _sys
from pathlib import Path as _Path

# Load prawduct-setup.py and re-export its entire namespace
_setup_path = _Path(__file__).resolve().parent / "prawduct-setup.py"
_spec = _ilu.spec_from_file_location("_prawduct_setup_inner", _setup_path)
_setup_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_setup_mod)

# Copy all public (and selected private) names into this module's globals
_g = globals()
for _name in dir(_setup_mod):
    if not _name.startswith("_") or _name in (
        "_bootstrap_manifest", "_resolve_framework_dir", "_try_pull_framework",
    ):
        _g[_name] = getattr(_setup_mod, _name)

# CLI: delegate to prawduct-setup.py sync
if __name__ == "__main__":
    import os
    os.execv(_sys.executable, [_sys.executable, str(_setup_path), "sync"] + _sys.argv[1:])
