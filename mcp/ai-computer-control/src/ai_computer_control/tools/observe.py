"""`observe` — one call that returns everything an agent needs to decide the next action.

Bundles a budgeted screenshot, the focused window, and (when their optional backends are present)
the UI-Automation element list and the OCR word list. This lets a single round-trip answer
"what's on screen and where can I click?" instead of chaining screenshot + ui_inspect + ocr_screen.

Coordinate contract (IMPORTANT):
  * All rect/center values in `uia_elements` and `ocr_words` are UNSCALED PHYSICAL SCREEN
    coordinates — identical to what ui_find / ocr_find_text already return — so they are directly
    clickable with mouse_click regardless of the `screenshot.scale`.
  * `screenshot.scale` describes ONLY the returned image bytes (scale<1.0 == downscaled to save
    tokens). To map a point you eyeball IN the image back to the screen: x_screen = x_image / scale.
"""

from ai_computer_control.server import mcp


def _focused_window() -> dict:
    """Best-effort foreground-window summary using ctypes (no pywin32 dependency)."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    try:
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            # Genuinely no foreground window (desktop focused) — distinct from a probe failure.
            return {"present": False, "hwnd": 0, "title": ""}
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer((n or 0) + 1)
        u.GetWindowTextW(hwnd, buf, (n or 0) + 1)
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return {"present": True, "hwnd": int(hwnd), "title": buf.value, "pid": int(pid.value),
                "rect": {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                         "width": r.right - r.left, "height": r.bottom - r.top}}
    except Exception as e:  # noqa: BLE001
        return {"present": False, "error": str(e)}


def _uia_elements(window_title: str | None, cap: int):
    """Flatten the focused (or named) window's UIA tree to <=cap {name,type,rect,center}.

    Returns a list on success, None when the UIA backend is absent, or the string sentinel
    'no_window' when a window_title was given but matched no open window (so the caller can tell the
    model to fix its title instead of assuming the backend is missing)."""
    try:
        from ai_computer_control.tools import uia
    except Exception:
        return None
    if not getattr(uia, "_AVAILABLE", False):
        return None
    root = uia._root(window_title)
    if root is None:
        return "no_window" if window_title else None
    items, count = [], [0]

    def walk(ctrl, depth):
        if len(items) >= cap or depth > 8 or count[0] > 4000:
            return
        count[0] += 1
        try:
            node = uia._node(ctrl)  # already carries name/type/automation_id/center
            r = getattr(ctrl, "BoundingRectangle", None)
            if r is not None:
                try:
                    node["rect"] = {"left": int(r.left), "top": int(r.top),
                                    "width": int(r.right - r.left), "height": int(r.bottom - r.top)}
                except Exception:
                    pass
            # Only surface elements that carry some identity (skip anonymous container noise).
            if node.get("name") or node.get("automation_id"):
                items.append(node)
        except Exception:
            pass
        try:
            for ch in ctrl.GetChildren():
                if len(items) >= cap:
                    break
                walk(ch, depth + 1)
        except Exception:
            pass

    try:
        walk(root, 0)
    except Exception:
        pass
    return items[:cap]


def _ocr_words(cap: int) -> list | None:
    """Full-screen OCR words as [{text,rect,center}] in screen coords. None if OCR backend absent."""
    try:
        from ai_computer_control.tools import ocr
    except Exception:
        return None
    if not getattr(ocr, "_AVAILABLE", False):
        return None
    res = ocr.ocr_screen()
    if not res.get("success"):
        return None
    words = []
    for w in res.get("words", [])[:cap]:
        words.append({"text": w["text"],
                      "rect": {"left": w["left"], "top": w["top"],
                               "width": w["width"], "height": w["height"]},
                      "center": w["center"]})
    return words


@mcp.tool()
def observe(max_width: int = 1280, window_title: str | None = None,
            include_uia: bool = True, include_ocr: bool = True,
            format: str = "png", quality: int = 80) -> dict:
    """One-shot situational snapshot: screenshot + focused window + UIA elements + OCR words.

    Everything you need to pick a next action in a single round-trip. UIA/OCR are included only when
    their optional backend is installed (otherwise the field is omitted and the reason noted under
    'degraded'); the screenshot always succeeds.

    Args:
        max_width: Downscale the returned screenshot to this width to save tokens (default 1280;
            0 = original). See 'scale' in the returned screenshot to remap image points to screen.
        window_title: Restrict UIA element collection to this window (substring); omit for the
            foreground window.
        include_uia: Collect UI-Automation elements (<=80) when uiautomation is available.
        include_ocr: Collect OCR words (<=200) when the OCR backend is available.
        format: Screenshot encoding 'png' (default) or 'jpeg'.
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with ok, screenshot:{image,width,height,scale,format}, focused_window:{...},
        uia_elements:[{name,type,rect,center}] (when available), ocr_words:[{text,rect,center}]
        (when available), and 'degraded' listing any backend that was requested but unavailable.
        NOTE: uia_elements/ocr_words rects & centers are UNSCALED physical screen coords (clickable);
        only screenshot bytes are affected by 'scale'.
    """
    import pyautogui
    from ai_computer_control.utils.image import encode_with_budget

    out = {"ok": True}
    degraded = []
    try:
        img = pyautogui.screenshot()
        out["screenshot"] = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
    except Exception as e:  # noqa: BLE001 — screenshot is the one hard requirement
        return {"ok": False, "error": f"screenshot failed: {e}"}

    out["focused_window"] = _focused_window()

    if include_uia:
        uia_items = _uia_elements(window_title, cap=80)
        if uia_items == "no_window":
            out["uia_note"] = (f"window_title {window_title!r} did not match any open window; "
                               f"adjust the substring or omit it to use the foreground window.")
        elif uia_items is None:
            degraded.append("uia")
        else:
            out["uia_elements"] = uia_items
    if include_ocr:
        ocr_items = _ocr_words(cap=200)
        if ocr_items is None:
            degraded.append("ocr")
        else:
            out["ocr_words"] = ocr_items

    if degraded:
        out["degraded"] = degraded
    return out
