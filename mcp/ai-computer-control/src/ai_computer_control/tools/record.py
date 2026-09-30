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
from ai_computer_control.utils.errors import exc_text
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
        def on_release(key):
            self._events.append((time.monotonic(), "keyup", {"key": _key_name(key)}))

        self._kbd_listener = _pynput_keyboard.Listener(on_press=on_press, on_release=on_release)
        # Start BOTH low-level input hooks; if the SECOND fails after the FIRST is installed, tear
        # down whichever already started (so no WH_MOUSE_LL/WH_KEYBOARD_LL hook is left dangling),
        # reset all state, and re-raise so record_start reports a DISTINCT start-failure (not the
        # misleading "already active" that a lingering self.active would otherwise trigger).
        try:
            self._mouse_listener.start()
            self._kbd_listener.start()
        except Exception:
            for lst in (self._mouse_listener, self._kbd_listener):
                try:
                    if lst is not None:
                        lst.stop()
                except Exception:
                    pass
            self._mouse_listener = self._kbd_listener = None
            with self._lock:
                self.active = False
            raise
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
        """Convert raw events into replayable steps (see _events_to_steps)."""
        return _events_to_steps(self._events)


_WAIT_GAP_S = 0.3      # a pause longer than this between steps becomes a `wait` step
_WAIT_MAX_S = 5.0      # ...capped, so an idle break while recording does not stall the replay


def _canon_mod(name: str) -> str | None:
    """Canonical hotkey modifier ('ctrl'/'alt'/'shift'/'win') for a recorded key name, else None."""
    n = str(name).lower()
    if n.startswith("alt_gr") or n.startswith("altgr"):
        return None          # AltGr composes characters; treat it as an ordinary key
    for prefix, canon in (("ctrl", "ctrl"), ("shift", "shift"), ("alt", "alt"), ("win", "win"), ("cmd", "win")):
        if n.startswith(prefix):
            return canon
    return None


def _chord_base(key: str, mods: list[str]) -> str:
    """The non-modifier key of a chord: Ctrl+C is recorded by pynput as the control char '\\x03' -> 'c'."""
    if len(key) == 1:
        if "ctrl" in mods and 1 <= ord(key) <= 26:
            return chr(ord(key) + 96)
        return key.lower()
    return key


def _events_to_steps(events, gap_s: float = _WAIT_GAP_S) -> list[dict]:
    """Raw events [(t, kind, payload)] -> macro_run steps.

    * runs of printable keys coalesce into type_text;
    * a modifier held while another key is pressed becomes ONE `hotkey` step (Ctrl+C replays as
      hotkey [ctrl, c], not `press_key ctrlleft` + a stray control character); a modifier pressed and
      released on its own is a plain press_key;
    * pauses longer than `gap_s` between steps become `wait` steps (capped), so a replay keeps the
      recorded pacing instead of a fixed inter-step delay.
    """
    steps: list[dict] = []
    text_buf: list[str] = []
    text_t: list[float] = []      # [first_char_time, last_char_time] of the current run
    held: list[list] = []         # [canonical mod, used, original key name, press time]
    last_end = [None]

    def add(step, t_start, t_end=None):
        if last_end[0] is not None and t_start - last_end[0] > gap_s:
            steps.append({"tool": "wait",
                          "args": {"seconds": round(min(_WAIT_MAX_S, t_start - last_end[0]), 1)}})
        steps.append(step)
        last_end[0] = t_end if t_end is not None else t_start

    def flush_text():
        if text_buf:
            add({"tool": "type_text", "args": {"text": "".join(text_buf)}}, text_t[0], text_t[1])
            text_buf.clear()
            text_t.clear()

    def push_char(ch, t):
        if not text_buf:
            text_t[:] = [t, t]
        else:
            text_t[1] = t
        text_buf.append(ch)

    for t, kind, payload in events:
        if kind == "key":
            key = payload["key"]
            mod = _canon_mod(key)
            if mod:
                if not any(h[0] == mod for h in held):
                    held.append([mod, False, key, t])
                continue
            if held:
                for h in held:
                    h[1] = True
                mods = [h[0] for h in held]
                if not (len(key) == 1 and set(mods) == {"shift"}):   # Shift+char is just a typed char
                    flush_text()
                    add({"tool": "hotkey", "args": {"keys": mods + [_chord_base(key, mods)]}},
                        min(h[3] for h in held), t)   # the chord starts when its first modifier went down
                    continue
            if len(key) == 1:  # a printable character -> accumulate into a type_text run
                push_char(key, t)
            else:
                flush_text()
                add({"tool": "press_key", "args": {"key": key}}, t)
        elif kind == "keyup":
            mod = _canon_mod(payload["key"])
            for h in list(held):
                if mod and h[0] == mod:
                    held.remove(h)
                    if not h[1]:      # pressed and released alone (e.g. the Win key)
                        flush_text()
                        add({"tool": "press_key", "args": {"key": h[2]}}, h[3], t)
        elif kind == "click":
            flush_text()
            add({"tool": "mouse_click",
                 "args": {"x": payload["x"], "y": payload["y"], "button": payload["button"]}}, t)
        elif kind == "scroll":
            flush_text()
            add({"tool": "scroll_at",
                 "args": {"x": payload["x"], "y": payload["y"], "amount": payload["amount"]}}, t)
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
        # b2-P2: pynput 命名与 pyautogui KEYBOARD_KEYS 不兼容(alt_l vs altleft 等)—— 录制宏回放时 press_key 校验会失败
        _MAP = {"esc": "escape", "return": "enter",
                "alt_l": "altleft", "alt_r": "altright",
                "ctrl_l": "ctrlleft", "ctrl_r": "ctrlright",
                "shift_l": "shiftleft", "shift_r": "shiftright",
                "cmd": "winleft", "cmd_l": "winleft", "cmd_r": "winright",
                "caps_lock": "capslock", "print_screen": "printscreen",
                "page_up": "pageup", "page_down": "pagedown",
                "num_lock": "numlock", "scroll_lock": "scrolllock",
                "backspace": "backspace", "delete": "delete", "insert": "insert",
                "home": "home", "end": "end",
                "up": "up", "down": "down", "left": "left", "right": "right",
                "space": "space", "tab": "tab",
                "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4", "f5": "f5", "f6": "f6",
                "f7": "f7", "f8": "f8", "f9": "f9", "f10": "f10", "f11": "f11", "f12": "f12"}
        return _MAP.get(name, name)
    return str(key)


_RECORDER = _Recorder()


@mcp.tool(audit=True)  # b2-P1: 全局键盘/鼠标监听是最敏感动作,必须留审计(与 record_stop 对齐)
def record_start() -> dict:
    """Begin recording live mouse/keyboard input into a replayable macro.

    Installs low-level input hooks (pynput). Call record_stop to finish. Only one recording may be
    active at a time. Degrades gracefully (ok:false + hint) if pynput is not installed.

    Returns:
        dict with ok and 'recording': True.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        started = _RECORDER.start()
    except Exception as e:  # noqa: BLE001 — hook install failed; _RECORDER.start already tore down
        return {"ok": False, "error": "failed to start input hooks", "detail": str(e)}
    if not started:
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
        'path' when saved. Steps keep the recorded pacing (a `wait` step for pauses over 0.3s, capped
        at 5s) and shortcuts such as Ctrl+C are recorded as one `hotkey` step.
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
        return {"ok": False, "error": exc_text(e)}
    return {"ok": True, "count": len(macros), "macros": macros, "macros_dir": d}
