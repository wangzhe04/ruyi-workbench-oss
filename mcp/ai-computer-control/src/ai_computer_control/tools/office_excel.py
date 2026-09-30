"""Excel beautify + chart tools (v1.6 模板驱动).

excel_beautify — turn a plain data .xlsx (just written by write_excel) into a professional-looking
                 sheet: bold white header on the primary fill, frozen header row, zebra striping,
                 thin borders over the used range, content-fit column widths (cap 50), right-aligned
                 numeric columns, auto-filter. Idempotent — re-running does not stack/duplicate styles.
excel_chart    — insert a native openpyxl chart (bar|line|pie) at a target cell, coloured from the
                 design tokens.

Both use openpyxl (already a core dependency, so no import guard needed for the happy path — but we
still degrade to a 中文人话 error if openpyxl is somehow unimportable, to honour the "never let the
MCP fail to start" discipline).
"""

import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools import office_style as style_tokens
from ai_computer_control.tools import office_io


def _protected_write_guard(path: str, allow_protected: bool):
    """Mirror document.py's write guard: refuse writing into a protected system tree unless overridden."""
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"拒绝写入：目标 {reason}。如确需写入，请传 allow_protected=true。"}
    return None


def _require_openpyxl():
    """Import openpyxl pieces lazily; return (modules_dict, None) or (None, error_dict)."""
    try:
        from openpyxl import load_workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
        return {
            "load_workbook": load_workbook,
            "Font": Font,
            "PatternFill": PatternFill,
            "Alignment": Alignment,
            "Border": Border,
            "Side": Side,
            "get_column_letter": get_column_letter,
        }, None
    except Exception as e:  # noqa: BLE001
        return None, {"error": f"Excel 美化需要 openpyxl（应随离线包安装）。导入失败：{e}"}


def _is_number(value) -> bool:
    """True if the cell value is a real number (int/float, not bool)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


@mcp.tool(audit=True)
def excel_beautify(
    path: str,
    sheet: str | None = None,
    style: str = "business",
    header_row: int = 1,
    allow_protected: bool = False,
) -> dict:
    """Beautify an existing .xlsx into a professional-looking sheet (模板驱动, idempotent).

    Applies the style's bold header row, frozen header, zebra striping, thin borders, content-fit column widths
    (cap 50 chars), right-aligned numeric columns and an auto-filter. Re-running is safe (recomputed, never layered).

    Args:
        path: Path to an existing .xlsx (e.g. just written by write_excel).
        sheet: Worksheet name; None = the active/first sheet.
        style: 'business' (default) | 'minimal' | 'vibrant'. Unknown -> 'business'.
        header_row: 1-based header row (default 1); rows below are data.
        allow_protected: Bypass the protected-path guard on the destination (default off).

    Returns:
        dict with 'success', 'path', 'output_path', 'sheet', 'style', 'rows', 'cols'. Failure (missing file / bad
        sheet / no data / import) -> {'error': <中文人话>}.
    """
    if not str(path).lower().endswith(".xlsx"):
        return {"error": "path 必须以 .xlsx 结尾"}
    if not os.path.exists(path):
        return {"error": f"文件不存在：{path}"}
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard
    mods, err = _require_openpyxl()
    if err:
        return err

    try:
        header_row = int(header_row)
        if header_row < 1:
            return {"error": "header_row 必须 >= 1"}
    except (TypeError, ValueError):
        return {"error": "header_row 必须是整数"}

    tokens = style_tokens.get_style(style)
    resolved_style = style if style in style_tokens.STYLES else style_tokens.DEFAULT_STYLE

    Font = mods["Font"]
    PatternFill = mods["PatternFill"]
    Alignment = mods["Alignment"]
    Border = mods["Border"]
    Side = mods["Side"]
    get_column_letter = mods["get_column_letter"]

    try:
        wb = mods["load_workbook"](path)
        if sheet is not None:
            if sheet not in wb.sheetnames:
                wb.close()
                return {"error": f"工作表不存在：{sheet}。可用：{wb.sheetnames}"}
            ws = wb[sheet]
        else:
            ws = wb.active

        max_row = ws.max_row
        max_col = ws.max_column
        if max_row < header_row or max_col < 1:
            wb.close()
            return {"error": "工作表没有可美化的数据（为空或表头行超出范围）"}

        # --- shared style objects (build once) ---
        # v1.7.1 表头版式选择器: 'fill' (business/vibrant) = 主色满底白粗字 (v1.6 原样);
        # 'underline' (minimal「墨白极简」) = 白底墨黑粗字 + 底部 2pt 青色下边框 (不用满底色).
        header_mode = tokens.get("excel_header", "fill")
        zebra_fill = PatternFill(fill_type="solid", fgColor=style_tokens.argb(tokens["zebra_fill"]))
        no_fill = PatternFill(fill_type=None)  # explicit clear -> idempotent (strips a prior zebra tint)
        body_font = Font(name=tokens["body_font"], bold=False,
                         color=style_tokens.argb(tokens["text_color"]))
        thin = Side(style="thin", color=style_tokens.argb(tokens["border_color"]))
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        if header_mode == "underline":
            header_fill = no_fill   # 白底 (explicit clear keeps re-runs idempotent)
            header_font = Font(name=tokens["body_font"], bold=True,
                               color=style_tokens.argb(tokens["text_color"]))
            # 'medium' ≈ 2pt in Excel border weights; 青色 accent line under the header row.
            accent_bottom = Side(style="medium", color=style_tokens.argb(tokens["accent"]))
            header_border = Border(left=thin, right=thin, top=thin, bottom=accent_bottom)
        else:
            header_fill = PatternFill(fill_type="solid",
                                      fgColor=style_tokens.argb(tokens["header_fill"]))
            header_font = Font(name=tokens["body_font"], bold=True,
                               color=style_tokens.argb(tokens["header_font_color"]))
            header_border = border
        left_mid = Alignment(horizontal="left", vertical="center")
        right_mid = Alignment(horizontal="right", vertical="center")
        center_mid = Alignment(horizontal="center", vertical="center")

        # Detect numeric columns from the data body (majority of non-empty cells numeric -> numeric col).
        numeric_col = {}
        for col in range(1, max_col + 1):
            num, total = 0, 0
            for row in range(header_row + 1, max_row + 1):
                v = ws.cell(row=row, column=col).value
                if v is None or v == "":
                    continue
                total += 1
                if _is_number(v):
                    num += 1
            numeric_col[col] = (total > 0 and num >= total / 2)

        # --- header row ---
        for col in range(1, max_col + 1):
            c = ws.cell(row=header_row, column=col)
            c.font = header_font
            c.fill = header_fill
            c.alignment = center_mid
            c.border = header_border

        # --- data rows: zebra (recomputed, idempotent), font, alignment, border ---
        for i, row in enumerate(range(header_row + 1, max_row + 1)):
            striped = (i % 2 == 1)  # first data row plain, second tinted, ...
            for col in range(1, max_col + 1):
                c = ws.cell(row=row, column=col)
                c.font = body_font
                c.fill = zebra_fill if striped else no_fill
                c.alignment = right_mid if numeric_col.get(col) else left_mid
                c.border = border

        # --- column widths: fit to content, cap 50 ---
        for col in range(1, max_col + 1):
            longest = 0
            for row in range(header_row, max_row + 1):
                cell = ws.cell(row=row, column=col)
                v = cell.value
                if v is None:
                    continue
                # Count display width: CJK chars are ~2 cells wide in Excel's default font.
                s = str(v)
                width = sum(2 if ord(ch) > 0x2E7F else 1 for ch in s)
                # 把关直修(v1.7 审美关真机撞出):cell 若带数字格式(千分位/货币/小数/百分号,write_excel
                # 落笔时设的),显示宽度按【格式化后】算——否则 beautify 重算列宽时把 write_excel 已算对的
                # 宽度按原始值 "1250" 盖窄,渲染成 ######。与 document.py write_excel 同一近似公式。
                fmt = str(cell.number_format or "")
                if isinstance(v, (int, float)) and fmt and fmt != "General":
                    try:
                        dec = 2 if "0.00" in fmt else (1 if "0.0" in fmt else 0)
                        body = f"{abs(float(v)):,.{dec}f}"
                        symbol = 1 if any(x in fmt for x in ("¥", "$", "％", "%")) else 0
                        sign = 1 if float(v) < 0 else 0
                        width = max(width, len(body) + symbol + sign)
                    except Exception:
                        pass
                longest = max(longest, width)
            # +2 padding; floor 8, cap 50.
            ws.column_dimensions[get_column_letter(col)].width = min(max(longest + 2, 8), 50)

        # --- freeze the header row (everything at/above header stays; scroll starts below) ---
        ws.freeze_panes = ws.cell(row=header_row + 1, column=1)

        # --- auto-filter over the used range (header .. last data row) ---
        first = f"A{header_row}"
        last = f"{get_column_letter(max_col)}{max_row}"
        ws.auto_filter.ref = f"{first}:{last}"

        # b2-P1: 原子写 — 先存同目录临时文件再 os.replace,失败不破坏原文件;finally 保证 wb.close()
        import tempfile
        dirn = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".xlsx-", suffix=".tmp")
        os.close(fd)
        try:
            wb.save(tmp)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise
        finally:
            wb.close()
        return {
            "success": True,
            "path": os.path.abspath(path),
            "output_path": os.path.abspath(path),
            "sheet": ws.title,
            "style": resolved_style,
            "rows": max_row,
            "cols": max_col,
        }
    except Exception as e:  # noqa: BLE001
        return office_io.io_failure(e, path, prefix="美化失败：")


def _rich_title(text: str, font_name: str):
    """Build an openpyxl chart-axis `Title` whose text is `text` rendered in the CJK `font_name`.

    We hand-build the RichText (not the bare-string shortcut) so the axis-title glyphs also carry the
    latin+ea typeface — otherwise Office draws 中文 axis titles in its default Latin face while the
    surrounding data is 微软雅黑. Returns a Title object, or None if openpyxl's chart-text classes are
    unavailable (defensive — axis titles then simply degrade to unstyled)."""
    try:
        from openpyxl.chart.title import Title
        from openpyxl.chart.text import RichText, Text
        from openpyxl.drawing.text import (
            Paragraph, ParagraphProperties, CharacterProperties, Font as DrawFont, RegularTextRun,
        )
    except Exception:  # noqa: BLE001
        return None
    cp = CharacterProperties(latin=DrawFont(typeface=font_name), ea=DrawFont(typeface=font_name))
    run = RegularTextRun(rPr=cp, t=str(text))
    para = Paragraph(pPr=ParagraphProperties(defRPr=cp), r=[run])
    # Title.tx is a <c:tx> wrapper (openpyxl.chart.text.Text) that HOLDS the RichText — passing the
    # RichText straight in raises a type error, so wrap it.
    return Title(tx=Text(rich=RichText(p=[para])))


def _apply_chart_font(chart, font_name: str):
    """Set the CJK typeface on the chart title / both axes / legend so text is 微软雅黑, not the Office
    default Latin face. Uses openpyxl's txPr/RichText with a latin+ea CharacterProperties. Best-effort:
    any missing sub-element is silently skipped (openpyxl chart objects vary by type)."""
    try:
        from openpyxl.chart.text import RichText
        from openpyxl.drawing.text import (
            Paragraph, ParagraphProperties, CharacterProperties, Font as DrawFont,
        )
    except Exception:  # noqa: BLE001
        return

    def _txpr():
        cp = CharacterProperties(latin=DrawFont(typeface=font_name),
                                 ea=DrawFont(typeface=font_name))
        return RichText(p=[Paragraph(pPr=ParagraphProperties(defRPr=cp), endParaRPr=cp)])

    # title
    try:
        if chart.title is not None and getattr(chart.title, "tx", None) is not None \
                and getattr(chart.title.tx, "rich", None) is not None:
            rich = chart.title.tx.rich
            cp = CharacterProperties(latin=DrawFont(typeface=font_name),
                                     ea=DrawFont(typeface=font_name))
            for para in rich.p:
                if para.pPr is None:
                    para.pPr = ParagraphProperties()
                para.pPr.defRPr = cp
    except Exception:  # noqa: BLE001
        pass
    # axes (tick-label / axis-title font). We set txPr on the axis itself so the SCALE numbers and
    # category labels also render in 微软雅黑; the axis *title* text font is handled by _rich_title.
    for axis_attr in ("x_axis", "y_axis"):
        try:
            axis = getattr(chart, axis_attr, None)
            if axis is not None:
                axis.txPr = _txpr()
        except Exception:  # noqa: BLE001
            pass
    # legend
    try:
        if getattr(chart, "legend", None) is not None:
            chart.legend.txPr = _txpr()
    except Exception:  # noqa: BLE001
        pass


def _first_col_header_text(ws, min_col, min_row):
    """The header cell text of the category (first) column — used to auto-derive x_title.
    Returns a str (possibly empty) — never raises."""
    try:
        v = ws.cell(row=min_row, column=min_col).value
        return "" if v is None else str(v).strip()
    except Exception:  # noqa: BLE001
        return ""


def _series_header_texts(ws, min_col, max_col, min_row):
    """The header cell texts of the series (non-category) columns — used to auto-derive y_title when a
    single series carries it. Returns a list[str] (skips blanks) — never raises."""
    out = []
    try:
        for col in range(min_col + 1, max_col + 1):
            v = ws.cell(row=min_row, column=col).value
            if v is not None and str(v).strip():
                out.append(str(v).strip())
    except Exception:  # noqa: BLE001
        pass
    return out


def _parse_range(data_range: str):
    """Validate and split an 'A1:B10' range. Return (info_dict, None) or (None, error_dict).

    info: {min_col, min_row, max_col, max_row}. Rejects single-cell / malformed / reversed ranges.
    """
    try:
        from openpyxl.utils.cell import range_boundaries
    except Exception as e:  # noqa: BLE001
        return None, {"error": f"无法解析区域（openpyxl 缺失）：{e}"}
    if not isinstance(data_range, str) or ":" not in data_range:
        return None, {"error": f"data_range 非法：{data_range!r}，应形如 'A1:B10'"}
    try:
        min_col, min_row, max_col, max_row = range_boundaries(data_range.strip())
    except Exception as e:  # noqa: BLE001
        return None, {"error": f"data_range 非法：{data_range!r}（{e}），应形如 'A1:B10'"}
    if None in (min_col, min_row, max_col, max_row):
        return None, {"error": f"data_range 非法：{data_range!r}，需为完整的矩形区域，如 'A1:B10'"}
    if max_row <= min_row:
        return None, {"error": f"data_range {data_range!r} 至少要有表头行 + 一行数据"}
    return {"min_col": min_col, "min_row": min_row, "max_col": max_col, "max_row": max_row}, None


@mcp.tool(audit=True)
def excel_chart(
    path: str,
    sheet: str,
    chart_type: str,
    data_range: str,
    title: str,
    target_cell: str = "H2",
    x_title: str | None = None,
    y_title: str | None = None,
    allow_protected: bool = False,
) -> dict:
    """Insert a native chart (bar | line | pie | scatter) into an existing .xlsx, coloured from the style palette.

    data_range: first row = series names (headers), first column = category axis — EXCEPT 'scatter', where the
    first column is numeric X and each further column one Y series (true XY chart, solid-circle markers, series
    not connected; use 'line' to connect).
    Axis titles use the token body font. Default (None): x_title = first column's header; y_title = the series
    header for a single series (empty for several, the legend carries it); '' = none. Pie ignores both.

    Args:
        path: Path to an existing .xlsx.
        sheet: Worksheet holding the data (the chart goes on the same sheet).
        chart_type: 'bar' | 'line' | 'pie' | 'scatter'.
        data_range: Data area as 'A1:B10' (layout above).
        title: Chart title.
        target_cell: Anchor cell of the chart's top-left corner (default 'H2').
        x_title: Horizontal-axis title, e.g. 「季度」.
        y_title: Vertical-axis title, e.g. 「销售额(万元)」.
        allow_protected: Bypass the protected-path guard on the destination (default off).

    Returns:
        dict with 'success', 'path', 'output_path', 'sheet', 'chart_type', 'anchor', 'x_title', 'y_title' (titles
        actually applied). Failure (bad type / range / missing sheet / import) -> {'error': <中文人话>}.
    """
    if not str(path).lower().endswith(".xlsx"):
        return {"error": "path 必须以 .xlsx 结尾"}
    if not os.path.exists(path):
        return {"error": f"文件不存在：{path}"}
    ctype = str(chart_type).strip().lower()
    if ctype not in ("bar", "line", "pie", "scatter"):
        return {"error": f"chart_type 非法：{chart_type!r}，仅支持 bar | line | pie | scatter"}
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard

    mods, err = _require_openpyxl()
    if err:
        return err

    rng, rerr = _parse_range(data_range)
    if rerr:
        return rerr

    try:
        from openpyxl.chart import BarChart, LineChart, PieChart, ScatterChart, Series, Reference
        from openpyxl.chart.series import DataPoint
    except Exception as e:  # noqa: BLE001
        return {"error": f"图表功能需要 openpyxl.chart（应随离线包安装）。导入失败：{e}"}

    # style is not a param of this tool per the contract; charts use the default (business) palette + font.
    biz = style_tokens.get_style("business")
    palette = biz["chart_palette"]
    chart_font_name = biz["body_font"]

    try:
        wb = mods["load_workbook"](path)
        if sheet not in wb.sheetnames:
            wb.close()
            return {"error": f"工作表不存在：{sheet}。可用：{wb.sheetnames}"}
        ws = wb[sheet]

        min_col, min_row = rng["min_col"], rng["min_row"]
        max_col, max_row = rng["max_col"], rng["max_row"]

        if ctype == "bar":
            chart = BarChart()
            chart.type = "col"
        elif ctype == "line":
            chart = LineChart()
        elif ctype == "scatter":
            chart = ScatterChart()
        else:
            chart = PieChart()

        chart.title = str(title)
        chart.style = 2
        # v1.7: align chart title / axis / legend fonts to the token body font (微软雅黑) so the chart
        # doesn't render its text in Office's default Latin face while data around it is 微软雅黑.
        _apply_chart_font(chart, chart_font_name)

        # Categories = first column (excluding the header cell). Data = remaining columns incl. header
        # row so series pick up their names.
        # b2-P1: 单列无法画图(Reference 抛崩溃式错误)—— 前置校验
        if max_col <= min_col:
            return {"error": "data_range 至少需要 2 列(1 列类别 + >=1 列数据),当前仅 1 列。请扩大 data_range。"}
        if ctype == "scatter":
            # XY chart: 首列 = 数值 X (不是类别，不走 set_categories)；其余每列各建一条 Y 系列，
            # title_from_data=True 会 pop 掉该列的表头单元格当系列名。
            xref = Reference(ws, min_col=min_col, min_row=min_row + 1, max_row=max_row)
            for col in range(min_col + 1, max_col + 1):
                yref = Reference(ws, min_col=col, min_row=min_row, max_row=max_row)
                s = Series(yref, xvalues=xref, title_from_data=True)
                chart.series.append(s)
        else:
            cats = Reference(ws, min_col=min_col, min_row=min_row + 1, max_row=max_row)
            data = Reference(ws, min_col=min_col + 1, min_row=min_row, max_col=max_col, max_row=max_row)
            chart.add_data(data, titles_from_data=True)
            chart.set_categories(cats)

        # --- v1.7.1 坐标轴标题 (饼图无轴，跳过) ---
        applied_x, applied_y = "", ""
        if ctype != "pie":
            # x_title: explicit unless None → auto-derive from the category-column header.
            if x_title is None:
                applied_x = _first_col_header_text(ws, min_col, min_row)
            else:
                applied_x = str(x_title)
            # y_title: explicit unless None → auto-derive from the single series header (blank if
            # multi-series, where the legend already names each series).
            if y_title is None:
                headers = _series_header_texts(ws, min_col, max_col, min_row)
                applied_y = headers[0] if len(headers) == 1 else ""
            else:
                applied_y = str(y_title)

            # delTitle 陷阱: 设 axis.title 后 axis.delete 若为 True 轴会连标题一起隐藏；显式关掉。
            chart.x_axis.delete = False
            chart.y_axis.delete = False
            if applied_x:
                t = _rich_title(applied_x, chart_font_name)
                chart.x_axis.title = t if t is not None else applied_x
            if applied_y:
                t = _rich_title(applied_y, chart_font_name)
                chart.y_axis.title = t if t is not None else applied_y

        # Apply palette colours.
        if ctype == "pie":
            # One series, colour each slice (data point) from the palette.
            if chart.series:
                s = chart.series[0]
                n_points = max_row - min_row  # number of categories
                for idx in range(n_points):
                    dp = DataPoint(idx=idx)
                    dp.graphicalProperties.solidFill = palette[idx % len(palette)]
                    s.data_points.append(dp)
        elif ctype == "scatter":
            # 标记点用实心圆 (可见)，系列间不连线 —— marker 的填充/描边才是散点的颜色载体，
            # graphicalProperties.line 是"点与点之间的连线"，散点约定关掉它。
            for i, s in enumerate(chart.series):
                color = palette[i % len(palette)]
                s.marker.symbol = "circle"
                s.marker.size = 7
                s.marker.graphicalProperties.solidFill = color
                s.marker.graphicalProperties.line.solidFill = color
                s.graphicalProperties.line.noFill = True
        else:
            for i, s in enumerate(chart.series):
                color = palette[i % len(palette)]
                s.graphicalProperties.solidFill = color
                if ctype == "line":
                    s.graphicalProperties.line.solidFill = color
                    s.smooth = False

        chart.height = 8   # cm
        chart.width = 15   # cm

        # b3-P2: 同 sheet + 同 anchor 重复插表会静默叠加多个图表 —— 先查已有图表锚点,重叠即明确提示
        # (openpyxl 的 chart.anchor 是 'H2' 字符串或 Anchor 对象;Anchor 对象取其 ._from.col/row 反推单元格)。
        try:
            _anchor_cell = str(target_cell).upper()
            _anchors = set()
            for _c in getattr(ws, "_charts", []) or []:
                _a = getattr(_c, "anchor", None)
                if isinstance(_a, str):
                    _anchors.add(_a.upper())
                elif _a is not None:
                    try:
                        _col = int(_a._from.col) + 1
                        _row = int(_a._from.row) + 1
                        from openpyxl.utils import get_column_letter as _gcl
                        _anchors.add(f"{_gcl(_col)}{_row}")
                    except Exception:
                        pass
            if _anchor_cell in _anchors:
                wb.close()
                return {"error": f"锚点 {target_cell!r} 已有图表。重复调用会在同一位置叠加,请换一个 target_cell(或先删除旧图)。"}
        except Exception:
            pass  # 检测尽力而为,绝不让它阻断正常插表

        try:
            ws.add_chart(chart, str(target_cell))
        except Exception as e:  # noqa: BLE001
            wb.close()
            return {"error": f"target_cell 非法：{target_cell!r}（{e}），应形如 'H2'"}

        # b2-P1: 原子写 — 先存同目录临时文件再 os.replace,失败不破坏原文件;finally 保证 wb.close()
        import tempfile
        dirn = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".xlsx-", suffix=".tmp")
        os.close(fd)
        try:
            wb.save(tmp)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise
        finally:
            wb.close()
        return {
            "success": True,
            "path": os.path.abspath(path),
            "output_path": os.path.abspath(path),
            "sheet": sheet,
            "chart_type": ctype,
            "anchor": str(target_cell),
            "x_title": applied_x,
            "y_title": applied_y,
        }
    except Exception as e:  # noqa: BLE001
        return office_io.io_failure(e, path, prefix="插入图表失败：")
