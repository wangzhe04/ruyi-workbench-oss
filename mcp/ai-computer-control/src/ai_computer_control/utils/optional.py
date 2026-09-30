"""Availability of heavy optional dependencies without importing them.

Importing matplotlib/pptx/cv2+numpy/playwright at server start cost ~0.7 s (Linux; more on a cold Windows
box) even in sessions that never touch a chart, deck or template match, and the workbench's detection probe
runs against a tight start budget. Tool modules therefore decide ``_AVAILABLE`` here with ``find_spec`` (a
file-system lookup) and do the real import on first use inside the tool that needs it.
"""

import importlib.util
import sys


def module_available(*names: str) -> tuple[bool, str]:
    """``(available, reason)`` — True only if every named top-level module can be located (not imported)."""
    for name in names:
        if sys.modules.get(name) is not None:
            continue
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError, AttributeError):
            found = False
        if not found:
            return False, f"No module named '{name}'"
    return True, ""
