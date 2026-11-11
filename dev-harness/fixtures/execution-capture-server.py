"""Real ACC tools/SDK with bounded test-owned journal rendezvous and one IO fault.

Never replaces a tool, native packet, decoder result or product authorization decision.
Only the explicitly owned fixture root may select the instrumented boundary.
"""
import json
import base64
import hashlib
import os
from pathlib import Path
import time

from ai_computer_control import server
from ai_computer_control.utils import execution_journal as journal
from ai_computer_control.utils import macos_session
from ai_computer_control.utils.execution_context import request_cancellation
from ai_computer_control.utils.execution_journal import current_operation
from ai_computer_control.tools import macos_capture

root = Path(os.environ['RUYI_CAPTURE_TEST_ROOT'])
if not root.is_absolute() or not root.is_dir():
    raise RuntimeError('owned capture fixture root required')
control = root / 'control.json'
original = journal.ReceiptJournal.append
fired = False
prepared = {}
original_fields = macos_capture._fields


def observe_fields(*args, **kwargs):
    value = original_fields(*args, **kwargs)
    config = json.loads(control.read_text()) if control.exists() else {}
    if config.get('kind') == 'large_image':
        # Observe the actual capture tool's final encoded image, before display
        # shrinking. Return the exact same object; never replace image bytes.
        image = base64.b64decode(value['image'], validate=True)
        (root / 'capture-large.png').write_bytes(image)
        (root / 'capture-large.json').write_text(json.dumps({'invocationId': current_operation()['journal'].invocation_id,
            'base64Chars': len(value['image']), 'bytes': len(image), 'sha256': hashlib.sha256(image).hexdigest()}))
    return value


def append(trace, stage, *args, **kwargs):
    global fired
    config = json.loads(control.read_text()) if control.exists() else {}
    kind = config.get('kind')
    target = {'entry_stop': 'native_entered', 'continue_stop': 'native_continue_sent',
              'native_terminal_eio': 'native_terminal'}.get(kind)
    if fired or stage != target:
        value = original(trace, stage, *args, **kwargs)
        if stage == 'native_prepared':
            prepared[value['operation_id']] = value['at']
        return value
    fired = True
    if kind == 'native_terminal_eio':
        (root / 'capture-fault.json').write_text(json.dumps({'kind': kind, 'invocationId': trace.invocation_id,
            'stage': stage, 'operationId': args[0], 'terminalFields': kwargs}))
        raise journal.ExecutionJournalError('execution_journal_io', 'isolated native terminal commit failure')
    result = original(trace, stage, *args, **kwargs)
    session = macos_session._SESSION
    opened = time.time() * 1000
    deadline = time.monotonic() + 5.
    (root / 'capture-gate.json').write_text(json.dumps({'kind': kind, 'invocationId': trace.invocation_id,
        'stage': stage, 'operationId': args[0], 'nativePid': session['child'].pid, 'accPid': os.getpid(),
        'helper': str(session['path']), 'frame': result, 'preparedAt': prepared[args[0]],
        'openedUnixMs': opened, 'deadlineUnixMs': opened + 5000}))
    event, _ = request_cancellation()
    while not (root / 'capture-release').exists() and not (event is not None and event.is_set()):
        if time.monotonic() > deadline:
            (root / 'capture-gate-exit.json').write_text(json.dumps({'reason': 'timeout', 'unixMs': time.time() * 1000}))
            raise RuntimeError('bounded actual native capture fixture rendezvous exceeded')
        time.sleep(.01)
    (root / 'capture-gate-exit.json').write_text(json.dumps({'reason': 'cancel' if event is not None and event.is_set() else 'manual', 'unixMs': time.time() * 1000}))
    return result


journal.ReceiptJournal.append = append
macos_capture._fields = observe_fields
server.main()
