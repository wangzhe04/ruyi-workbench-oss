"""`observe` — one call that returns everything an agent needs to decide the next action.

Bundles a budgeted screenshot, the focused window, and (when their optional backends are present)
the UI-Automation element list and the OCR word list. This lets a single round-trip answer
"what's on screen and where can I click?" instead of chaining screenshot + ui_inspect + ocr_screen.

Coordinate contract (IMPORTANT):
  * All rect/center values in `uia_elements` and `ocr_words` are UNSCALED PHYSICAL SCREEN
    coordinates — identical to what ui_find / ocr_find_text already return — so they are directly
    clickable with mouse_click regardless of the `screenshot.scale`.
  * `screenshot.scale` describes ONLY the returned image bytes (scale<1.0 == downscaled to save
    tokens). To map a point you eyeball IN the image back to the screen:
    x_screen = screenshot.origin.x + x_image / scale (origin is {x:0,y:0} for the primary-screen frame).
  * The screen is grabbed ONCE: the screenshot and the OCR words come from the same frame (OCR of a
    targeted window crops that frame instead of grabbing again).
"""

import asyncio
import threading
import time

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


_UIA_MAX_VISITS = 4000       # hard cap on nodes touched per walk (each is a cross-process COM call)
_UIA_DEADLINE_S = 12.0       # the walk stops itself and returns what it has; the outer 15s wait is a backstop
_DOC_TYPES = {"document", "webarea"}


def _uia_elements(window_title: str | None, cap: int, *, max_visits: int = _UIA_MAX_VISITS,
                  deadline_s: float | None = _UIA_DEADLINE_S, shared: dict | None = None):
    """Flatten the focused (or named) window's UIA tree to <=cap {name,type,rect,center}.

    Returns {items,limitation,truncated,timed_out,visited} on success, None when the UIA backend is
    absent, or the string sentinel 'no_window' when a window_title was given but matched no open window
    (so the caller can tell the model to fix its title instead of assuming the backend is missing).

    The walk STOPS once `cap` items are collected (it used to keep touching up to 4000 nodes, ~28k COM
    calls, for 80 items), except that a browser window whose page Document has not been seen yet is probed
    with cheap type-only reads so the "browser page surface not exposed" detection stays correct.
    `truncated` means nodes were left unvisited (cap/visit-cap/deadline); `timed_out` means the deadline hit.

    `shared` (optional dict) receives live state {items,count,control_types,truncated,timed_out,cancel} so
    a caller that gives up waiting (thread still running) can still read the partial result, and can set
    shared['cancel'] (threading.Event) to make the walk unwind."""
    try:
        from ai_computer_control.tools import uia
    except Exception:
        return None
    if not getattr(uia, "_AVAILABLE", False):
        return None
    root = uia._root(window_title)
    if root is None:
        return "no_window" if window_title else None
    st = shared if shared is not None else {}
    items = st.setdefault("items", [])
    control_types: set = st.setdefault("control_types", set())
    cancel = st.setdefault("cancel", threading.Event())
    st.update(count=0, truncated=False, timed_out=False)
    deadline = (time.monotonic() + deadline_s) if deadline_s else None
    probe = {"browser": None}  # lazily computed: is this a browser window still missing its Document?

    def has_doc() -> bool:
        return any(str(t).lower().replace("control", "") in _DOC_TYPES for t in control_types)

    def want_probe() -> bool:
        if probe["browser"] is None:
            try:
                probe["browser"] = uia._browser_accessibility_status(root, 0, set()) is not None
            except Exception:
                probe["browser"] = False
        return probe["browser"] and not has_doc()

    def walk(ctrl, depth):
        if depth > 8 or cancel.is_set():
            return
        if st["count"] >= max_visits:
            st["truncated"] = True
            return
        if deadline is not None and time.monotonic() > deadline:
            st["timed_out"] = st["truncated"] = True
            return
        filling = len(items) < cap
        if not filling and not want_probe():
            st["truncated"] = True  # a node we chose not to visit
            return
        st["count"] += 1
        if filling:
            try:
                node = uia._node(ctrl, include_center=False)  # 4 property reads
                if node.get("type"):
                    control_types.add(str(node["type"]))
                r = getattr(ctrl, "BoundingRectangle", None)  # the ONE rect read (center derives from it)
                if r is not None:
                    try:
                        node["rect"] = {"left": int(r.left), "top": int(r.top),
                                        "width": int(r.right - r.left), "height": int(r.bottom - r.top)}
                        node["center"] = [int((r.left + r.right) / 2), int((r.top + r.bottom) / 2)]
                    except Exception:
                        pass
                # Only surface elements that carry some identity (skip anonymous container noise).
                if node.get("name") or node.get("automation_id"):
                    items.append(node)
            except Exception:
                pass
        else:
            try:  # probe: one cheap read to spot the page Document
                t = getattr(ctrl, "ControlTypeName", "")
                if t:
                    control_types.add(str(t))
            except Exception:
                pass
        try:
            for ch in ctrl.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass

    try:
        walk(root, 0)
    except Exception:
        pass
    limitation = None
    if not st["timed_out"] and not cancel.is_set():
        limitation = uia._browser_accessibility_status(root, st["count"], control_types)
    return {"items": items[:cap], "limitation": limitation, "truncated": bool(st["truncated"]),
            "timed_out": bool(st["timed_out"]), "visited": st["count"]}


def _window_rect_for_title(window_title: str):
    """(left, top, width, height) of the visible top-level window matching the title substring, else None.

    None also for a minimized / zero-size window (there is nothing on screen to OCR)."""
    try:
        from ai_computer_control.utils import wincap
        hwnd, _title = wincap._find_hwnd(window_title)
        if not hwnd or wincap._is_minimized(hwnd):
            return None
        l, t, r, b = wincap._window_rect(hwnd)
        if r - l <= 0 or b - t <= 0:
            return None
        return int(l), int(t), int(r - l), int(b - t)
    except Exception:
        return None


def _ocr_source(frame, frame_origin, rect):
    """Pick the pixels to OCR for a window `rect` (l,t,w,h in virtual-screen coords).

    Returns (image, origin, how): a CROP of the already-captured `frame` when the (desktop-clipped) rect
    lies inside it - no second grab; ('grab' in `how`) means the caller must capture that rect itself
    (window is on another monitor / straddles the frame edge); None when rect is not on the desktop."""
    from ai_computer_control.utils.image import clip_to_virtual
    clipped, _bounds = clip_to_virtual(rect)
    if clipped is None:
        return None
    cl, ct, cw, ch = clipped
    if frame is not None:
        fx, fy = frame_origin
        if cl >= fx and ct >= fy and cl + cw <= fx + frame.width and ct + ch <= fy + frame.height:
            return frame.crop((cl - fx, ct - fy, cl - fx + cw, ct - fy + ch)), (cl, ct), "frame"
    return None, (cl, ct, cw, ch), "grab"


async def _ocr_words(cap: int, lang: str | None = None, img=None, origin=(0, 0)) -> dict | None:
    """OCR words as {words:[{text,rect,center}], total, truncated} in screen coords. None if OCR is absent.

    `img`/`origin` is the ALREADY-CAPTURED frame (or crop) to read - no second screen grab; without it
    the screen is grabbed by ocr_screen (legacy path). `lang` is forwarded so Chinese screen text is
    recognized with a Chinese engine even on a box whose display language is English (an explicit lang
    wins over ocr.py's zh-CN auto-preference). Bounded by a 40s timeout so a stuck recognize_async
    degrades gracefully instead of hanging the whole observe() call.
    """
    try:
        from ai_computer_control.tools import ocr
    except Exception:
        return None
    if not getattr(ocr, "_AVAILABLE", False):
        return None
    try:
        if img is not None:
            res = await asyncio.wait_for(ocr.ocr_frame(img, origin=origin, lang=lang), timeout=40)
        else:
            res = await asyncio.wait_for(ocr.ocr_screen(lang=lang), timeout=40)
    except asyncio.TimeoutError:
        return None
    if not res.get("success"):
        return None
    all_words = res.get("words", [])
    total = max(int(res.get("words_total") or 0), len(all_words))
    words = []
    for w in all_words[:cap]:
        words.append({"text": w["text"],
                      "rect": {"left": w["left"], "top": w["top"],
                               "width": w["width"], "height": w["height"]},
                      "center": w["center"]})
    return {"words": words, "total": total, "truncated": total > len(words)}


@mcp.tool()
async def observe(max_width: int = 1280, window_title: str | None = None,
                  include_uia: bool = True, include_ocr: bool = True,
                  format: str = "png", quality: int = 80,
                  lang: str | None = None, include_screenshot: bool = True) -> dict:
    """One-shot situational snapshot: screenshot + focused window + UIA elements + OCR words.

    UIA/OCR are included only when their optional backend is installed (otherwise omitted, reason under
    'degraded'); the screenshot always succeeds.

    Args:
        max_width: Downscale the screenshot to this width (default 1280; 0 = original). Screen x =
            screenshot.origin.x + x / scale.
        window_title: Restrict UIA and OCR to this window (substring); omit for the foreground window (UIA) /
            primary screen (OCR).
        include_uia: Collect UI-Automation elements (<=80).
        include_ocr: Collect OCR words (<=200).
        format: 'png' (default) or 'jpeg'.
        quality: JPEG quality 1-100 (ignored for PNG).
        lang: Optional OCR language hint (zh/chinese/zh-CN -> zh-Hans, ja, ko, en); omit to auto-detect.
        include_screenshot: Default True. False skips the image (text-only models / cheap polling): no
            'screenshot' key, no full-screen grab (OCR of a targeted window grabs only its rect).

    Returns:
        dict with ok, screenshot:{image,width,height,scale,format,origin}, focused_window:{...},
        uia_elements:[{name,type,rect,center}] (+ uia_truncated / uia_timed_out / uia_visited when the walk hit
        its cap or deadline; a timeout still returns the partial list), ocr_words:[{text,rect,center}] with
        ocr_scope:{kind:'screen'|'window',origin,rect?}, ocr_truncated + ocr_total when >200 words, and 'degraded'
        listing requested backends that were unavailable or timed out.
        NOTE: uia/ocr rects & centers are UNSCALED physical screen coords (clickable); 'scale' affects only the
        screenshot bytes.
    """
    from ai_computer_control.utils.image import capture_fields, encode_with_budget, grab_screen

    out = {"ok": True}
    degraded = []

    # ---- capture: at most one full-screen grab, shared by the image and OCR ----
    win_rect = _window_rect_for_title(window_title) if (include_ocr and window_title) else None
    frame = frame_info = None
    if include_screenshot or (include_ocr and win_rect is None):
        try:
            frame, frame_info = grab_screen()
        except Exception as e:  # noqa: BLE001 — the screenshot is the one hard requirement (when asked for)
            if include_screenshot:
                return {"ok": False, "error": f"screenshot failed: {e}"}
            degraded.append("ocr")
    if include_screenshot and frame is not None:
        out["screenshot"] = {**encode_with_budget(frame, max_width=max_width, fmt=format, quality=quality),
                             **capture_fields(frame, frame_info)}

    out["focused_window"] = _focused_window()

    async def run_uia():
        # The UIA tree walk is synchronous COM (ctrl.GetChildren per node); a single unresponsive
        # window can hang it. Run it off the event loop with a 15s cap so observe() still returns the
        # screenshot + OCR even when one window is stuck. COM must be initialized on the worker thread
        # (uiautomation/comtypes need it); _uia_elements_com wraps _uia_elements with CoInitialize.
        # The walk keeps its state in `shared`, so a timeout still yields the partial element list.
        shared: dict = {"cancel": threading.Event()}

        def _uia_elements_com():
            co_inited = False
            try:
                try:
                    import pythoncom
                    pythoncom.CoInitialize()
                    co_inited = True
                except Exception:
                    pass
                return _uia_elements(window_title, 80, shared=shared)
            finally:
                if co_inited:
                    try:
                        import pythoncom
                        pythoncom.CoUninitialize()
                    except Exception:
                        pass
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_uia_elements_com), timeout=15)
        except asyncio.TimeoutError:
            shared["cancel"].set()  # make the still-running worker unwind
            return {"items": list(shared.get("items", []))[:80], "limitation": None, "truncated": True,
                    "timed_out": True, "visited": shared.get("count", 0), "_hard_timeout": True}

    async def run_ocr():
        if not include_ocr:
            return None
        f_origin = (frame_info["origin"]["x"], frame_info["origin"]["y"]) if frame_info else (0, 0)
        img, origin = frame, f_origin
        scope = {"kind": "screen", "origin": {"x": f_origin[0], "y": f_origin[1]}}
        if win_rect is not None:
            src = _ocr_source(frame, f_origin, win_rect)
            if src is not None:
                sub, org, how = src
                if how == "grab":  # window on another monitor / straddling the frame: grab just its rect
                    try:
                        sub, ginfo = grab_screen(region=org)
                        org = (ginfo["origin"]["x"], ginfo["origin"]["y"])
                    except Exception:
                        sub = None
                if sub is not None:
                    img, origin = sub, (org[0], org[1])
                    scope = {"kind": "window", "origin": {"x": origin[0], "y": origin[1]},
                             "rect": {"left": win_rect[0], "top": win_rect[1],
                                      "width": win_rect[2], "height": win_rect[3]}}
        if img is None:  # targeted window not capturable (minimized/off-desktop): read the primary screen
            try:
                img, finfo = grab_screen()
                origin = (finfo["origin"]["x"], finfo["origin"]["y"])
                scope = {"kind": "screen", "origin": {"x": origin[0], "y": origin[1]},
                         "note": "window_title did not resolve to a visible window rect; OCR covers the screen"}
            except Exception:
                return None
        res = await _ocr_words(cap=200, lang=lang, img=img, origin=origin)
        if res is not None:
            res["scope"] = scope
        return res

    # UIA (COM objects created and used only on its own CoInitialize'd worker thread) and OCR (WinRT
    # objects awaited on the event loop) share no apartment-bound state, so they run concurrently:
    # latency is max(UIA, OCR) instead of their sum.
    uia_res, ocr_res = await asyncio.gather(
        run_uia() if include_uia else _none(), run_ocr())

    if include_uia:
        uia_items = uia_res
        if isinstance(uia_items, dict) and uia_items.get("_hard_timeout"):
            degraded.append("uia_timeout")
        if uia_items == "no_window":
            out["uia_note"] = (f"window_title {window_title!r} did not match any open window; "
                               f"adjust the substring or omit it to use the foreground window.")
        elif uia_items is None:
            degraded.append("uia")
        else:
            if uia_items["items"] or not uia_items.get("timed_out"):
                out["uia_elements"] = uia_items["items"]
            if uia_items.get("truncated"):
                out["uia_truncated"] = True
            if uia_items.get("timed_out"):
                out["uia_timed_out"] = True
                if "uia_timeout" not in degraded:
                    degraded.append("uia_timeout")
            out["uia_visited"] = uia_items.get("visited", 0)
            limitation = uia_items.get("limitation")
            if limitation:
                out["uia_accessibility"] = limitation
                out["grounding_strategy"] = (
                    "UIA exposed only browser chrome. Prefer DOM/CDP; otherwise use OCR words or "
                    "screenshot coordinates and verify the result."
                )
    if include_ocr and "ocr" not in degraded:
        if ocr_res is None:
            degraded.append("ocr")
        else:
            out["ocr_words"] = ocr_res["words"]
            out["ocr_scope"] = ocr_res["scope"]
            if ocr_res["truncated"]:
                out["ocr_truncated"] = True
                out["ocr_total"] = ocr_res["total"]

    if degraded:
        out["degraded"] = degraded
    return out


async def _none():
    return None
