"""Macro recording — capture live mouse/keyboard into a replayable step list.

`record_start()` installs low-level pynput hooks; `record_stop(save_as?)` tears them down and returns
(and optionally persists to <data>/macros/<name>.json) a step list SHAPED EXACTLY like what
`macro_run` / `batch_actions` replay: `[{"tool": "<name>", "args": {...}}, ...]`. So a recording can
be handed straight back to `macro_run(steps=...)`.

pynput is an OPTIONAL dependency. If it is absent, record_start/record_stop degrade gracefully with an
install hint (macro_list still works — it only reads the macros directory). This mirrors
ocr/vision/uia/browser.
"""

import json
import os
import threading
import time

from ai_computer_control.server import mcp
from ai_computer_control.paths import data_dir

try:
    from pynput import mouse as _pynput_mouse  # type: ignore
    from pynput import keyboard as _pynput_keyboard  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency
    _pynput_mouse = _pynput_keyboard = None  # type: ignore
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


def _unavailable() -> dict:
    return {"ok": False, "error": "pynput not installed",
            "hint": "Add 'pynput' to requirements_offline.txt and reinstall (it is an OPTIONAL "
                    "recording dependency); macro replay via macro_run needs no extra deps.",
            "detail": _IMPORT_ERROR}


def _macros_dir() -> str:
    d = os.path.join(data_dir(), "macros")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


class _Recorder:
    """Collects raw events; converts to the macro_run step vocabulary on stop."""

    def __init__(self):
        self._lock = threading.Lock()
        self.active = False
        self.started_at = 0.0
        self._events = []  # (t, kind, payload)
        self._mouse_listener = None
        self._kbd_listener = None
        self._pressed_text = []  # buffer of printable chars to coalesce into type_text steps

    def start(self):
        with self._lock:
            if self.active:
                return False
            self._events = []
            self._pressed_text = []
            self.started_at = time.monotonic()
            self.active = True

        def on_click(x, y, button, pressed):
            if pressed:  # record on press only (a click = down+up; replay is a single mouse_click)
                self._events.append((time.monotonic(), "click",
                                     {"x": int(x), "y": int(y),
                                      "button": getattr(button, "name", "left")}))

        def on_scroll(x, y, dx, dy):
            self._events.append((time.monotonic(), "scroll",
                                 {"x": int(x), "y": int(y), "amount": int(dy)}))

        def on_press(key):
            self._events.append((time.monotonic(), "key", {"key": _key_name(key)}))

        self._mouse_listener = _pynput_mouse.Listener(on_click=on_click, on_scroll=on_scroll)
        self._kbd_listener = _pynput_keyboard.Listener(on_press=on_press)
        self._mouse_listener.start()
        self._kbd_listener.start()
        return True

    def stop(self):
        with self._lock:
            if not self.active:
                return None
            self.active = False
        for lst in (self._mouse_listener, self._kbd_listener):
            try:
                if lst is not None:
                    lst.stop()
            except Exception:
                pass
        self._mouse_listener = self._kbd_listener = None
        return self._to_steps()

    def _to_steps(self):
        """Convert raw events into replayable steps, coalescing runs of printable keys into type_text."""
        steps = []
        text_buf = []

        def flush_text():
            if text_buf:
                steps.append({"tool": "type_text", "args": {"text": "".join(text_buf)}})
                text_buf.clear()

        for _t, kind, payload in self._events:
            if kind == "key":
                key = payload["key"]
                if len(key) == 1:  # a printable character -> accumulate into a type_text run
                    text_buf.append(key)
                else:
                    flush_text()
                    steps.append({"tool": "press_key", "args": {"key": key}})
            elif kind == "click":
                flush_text()
                steps.append({"tool": "mouse_click",
                              "args": {"x": payload["x"], "y": payload["y"],
                                       "button": payload["button"]}})
            elif kind == "scroll":
                flush_text()
                steps.append({"tool": "scroll_at",
                              "args": {"x": payload["x"], "y": payload["y"],
                                       "amount": payload["amount"]}})
        flush_text()
        return steps


def _key_name(key) -> str:
    """Map a pynput key to press_key's vocabulary (single printable char, or a named key)."""
    try:
        ch = getattr(key, "char", None)
        if ch is not None and ch != "":
            return ch
    except Exception:
        pass
    name = getattr(key, "name", None)
    if name:
        # pynput names line up with pyautogui/press_key for the common set (enter/tab/esc/f1..).
        return {"esc": "escape", "return": "enter"}.get(name, name)
    return str(key)


_RECORDER = _Recorder()


@mcp.tool()
def record_start() -> dict:
    """Begin recording live mouse/keyboard input into a replayable macro.

    Installs low-level input hooks (pynput). Call record_stop to finish. Only one recording may be
    active at a time. Degrades gracefully (ok:false + hint) if pynput is not installed.

    Returns:
        dict with ok and 'recording': True.
    """
    if not _AVAILABLE:
        return _unavailable()
    if not _RECORDER.start():
        return {"ok": False, "error": "a recording is already active; call record_stop first"}
    return {"ok": True, "recording": True, "note": "recording mouse/keyboard; call record_stop to finish"}


@mcp.tool(audit=True)
def record_stop(save_as: str | None = None) -> dict:
    """Stop the active recording and return the captured steps (macro_run-compatible).

    Args:
        save_as: Optional macro name; if given, the steps are written to <data>/macros/<name>.json
            (a '.json' suffix is added if missing) for later macro_list / macro_run use.

    Returns:
        dict with ok, 'steps' (list of {tool,args} directly replayable by macro_run), 'count', and
        'path' when saved.
    """
    if not _AVAILABLE:
        return _unavailable()
    steps = _RECORDER.stop()
    if steps is None:
        return {"ok": False, "error": "no active recording (call record_start first)"}
    out = {"ok": True, "count": len(steps), "steps": steps}
    if save_as:
        name = save_as if save_as.lower().endswith(".json") else save_as + ".json"
        # Guard against path traversal — keep the file inside the macros directory.
        name = os.path.basename(name)
        path = os.path.join(_macros_dir(), name)
        try:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"name": os.path.splitext(name)[0], "steps": steps,
                           "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, f,
                          ensure_ascii=False, indent=2)
            os.replace(tmp, path)  # atomic
            out["path"] = path
            out["output_path"] = path  # v1.5.1: 产物收割键(与 path 同值)
            out["saved_as"] = os.path.splitext(name)[0]
        except Exception as e:  # noqa: BLE001
            out["save_error"] = str(e)
    return out


@mcp.tool()
def macro_list() -> dict:
    """List saved macros in <data>/macros (name, step count, path, recorded_at).

    Works even without pynput — it only reads the macros directory. Load a macro's 'steps' and pass
    them to macro_run to replay it.

    Returns:
        dict with ok, count, and 'macros': [{name, steps, path, recorded_at}].
    """
    d = _macros_dir()
    macros = []
    try:
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith(".json"):
                continue
            path = os.path.join(d, fn)
            entry = {"name": os.path.splitext(fn)[0], "path": path, "steps": None, "recorded_at": None}
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    entry["steps"] = len(data.get("steps", []))
                    entry["recorded_at"] = data.get("recorded_at")
                elif isinstance(data, list):  # bare step list
                    entry["steps"] = len(data)
            except Exception:
                pass
            macros.append(entry)
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    return {"ok": True, "count": len(macros), "macros": macros, "macros_dir": d}
