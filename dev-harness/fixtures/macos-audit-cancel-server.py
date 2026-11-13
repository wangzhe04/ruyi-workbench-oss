"""Actual ACC stdio with a bounded observation barrier for cooperative-cancel regression."""
from pathlib import Path
import os
import time

import ai_computer_control.server as server
from ai_computer_control.tools import macos_act_and_verify as act

root = Path(os.environ['WCW_DATA_DIR']) / 'cancel-barrier'
root.mkdir(parents=True, exist_ok=True)
original_capture, original_after = act.capture_frame, act._after


def barrier(phase):
    if (root / 'phase').read_text() != phase:
        return
    (root / 'entered').write_text(phase)
    deadline = time.monotonic() + 10
    while not (root / 'release').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('Owned observation barrier expired')
        time.sleep(.01)


def capture(*args):
    phase = (root / 'phase').read_text()
    try:
        if phase in ('before', 'macro-before'):
            barrier(phase)
        return original_capture(*args)
    finally:
        if phase in ('before', 'macro-before'):
            (root / 'finished').write_text(phase)


def after(*args):
    try:
        barrier('after')
        return original_after(*args)
    finally:
        (root / 'finished').write_text('after')


act.capture_frame, act._after = capture, after
server.main()
