"""Behavioral smoke test for v1.9.1 -- CJK OCR 硬化 + 工具超时/卡死修复 (第87波).

覆盖 (均无需真实显示,纯函数/注册/契约级):
  OCR 中文修复:
    - _normalize_lang_tag: zh/chinese/zh-CN -> zh-Hans-CN; zh-TW/zh-Hant -> zh-Hant-TW
    - _candidate_lang_tags: 中文请求给简繁双候选
    - _is_cjk: 识别中日韩文字
    - _find_phrase: CJK 跨词短语无空格匹配 (ocr_find_text "系统设置" 命中 ["系统","设置"])
    - ocr_available_languages 工具已注册
  工具超时/卡死修复:
    - ocr._recognize 用 asyncio.wait_for 包了 recognize_async (源码静态断言)
    - observe 增加 lang 参数 + UIA/OCR 每步超时 (源码静态断言)
    - uia._run_bounded 存在且在 daemon 线程 join 超时返回哨兵
    - office_read._load_workbook_bounded 存在
    - capture.window_screenshot 的 PrintWindow 在有界线程内 (源码静态断言)
  CJK 编码:
    - filesystem._decode_text: GBK 字节按 UTF-8 解失败 -> 回退系统 ACP,无 U+FFFD
    - application 用 shell._default_console_encoding (源码静态断言,不再硬编码 utf-8)

Run with UTF-8:  python -X utf8 tests/smoke_v191.py
"""

import asyncio
import inspect
import os
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
sys.path.insert(0, _SRC)

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_v191_data")
os.makedirs(_DATA, exist_ok=True)
os.environ.setdefault("WCW_DATA_DIR", _DATA)

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.ocr as ocr  # noqa: E402
import ai_computer_control.tools.filesystem as fs  # noqa: E402

_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def _src_has(module, needle: str) -> bool:
    try:
        src = inspect.getsource(module)
    except (TypeError, OSError):
        src = ""
    return needle in src


def main() -> int:
    print("# v1.9.1 smoke: CJK OCR + 超时/卡死修复")

    # --- OCR lang normalization -------------------------------------------------
    print("\n== OCR 语言标签归一化 ==")
    check(ocr._normalize_lang_tag("zh") == "zh-Hans-CN", "zh -> zh-Hans-CN")
    check(ocr._normalize_lang_tag("chinese") == "zh-Hans-CN", "chinese -> zh-Hans-CN")
    check(ocr._normalize_lang_tag("zh-CN") == "zh-Hans-CN", "zh-CN -> zh-Hans-CN")
    check(ocr._normalize_lang_tag("zh-TW") == "zh-Hant-TW", "zh-TW -> zh-Hant-TW")
    check(ocr._normalize_lang_tag("zh-Hant") == "zh-Hant-TW", "zh-Hant -> zh-Hant-TW")
    check(ocr._normalize_lang_tag(None) is None, "None -> None")
    check(ocr._normalize_lang_tag("ja") == "ja", "ja -> ja")

    # Candidate chain: a Simplified request should also try Traditional (and vice-versa).
    cands = ocr._candidate_lang_tags("zh")
    check("zh-Hans-CN" in cands and "zh-Hant-TW" in cands, "zh 候选含简繁两支")
    cands_t = ocr._candidate_lang_tags("zh-TW")
    check("zh-Hant-TW" in cands_t and "zh-Hans-CN" in cands_t, "zh-TW 候选含繁简两支")

    # --- CJK detection + phrase matching ---------------------------------------
    print("\n== CJK 检测 + 跨词短语匹配 ==")
    check(ocr._is_cjk("系统设置") is True, "_is_cjk 识别中文")
    check(ocr._is_cjk("hello world") is False, "_is_cjk 非中文返回 False")
    check(ocr._is_cjk("設定") is True, "_is_cjk 识别繁体")

    # Windows segments CJK into 2-4 char units; "系统设置" arrives as words ["系统","设置"].
    words = [
        {"text": "系统", "left": 10, "top": 10, "width": 40, "height": 20, "center": [30, 20]},
        {"text": "设置", "left": 55, "top": 10, "width": 40, "height": 20, "center": [75, 20]},
        {"text": "取消", "left": 100, "top": 10, "width": 40, "height": 20, "center": [120, 20]},
    ]
    m = ocr._find_phrase(words, "系统设置")
    check(m is not None, "ocr_find_text CJK 跨词短语命中 (无空格)")
    check(m is not None and "系统" in m["matched_text"], "matched_text 含首词")
    # Latin phrase still works (space-joined).
    latin = [
        {"text": "Save", "left": 0, "top": 0, "width": 30, "height": 20, "center": [15, 10]},
        {"text": "As", "left": 35, "top": 0, "width": 20, "height": 20, "center": [45, 10]},
    ]
    ml = ocr._find_phrase(latin, "save as")
    check(ml is not None, "Latin 短语仍按空格匹配")
    # Non-existent phrase.
    check(ocr._find_phrase(words, "不存在的文字") is None, "未命中返回 None")

    # --- Small-image upscaling --------------------------------------------------
    print("\n== 小图放大 ==")
    try:
        from PIL import Image
        import io as _io
        buf = _io.BytesIO()
        Image.new("RGB", (300, 200), (255, 255, 255)).save(buf, "PNG")
        small_bytes = buf.getvalue()
        _upscaled, scale = ocr._maybe_upscale(small_bytes, min_dim=900)
        check(scale > 1.0, f"小图被放大 (scale={scale:.2f})")
        big_buf = _io.BytesIO()
        Image.new("RGB", (1920, 1080), (0, 0, 0)).save(big_buf, "PNG")
        _big, bscale = ocr._maybe_upscale(big_buf.getvalue(), min_dim=900)
        check(bscale == 1.0, "大图不放大 (scale==1.0)")
    except Exception as e:  # noqa: BLE001
        check(False, f"upscale 测试异常 (Pillow 缺失?): {e}")

    # --- New tool registered ----------------------------------------------------
    print("\n== 新工具注册 ==")
    names = {t.name for t in server.mcp._tool_manager.list_tools()}
    check("ocr_available_languages" in names, "ocr_available_languages 已注册")
    check(server.VERSION == "1.9.1", f"VERSION == 1.9.1 (got {server.VERSION})")

    # --- winsdk language-pack enumeration shape (regression gate) ---------------
    # winsdk exposes installed OCR languages as the PROPERTY `available_recognizer_languages`;
    # the method-shaped `get_available_recognizer_languages()` does not exist and made
    # ocr_available_languages always error + the "installed Chinese engine" fallback dead.
    print("\n== OCR 语言包枚举 (winsdk 属性形态) ==")
    check(_src_has(ocr, '"available_recognizer_languages"'),
          "_available_lang_tags 用属性 available_recognizer_languages (非不存在的方法)")
    check(_src_has(ocr, "getattr(_ocr.OcrEngine"),
          "getattr 容错旧/新 winsdk 形态")
    check(ocr._available_lang_tags() is not None, "_available_lang_tags 不抛异常 (无包时返回 [])")

    # --- OCR recognize_async is bounded (source assertion) ---------------------
    print("\n== OCR/observe 超时契约 (源码断言) ==")
    check(_src_has(ocr, "asyncio.wait_for(engine.recognize_async(bitmap)"),
          "_recognize 用 asyncio.wait_for 包 recognize_async")
    check(_src_has(ocr, "_OCR_RECOGNIZE_TIMEOUT_S"), "存在 recognize 超时常量")

    import ai_computer_control.tools.observe as observe
    check("lang" in inspect.signature(observe.observe).parameters,
          "observe 增加 lang 参数")
    check(_src_has(observe, "asyncio.to_thread(_uia_elements"),
          "observe UIA 遍历在 asyncio.to_thread 内")
    check(_src_has(observe, "asyncio.wait_for(") and _src_has(observe, "timeout=15"),
          "observe UIA 遍历有 15s 超时")

    # --- UIA bounded execution --------------------------------------------------
    print("\n== UIA 有界执行 ==")
    import ai_computer_control.tools.uia as uia
    check(hasattr(uia, "_run_bounded"), "uia._run_bounded 存在")
    check(hasattr(uia, "_TIMEOUT_SENTINEL"), "uia._TIMEOUT_SENTINEL 存在")
    # A slow function (3s) with a 1s bound must return the sentinel, not hang.
    r = uia._run_bounded(lambda: time.sleep(3) or "late", timeout=1)
    check(r is uia._TIMEOUT_SENTINEL, "_run_bounded 超时返回哨兵 (不死等)")
    # A fast function returns its value.
    r2 = uia._run_bounded(lambda: "ok", timeout=5)
    check(r2 == "ok", "_run_bounded 正常返回结果")
    # An exception propagates.
    try:
        uia._run_bounded(lambda: (_ for _ in ()).throw(ValueError("boom")), timeout=5)
        check(False, "_run_bounded 异常应抛出")
    except ValueError:
        check(True, "_run_bounded 异常向上抛")

    # --- office_read bounded load_workbook -------------------------------------
    print("\n== office_read 有界 load_workbook ==")
    import ai_computer_control.tools.office_read as oread
    check(hasattr(oread, "_load_workbook_bounded"), "_load_workbook_bounded 存在")
    # A non-xlsx path returns an error (not a hang).
    wb, err = oread._load_workbook_bounded(os.path.join(_DATA, "does_not_exist.xlsx"), timeout=5)
    check(wb is None and err is not None, "坏路径返回 (None, error)")

    # --- capture PrintWindow bounded (source assertion) ------------------------
    print("\n== capture PrintWindow 有界 ==")
    import ai_computer_control.tools.capture as capture
    check(_src_has(capture, "threading.Thread(target=_cap, daemon=True)"),
          "PrintWindow 在 daemon 线程内 (join 超时)")
    check(_src_has(capture, "t.join(timeout=5)"), "PrintWindow join 5s 超时")

    # --- filesystem GBK fallback -----------------------------------------------
    print("\n== filesystem GBK 回退 ==")
    gbk_bytes = "中文内容".encode("gbk")
    content, used, fallback = fs._decode_text(gbk_bytes, "utf-8")
    check("中文内容" in content, f"GBK 字节按 utf-8 解失败 -> 回退 ACP,无乱码 (used={used})")
    check(fallback == "utf-8", "fallback_from 标记为 utf-8")
    # Valid UTF-8 stays UTF-8.
    utf8_bytes = "中文".encode("utf-8")
    c2, u2, f2 = fs._decode_text(utf8_bytes, "utf-8")
    check(u2 == "utf-8" and f2 is None and c2 == "中文", "合法 UTF-8 不触发回退")
    # Explicit encoding honored.
    c3, u3, _ = fs._decode_text("hello".encode("ascii"), "ascii")
    check(u3 == "ascii" and c3 == "hello", "显式 encoding 被尊重")

    # --- application uses OEM encoding (source assertion) ----------------------
    print("\n== application OEM 编码 ==")
    import ai_computer_control.tools.application as app
    check(_src_has(app, "_default_console_encoding()"), "launch_application 用 _default_console_encoding (不再硬编码 utf-8)")

    # --- summary ---------------------------------------------------------------
    print("\n" + ("=" * 60))
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        return 1
    print("OK: all v1.9.1 assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
