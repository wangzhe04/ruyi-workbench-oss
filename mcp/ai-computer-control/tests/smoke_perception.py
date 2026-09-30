"""Behavioral smoke test for the perception fixes (audit acc-desktop F1/F2/F4/F7/F9/F10/F13/F15/F17).

Pure logic driven through fakes - no display, no win32/UIA/WinRT needed (they are MagicMocks on Linux):
  F1   _find_phrase spans exactly the matched words, never joins across lines, click centre = union centre
  F2   grab_screen: virtual-desktop capture (all_screens, negative origin), origin reported, off-desktop
       region = error (not black), all-black frame flagged
  F4   observe's UIA walk stops at the cap, caps visits, keeps the browser-Document probe, partial on deadline
  F7   observe: one grab, OCR reuses the frame, window-scoped OCR crop, include_screenshot=False, flags
  F9   wincap.capture_window: blank PrintWindow falls back, minimized detected; screenshot(window_title=)
  F10  ocr_click phrase/CJK path, miss diagnostics (words_seen, near_matches, hint), no dead confidence
  F13  origin in results, get_clipboard_image / window_screenshot image budget, format key
  F15  template matching: early exit, region + origin, best_confidence on miss, DPI scales

Run with UTF-8:  python -X utf8 tests/smoke_perception.py
"""

import asyncio
import inspect
import os
import sys
import tempfile
import threading
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_perception_data")
os.makedirs(_DATA, exist_ok=True)
os.environ.setdefault("WCW_DATA_DIR", _DATA)

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.ocr as ocr  # noqa: E402
import ai_computer_control.tools.observe as observe  # noqa: E402
import ai_computer_control.tools.screen as screen  # noqa: E402
import ai_computer_control.tools.capture as capture  # noqa: E402
import ai_computer_control.tools.uia as uia  # noqa: E402
import ai_computer_control.utils.image as imgu  # noqa: E402
try:
    import ai_computer_control.utils.wincap as wincap  # noqa: E402
except ImportError:  # pre-fix tree: no shared window-capture core -> the F9 checks fail instead of the import
    wincap = None
from PIL import Image  # noqa: E402
import PIL.ImageGrab as IG  # noqa: E402

TOOLS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def w(text, left, top, width=40, height=20, line=None):
    d = {"text": text, "left": left, "top": top, "width": width, "height": height,
         "center": [left + width // 2, top + height // 2]}
    if line is not None:
        d["line"] = line
    return d


class Patch:
    """Tiny attribute patcher usable as a context manager (restores on exit)."""

    def __init__(self, *triples):
        self.triples = triples
        self.saved = []

    def __enter__(self):
        for obj, name, val in self.triples:
            self.saved.append((obj, name, getattr(obj, name)))
            setattr(obj, name, val)
        return self

    def __exit__(self, *a):
        for obj, name, old in reversed(self.saved):
            setattr(obj, name, old)


# ================================================================= F1 / F10: phrase matching
def test_phrase():
    print("\n== F1 _find_phrase: exact span, no leading noise, no cross-line ==")
    # "系统 设置" precede "Save As" on the same line; old code returned a span starting at 系统.
    words = [w("系统", 100, 10, 40), w("设置", 145, 10, 40), w("Save", 300, 10, 30), w("As", 335, 10, 30)]
    m = ocr._find_phrase(words, "Save As")
    check(m is not None and m["matched_text"] == "Save As", f"matched_text is exactly the phrase (got {m and m['matched_text']!r})")
    check(m is not None and m["rect"]["left"] == 300 and m["rect"]["width"] == 65,
          f"rect is the union of Save+As only (got {m and m['rect']})")
    check(m is not None and m["center"] == [332, 20], f"click centre = centre of Save..As (got {m and m['center']})")
    check(m is not None and m["match_type"] == "phrase" and m["word_count"] == 2, "match_type phrase, word_count 2")

    cj = [w("打开", 10, 10), w("系统", 100, 10), w("设置", 145, 10), w("取消", 200, 10)]
    mc = ocr._find_phrase(cj, "系统设置")
    check(mc is not None and mc["rect"]["left"] == 100 and mc["rect"]["width"] == 85 and mc["matched_text"] == "系统 设置",
          f"CJK phrase spans only 系统+设置 (got {mc and (mc['rect'], mc['matched_text'])})")

    # Cross-line: "Save" ends line 0, "As" starts line 1 -> must not match; with engine line indexes and without.
    for with_line in (True, False):
        two = [w("File", 10, 10, line=0 if with_line else None), w("Save", 300, 10, line=0 if with_line else None),
               w("As", 10, 40, line=1 if with_line else None), w("Edit", 60, 40, line=1 if with_line else None)]
        check(ocr._find_phrase(two, "Save As") is None,
              f"no match across a line break ({'engine line ids' if with_line else 'geometric lines'})")
    # ... unless the phrase itself spans lines
    ml = ocr._find_phrase(two, "Save\nAs")
    check(ml is not None and ml["word_count"] == 2, "a query containing a line break may span lines")

    # A later duplicate: matches listed in reading order; ocr_find_text reports count
    dup = [w("Save", 10, 10), w("As", 55, 10), w("x", 100, 10), w("Save", 10, 60), w("As", 55, 60)]
    allm = ocr._phrase_matches(dup, "save as")
    check(len(allm) == 2 and allm[0]["rect"]["top"] == 10 and allm[1]["rect"]["top"] == 60, "two phrase matches in reading order")
    check(ocr._find_phrase(dup, "no such") is None, "miss -> None")
    # single-word substring unchanged
    s1 = ocr._find_phrase(words, "save")
    check(s1 is not None and s1["match_type"] == "word" and s1["center"] == [315, 20], "single-word substring path unchanged")

    print("\n== F10 ocr_click / ocr_find_text: phrase path, miss diagnostics ==")
    clicks = []
    import pyautogui

    async def fake_screen(region=None, lang=None):
        return {"success": True, "lang_used": "en-US", "words": words}

    with Patch((ocr, "_AVAILABLE", True), (ocr, "ocr_screen", fake_screen),
               (pyautogui, "click", lambda x, y, *a, **k: clicks.append((x, y)))):
        r = asyncio.run(TOOLS["ocr_click"](text="Save As"))
        check(r.get("success") is True and clicks == [(332, 20)], f"ocr_click multi-word phrase clicks the union centre (clicks={clicks})")
        check(r["clicked"]["match_type"] == "phrase", "clicked reports match_type=phrase")
        miss = asyncio.run(TOOLS["ocr_click"](text="Sav Ass"))
        check(miss.get("found") is False and miss.get("not_found") is True and miss.get("clicked") is None,
              "miss keeps not_found/clicked and adds found:false")
        check(miss.get("words_seen") == 4 and miss.get("lang_used") == "en-US", "miss reports words_seen + lang_used")
        check(bool(miss.get("near_matches")) and miss["near_matches"][0]["text"] == "Save As"
              and 0 < miss["near_matches"][0]["score"] < 1, f"near_matches lists the closest text (got {miss.get('near_matches')})")
        check("hint" in miss, "miss carries a hint")
        f = asyncio.run(TOOLS["ocr_find_text"](text="Save As"))
        check(f.get("found") is True and f.get("count") == 1 and f.get("match_type") == "phrase", "ocr_find_text: count + match_type")
        fm = asyncio.run(TOOLS["ocr_find_text"](text="zzzzqq"))
        check(fm.get("found") is False and fm.get("words_seen") == 4 and "hint" in fm, "ocr_find_text miss diagnostics")

    async def empty_screen(region=None, lang=None):
        return {"success": True, "words": [], "blank": True}
    with Patch((ocr, "_AVAILABLE", True), (ocr, "ocr_screen", empty_screen)):
        e = asyncio.run(TOOLS["ocr_click"](text="OK"))
        check(e.get("words_seen") == 0 and "no text" in e.get("hint", ""), "empty OCR gets the 'read no text' hint")
        check(e.get("blank") is True, "blank frame flag forwarded on an empty read")

    src = inspect.getsource(ocr)
    check("result.confidence" not in src and 'out["confidence"]' not in src, "dead OCR confidence code removed")
    check("substring of a single OCR word" not in (TOOLS["ocr_click"].__doc__ or ""), "ocr_click docstring no longer claims single-word only")


# ================================================================= F2: capture / origin / blank
def test_capture():
    print("\n== F2 grab_screen: virtual desktop, origin, off-desktop error, blank frame ==")
    calls = []

    def fake_grab(bbox=None, all_screens=False, **kw):
        calls.append({"bbox": bbox, "all_screens": all_screens})
        size = (bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else (1920, 1080)
        return Image.new("RGB", size, (30, 60, 90))

    # two 1920x1080 monitors side by side, primary on the left (origin 0,0)
    with Patch((IG, "grab", fake_grab), (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080)),
               (imgu, "primary_screen_size", lambda: (1920, 1080))):
        img, info = imgu.grab_screen(region=(2000, 100, 400, 300))
        check(calls[-1]["all_screens"] is True and calls[-1]["bbox"] == (2000, 100, 2400, 400),
              f"off-primary region uses all_screens=True with the virtual bbox (got {calls[-1]})")
        check(info["origin"] == {"x": 2000, "y": 100} and img.size == (400, 300), "origin reports the region's virtual-screen origin")
        imgu.grab_screen(region=(10, 10, 100, 100))
        check(calls[-1]["all_screens"] is False, "region inside the primary keeps the cheap primary-only grab")
        imgu.grab_screen()
        check(calls[-1]["bbox"] is None and calls[-1]["all_screens"] is False, "default full-screen capture stays primary-only")
        try:
            imgu.grab_screen(region=(5000, 0, 100, 100))
            check(False, "region wholly off the desktop must raise")
        except ValueError as e:
            check("outside the virtual desktop" in str(e), f"off-desktop region -> clear error (got {e})")
        img2, info2 = imgu.grab_screen(region=(3800, 1000, 200, 200))
        check(info2.get("clipped") is True and img2.size == (40, 80) and info2["origin"] == {"x": 3800, "y": 1000},
              f"partly-outside region is clipped and flagged (got {info2}, size {img2.size})")
        _, info3 = imgu.grab_screen(monitor="all")
        check(calls[-1]["bbox"] == (0, 0, 3840, 1080) and info3["monitor"] == "all", "monitor='all' captures the whole virtual desktop")

    # secondary monitor to the LEFT of the primary: negative virtual origin
    with Patch((IG, "grab", fake_grab), (imgu, "virtual_screen_rect", lambda: (-1920, 0, 3840, 1080)),
               (imgu, "primary_screen_size", lambda: (1920, 1080))):
        img, info = imgu.grab_screen(region=(-500, 100, 400, 300))
        check(info["origin"] == {"x": -500, "y": 100} and calls[-1]["all_screens"] is True, "negative-origin monitor is capturable")

    print("\n== F2/F13 screenshot tools: origin, blank frame, off-desktop ==")

    def black_grab(bbox=None, all_screens=False, **kw):
        size = (bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else (64, 48)
        return Image.new("RGB", size, (0, 0, 0))

    with Patch((IG, "grab", fake_grab), (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080)),
               (imgu, "primary_screen_size", lambda: (1920, 1080))):
        r = TOOLS["screenshot"](region="2000,100,400,300", max_width=200)
        check(r.get("ok") is True and r["origin"] == {"x": 2000, "y": 100} and r["scale"] == 0.5 and r["format"] == "png",
              f"screenshot(region) returns origin + scale + format (got { {k: v for k, v in r.items() if k != 'image'} })")
        r = TOOLS["screenshot_region"](x=-10, y=5000, width=50, height=50)
        check(r.get("ok") is False and "outside the virtual desktop" in r.get("error", ""), "screenshot_region off-desktop -> ok:false (was black ok:true)")
        r = TOOLS["screenshot"](region="9000,0,10,10")
        check(r.get("ok") is False, "screenshot(region) off-desktop -> ok:false")
        r = TOOLS["screenshot"](format="jpeg", max_width=0)
        check(r.get("ok") is True and r.get("format") == "jpeg", "format:'jpeg' is reported in an explicit 'format' key")
        r = TOOLS["screenshot"](format="jpg", max_width=0)
        check(r.get("format") == "jpeg", "'jpg' normalises to format 'jpeg'")
        r = TOOLS["screenshot"](format="webp", max_width=0)
        check(r.get("format") == "png", "unknown format falls back to png and says so")

    with Patch((IG, "grab", black_grab), (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080)),
               (imgu, "primary_screen_size", lambda: (1920, 1080))):
        r = TOOLS["screenshot"](region="100,100,64,48")
        check(r.get("ok") is True and r.get("blank") is True and r.get("warning") and r.get("hint"),
              "all-black frame is reported (blank + warning + hint), not silent")
    check(imgu.is_blank_frame(Image.new("RGB", (4, 4), (0, 0, 0))) is True, "is_blank_frame: black -> True")
    im = Image.new("RGB", (4, 4), (0, 0, 0))
    im.putpixel((2, 2), (0, 1, 0))
    check(imgu.is_blank_frame(im) is False, "is_blank_frame: one non-zero pixel -> False")
    check(imgu.is_blank_frame(Image.new("RGBA", (4, 4), (0, 0, 0, 255))) is True, "is_blank_frame ignores alpha")
    check("origin_x + x_img / scale" in imgu.encode_with_budget.__doc__ and "origin.x + x_in_image / scale" in screen.screenshot.__doc__,
          "coordinate docs use x_screen = origin + x_img/scale")

    print("\n== F2 ocr_screen region handling ==")
    grabs = []

    def fake_png(region=None):
        grabs.append(region)
        return b"png"

    async def fake_recognize(_png, _lang):
        return {"success": True, "text": "", "lines": [], "words": [w("A", 5, 5, 10, 10)]}

    with Patch((ocr, "_AVAILABLE", True), (ocr, "_screenshot_png", fake_png), (ocr, "_recognize", fake_recognize),
               (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080))):
        r = asyncio.run(TOOLS["ocr_screen"](region="2000,100,300,200"))
        check(r.get("success") and r["origin"] == {"x": 2000, "y": 100} and r["words"][0]["left"] == 2005
              and grabs[-1] == (2000, 100, 2300, 300), f"ocr_screen region on display 2: offsets applied (words {r.get('words')})")
        r = asyncio.run(TOOLS["ocr_screen"](region="9000,100,300,200"))
        check(r.get("ok") is False and "outside the virtual desktop" in r.get("error", ""), "ocr_screen off-desktop region -> error, not empty OCR")


# ================================================================= F4 / F7: observe
class _R:
    def __init__(self, l=0, t=0, r=10, b=10):
        self.left, self.top, self.right, self.bottom = l, t, r, b


class FakeTree:
    """Fake UIA control with call counters. `spec(depth, idx)` -> (type, children_count)."""

    calls: dict = {}

    def __init__(self, depth, idx, kind="ButtonControl", fanout=17, max_depth=3, slow=0.0, doc_at=None):
        self.depth, self.idx, self.kind = depth, idx, kind
        self.fanout, self.max_depth, self.slow, self.doc_at = fanout, max_depth, slow, doc_at

    def _c(self, k):
        FakeTree.calls[k] = FakeTree.calls.get(k, 0) + 1

    @property
    def Name(self):
        self._c("Name")
        if self.slow:
            time.sleep(self.slow)
        return f"n{self.depth}-{self.idx}"

    @property
    def ControlTypeName(self):
        self._c("ControlTypeName")
        return "DocumentControl" if self.doc_at == (self.depth, self.idx) else self.kind

    @property
    def AutomationId(self):
        self._c("AutomationId")
        return ""

    @property
    def ClassName(self):
        self._c("ClassName")
        return "X"

    @property
    def BoundingRectangle(self):
        self._c("BoundingRectangle")
        return _R()

    def GetChildren(self):
        self._c("GetChildren")
        if self.depth >= self.max_depth:
            return []
        return [FakeTree(self.depth + 1, i, self.kind, self.fanout, self.max_depth, self.slow, self.doc_at)
                for i in range(self.fanout)]


def _browser_status(root, count, types):
    norm = {str(t).lower().replace("control", "") for t in types}
    if "document" in norm:
        return None
    return {"accessibilityLimited": True, "observedNodes": count}


def test_uia_walk():
    print("\n== F4 observe UIA walk: stops at the cap, caps visits, partial on deadline ==")
    FakeTree.calls = {}
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0)),
               (uia, "_browser_accessibility_status", lambda *a, **k: None)):
        res = observe._uia_elements(None, 80)
    total = sum(FakeTree.calls.values())
    check(len(res["items"]) == 80, "80 items collected")
    check(FakeTree.calls.get("Name", 0) <= 200, f"Name reads bounded by the cap, not the tree (got {FakeTree.calls.get('Name')}; was 4001)")
    check(total < 2500, f"total COM-style calls a fraction of the old ~28,000 (got {total})")
    check(res["truncated"] is True and res["timed_out"] is False, "truncated flag set, not timed out")
    check(FakeTree.calls.get("BoundingRectangle", 0) == FakeTree.calls.get("Name", 0), "rect read once per node")
    check(all("center" in it and "rect" in it for it in res["items"]), "items keep rect + center")

    # visit cap
    FakeTree.calls = {}
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0)),
               (uia, "_browser_accessibility_status", lambda *a, **k: None)):
        res = observe._uia_elements(None, 10_000, max_visits=50)
    check(res["visited"] == 50 and res["truncated"] is True, f"total visits capped (visited {res['visited']})")

    # complete tree that fits under the cap is NOT truncated
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0, fanout=2, max_depth=2)),
               (uia, "_browser_accessibility_status", lambda *a, **k: None)):
        res = observe._uia_elements(None, 80)
    check(res["truncated"] is False and len(res["items"]) == 7, "fully walked small tree: not truncated")

    # browser window: Document sits deep in a late branch; the cap fills first. Probe must still find it.
    FakeTree.calls = {}
    with Patch((uia, "_AVAILABLE", True),
               (uia, "_root", lambda t: FakeTree(0, 0, doc_at=(3, 2000 % 17))),
               (uia, "_browser_accessibility_status", _browser_status)):
        res = observe._uia_elements(None, 80)
    check(res["limitation"] is None, "browser Document found by the probe -> no false 'accessibilityLimited'")
    check(res["visited"] < 4000, f"probe stops at the Document (visited {res['visited']})")
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0)),
               (uia, "_browser_accessibility_status", _browser_status)):
        res = observe._uia_elements(None, 80)
    check(res["limitation"] is not None and res["visited"] == 4000, "browser without a Document still gets the limitation flag")

    # deadline: slow controls -> returns what was collected + timed_out
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0, slow=0.01)),
               (uia, "_browser_accessibility_status", lambda *a, **k: None)):
        res = observe._uia_elements(None, 80, deadline_s=0.15)
    check(res["timed_out"] is True and res["truncated"] is True and 0 < len(res["items"]) < 80,
          f"deadline returns the partial list, flagged (items {len(res['items'])})")

    # shared state survives an abandoned worker
    shared = {"cancel": threading.Event()}
    with Patch((uia, "_AVAILABLE", True), (uia, "_root", lambda t: FakeTree(0, 0, slow=0.02)),
               (uia, "_browser_accessibility_status", lambda *a, **k: None)):
        t = threading.Thread(target=lambda: observe._uia_elements(None, 80, shared=shared, deadline_s=None), daemon=True)
        t.start()
        time.sleep(0.3)
        partial = list(shared["items"])
        shared["cancel"].set()
        t.join(3)
    check(len(partial) > 0 and not t.is_alive(), "shared partial results readable mid-walk; cancel unwinds the worker")


def test_observe():
    print("\n== F7 observe: one grab, frame reuse, scoped OCR, include_screenshot ==")
    grabs = []
    ocr_calls = []

    def fake_grab(bbox=None, all_screens=False, **kw):
        grabs.append(bbox)
        size = (bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else (1920, 1080)
        return Image.new("RGB", size, (200, 200, 200))

    async def fake_ocr_frame(img, origin=(0, 0), lang=None):
        ocr_calls.append((img.size, tuple(origin)))
        ws = [w(f"t{i}", origin[0] + i, origin[1] + 1, 10, 10) for i in range(250)]
        return {"success": True, "words": ws, "words_total": 250, "origin": {"x": origin[0], "y": origin[1]}}

    def fake_uia(window_title, cap, **kw):
        return {"items": [{"name": "OK", "center": [1, 1]}], "limitation": None, "truncated": True,
                "timed_out": True, "visited": 12}

    patches = (
        (IG, "grab", fake_grab), (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080)),
        (imgu, "primary_screen_size", lambda: (1920, 1080)),
        (observe, "_focused_window", lambda: {"present": True}),
        (observe, "_uia_elements", fake_uia),
        (ocr, "_AVAILABLE", True), (ocr, "ocr_frame", fake_ocr_frame),
    )
    with Patch(*patches):
        out = asyncio.run(TOOLS["observe"]())
        check(len(grabs) == 1, f"default observe: exactly one screen grab (got {len(grabs)})")
        check(ocr_calls[-1] == ((1920, 1080), (0, 0)), "OCR read the SAME frame (full size, origin 0,0)")
        check(out.get("ocr_truncated") is True and out.get("ocr_total") == 250 and len(out["ocr_words"]) == 200,
              "ocr_truncated + ocr_total surfaced when >200 words")
        check(out["ocr_scope"]["kind"] == "screen", "ocr_scope reported (screen)")
        check(out["screenshot"]["origin"] == {"x": 0, "y": 0} and out["screenshot"]["format"] == "png", "screenshot carries origin + format")
        check(out.get("uia_timed_out") is True and out.get("uia_truncated") is True and out.get("uia_elements"),
              "UIA deadline: partial elements returned with uia_timed_out/uia_truncated")
        check("uia_timeout" in out.get("degraded", []), "degraded still lists uia_timeout (compat)")

        # window-scoped OCR crops the existing frame (no 2nd grab); rect partly off-screen is clipped
        grabs.clear(); ocr_calls.clear()
        with Patch((observe, "_window_rect_for_title", lambda t: (-7, -7, 1000, 700))):
            out = asyncio.run(TOOLS["observe"](window_title="Notepad"))
        check(len(grabs) == 1 and ocr_calls[-1] == ((993, 693), (0, 0)),
              f"targeted window: OCR crop of the same frame clipped to the desktop (grabs {len(grabs)}, ocr {ocr_calls[-1]})")
        check(out["ocr_scope"]["kind"] == "window" and out["ocr_scope"]["rect"]["width"] == 1000, "ocr_scope kind=window with rect")

        # include_screenshot=False + targeted window: no full-screen grab, only the window rect
        grabs.clear(); ocr_calls.clear()
        with Patch((observe, "_window_rect_for_title", lambda t: (100, 50, 800, 600))):
            out = asyncio.run(TOOLS["observe"](window_title="Notepad", include_screenshot=False))
        check("screenshot" not in out and grabs == [(100, 50, 900, 650)], f"include_screenshot=False: only the window rect is grabbed (grabs {grabs})")
        check(ocr_calls[-1] == ((800, 600), (100, 50)) and out["ocr_words"][0]["rect"]["left"] == 100,
              "window OCR words come back in screen coordinates")

        # window on the second monitor: outside the primary frame -> grabbed via the virtual desktop
        grabs.clear(); ocr_calls.clear()
        with Patch((observe, "_window_rect_for_title", lambda t: (2100, 100, 600, 400))):
            out = asyncio.run(TOOLS["observe"](window_title="Other"))
        check(grabs == [None, (2100, 100, 2700, 500)] and ocr_calls[-1] == ((600, 400), (2100, 100)),
              f"window off the primary frame: its rect is grabbed separately (grabs {grabs})")

        # nothing requested that needs pixels -> no grab at all
        grabs.clear()
        out = asyncio.run(TOOLS["observe"](include_screenshot=False, include_ocr=False))
        check(grabs == [] and "screenshot" not in out and out.get("ok") is True, "include_screenshot=False + include_ocr=False: no grab")

    check("include_screenshot" in inspect.signature(observe.observe).parameters
          and inspect.signature(observe.observe).parameters["include_screenshot"].default is True,
          "include_screenshot exists and defaults to True (old behaviour)")

    print("\n== F7 ocr helpers: PNG header size, no decode for big frames ==")
    import io
    buf = io.BytesIO()
    Image.new("RGB", (1920, 1080), (1, 2, 3)).save(buf, "PNG")
    data = buf.getvalue()
    check(ocr._png_size(data) == (1920, 1080), "_png_size reads IHDR")
    check(ocr._png_size(b"nope") is None, "_png_size: non-PNG -> None")
    real_open = Image.open
    opened = []
    with Patch((Image, "open", lambda *a, **k: (opened.append(1), real_open(*a, **k))[1])):
        b2, sc = ocr._maybe_upscale(data)
    check(sc == 1.0 and b2 is data and not opened, "_maybe_upscale: big frame returned without decoding it")


# ================================================================= F9: window capture
def test_window():
    print("\n== F9 window capture: blank PrintWindow, minimized, screenshot(window_title) ==")
    grabs = []

    def fake_grab(bbox=None, all_screens=False, **kw):
        grabs.append(bbox)
        size = (bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else (10, 10)
        return Image.new("RGB", size, (9, 9, 9))

    good = Image.new("RGB", (400, 300), (120, 120, 120))
    black = Image.new("RGB", (400, 300), (0, 0, 0))
    state = {"pw": good, "min": False}
    restored = []
    base = (
        (IG, "grab", fake_grab), (imgu, "virtual_screen_rect", lambda: (0, 0, 3840, 1080)),
        (imgu, "primary_screen_size", lambda: (1920, 1080)),
        (wincap, "_find_hwnd", lambda t: (77, "Calculator")),
        (wincap, "_is_minimized", lambda h: state["min"]),
        (wincap, "_restore", lambda h: restored.append(h)),
        (wincap, "_window_rect", lambda h: (100, 50, 500, 350)),
        (wincap, "_frame_rect", lambda h, fb: (107, 50, 493, 343)),
        (wincap, "_bring_foreground", lambda h: None),
        (wincap, "_printwindow_bounded", lambda h, wd, ht: state["pw"]),
    )
    with Patch(*base):
        r = wincap.capture_window("calc")
        check(r["ok"] and r["method"] == "printwindow" and r["origin"] == {"x": 100, "y": 50} and not grabs,
              "PrintWindow frame used as-is; origin = window rect top-left")
        state["pw"] = black
        r = wincap.capture_window("calc")
        check(r["ok"] and r["method"] == "screen_crop" and r.get("printwindow_blank") is True and r.get("occluded_possible") is True,
              "blank PrintWindow frame falls back to the screen crop and says so")
        check(grabs[-1] == (107, 50, 493, 343) and r["origin"] == {"x": 107, "y": 50}, "crop uses the DWM visible frame; origin follows it")
        state["pw"] = None
        r = wincap.capture_window("calc")
        check(r["method"] == "screen_crop", "PrintWindow failure/timeout falls back too")
        state["pw"] = good
        state["min"] = True
        r = wincap.capture_window("calc", restore_minimized=False)
        check(r["ok"] is False and r.get("minimized") is True and "restore" in r.get("hint", "").lower(), "minimized window -> error + restore hint, not black")
        r = wincap.capture_window("calc", restore_minimized=True)
        check(r["ok"] and r.get("restored") is True and restored == [77], "minimized + restore_minimized -> restored:true")
        state["min"] = False

    # tool level
    seen = {}

    def fake_cap(title, restore_minimized=True):
        seen["args"] = (title, restore_minimized)
        return {"ok": True, "img": Image.new("RGB", (3000, 2000), (5, 5, 5)), "matched_title": "Calculator",
                "method": "printwindow", "origin": {"x": 40, "y": 60},
                "window_rect": {"left": 40, "top": 60, "width": 3000, "height": 2000}}

    with Patch((wincap, "capture_window", fake_cap)):
        r = TOOLS["screenshot"](window_title="calc")
        check(seen["args"] == ("calc", False), "screenshot(window_title) delegates to the shared capture (substring, no auto-restore)")
        check(r["ok"] and r["matched_title"] == "Calculator" and r["method"] == "printwindow" and r["origin"] == {"x": 40, "y": 60},
              "screenshot(window_title) returns matched_title/method/origin")
        r = TOOLS["window_screenshot"](title_substring="calc")
        check(r["ok"] and r["width"] <= 1280 and r["scale"] < 1 and r["format"] == "png" and "image_base64" in r,
              f"window_screenshot default budget matches screenshot (width {r.get('width')}, scale {r.get('scale')})")
        r = TOOLS["window_screenshot"](title_substring="calc", max_width=0)
        check(r["width"] == 3000 and r["scale"] == 1.0, "max_width=0 still returns the original size")
        r = TOOLS["window_screenshot"](title_substring="calc", format="jpeg")
        check(r["format"] == "jpeg", "window_screenshot reports format:'jpeg'")

    with Patch((wincap, "capture_window", lambda t, restore_minimized=True: {"ok": False, "found": False, "error": "no visible window matches 'x'"})):
        r = TOOLS["screenshot"](window_title="zzz")
        check(r["ok"] is False and "not found" in r["error"].lower(), "screenshot(window_title) miss -> Window not found")

    src = inspect.getsource(wincap)
    check("threading.Thread(target=_cap, daemon=True)" in src and "t.join(timeout=5)" in src, "PrintWindow stays in a bounded daemon thread")

    print("\n== F13 get_clipboard_image budget ==")
    big = Image.new("RGB", (4000, 3000), (10, 20, 30))
    with Patch((IG, "grabclipboard", lambda: big)):
        r = TOOLS["get_clipboard_image"]()
        check(r.get("has_image") and r["width"] <= 1280 and r["scale"] < 1 and r["original_width"] == 4000 and r["format"] == "png",
              f"clipboard image obeys the 1280 budget (got {r.get('width')}, scale {r.get('scale')})")
        r = TOOLS["get_clipboard_image"](max_width=0, format="jpeg")
        check(r["width"] == 4000 and r["format"] == "jpeg", "max_width=0 keeps full size; jpeg reported")


# ================================================================= F15: template matching
def test_vision():
    print("\n== F15 template matching: early exit, region, best score, DPI scales ==")
    try:
        import cv2
        import numpy as np
        import ai_computer_control.tools.vision as vision
    except Exception as e:  # noqa: BLE001
        print(f"  [skip] cv2/numpy unavailable: {e}")
        return
    if not vision._AVAILABLE:
        print("  [skip] vision backend unavailable")
        return
    rng = np.random.default_rng(7)
    templ = rng.integers(0, 255, (40, 60), dtype=np.uint8)
    screen_arr = rng.integers(0, 255, (400, 800), dtype=np.uint8)
    screen_arr[100:140, 200:260] = templ

    counter = {"n": 0}
    real_mt = cv2.matchTemplate

    def counting(*a, **k):
        counter["n"] += 1
        return real_mt(*a, **k)

    _cvp = Patch((cv2, "matchTemplate", counting))
    with _cvp:
        hits, best = vision._match(screen_arr, templ, 0.8, vision._MULTISCALE, find_all=False)
    check(counter["n"] == 1 and hits and best[1] == 1.0 and best[0] > 0.99, f"exact hit at 1.0 exits after 1 scale (matchTemplate calls: {counter['n']})")
    counter["n"] = 0
    with _cvp:
        hits, best = vision._match(screen_arr, templ, 0.8, vision._MULTISCALE, find_all=True)
    check(counter["n"] == len(vision._MULTISCALE), "find_all keeps scanning every scale (no early exit)")

    for sc in (2.0, 1.75, 1.5, 1.25, 0.667, 0.5):
        check(sc in vision._MULTISCALE, f"scale {sc} in the multiscale ladder")
    # icon rendered at 2x (200% DPI) is found by the ladder
    big = rng.integers(0, 255, (400, 800), dtype=np.uint8)
    scaled = cv2.resize(templ, (int(60 * 2.0), int(40 * 2.0)))
    big[150:150 + scaled.shape[0], 300:300 + scaled.shape[1]] = scaled
    hits, best = vision._match(big, templ, 0.8, vision._MULTISCALE, find_all=False)
    check(hits and best[1] == 2.0 and hits[0][1:3] == (300, 150), f"template shown at 200% found via the 2.0 scale (best {best})")

    # miss returns the best score
    noise = rng.integers(0, 255, (400, 800), dtype=np.uint8)
    hits, best = vision._match(noise, templ, 0.8, vision._MULTISCALE, find_all=False)
    check(not hits and best is not None and 0 <= best[0] < 0.8, f"miss still reports the best score seen (best {best})")

    # tool level: find_template / vision_click / wait_for_image with a patched frame source
    def frame_src(region=None):
        if region:
            x, y, wd, ht = vision._parse_region(region)
            return screen_arr[y:y + ht, x:x + wd], (x, y)
        return screen_arr, (0, 0)

    ok, buf = cv2.imencode(".png", templ)
    import base64
    b64 = base64.b64encode(buf.tobytes()).decode()
    clicks = []
    import pyautogui
    with Patch((vision, "_screen_gray", frame_src), (pyautogui, "click", lambda x, y, *a, **k: clicks.append((x, y)))):
        r = vision.find_template(template_b64=b64)
        check(r["found"] and r["match"]["center"] == [230, 120], f"find_template hit centre (got {r})")
        r = vision.find_template(template_b64=b64, region="150,50,300,200")
        check(r["found"] and r["match"]["center"] == [230, 120], "region search returns SCREEN coordinates (origin added)")
        r = vision.find_template(template_b64=b64, region="500,300,200,90")
        check(r["found"] is False and "best_confidence" in r and r["best_confidence"] is not None and "hint" in r,
              f"find_template miss: best_confidence + hint (got {r})")
        r = vision.vision_click(template_b64=b64, region="150,50,300,200")
        check(r["found"] and clicks == [(230, 120)] and r["clicked"] is True, "vision_click with region clicks the screen-coordinate centre")
        r = vision.vision_click(template_b64=b64, region="500,300,200,90", click=False)
        check(r["ok"] and r["found"] is False and r.get("best_confidence") is not None, "vision_click miss carries best_confidence")
        t0 = time.monotonic()
        r = vision.wait_for_image(template_b64=b64, region="500,300,200,90", timeout=0.3, poll_ms=50)
        check(r["found"] is False and r.get("waited_ms", -1) >= 250 and r.get("best_confidence") is not None,
              f"wait_for_image timeout: waited_ms + best_confidence (got {r})")
        r = vision.find_template(template_b64=b64, region="1,2,3")
        check("error" in r, "bad region -> error")


def main() -> int:
    print("# perception smoke (F1/F2/F4/F7/F9/F10/F13/F15/F17)")
    for fn in (test_phrase, test_capture, test_uia_walk, test_observe, test_window, test_vision):
        try:
            fn()
        except Exception as e:  # noqa: BLE001 - a crash in one area must not hide the others
            import traceback
            traceback.print_exc()
            check(False, f"{fn.__name__} crashed: {type(e).__name__}: {e}")

    print("\n== F17 find_on_screen exact-only note ==")
    import pyautogui

    class Loc:
        left, top, width, height = 10, 20, 30, 40

    def loc(path, confidence=None):
        if confidence is not None:
            raise NotImplementedError("needs opencv")
        return Loc()

    try:
        with Patch((pyautogui, "locateOnScreen", loc),
                   (pyautogui, "center", lambda l: type("P", (), {"x": 25, "y": 40})())):
            r = TOOLS["find_on_screen"](template_path="x.png")
            check(r.get("found") is True and r.get("matched_exact_only") is True and "note" in r,
                  "find_on_screen without OpenCV flags matched_exact_only")
    except Exception as e:  # noqa: BLE001
        check(False, f"find_on_screen check crashed: {e}")

    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-PERCEPTION SMOKE: FAIL")
        return 1
    print("ACC-PERCEPTION SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
