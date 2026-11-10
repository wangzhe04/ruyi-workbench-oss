"""Native controlled-input recording with fresh-target replay through macro_run."""
import json
import os
from pathlib import Path
import re
import stat
import uuid
from pydantic import StrictFloat, StrictInt

from ai_computer_control.paths import data_dir
from ai_computer_control.server import mcp
from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.macos_recording import validate_recording, recording_gate
from ai_computer_control.utils.macos_session import request


def _name(value):
    if not isinstance(value, str):
        raise DesktopError('invalid_args', 'save_as must be a macro name')
    name = value[:-5] if value.lower().endswith('.json') else value
    if not re.fullmatch(r'[\w -]{1,80}', name, re.UNICODE) or not name.strip():
        raise DesktopError('invalid_args', 'Use a 1–80 character macro name with letters, digits, spaces, underscores or hyphens')
    return name + '.json'


def _directory():
    path = Path(data_dir()) / 'macros'
    path.mkdir(mode=0o700, exist_ok=True)
    return path, os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _save(name, recording):
    path, directory = _directory()
    temporary = '.' + uuid.uuid4().hex + '.tmp'
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write((json.dumps(recording, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        return str(path / name)
    finally:
        try:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
        finally:
            os.close(directory)


@mcp.tool(audit=True)
def record_start(target: dict, max_seconds: StrictFloat | StrictInt = 60) -> dict:
    """Record this MCP worker's controlled Mac inputs into one currently focused window.

    Pass a complete current target. Captures successful native text, shortcuts, clicks, pointer movement,
    drags and scroll requests, including those issued by composed tools. Source is controlled_native_requests.
    Bounds are 1–300 seconds, 100 actions and 48000 action JSON bytes. Focus/identity/geometry changes,
    secure input, lock, permission loss or a failed input invalidate the recording. Call record_stop to collect it.
    """
    with recording_gate():
        return request({'op': 'record.start', 'target': target, 'max_seconds': max_seconds})


@mcp.tool(audit=True)
def record_stop(save_as: str | None = None) -> dict:
    """Collect the native recording. Pass its recording object and a fresh target to macro_run.

    save_as optionally atomically saves a complete recording in the internal data/macros directory.
    An interrupted recording is returned with complete=false and its reason. Save failures retain the
    collected in-memory recording in this response. The source contains text supplied to controlled input.
    """
    name = _name(save_as) if save_as is not None else None
    result = request({'op': 'record.stop'})
    recording = result['recording']
    out = {**result, 'count': len(recording['actions']), 'complete': recording['complete']}
    if name is not None:
        try:
            validate_recording(recording)
            path = _save(name, recording)
            out.update(path=path, output_path=path, saved_as=name[:-5])
        except (DesktopError, OSError) as error:
            out.update(save_error=str(error), saved=None)
    return out


@mcp.tool()
def macro_list() -> dict:
    """List bounded metadata for up to 200 internal saved Mac recordings.

    Read a selected JSON file and pass the recording object to macro_run(recording=..., target=...).
    Symlink/non-regular files and oversized or invalid records are listed as invalid.
    """
    path, directory = _directory()
    macros = []
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.lower().endswith('.json'):
                    names.append(entry.name)
                    if len(names) > 200:
                        break
        names.sort()
        for name in names[:200]:
            entry = {'name': name[:-5], 'path': str(path / name), 'valid': False}
            try:
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(descriptor, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode) or before.st_size > 128000:
                        raise ValueError('invalid macro file')
                    data = stream.read(128001)
                    after = os.fstat(stream.fileno())
                    if len(data) > 128000 or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError('macro changed during read')
                recording = json.loads(data)
                validate_recording(recording)
                entry.update(valid=True, steps=len(recording['actions']), source=recording['source'])
            except (OSError, ValueError, DesktopError, RecursionError):
                pass
            macros.append(entry)
        return {'ok': True, 'count': len(macros), 'macros': macros, 'truncated': len(names) > 200}
    finally:
        os.close(directory)
