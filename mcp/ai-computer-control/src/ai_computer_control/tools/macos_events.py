"""Target-bound Mac keyboard and pointer tools."""
import asyncio
import threading
import anyio

from ai_computer_control.server import mcp
from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.errors import ToolCancelled
from ai_computer_control.utils.macos_session import request
from ai_computer_control.utils.text_input import _route_clipboard, _split_trailing_enter, parse_macos_keys as _keys, MACOS_RECORDED_KEY_FLAGS
from pydantic import StrictInt
from ai_computer_control.utils.macos_sequence import validate_events


@mcp.tool(audit=True)
def type_text(text: str, target: dict, interval: float = 0.02, use_clipboard: bool | None = None,
              input_source: dict | None = None) -> dict:
    """Enter text in the already-focused Mac window identified by its complete current target.

    Auto routing uses Cmd+V for Chinese/non-ASCII, multiline or long text. Paste preserves all prior
    clipboard formats within a 32 MiB snapshot and restores only while its own version is current.
    use_clipboard=False sends Unicode keyboard events, including Chinese. A trailing newline in an
    auto-pasted single line becomes Enter. Explicit paste preserves all newlines verbatim.
    Text is bounded by 48000 UTF-8 bytes. Per-key interval is 0..0.2 seconds with a five-second typing budget.
    Focus, process identity and window geometry are checked during the sequence. Success reports events
    posted. Observe the target application's result to confirm consumption.
    Optional input_source binds every native focus check to the recorded keyboard source.
    """
    paste, route = _route_clipboard(text, use_clipboard)
    body, enters = _split_trailing_enter(text, route) if paste else (text, 0)
    payload = {"op":"keyboard.text", "target":target, "text":body, "paste":paste, "interval":interval, "enters":enters}
    if input_source is not None:
        payload['input_source'] = input_source
    result = request(payload)
    return {**result, "length":len(text), "method":"clipboard" if paste else "typewrite", "route":route,
            **({"trailing_enter":enters} if enters else {})}


@mcp.tool(audit=True)
def press_key(key: str, target: dict, input_source: dict | None = None) -> dict:
    """Press and release one Mac key or chord in the already-focused bound window.

    Examples include enter, escape, backspace, delete, arrows, f1..f12 and cmd+shift+s.
    cmd/command, option/alt, control/ctrl and shift are distinct Mac modifiers. Letter key names use
    Mac ANSI virtual-key positions. Use type_text for layout-independent text. Each chord is fully released.
    Pass the complete target from a current observation. Unknown/repeated keys and changed focus are refused.
    """
    keys = _keys(key)
    if isinstance(keys, dict):
        return keys
    payload = {"op":"keyboard.chord", "target":target, "keys":keys}
    if input_source is not None:
        payload['input_source'] = input_source
    return {**request(payload), "key":key}


@mcp.tool(audit=True)
def hotkey(keys: str | list[str], target: dict, input_source: dict | None = None,
           event_flags: StrictInt = 0) -> dict:
    """Press and release a Mac shortcut in the focused bound window, such as cmd+v or ['cmd','shift','s'].

    One to eight unique keys are allowed, with modifiers preceding at most one ordinary key.
    cmd means Command and ctrl means Control. The target and focus are validated before posting the sequence.
    Optional input_source binds replay to its recorded keyboard source. event_flags preserves only recorded
    Caps Lock, Fn, keypad and Help event flags and does not toggle global keyboard settings.
    """
    parts = _keys(keys)
    if isinstance(parts, dict):
        return parts
    if type(event_flags) is not int or event_flags < 0 or event_flags & ~MACOS_RECORDED_KEY_FLAGS:
        return {'ok': False, 'code': 'invalid_args', 'error': 'Unsupported recorded keyboard event flags'}
    payload = {"op":"keyboard.chord", "target":target, "keys":parts}
    if input_source is not None:
        payload['input_source'] = input_source
    if event_flags:
        payload['event_flags'] = event_flags
    return {**request(payload), "keys":parts}


@mcp.tool()
def get_mouse_position() -> dict:
    """Observe the Mac cursor in global logical points. Requires an unlocked desktop."""
    return request({"op":"mouse.position"})


@mcp.tool(audit=True)
def mouse_click(x: int, y: int, target: dict, button: str = "left", clicks: int = 1, interval: float = 0.1) -> dict:
    """Click inside the already-focused bound Mac window in global logical points.

    WindowServer mouseDown routing and AX hit tests must agree with the exact target before each click.
    Supports left/right/middle buttons, one to five clicks and interval 0..0.5 seconds.
    Physical held modifiers/buttons, covered points, changed focus and stale geometry are refused.
    """
    return request({"op":"mouse.click", "target":target, "x":x, "y":y, "button":button,
                    "clicks":clicks, "interval":interval})


@mcp.tool(audit=True)
def mouse_move(x: int, y: int, target: dict, duration: float = 0.2) -> dict:
    """Move the Mac cursor to a visible point in the focused bound window and report its observed position.

    Uses global logical points and a 0..2 second movement duration. Target focus/identity remain guarded.
    """
    return request({"op":"mouse.move", "target":target, "x":x, "y":y, "duration":duration})


@mcp.tool(audit=True)
def mouse_drag(start_x: int, start_y: int, end_x: int, end_y: int, target: dict,
               duration: float = 0.5, button: str = "left") -> dict:
    """Drag within one focused bound Mac window using global logical points and duration 0..2 seconds.

    Both endpoints and the sampled path must stay visible in the exact window. Focus, geometry and hit
    identity are rechecked during the drag. The owned button is released on every completion/failure path.
    """
    return request({"op":"mouse.drag", "target":target, "start_x":start_x, "start_y":start_y,
                    "x":end_x, "y":end_y, "duration":duration, "button":button})


@mcp.tool(audit=True)
def mouse_scroll(clicks: int, target: dict, x: int | None = None, y: int | None = None,
                 direction: str = "vertical") -> dict:
    """Scroll in the focused bound Mac window at a verified visible point.

    Specify both x/y in global logical points, or omit both to use the observed cursor. Up to 100 notches
    per call. Positive means up for vertical and right for horizontal. Cursor position is read back before
    posting the wheel event. Window focus, geometry and hit identity must still match.
    """
    if (x is None) != (y is None):
        return {"ok":False, "code":"invalid_args", "error":"Specify both x and y, or omit both"}
    if x is None:
        position = request({"op":"mouse.position"})
        x, y = position["x"], position["y"]
    return request({"op":"mouse.scroll", "target":target, "x":x, "y":y, "amount":clicks, "direction":direction})


@mcp.tool(audit=True)
def scroll_at(x: int, y: int, amount: int, target: dict) -> dict:
    """Scroll vertically at a verified point in the focused bound Mac window. Positive means up."""
    return mouse_scroll(clicks=amount, target=target, x=x, y=y)


@mcp.tool(audit=True)
async def input_sequence(events: list[dict], target: dict, input_source: dict) -> dict:
    """Replay a balanced, source-bound Mac keyboard/pointer gesture in the focused exact target.

    Pass event rows from a native_window_events recording. Types are key_down/key_up/flags,
    mouse_down/mouse_up/drag/move and scroll. Portable rows retain down/up, left/right modifier changes, repeat, keyboard type, optional
    Unicode payload, pointer paths, click counts, pressure, continuous three-axis scroll and phases.
    Ordinary mouse and mouse-touch subtype rows are supported. Tablet, multitouch and Force Touch
    pressure-stage gestures are outside this portable sequence; capture refuses unpreserved associations.
    at_us is a monotonic relative microsecond offset, starting at zero. Limits are 512 events,
    five seconds and 48000 JSON bytes. All fields and complete ownership are checked before dispatch.
    The recorded input source must match. Begin with neutral/committed IME and dead-key composition.
    Each event rechecks focus, target, permissions, source and pointer hit. Owned input is released on
    interruption. Success reports posted events. Observe application state to confirm consumption.
    """
    validate_events(events, target.get('bounds'))
    payload = {'op': 'input.sequence', 'events': events, 'target': target, 'input_source': input_source}
    cancel_event, finished = threading.Event(), threading.Event()
    cancel_lock = threading.Lock()
    receipt = {}

    def execute():
        try:
            receipt['result'] = request(payload, cancel_event=cancel_event, cancel_lock=cancel_lock)
        except Exception as error:
            receipt['error'] = error
        finally:
            finished.set()

    worker = threading.Thread(target=execute, name='ruyi-macos-input-sequence', daemon=True)
    worker.start()
    try:
        while not finished.is_set():
            await asyncio.sleep(.01)
    except asyncio.CancelledError:
        with cancel_lock:
            cancel_event.set()
        # The thread owns native shutdown. Keep the tool and any enclosing replay gate until it
        # finishes, even during asyncio shutdown or repeated cancellation of the enclosing task.
        with anyio.CancelScope(shield=True):
            while not finished.is_set():
                try:
                    await asyncio.sleep(.01)
                except asyncio.CancelledError:
                    pass
        worker.join()
        result = {'outcome': 'unknown'}
        native = receipt.get('result')
        error = receipt.get('error')
        if native is not None:
            result['outcome'] = 'unconfirmed'
            if type(native.get('action_sent')) is bool:
                result['action_sent'] = native['action_sent']
        elif isinstance(error, DesktopError):
            result.update(error.details)
        raise ToolCancelled('input_sequence', {'code': 'cancelled', 'error': 'Tool execution cancelled', **result}) from None
    worker.join()
    if 'error' in receipt:
        raise receipt['error']
    return receipt['result']
