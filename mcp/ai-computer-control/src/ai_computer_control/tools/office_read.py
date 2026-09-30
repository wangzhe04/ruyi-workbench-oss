"""结构化读表 / 分页读 PDF —— 解决「AI 盲操作」类痛点 (v1.8.0).

read_document (document.py) 的 xlsx/pdf 分支保留不动 —— 那是「把整篇拍平成一段文本」的粗读，适合小文件
快速一瞥。本模块是【增强版结构化读】:

  * excel_read      —— 结构化读表: 返回 headers/data 二维、可选公式、数字格式、多 sheet 概要，
                        read_only 防大文件卡死，max_rows 截断防上下文爆掉。
  * pdf_read_pages  —— 分页读 PDF: 只读你点名的页 (支持 '3' / '1-5' / '1,3,7-9')，逐页截断，
                        试给大纲 (outline)。解决「50 页 PDF 整读爆上下文」。

依赖纪律: openpyxl / pdfplumber 都在核心依赖树里 (requirements_offline.txt)。若某台机器缺失，工具返回
人话安装提示而非炸服务器启动 (import 守护)。pypdf 不在依赖树 —— pdf 大纲能拿到就给、拿不到就如实说明。
"""

import os
import threading

from ai_computer_control.server import mcp


# load_workbook on a huge/corrupt xlsx can take minutes (it parses the whole zip + shared-strings).
# Run it in a daemon thread with a join deadline so excel_read returns a clean error instead of
# hanging to the 120s bridge kill (which would also lose warm ACC state for every other tool).
_WB_TIMEOUT_SENTINEL = object()


def _load_workbook_bounded(path, timeout=20, **kwargs):
    """load_workbook in a daemon thread. Returns (wb, None) or (None, error_str_or_'timeout')."""
    holder = {}

    def _run():
        try:
            from openpyxl import load_workbook
            holder["wb"] = load_workbook(path, **kwargs)
        except Exception as e:  # noqa: BLE001
            holder["e"] = e
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        return None, "timeout"
    if "e" in holder:
        return None, f"{type(holder['e']).__name__}: {holder['e']}"
    return holder.get("wb"), None



_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_OOXML_EXTS = (".docx", ".docm", ".xlsx", ".xlsm", ".xltx", ".xltm", ".pptx", ".pptm")


def ole_password_hint(path: str) -> str | None:
    """OOXML 扩展名却是 OLE 复合文档头(D0 CF 11 E0): 设了「打开密码」的 Office 文件就是这种封装
    (旧版 .xls/.doc/.ppt 改扩展名也是)。给人话,而不是「File is not a zip file」。"""
    if not str(path).lower().endswith(_OOXML_EXTS):
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except Exception:
        return None
    if head == _OLE_MAGIC:
        return ("文件是 OLE 复合文档而非 OOXML 压缩包:多半设置了【打开密码】(加密的 Office 文件会变成这种封装),"
                "也可能是旧版 .xls/.doc/.ppt 直接改了扩展名。请让用户解除密码保护,或另存为未加密的新版格式后重试。")
    return None


def _exc_chain_names(e: BaseException) -> list[str]:
    names, seen, cur = [], set(), e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        names.append(type(cur).__name__)
        for a in getattr(cur, "args", ()):
            if isinstance(a, BaseException):
                names.append(type(a).__name__)
        cur = cur.__cause__ or cur.__context__
    return names


def describe_read_error(e: BaseException, path: str = "") -> str:
    """把读文档时的异常翻成人话(非空!)。加密 PDF / 加密 Office / 损坏或改名的文件都给明确原因;
    空消息异常回落到类型名 —— 空 error 会被 server 归一化成 ok:true(F9)。"""
    names = _exc_chain_names(e)
    msg = str(e).strip()
    low = msg.lower()
    if any(n in ("PDFPasswordIncorrect", "PDFEncryptionError") for n in names) or ("password" in low and "pdf" in low):
        return "PDF 已加密(password-protected),需要密码才能读取。请让用户先解除密码保护,或另存为未加密的副本。"
    hint = ole_password_hint(path) if path else None
    if hint:
        return hint
    ext = os.path.splitext(str(path))[1].lower()
    if any(n in ("BadZipFile", "PackageNotFoundError") for n in names) or "not a zip file" in low:
        return f"不是有效的 {ext or 'Office'} 文件(已损坏,或是改了扩展名的其他格式如旧版 .doc/.xls)。"
    if not msg:
        return type(e).__name__
    return f"{type(e).__name__}: {msg}"


# =============================================================================================
# T1 excel_read —— 结构化读表
# =============================================================================================
def _col_letter(idx: int) -> str:
    """1-based 列号 → Excel 列字母 (1→A, 27→AA)。"""
    s = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        s = chr(65 + rem) + s
    return s


def _parse_a1_range(rng: str):
    """把 'B2:D10' 拆成 (min_row, min_col, max_row, max_col)，1-based。坏 range 抛 ValueError (人话)。"""
    from openpyxl.utils import range_boundaries  # (min_col, min_row, max_col, max_row)

    try:
        min_col, min_row, max_col, max_row = range_boundaries(str(rng).strip())
    except Exception:
        raise ValueError(
            f"看不懂的单元格区域 range={rng!r} —— 请用 A1 记法，例如 'A1:D20' 或单格 'B2'。"
        )
    if None in (min_col, min_row, max_col, max_row):
        raise ValueError(
            f"不完整的单元格区域 range={rng!r} —— 需要形如 'A1:D20' 的闭区间 (不支持整列 'A:A')。"
        )
    return min_row, min_col, max_row, max_col


@mcp.tool()
def excel_read(
    path: str,
    sheet: str | None = None,
    range: str | None = None,
    include_formulas: bool = False,
    max_rows: int = 200,
) -> dict:
    """结构化读取 Excel (.xlsx):二维 data + 表头 + 可选公式/数字格式。

    比 read_document 的粗读(整篇拍平成文本)更适合表格。多 sheet 时缺省返回「各 sheet 概要 + active sheet 的
    数据」,再用 sheet= 精读某张。

    Args:
        path: .xlsx 文件路径。
        sheet: 工作表名;缺省读活动表,并在 sheets 里给出全部表的概要。
        range: A1 记法区域 ('A1:D50' / 单格 'B2');缺省从 A1 读到数据末尾 (受 max_rows 限)。
        include_formulas: True 时额外回读公式 (如 {'D2':'=SUM(B2:C2)'}),稍慢;缺省只给算好的值。
        max_rows: 数据行数上限,默认 200;超出则截断并在 truncated 给出真实总行数。

    Returns:
        dict with ok, path, sheet (实际读的表), sheets [{name, rows, cols}], headers (读入的第一行,data 不含它),
        data [[...]] (字符串/数字/None), truncated {rows_returned, rows_total, note} | None,
        formulas {'A1':'=...'} | None (仅真有公式的格), number_formats {'B':'¥#,##0.00'} | None (非通用格式的列),
        range (实际读取的 A1 区域)。缺 openpyxl / 文件不存在 / 坏 range / 坏 sheet 名 -> {'error': 人话说明}。
    """
    if not str(path).lower().endswith((".xlsx", ".xlsm", ".xltx", ".xltm")):
        return {"error": f"excel_read 只读 .xlsx 系列，收到 {path!r}。CSV/老 .xls 不支持。"}
    if not os.path.exists(path):
        return {"error": f"文件不存在: {path}"}

    try:
        from openpyxl import load_workbook
    except Exception:
        return {"error": "结构化读表需要 openpyxl。离线包已含，可运行 installer 重装；或 pip install openpyxl"}

    try:
        mr = max(1, int(max_rows))
    except Exception:
        mr = 200

    ole = ole_password_hint(path)
    if ole:
        return {"error": ole}

    try:
        # read_only=True: 流式读，防大文件把内存/时间吃爆 (用户明确要求)。data_only=True: 取算好的值。
        wb, wb_err = _load_workbook_bounded(path, timeout=20, read_only=True, data_only=True)
        if wb_err == "timeout":
            return {"error": "打开工作簿超时 (>20s) -- 文件可能过大或损坏；可用 pdf_read_pages 风格按区读取，或减小范围"}
        if wb is None:
            return {"error": f"打不开工作簿 (可能损坏或非 xlsx): {wb_err}"}
    except Exception as e:
        return {"error": f"打不开工作簿 (可能损坏或非 xlsx): {describe_read_error(e, path)}"}

    try:
        # 全表概要 (维度) —— 多 sheet 时让 AI 一眼看清有哪些表、各多大。
        # 没写 <dimension> 的工作表(部分生成器)read_only 下 max_row/max_column 是 None: 报 None(未知),
        # 不要报 0 —— 0 会让模型以为是空表。
        sheets_summary = []
        for nm in wb.sheetnames:
            w = wb[nm]
            sheets_summary.append({
                "name": nm,
                "rows": int(w.max_row) if w.max_row else None,
                "cols": int(w.max_column) if w.max_column else None,
            })

        # 选表: 显式 sheet= 优先，否则活动表。
        if sheet is not None:
            if sheet not in wb.sheetnames:
                wb.close()
                return {"error": f"没有名为 {sheet!r} 的工作表。可选: {wb.sheetnames}"}
            ws = wb[sheet]
            active_name = sheet
        else:
            ws = wb.active
            active_name = ws.title

        # 区域: 显式 range= 优先，否则整表 (A1 起)。
        explicit = range is not None
        if explicit:
            try:
                min_row, min_col, max_row, max_col = _parse_a1_range(range)
            except ValueError as ve:
                wb.close()
                return {"error": str(ve)}
        else:
            min_row, min_col = 1, 1
            max_row = int(ws.max_row) if ws.max_row else None
            max_col = int(ws.max_column) if ws.max_column else None
            # 声明的维度不可信(缺失,或只有 A1 却有数据): 不按维度截,改成逐行迭代到 max_rows。
            if not max_row or not max_col or (max_row <= 1 and max_col <= 1):
                max_row = max_col = None

        # 读值: 一遍 read_only 迭代同时取 值 + 数字格式(read_only 的 ReadOnlyCell 自带 number_format,
        # 不必再整本非只读重开 —— 那一遍在 5 万行表上就是 3 秒)。
        bounded = max_row is not None and max_col is not None
        if bounded:
            rows_total = max_row - min_row + 1
            row_cap = min(rows_total, mr)
            it = ws.iter_rows(min_row=min_row, max_row=min_row + row_cap - 1,
                              min_col=min_col, max_col=max_col, values_only=False)
        else:
            rows_total = None
            row_cap = mr
            it = ws.iter_rows(min_row=min_row, min_col=min_col,
                              max_col=max_col, values_only=False)

        data = []
        col_formats: dict[int, str] = {}   # 绝对列号 -> 首个非 General 格式(跳过表头行)
        more = False
        width = 0
        for ridx, row in enumerate(it):
            if ridx >= row_cap:
                more = True    # 多看到第 row_cap+1 行 = 确有更多(未声明维度时用它判截断)
                break
            vals = []
            for cidx, cell in enumerate(row):
                vals.append(getattr(cell, "value", None))
                if ridx >= 1 or row_cap == 1:
                    nf = getattr(cell, "number_format", None)
                    col = (getattr(cell, "column", None) or (min_col + cidx))
                    if nf and nf != "General" and col not in col_formats:
                        col_formats[col] = nf
            width = max(width, len(vals))
            data.append(vals)
        if not bounded:
            max_col = min_col + max(width, 1) - 1
        for r_ in data:            # 未声明维度时各行长短不一: 补齐成矩形
            if len(r_) < width:
                r_.extend([None] * (width - len(r_)))
        n_read = len(data)
        hard_max_row = min_row + max(n_read, 1) - 1
        if not bounded and not more:
            rows_total = n_read

        headers = [("" if v is None else v) for v in data[0]] if data else []
        body = data[1:] if len(data) > 1 else []
        number_formats = {_col_letter(c): f for c, f in sorted(col_formats.items())}

        truncated = None
        if more or (rows_total is not None and rows_total > n_read):
            truncated = {
                "rows_returned": n_read,
                "rows_total": rows_total,      # None = 工作表未声明维度,总行数未知
                "next_start_row": min_row + n_read,
                "note": (f"数据超 max_rows={mr}，只返回前 {n_read} 行"
                         + (f" (共 {rows_total} 行)" if rows_total is not None else " (工作表未声明维度,总行数未知)")
                         + "。缩小 range= (如续读用 next_range) 或调大 max_rows= 读更多。"),
            }
            if rows_total is not None:
                truncated["next_range"] = (f"{_col_letter(min_col)}{min_row + n_read}:"
                                           f"{_col_letter(max_col)}{max_row}")
            else:
                truncated["next_range"] = f"{_col_letter(min_col)}{min_row + n_read}:{_col_letter(max_col)}{min_row + n_read + mr - 1}"

        wb.close()

        out = {
            "ok": True,
            "path": os.path.abspath(path),
            "sheet": active_name,
            "sheets": sheets_summary,
            "headers": headers,
            "data": body,
            "range": f"{_col_letter(min_col)}{min_row}:{_col_letter(max_col)}{hard_max_row}",
            "truncated": truncated,
            "number_formats": number_formats or None,
            "formulas": None,
        }

        # include_formulas: 单独开一次 data_only=False (values 变成公式串)，只挑真有公式的格。
        if include_formulas:
            out["formulas"] = _read_formulas(path, active_name, min_row, min_col,
                                             max_row if max_row is not None else hard_max_row, max_col, mr)

        return out
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return {"error": f"读表失败: {describe_read_error(e, path)}"}


def _read_formulas(path, sheet_name, min_row, min_col, max_row, max_col, mr) -> dict:
    """回读区域内的公式 (data_only=False → cell.value 是 '=...' 串)。仅收真以 '=' 开头的格。"""
    out = {}
    try:
        wb, _ = _load_workbook_bounded(path, timeout=20, read_only=True, data_only=False)
        if wb is None:
            return {}
        ws = wb[sheet_name]
        hard_max_row = min_row + min(max_row - min_row + 1, mr) - 1
        r = min_row - 1
        for row in ws.iter_rows(min_row=min_row, max_row=hard_max_row,
                                min_col=min_col, max_col=max_col, values_only=False):
            r += 1
            for cell in row:
                v = cell.value
                if isinstance(v, str) and v.startswith("="):
                    out[f"{_col_letter(cell.column)}{cell.row}"] = v
        wb.close()
    except Exception:
        return {}
    return out


# =============================================================================================
# T2 pdf_read_pages —— 分页读 PDF
# =============================================================================================
def _parse_pages(spec: str, total: int) -> list[int]:
    """'3' / '1-5' / '1,3,7-9' → 有序去重的 1-based 页号列表。越界/坏格式抛 ValueError (人话)。"""
    spec = str(spec).strip()
    if not spec:
        raise ValueError("pages 不能为空 —— 例如 '3' / '1-5' / '1,3,7-9'。")
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, _, hi_s = part.partition("-")
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError:
                raise ValueError(f"看不懂的页码段 {part!r} —— 例如 '1-5'。")
            if lo > hi:
                lo, hi = hi, lo
            for p in range(lo, hi + 1):
                pages.append(p)
        else:
            try:
                pages.append(int(part))
            except ValueError:
                raise ValueError(f"看不懂的页码 {part!r} —— 例如 '3'。")
    if not pages:
        raise ValueError(f"pages={spec!r} 没解析出任何页码。")
    bad = sorted({p for p in pages if p < 1 or p > total})
    if bad:
        raise ValueError(
            f"页码越界: {bad} —— 本 PDF 共 {total} 页 (有效页码 1..{total})。"
        )
    # 去重保序。
    seen, ordered = set(), []
    for p in pages:
        if p not in seen:
            seen.add(p)
            ordered.append(p)
    return ordered


def _pdf_outline(path: str) -> list[dict]:
    """尽力取 PDF 大纲/书签 [{title, page}]。pdfplumber 拿不到大纲，试 pypdf；pypdf 不在依赖树则返回 []。"""
    try:
        import pypdf  # 不在依赖树 —— 装了就用，没装就静默回 []。
    except Exception:
        return []
    try:
        reader = pypdf.PdfReader(path)
        out = []

        def _walk(items):
            for it in items:
                if isinstance(it, list):
                    _walk(it)
                    continue
                try:
                    title = str(getattr(it, "title", "") or "")
                    pageno = reader.get_destination_page_number(it) + 1  # 0-based → 1-based
                    out.append({"title": title, "page": int(pageno)})
                except Exception:
                    continue

        _walk(reader.outline or [])
        return out
    except Exception:
        return []


def _compress_pages(pages: list[int]) -> str:
    """[17,18,19,25] -> '17-19,25' (续读用的 pages 规格)。"""
    out, i = [], 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        out.append(str(pages[i]) if i == j else f"{pages[i]}-{pages[j]}")
        i = j + 1
    return ",".join(out)


_PDF_TIME_BUDGET_S = 15.0


@mcp.tool()
def pdf_read_pages(path: str, pages: str = "1-5", max_chars_per_page: int = 4000,
                   max_chars: int = 30000) -> dict:
    """分页读取 PDF:只读你点名的页,避免「50 页 PDF 整读爆上下文」。

    比 read_document(整本拍平成一段文本)更精确:逐页截断、总量有预算,并尽力给出大纲,可先看目录再选页。

    Args:
        path: .pdf 文件路径。
        pages: 1-based 页码规格:'3' / '1-5' / '1,3,7-9'。默认 '1-5'。
        max_chars_per_page: 每页文本上限,默认 4000;超出截断并 truncated=True。
        max_chars: 本次调用总字符预算,默认 30000(另有约 15 秒时间预算);用尽即停,返回 next_pages / nextPage。

    Returns:
        dict with ok, path, total_pages, outline [{title, page}] (书签大纲,需 pypdf 且有书签), outline_note,
        pages [{page, text, chars, truncated}], truncated: True (预算用尽、仍有请求页没读;连同 next_pages /
        nextPage / stopped_by), next_pages (如 '17-100',直接作为下次的 pages 参数), note / no_text_pages (无文字层的
        扫描件/图片页,建议 OCR)。加密 PDF -> error 说明需要密码。越界页码 / 坏 pages 格式 / 缺 pdfplumber /
        文件不存在 -> {'error': 人话说明}。
    """
    if not str(path).lower().endswith(".pdf"):
        return {"error": f"pdf_read_pages 只读 .pdf，收到 {path!r}。"}
    if not os.path.exists(path):
        return {"error": f"文件不存在: {path}"}

    try:
        import pdfplumber
    except Exception:
        return {"error": "分页读 PDF 需要 pdfplumber。离线包已含，可运行 installer 重装；或 pip install pdfplumber"}

    try:
        cap = max(1, int(max_chars_per_page))
    except Exception:
        cap = 4000
    try:
        budget = max(1, int(max_chars))
    except Exception:
        budget = 30000

    try:
        import time
        t0 = time.monotonic()
        with pdfplumber.open(path) as pdf:
            total = len(pdf.pages)
            try:
                want = _parse_pages(pages, total)
            except ValueError as ve:
                return {"error": str(ve)}

            out_pages = []
            used = 0
            stopped_by = None
            remaining: list[int] = []
            for idx, pno in enumerate(want):
                if out_pages and used >= budget:
                    stopped_by, remaining = "max_chars", want[idx:]
                    break
                if out_pages and time.monotonic() - t0 > _PDF_TIME_BUDGET_S:
                    stopped_by, remaining = "time", want[idx:]
                    break
                page = pdf.pages[pno - 1]  # 1-based → 0-based
                text = page.extract_text() or ""
                truncated = False
                room = budget - used
                if out_pages and min(len(text), cap) > room:
                    # 这一页装不下剩余预算: 整页留给下一次调用(不切半页)。
                    stopped_by, remaining = "max_chars", want[idx:]
                    break
                lim = min(cap, budget)   # 首页即便超预算也只给预算内的部分(保证有进展)
                if len(text) > lim:
                    text = text[:lim]
                    truncated = True
                used += len(text)
                out_pages.append({
                    "page": pno,
                    "text": text,
                    "chars": len(text),
                    "truncated": truncated,
                })

        outline = _pdf_outline(path)
        outline_note = None
        if not outline:
            outline_note = "未读到大纲 (PDF 无书签，或未安装 pypdf —— 离线依赖清单含 pypdf，装好后可读大纲)。"

        out = {
            "ok": True,
            "path": os.path.abspath(path),
            "total_pages": total,
            "outline": outline,
            "outline_note": outline_note,
            "pages": out_pages,
        }
        no_text = [p["page"] for p in out_pages if p["chars"] == 0]
        if no_text:
            out["no_text_pages"] = no_text
            out["note"] = (f"第 {_compress_pages(no_text)} 页没有文字层(多半是扫描件/图片 PDF)。"
                           "可把该页导出/截图为图片后用 ocr_image 做 OCR 识别(或对屏幕上打开的 PDF 用 ocr_screen)。")
        if stopped_by:
            out["truncated"] = True
            out["stopped_by"] = stopped_by
            out["next_pages"] = _compress_pages(remaining)
            out["nextPage"] = remaining[0]
        return out
    except Exception as e:
        msg = describe_read_error(e, path)
        return {"error": msg if msg.startswith("PDF 已加密") else f"读 PDF 失败: {msg}"}
