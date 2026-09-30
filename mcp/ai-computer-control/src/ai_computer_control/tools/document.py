"""Document reading and editing tools (Word, Excel, PDF).

v1.7 「Office 体系 2.0」: write_document / write_excel were v0.x 老工具, never wired into the design-token
system. On a 中文 Windows box that produced docx/xlsx with ZERO explicit font declarations, so Word/Excel
fell back to per-level defaults (拉丁 Calibri / 中文 宋体 混排, 标题各回落各的 —— 用户真机实测「字体都不对，
中文大小不一」). Root cause for Word: python-docx's `font.name` only writes the ascii/hAnsi rFonts slots;
the CJK glyph run is governed by the SEPARATE `w:eastAsia` rFonts attribute, which python-docx never
touches — so 中文 always falls back. Fix (this module): inject explicit fonts at the *styles.xml* level
(Normal / Title / Heading 1-3), writing all three rFonts links (ascii / hAnsi / **eastAsia**) to the
token font, plus a size ladder and heading colour, via a hand-written lxml `_set_style_font`. No run is
left 裸奔 — every paragraph inherits a fully-specified style. write_excel gets the same treatment (每格
落笔即带 token Font + 数字格式启发式), so 「不跑 beautify 也不难看」.
"""

import os
import re
import math
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools.filesystem import _non_ascii_report
from ai_computer_control.tools import office_style as style_tokens
from ai_computer_control.tools import office_io, office_markup


# v1.0 收官安全加固(对抗复核 CONFIRMED·minor):写族(write_document/write_excel/write_pdf)此前不接
# protected_path_reason,而删/移/拷族(filesystem.py)都接 —— 造成「能往受保护系统树种植/覆盖文件、却删不掉」
# 的护栏不对称。补齐:写前对目标路径过同一护栏,带 allow_protected 逃生阀,与 delete/move/copy 一致。
def _protected_write_guard(path: str, allow_protected: bool):
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"refused: destination {reason}. Pass allow_protected=true to override."}
    return None


@mcp.tool()
def read_document(path: str) -> dict:
    """Read the text content of a document file (Word .docx, Excel .xlsx, PDF .pdf).

    何时用: 只想快速拿走一个小文档的全部文字(一页纸的 docx、小 xlsx、几页的 pdf)。
    何时别用(v1.9 收敛, 03 Phase B):
      * .pdf → 请改用 pdf_read_pages(分页点读 + 大纲 + 每页字符上限);本分支【已弃用】,
        无分页上限会整本抽取,50 页 PDF 直接爆上下文。
      * .xlsx → 请改用 excel_read(结构化二维 data + 表头 + 公式/数字格式);本分支【已弃用】,
        静默截 500 行且把结构拍平成文本。
      * .docx 分支仍是本工具的主用途(无 successor)。

    Args:
        path: Path to the document file.

    Returns:
        dict with 'content' (extracted text), 'type', 'pages'/'sheets' count. 弃用分支附带
        'deprecated'/'successor' 字段明示替代工具。
    """
    ext = os.path.splitext(path)[1].lower()

    try:
        if ext == ".docx":
            out = _read_docx(path)
        elif ext == ".xlsx":
            out = _read_xlsx(path)
            out["deprecated"] = True
            out["successor"] = "excel_read"
        elif ext == ".pdf":
            out = _read_pdf(path)
            out["deprecated"] = True
            out["successor"] = "pdf_read_pages"
        else:
            return {"error": f"Unsupported format: {ext}. Supported: .docx, .xlsx, .pdf"}
        content = out.get("content") or ""
        non_ascii = _non_ascii_report(content)
        if non_ascii["total"]:
            out["non_ascii"] = non_ascii
        return out
    except Exception as e:
        return {"error": str(e)}


def _read_docx(path: str) -> dict:
    from docx import Document

    doc = Document(path)
    paragraphs = [p.text for p in doc.paragraphs]

    # Also read tables
    tables_text = []
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text for cell in row.cells]
            rows.append(" | ".join(cells))
        tables_text.append("\n".join(rows))

    content = "\n".join(paragraphs)
    if tables_text:
        content += "\n\n--- Tables ---\n" + "\n\n".join(tables_text)

    return {
        "content": content,
        "type": "docx",
        "paragraphs": len(paragraphs),
        "tables": len(doc.tables),
    }


def _read_xlsx(path: str) -> dict:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    sheets = {}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        # Bound the iteration: a 500K-row sheet would otherwise be fully materialized before the
        # 500-row output cap is applied, hanging the tool. Stop reading once we have enough headroom.
        for row in ws.iter_rows(values_only=True):
            rows.append([str(cell) if cell is not None else "" for cell in row])
            if len(rows) >= 500:
                break
        sheets[sheet_name] = rows

    wb.close()

    content_parts = []
    for name, rows in sheets.items():
        content_parts.append(f"=== Sheet: {name} ===")
        for row in rows[:500]:
            content_parts.append(" | ".join(row))

    return {
        "content": "\n".join(content_parts),
        "type": "xlsx",
        "sheets": list(sheets.keys()),
        "sheet_count": len(sheets),
    }


def _read_pdf(path: str) -> dict:
    import pdfplumber

    # Hard page cap: a huge/complex PDF can make extract_text() take minutes. read_document is a
    # quick-content probe; deep extraction should use pdf_read_pages (per-page + char budgets).
    _MAX_PAGES = 80
    text_parts = []
    truncated = False
    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            if i >= _MAX_PAGES:
                truncated = True
                break
            text = page.extract_text()
            if text:
                text_parts.append(f"--- Page {i + 1} ---\n{text}")

    out = {
        "content": "\n\n".join(text_parts),
        "type": "pdf",
        "pages": page_count,
    }
    if truncated:
        out["truncated"] = True
        out["note"] = f"only the first {_MAX_PAGES} of {page_count} pages were extracted; use pdf_read_pages for the rest"
    return out


# =============================================================================================
# Word 字体纪律 helpers (v1.7 「Office 体系 2.0」)
#
# The生死线: python-docx sets ascii/hAnsi rFonts via Font.name but NEVER w:eastAsia, so on 中文
# Windows every CJK run falls back to the theme's minor-EA font (宋体). We hand-write the whole
# w:rPr/w:rFonts (ascii + hAnsi + eastAsia all = token font) at the STYLE level in styles.xml, plus
# the size / colour / bold, via lxml directly on `style.element.get_or_add_rPr()`. Applying this to
# Normal / Title / Heading 1-3 means every paragraph that uses a built-in style inherits a fully
# specified font — no run is ever 裸奔 (font-declaration-free) again.
# =============================================================================================

# Size ladder (pt) —用户拍板: Normal 11 / H3 14 / H2 16 / H1 20 / Title 28.
_WORD_SIZES = {"Normal": 11, "Heading 3": 14, "Heading 2": 16, "Heading 1": 20, "Title": 28}


def _set_style_font(style, name, size_pt, color_hex=None, bold=None):
    """Force a python-docx *style* onto an explicit font at the styles.xml (rPr) level via lxml.

    Writes, on the style's `<w:rPr>`:
      * `<w:rFonts w:ascii w:hAnsi w:eastAsia w:cs>` — ALL FOUR set to `name` so 拉丁 + 中文 use the
        same family (the eastAsia slot is the one python-docx never sets → the whole 中文大小不一 bug).
      * `<w:sz>` / `<w:szCs>` — size in half-points (size_pt * 2).
      * `<w:color>` — hex colour (no '#'), when color_hex is given.
      * `<w:b>` / `<w:bCs>` — bold on/off, when bold is not None.

    Idempotent: existing rFonts/sz/color/b children are removed and re-appended, so re-styling a
    style never stacks duplicate elements.
    """
    from docx.oxml.ns import qn

    rpr = style.element.get_or_add_rPr()

    def _clear(tag):
        for el in rpr.findall(qn(tag)):
            rpr.remove(el)

    # rFonts: ascii / hAnsi / eastAsia / cs all = name.
    _clear("w:rFonts")
    rfonts = rpr.makeelement(qn("w:rFonts"), {})
    for slot in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(slot), name)
    rpr.append(rfonts)

    # sz / szCs in half-points.
    _clear("w:sz")
    _clear("w:szCs")
    half = str(int(round(size_pt * 2)))
    for tag in ("w:sz", "w:szCs"):
        el = rpr.makeelement(qn(tag), {})
        el.set(qn("w:val"), half)
        rpr.append(el)

    if color_hex is not None:
        _clear("w:color")
        col = rpr.makeelement(qn("w:color"), {})
        col.set(qn("w:val"), str(color_hex).lstrip("#").upper())
        rpr.append(col)

    if bold is not None:
        _clear("w:b")
        _clear("w:bCs")
        for tag in ("w:b", "w:bCs"):
            el = rpr.makeelement(qn(tag), {})
            el.set(qn("w:val"), "1" if bold else "0")
            rpr.append(el)


def _apply_word_styles(doc, tokens):
    """Inject token fonts/sizes/colours into Normal / Title / Heading 1-3 (the 字体纪律 backbone).

    Normal: body font, 11pt, text colour, 行距 1.4. Title: title font, 28pt, deep title colour, bold.
    H1/H2/H3: heading font, 20/16/14pt, heading colour, bold. Heading paragraphs also get a coloured
    hairline bottom border (2.25pt) via _add_heading_rule at content time (border lives on the
    paragraph, not the style, so python-docx can't carry it in styles.xml reliably).
    """
    from docx.shared import Pt

    body_font = tokens["body_font"]
    title_font = tokens["title_font"]
    text_color = tokens["text_color"]
    title_color = tokens["word_title_color"]
    heading_color = tokens["word_heading_color"]

    styles = doc.styles

    # Normal — the parent of everything; also set line spacing 1.4 + a touch of space-after.
    normal = styles["Normal"]
    _set_style_font(normal, body_font, _WORD_SIZES["Normal"], color_hex=text_color, bold=False)
    pf = normal.paragraph_format
    pf.line_spacing = 1.4
    pf.space_after = Pt(6)
    pf.widow_control = True

    # Title (level-0 heading via add_heading(..,0)).
    try:
        _set_style_font(styles["Title"], title_font, _WORD_SIZES["Title"],
                        color_hex=title_color, bold=True)
        styles["Title"].paragraph_format.space_after = Pt(10)
    except KeyError:
        pass

    for lvl, sz in (("Heading 1", _WORD_SIZES["Heading 1"]),
                    ("Heading 2", _WORD_SIZES["Heading 2"]),
                    ("Heading 3", _WORD_SIZES["Heading 3"])):
        try:
            st = styles[lvl]
            _set_style_font(st, title_font, sz, color_hex=heading_color, bold=True)
            hpf = st.paragraph_format
            hpf.keep_with_next = True
            hpf.keep_together = True
            # H1 前段距加大 so sections breathe; H2/H3 modest.
            hpf.space_before = Pt(18 if lvl == "Heading 1" else 12)
            hpf.space_after = Pt(4)
        except KeyError:
            pass

    # List Bullet / List Number: these inherit from Normal but their own rPr may not carry the
    # eastAsia link, so a bullet run can still fall back to 宋体. Inject the body font explicitly at
    # Normal 字号 so 无裸 run also holds for list items (the 字体纪律 must cover 项目符号).
    for lst in ("List Bullet", "List Number"):
        try:
            _set_style_font(styles[lst], body_font, _WORD_SIZES["Normal"],
                            color_hex=text_color, bold=False)
        except KeyError:
            pass


def _add_heading_rule(paragraph, color_hex, side="bottom", sz="18"):
    """Add a coloured hairline as a paragraph border (标题强调线).

    side='bottom' (default) — 标题下细横线 (business/vibrant v1.7 原样式; sz 18 = 2.25pt).
    side='left'   (v1.7.1 minimal) — 左侧青色细竖线 (段落左边框), 墨白极简的「装帧竖线」语言:
                  不用底纹/横幅, 仅一条竖 hairline 标记层级. sz 单位是 1/8 pt.
    Idempotent: an existing pBdr is replaced, never stacked."""
    from docx.oxml.ns import qn

    ppr = paragraph._p.get_or_add_pPr()
    for existing in ppr.findall(qn("w:pBdr")):
        ppr.remove(existing)
    pbdr = ppr.makeelement(qn("w:pBdr"), {})
    edge = pbdr.makeelement(qn("w:" + ("left" if side == "left" else "bottom")), {})
    edge.set(qn("w:val"), "single")
    edge.set(qn("w:sz"), str(sz))      # eighths of a point → 18 = 2.25pt
    edge.set(qn("w:space"), "4")
    edge.set(qn("w:color"), str(color_hex).lstrip("#").upper())
    pbdr.append(edge)
    ppr.append(pbdr)


def _add_page_number_footer(doc, tokens):
    """Centre a 「第 X 页」 footer using a PAGE field so Word renders the live page number."""
    from docx.oxml.ns import qn
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    section = doc.sections[0]
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.text = ""
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def _run_text(text):
        r = p.add_run(text)
        r.font.name = tokens["body_font"]
        r.font.size = Pt(9)
        # eastAsia on the run too (footer runs are direct, not style-driven).
        rpr = r._element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = rpr.makeelement(qn("w:rFonts"), {})
            rpr.append(rf)
        rf.set(qn("w:eastAsia"), tokens["body_font"])
        return r

    def _field(instr):
        r = p.add_run()
        fld_begin = r._element.makeelement(qn("w:fldChar"), {})
        fld_begin.set(qn("w:fldCharType"), "begin")
        r._element.append(fld_begin)
        r2 = p.add_run()
        instr_el = r2._element.makeelement(qn("w:instrText"), {})
        instr_el.set(qn("xml:space"), "preserve")
        instr_el.text = instr
        r2._element.append(instr_el)
        r3 = p.add_run()
        fld_end = r3._element.makeelement(qn("w:fldChar"), {})
        fld_end.set(qn("w:fldCharType"), "end")
        r3._element.append(fld_end)

    _run_text("第 ")
    _field(" PAGE ")
    _run_text(" 页")


def _add_cover(doc, cover, tokens):
    """Render the cover page then a page break. v1.7.1 dispatches on the word_cover 版式选择器:

      * 'dark_block' (business/vibrant, v1.7 原样) — 深底满铺单元格题块 + 白大字 + 金/强调线;
        vibrant 额外在题块下沿加一条 0.3in 珊瑚粗条 (word_cover_bar token).
      * 'light_top'  (minimal, v1.7.1 new) — 白底装帧: 墨黑特大字置于页面上 1/3, 下方一条细青线,
        副题灰. 无任何色块 (高级文印/咨询装帧).

    cover: {title, subtitle?, date?, author?}.
    """
    if tokens.get("word_cover", "dark_block") == "light_top":
        _add_cover_light(doc, cover, tokens)
        return

    from docx.oxml.ns import qn
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.shared import Pt, RGBColor

    bg = tokens["word_cover_bg"]
    fg = tokens["word_cover_fg"]
    sub = tokens["word_cover_sub"]
    accent = tokens["accent"]           # 鎏金 on the dark cover block
    title_font = tokens["title_font"]
    body_font = tokens["body_font"]

    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    # shade the cell with the deep cover colour.
    tcPr = cell._tc.get_or_add_tcPr()
    shd = tcPr.makeelement(qn("w:shd"), {})
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), bg.lstrip("#").upper())
    tcPr.append(shd)
    # remove default table borders (borderless block).
    tblPr = tbl._tbl.tblPr
    borders = tblPr.makeelement(qn("w:tblBorders"), {})
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        b = borders.makeelement(qn("w:" + edge), {})
        b.set(qn("w:val"), "none")
        borders.append(b)
    tblPr.append(borders)

    def _styled_run(paragraph, text, size, color_hex, bold=False):
        r = paragraph.add_run(text)
        r.font.name = title_font if bold else body_font
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = RGBColor(*style_tokens.rgb_tuple(color_hex))
        rpr = r._element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = rpr.makeelement(qn("w:rFonts"), {})
            rpr.append(rf)
        rf.set(qn("w:eastAsia"), title_font if bold else body_font)
        return r

    # top spacer
    sp = cell.paragraphs[0]
    sp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sp.paragraph_format.space_before = Pt(48)

    # title
    tp = cell.add_paragraph()
    tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tp.paragraph_format.space_before = Pt(6)
    _styled_run(tp, str(cover.get("title", "")), 32, fg, bold=True)

    # accent 鎏金 rule under the title (drawn on the dark block → 鎏金 shines here)
    _add_heading_rule(tp, accent)

    subtitle = cover.get("subtitle")
    if subtitle:
        subp = cell.add_paragraph()
        subp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        subp.paragraph_format.space_before = Pt(10)
        _styled_run(subp, str(subtitle), 16, sub, bold=False)

    meta = []
    if cover.get("author"):
        meta.append(str(cover.get("author")))
    if cover.get("date"):
        meta.append(str(cover.get("date")))
    if meta:
        mp = cell.add_paragraph()
        mp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        mp.paragraph_format.space_before = Pt(24)
        mp.paragraph_format.space_after = Pt(48)
        _styled_run(mp, "　·　".join(meta), 12, sub, bold=False)
    else:
        # bottom spacer so the block has vertical breathing room even without meta
        bp = cell.add_paragraph()
        bp.paragraph_format.space_after = Pt(48)

    # v1.7.1 vibrant: 珊瑚粗条 (0.3in) 在题块下沿 — a second exact-height row shaded coral appended
    # to the same borderless table (adjacent tables merge in Word, so a row IS the clean way).
    bar_hex = tokens.get("word_cover_bar")
    if bar_hex:
        row2 = tbl.add_row()
        bar_cell = row2.cells[0]
        btcPr = bar_cell._tc.get_or_add_tcPr()
        bshd = btcPr.makeelement(qn("w:shd"), {})
        bshd.set(qn("w:val"), "clear")
        bshd.set(qn("w:color"), "auto")
        bshd.set(qn("w:fill"), str(bar_hex).lstrip("#").upper())
        btcPr.append(bshd)
        # exact row height 0.3in = 432 twips; squash the cell paragraph so it can't stretch the row.
        trPr = row2._tr.get_or_add_trPr()
        trH = trPr.makeelement(qn("w:trHeight"), {})
        trH.set(qn("w:val"), "432")
        trH.set(qn("w:hRule"), "exact")
        trPr.append(trH)
        bp2 = bar_cell.paragraphs[0]
        bp2.paragraph_format.space_before = Pt(0)
        bp2.paragraph_format.space_after = Pt(0)
        bp2.paragraph_format.line_spacing = 1.0
        br = bp2.add_run("")
        br.font.size = Pt(2)

    # page break so the body starts on a fresh page
    doc.add_page_break()


def _add_cover_light(doc, cover, tokens):
    """minimal「墨白极简」Word 封面 (v1.7.1) — 高级文印/咨询装帧:

    白底无色块; 标题墨黑特大字 (36pt) 置于页面上 1/3 (上方留白约 2in), 左对齐 (与 minimal PPT 封面的
    左对齐语言一致); 标题下一条细青线 (1.5pt, 段落下边框); 副题灰; 作者·日期灰小字。然后分页。
    """
    from docx.oxml.ns import qn
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    ink = tokens["word_title_color"]        # 222222 墨黑
    accent = tokens["accent"]               # 3B7C8C 青
    sub = tokens["subtle_color"]            # 8C8C8C 灰 (白底上的次要字色)
    title_font = tokens["title_font"]
    body_font = tokens["body_font"]

    def _styled_run(paragraph, text, size, color_hex, bold=False):
        r = paragraph.add_run(text)
        r.font.name = title_font if bold else body_font
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = RGBColor(*style_tokens.rgb_tuple(color_hex))
        rpr = r._element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = rpr.makeelement(qn("w:rFonts"), {})
            rpr.append(rf)
        rf.set(qn("w:eastAsia"), title_font if bold else body_font)
        return r

    # push the title block down to the top-third of the page (~2in of air under the top margin).
    spacer = doc.add_paragraph("")
    spacer.paragraph_format.space_after = Pt(144)

    tp = doc.add_paragraph()
    tp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    _styled_run(tp, str(cover.get("title", "")), 36, ink, bold=True)
    # 细青线 under the title — thinner than the business rule (12 = 1.5pt), same pBdr mechanism.
    _add_heading_rule(tp, accent, side="bottom", sz="12")

    subtitle = cover.get("subtitle")
    if subtitle:
        subp = doc.add_paragraph()
        subp.alignment = WD_ALIGN_PARAGRAPH.LEFT
        subp.paragraph_format.space_before = Pt(14)
        _styled_run(subp, str(subtitle), 15, sub, bold=False)

    meta = []
    if cover.get("author"):
        meta.append(str(cover.get("author")))
    if cover.get("date"):
        meta.append(str(cover.get("date")))
    if meta:
        mp = doc.add_paragraph()
        mp.alignment = WD_ALIGN_PARAGRAPH.LEFT
        mp.paragraph_format.space_before = Pt(30)
        _styled_run(mp, "　·　".join(meta), 11, sub, bold=False)

    doc.add_page_break()


def _disp_width(value) -> int:
    """Display width in half-em units: CJK / full-width = 2, everything else = 1."""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in str(value))


def _cell_text(value) -> str:
    """Table / sheet cell value -> display text. None is an EMPTY cell, not the word 'None'."""
    if value is None:
        return ""
    return str(value)


def _apply_run_font(run, font_name, east_asia=None):
    """Explicit latin font + the separate eastAsia slot python-docx never touches."""
    from docx.oxml.ns import qn
    run.font.name = font_name
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rf)
    rf.set(qn("w:eastAsia"), east_asia or font_name)


_XML_BAD_CHARS = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def _raw_run(parent_el, text, *, font=None, east_asia=None, size_pt=None, color_hex=None,
             bold=None, italic=None, underline=False, shade_hex=None):
    """Append one <w:r> to `parent_el` (a <w:p> or <w:hyperlink>) built directly with lxml.

    python-docx's run.font.* setters cost ~0.4 ms per run (each touches the CT_RPr child-order
    machinery); a 1000-row table has 3000+ runs, so this is the hot path. Children are written in
    CT_RPr schema order: rFonts, b, i, color, sz/szCs, u, shd."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    r = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    if font:
        rf = OxmlElement("w:rFonts")
        rf.set(qn("w:ascii"), font)
        rf.set(qn("w:hAnsi"), font)
        rf.set(qn("w:eastAsia"), east_asia or font)
        rpr.append(rf)
    if bold is not None:
        b = OxmlElement("w:b")
        if not bold:
            b.set(qn("w:val"), "0")
        rpr.append(b)
    if italic:
        rpr.append(OxmlElement("w:i"))
    if color_hex:
        c = OxmlElement("w:color")
        c.set(qn("w:val"), str(color_hex).lstrip("#").upper())
        rpr.append(c)
    if size_pt:
        half = str(int(round(size_pt * 2)))
        for tag in ("w:sz", "w:szCs"):
            sz = OxmlElement(tag)
            sz.set(qn("w:val"), half)
            rpr.append(sz)
    if underline:
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rpr.append(u)
    if shade_hex:
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), shade_hex)
        rpr.append(shd)
    if len(rpr):
        r.append(rpr)
    text = _XML_BAD_CHARS.sub("", str(text))
    parts = text.split("\n")
    for i, part in enumerate(parts):
        if i:
            r.append(OxmlElement("w:br"))
        for j, chunk in enumerate(part.split("\t")):
            if j:
                r.append(OxmlElement("w:tab"))
            if chunk:
                t = OxmlElement("w:t")
                t.text = chunk
                if chunk != chunk.strip():
                    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                r.append(t)
    parent_el.append(r)
    return r


def _add_inline(paragraph, text, *, font=None, size_pt=None, color_hex=None, bold=None):
    """Append `text` (inline markdown-lite) to `paragraph` as runs: **bold**, *italic*, `code`
    (Consolas + light shading), [text](url) as a real Word hyperlink (http/https/mailto only; any other
    scheme is kept as 'text (url)' so nothing is lost or made clickable by surprise)."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.opc.constants import RELATIONSHIP_TYPE as RT

    for seg, fmt in office_markup.parse_inline(text):
        url = fmt.get("url")
        if url and not office_markup.is_safe_url(url):
            seg = f"{seg} ({url})"
            url = None
        parent = paragraph._p
        if url:
            r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
            link = OxmlElement("w:hyperlink")
            link.set(qn("r:id"), r_id)
            link.set(qn("w:history"), "1")
            paragraph._p.append(link)
            parent = link
        is_bold = True if fmt.get("bold") else bold
        if fmt.get("code"):
            _raw_run(parent, seg, font="Consolas", east_asia=font, size_pt=(size_pt or 11) - 1,
                     color_hex=color_hex if not url else None, bold=is_bold,
                     italic=fmt.get("italic"), underline=bool(url), shade_hex="F2F2F2")
        else:
            _raw_run(parent, seg, font=font, size_pt=size_pt,
                     color_hex=("0563C1" if url else color_hex), bold=is_bold,
                     italic=fmt.get("italic"), underline=bool(url))
    return paragraph


def _add_content_table(doc, headers, rows, tokens, aligns=None):
    """Add a token-styled table (表头主色填充白字 + 斑马纹 + 细边框), matching the Excel/PPT observation.

    Perf: python-docx's Table.cell(r, c) rebuilds the whole cell grid on every call, which made a
    1000-row table O(rows^2 * cols^2) (minutes). The grid is fetched ONCE (`tbl._cells`) and indexed.
    Cell text is inline markdown-lite; `aligns` is an optional per-column 'left'|'center'|'right'."""
    from docx.oxml.ns import qn
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement

    primary = tokens["header_fill"]
    header_fg = tokens["header_font_color"]
    zebra = tokens["zebra_fill"]
    border = tokens["border_color"]
    text_color = tokens["text_color"]
    body_font = tokens["body_font"]

    n_cols = len(headers)
    tbl = doc.add_table(rows=1 + len(rows), cols=n_cols)
    tbl.style = "Table Grid"  # gives us a real grid to recolour
    # Repeat the header after a page break and keep each data row together.
    tr_list = tbl._tbl.tr_lst
    tr_list[0].get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    for tr in tr_list:
        tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))

    # recolour all borders to the token hairline
    tblPr = tbl._tbl.tblPr
    for existing in tblPr.findall(qn("w:tblBorders")):
        tblPr.remove(existing)
    borders = tblPr.makeelement(qn("w:tblBorders"), {})
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        b = borders.makeelement(qn("w:" + edge), {})
        b.set(qn("w:val"), "single")
        b.set(qn("w:sz"), "4")            # 0.5pt
        b.set(qn("w:color"), border.lstrip("#").upper())
        borders.append(b)
    tblPr.append(borders)

    align_map = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
                 "right": WD_ALIGN_PARAGRAPH.RIGHT}

    def _shade(cell, fill_hex):
        tcPr = cell._tc.get_or_add_tcPr()
        for ex in tcPr.findall(qn("w:shd")):
            tcPr.remove(ex)
        shd = tcPr.makeelement(qn("w:shd"), {})
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), fill_hex.lstrip("#").upper())
        tcPr.append(shd)

    def _cell_run(cell, text, color_hex, bold, col):
        p = cell.paragraphs[0]
        p.alignment = align_map.get((aligns[col] if aligns and col < len(aligns) else "left"),
                                    WD_ALIGN_PARAGRAPH.LEFT)
        _add_inline(p, _cell_text(text), font=body_font, size_pt=10.5, color_hex=color_hex, bold=bold)

    # One grid fetch (row-major list); fall back to per-call cell() if a python-docx build lacks it.
    try:
        grid = tbl._cells
    except Exception:  # noqa: BLE001
        grid = None

    def _cell(r, c):
        return grid[r * n_cols + c] if grid is not None else tbl.cell(r, c)

    # header row
    for c, h in enumerate(headers):
        cell = _cell(0, c)
        _shade(cell, primary)
        _cell_run(cell, h, header_fg, True, c)

    # body rows with zebra
    for ri, row in enumerate(rows, start=1):
        striped = (ri % 2 == 0)
        for c in range(n_cols):
            cell = _cell(ri, c)
            if striped:
                _shade(cell, zebra)
            val = row[c] if c < len(row) else ""
            _cell_run(cell, val, text_color, False, c)


class _ListNumbering:
    """Fresh Word numbering instance per markdown numbered list, so a second list restarts at 1.

    python-docx's 'List Number' style points at ONE style-level numId, so every list in the document
    shares a counter (the second list would start at 3). For each new list we add a <w:num> that
    references the same abstractNum with a startOverride and stamp it on the paragraphs' numPr."""

    _STYLES = ("List Number", "List Number 2", "List Number 3")

    def __init__(self, doc):
        self.doc = doc
        self.by_list: dict = {}
        self.ok = True
        try:
            self.numbering = doc.part.numbering_part.numbering_definitions._numbering
        except Exception:  # noqa: BLE001
            self.numbering = None
            self.ok = False

    def _new_num(self, style_name, start):
        style = self.doc.styles[style_name]
        style_num = style.element.pPr.numPr.numId.val
        abstract_id = self.numbering.num_having_numId(style_num).abstractNumId.val
        num = self.numbering.add_num(abstract_id)
        lvl = num.add_lvlOverride(ilvl=0)
        lvl.add_startOverride(int(start))
        return num.numId

    def apply(self, paragraph, style_name, list_id, start):
        if not self.ok:
            return
        try:
            if list_id not in self.by_list:
                self.by_list[list_id] = self._new_num(style_name, start)
            ppr = paragraph._p.get_or_add_pPr()
            num_pr = ppr.get_or_add_numPr()
            num_pr.get_or_add_ilvl().val = 0
            num_pr.get_or_add_numId().val = self.by_list[list_id]
        except Exception:  # noqa: BLE001 — degrade to style-level (continuous) numbering
            self.ok = False


def _styled_para(doc, style_name):
    try:
        return doc.add_paragraph(style=style_name)
    except KeyError:
        return doc.add_paragraph()


def _add_block_paragraphs(doc, blocks, tokens, rule_color, rule_side, numbering):
    """Walk parsed markdown-lite blocks and emit Word paragraphs / tables."""
    from docx.shared import Pt, Inches

    list_starts: dict = {}
    for blk in blocks:
        kind = blk[0]
        if kind == "blank":
            doc.add_paragraph("")
        elif kind == "heading":
            p = doc.add_heading("", level=blk[1])
            _add_inline(p, blk[2])
            _add_heading_rule(p, rule_color, side=rule_side)
        elif kind == "bullet":
            level = min(blk[1], 2)
            p = _styled_para(doc, "List Bullet" if level == 0 else f"List Bullet {level + 1}")
            _add_inline(p, blk[2])
        elif kind == "number":
            _, level, text, num, list_id, first = blk
            level = min(level, 2)
            if first:
                list_starts[list_id] = num
            p = _styled_para(doc, _ListNumbering._STYLES[level])
            _add_inline(p, text)
            numbering.apply(p, _ListNumbering._STYLES[level], list_id, list_starts.get(list_id, num))
        elif kind == "table":
            _, headers, rows, aligns = blk
            _add_content_table(doc, headers, rows, tokens, aligns=aligns)
        elif kind == "quote":
            p = _styled_para(doc, "Quote")
            _add_inline(p, blk[1])
        elif kind == "code":
            from docx.oxml.ns import qn
            body_font = tokens["body_font"]
            for line in (blk[1] or [""]):
                p = doc.add_paragraph()
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.0
                p.paragraph_format.left_indent = Inches(0.25)
                ppr = p._p.get_or_add_pPr()
                shd = ppr.makeelement(qn("w:shd"), {})
                shd.set(qn("w:val"), "clear")
                shd.set(qn("w:color"), "auto")
                shd.set(qn("w:fill"), "F2F2F2")
                ppr.append(shd)
                r = p.add_run(line.replace("\t", "    ") or " ")
                _apply_run_font(r, "Consolas", east_asia=body_font)
                r.font.size = Pt(9.5)
            doc.add_paragraph("")
        elif kind == "rule":
            p = doc.add_paragraph("")
            _add_heading_rule(p, tokens["border_color"], side="bottom", sz="6")
        else:  # para
            p = doc.add_paragraph()
            _add_inline(p, blk[1])


@mcp.tool()
def write_document(
    path: str,
    content: str,
    title: str | None = None,
    style: str = "business",
    cover: dict | None = None,
    page_numbers: bool = False,
    allow_protected: bool = False,
) -> dict:
    """Create or overwrite a styled Word document (.docx) — v1.7「Office 体系 2.0」字体纪律版.

    Every built-in style (Normal / Title / Heading 1-3) is injected with an EXPLICIT font (token
    body/heading family, all three rFonts links incl. **w:eastAsia** so 中文 no longer falls back to
    宋体), a size ladder (Normal 11 / H3 14 / H2 16 / H1 20 / Title 28 pt), the token heading colour,
    行距 1.4 and加大 H1 前段距. Headings get a coloured 2.25pt hairline underline. So no run is 裸奔 and
    old「字体都不对、中文大小不一」is fixed structurally.

    content markdown-lite (向后兼容 — old plain-text/heading calls work unchanged and auto-inherit the
    new styles). Supported subset (what models actually emit):
        '# ' .. '###### '      -> heading levels 1/2/3 (4-6 fold into 3), with the accent hairline
        '- ' / '* ' / '+ '     -> bullet; indent 2+ spaces = nested (up to 3 levels)
        '1. ' / '1) '          -> numbered point; each separate list restarts (a blank line + '1.' or
                                  any paragraph in between starts a new list)
        GFM pipe table         -> '| a | b |' + '|---|:--:|' separator + rows = a token-styled table
                                  (':---:' / '---:' set column alignment)
        **bold** *italic* `code` [text](https://url)   -> real runs; links become Word hyperlinks
        '> quote'  ```fence```  '---' (rule)   -> Quote style / monospace block / hairline
        blank line             -> spacer

    v1.7 additions:
      * style: 'business'「青花商务」(default) | 'minimal'「墨白极简」| 'vibrant'「活力现代」. Unknown -> business.
      * cover: optional {title, subtitle?, date?, author?} — a full-width 深底满铺 title-block (white 大字
        + 鎏金/强调金 line + subtitle + author·date) on its own page, then a page break before the body.
      * page_numbers: True adds a centred 「第 X 页」 footer via a live PAGE field.
      * inline table 段落: a line 'TABLE: h1 | h2 | h3' begins a token-styled table (表头主色白字 + 斑马纹
        + 细边框); each following '| a | b | c' line is a row; a blank line ends the table. Non-table
        content is unaffected (向后兼容).

    Args:
        path: Output file path (must end with .docx).
        content: Body text in markdown-lite (see above).
        title: Optional document title — added as a Title-styled heading at the top of the body.
        style: Design style name (see above).
        cover: Optional cover-page spec dict (see above).
        page_numbers: Add a 「第 X 页」 page-number footer (default off).
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success', 'path', 'output_path', 'style'. On failure {'error': ...}; when the target is
        held open by Excel/Word/WPS: {'error', 'code': 'file_locked', 'hint'} and the old file is untouched.
    """
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard
    _, dep_err = office_io.require("docx")
    if dep_err:
        return dep_err
    from docx import Document

    tokens = style_tokens.get_style(style)
    resolved_style = style if style in style_tokens.STYLES else style_tokens.DEFAULT_STYLE

    try:
        doc = Document()

        # 字体纪律 backbone: inject explicit fonts/sizes/colours into the built-in styles FIRST,
        # so every paragraph added below inherits a fully specified font (no 裸奔 run).
        _apply_word_styles(doc, tokens)

        if cover and isinstance(cover, dict):
            _add_cover(doc, cover, tokens)

        if title:
            doc.add_heading(str(title), level=0)  # Title style (level 0)

        rule_color = tokens["word_rule_color"]
        # v1.7.1: minimal 标题不用底线而用左侧青色细竖线 (word_heading_rule='left'); 其它风格照旧 bottom.
        rule_side = "left" if tokens.get("word_heading_rule", "bottom") == "left" else "bottom"

        blocks = office_markup.parse_blocks(str(content))
        _add_block_paragraphs(doc, blocks, tokens, rule_color, rule_side, _ListNumbering(doc))

        if page_numbers:
            _add_page_number_footer(doc, tokens)

        office_io.atomic_save(path, doc.save)
        # v1.5.1: echo output_path (== path) so the workbench 产物收割 (ARTIFACT_OUTPUT_PATH_KEYS)
        # picks this file up directly. 老字段 path 保留(字段只增,不破坏现有契约)。
        return {"success": True, "path": os.path.abspath(path),
                "output_path": os.path.abspath(path), "style": resolved_style,
                "visual_review_required": True}
    except Exception as e:
        return office_io.io_failure(e, path)


def _looks_numeric(value) -> bool:
    """True if `value` (possibly a numeric string) should be treated as a number for formatting."""
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        s = value.strip().replace(",", "").replace("%", "").replace("¥", "").replace("$", "").strip()
        if s in ("", "-", "."):
            return False
        try:
            float(s)
            return True
        except ValueError:
            return False
    return False


def _numeric_value(value):
    """Coerce a numeric-looking string to int/float so Excel stores a real number (not text)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        raw = value.strip()
        # Identifiers and high precision integers must survive an Excel round trip unchanged.
        if re.fullmatch(r"[+-]?0\d+", raw) or re.fullmatch(r"[+-]?\d{16,}", raw):
            return value
        s = raw.replace(",", "").replace("%", "").replace("¥", "").replace("$", "").strip()
        try:
            f = float(s)
            if not math.isfinite(f):
                return value
            if raw.endswith('%'):
                return f / 100
            return int(f) if f == int(f) else f
        except ValueError:
            return value
    return value


# 标识类列(年份/手机/邮编/编号…):数字长得像数量,但千分位会毁掉它 (2024 -> 2,024, 手机号 13,800,138,000)。
_IDENT_HEADER_CN = ("年份", "年度", "编号", "编码", "号码", "手机", "电话", "邮编", "邮政", "代码", "证件",
                    "身份证", "工号", "学号", "序号", "单号", "订单号", "卡号", "账号", "帐号", "流水",
                    "条码", "货号", "型号", "传真", "区号")
_IDENT_HEADER_EN = re.compile(
    r"(?:^|[^a-z])(?:id|no|code|zip|postcode|postal|phone|mobile|tel|year|serial|sku|isbn)(?:$|[^a-z])|[a-z]id$",
    re.I)
_PHONE_RE = re.compile(r"1[3-9]\d{9}")


def _header_is_identifier(header) -> bool:
    h = str(header or "").strip()
    if not h:
        return False
    if h == "年" or h.endswith("年份") or any(k in h for k in _IDENT_HEADER_CN):
        return True
    return bool(_IDENT_HEADER_EN.search(h))


def _is_identifier_column(header, sample_values) -> bool:
    """Year / phone / postcode / ID style column: numeric-looking but NOT a quantity."""
    if _header_is_identifier(header):
        return True
    ints = []
    for v in sample_values:
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        nv = _numeric_value(v)
        if isinstance(nv, bool) or not isinstance(nv, int):
            return False
        ints.append(nv)
    if not ints:
        return False
    if all(_PHONE_RE.fullmatch(str(x)) for x in ints):        # 11 位手机号
        return True
    if len(ints) >= 2 and all(1900 <= x <= 2100 for x in ints):   # 一列年份
        return True
    return False


def _column_number_format(header, sample_values) -> str | None:
    """Heuristic Excel number format for a column, from its header text + a sample of its values.

    * 含 '%' 表头 OR values 含 '%'                       -> '0.0%'
    * 含 '$'/'¥'/'€' 表头, 或 '金额/收入/成本/价格/费用' 关键词 -> 货币 ('¥#,##0.00', '$…', '€…')
    * 标识类列(年份/手机/邮编/编号/ID…, 见 _is_identifier_column) -> None (General, 不加千分位)
    * 纯数量列且任一值 > 999                              -> '#,##0' (含小数则 '#,##0.00')
    * 否则 None (不设格式).
    """
    h = str(header or "")
    money_kw = ("金额", "收入", "成本", "价格", "费用", "支出", "营收", "利润", "销售额", "总额")
    sample_values = [v for v in sample_values if v is not None and v != ""]
    if "%" in h or any(isinstance(v, str) and "%" in v for v in sample_values):
        return "0.0%"
    if "$" in h or "美元" in h or "USD" in h.upper():
        return "$#,##0.00"
    if "€" in h or "欧元" in h:
        return "€#,##0.00"
    if "¥" in h or any(k in h for k in money_kw):
        return "¥#,##0.00"
    if _is_identifier_column(header, sample_values):
        return None
    # plain numeric column with a big value -> thousands separator
    numeric = [v for v in sample_values if _looks_numeric(v)]
    if numeric and len(numeric) >= max(1, len(sample_values) // 2):
        try:
            nums = [float(_numeric_value(v)) for v in numeric]
            if any(abs(x) > 999 for x in nums):
                return "#,##0.00" if any(x != int(x) for x in nums) else "#,##0"
        except (ValueError, TypeError):
            pass
    return None


_XLSX_BAD_SHEET_CHARS = set('[]:*?/\\')

@mcp.tool()
def write_excel(
    path: str,
    data: list[list[str | int | float | bool | None]],
    sheet_name: str = "Sheet1",
    headers: list[str | int | float] | None = None,
    style: str = "business",
    allow_protected: bool = False,
) -> dict:
    """Create or overwrite a styled Excel file (.xlsx) — v1.7「Office 体系 2.0」落笔即样式版.

    Unlike the old bare writer (which left ZERO font declarations → mixed Calibri/宋体), every cell is
    written with the token body font (微软雅黑, 11pt); the header row (if given) is bold on that font;
    numeric-looking columns get a number format by heuristic (千分位 for quantities >999, 百分比 for '%'
    columns, 货币 for '$'/'¥'/金额/收入/成本… headers) and numeric-looking strings are coerced to real
    numbers so Excel can compute on them; column widths auto-fit (CJK-aware) on first write. Year /
    phone / postcode / ID columns (年份, 手机号, 邮编, 编号, ID …) are NOT thousands-separated, and
    leading-zero strings stay text. So the
    sheet 「不跑 beautify 也不难看」. excel_beautify remains the full makeover (frozen header, zebra,
    borders, auto-filter) — this is the 落笔即样式 baseline.

    Args:
        path: Output file path (must end with .xlsx).
        data: 2D list of cell values (list of rows). Cells may be JSON strings, numbers, booleans or null
              (null = empty cell); real numbers stay numeric in the sheet.
        sheet_name: Name of the worksheet (<=31 chars, none of [ ] : * ? / \\).
        headers: Optional list of header row values (rendered bold on the token font).
        style: Design style — 'business' (default) | 'minimal' | 'vibrant'. Unknown -> business.
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success', 'path', 'output_path', 'rows', 'style'. On failure {'error': ...}; a target held
        open by Excel/WPS gives {'error', 'code': 'file_locked', 'hint'}.
    """
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard
    _, dep_err = office_io.require("openpyxl")
    if dep_err:
        return dep_err
    sheet_name = str(sheet_name)
    if not sheet_name.strip() or len(sheet_name) > 31 or any(ch in _XLSX_BAD_SHEET_CHARS for ch in sheet_name):
        return {"error": f"sheet_name 非法:{sheet_name!r}。Excel 工作表名 1-31 个字符,且不能含 [ ] : * ? / \\ 。请改名后重试。"}
    from openpyxl import Workbook
    from openpyxl.styles import Font, Border, Side
    from openpyxl.utils import get_column_letter

    tokens = style_tokens.get_style(style)
    resolved_style = style if style in style_tokens.STYLES else style_tokens.DEFAULT_STYLE
    body_font_name = tokens["body_font"]
    text_argb = style_tokens.argb(tokens["text_color"])

    try:
        wb = Workbook()
        ws = wb.active
        ws.title = sheet_name
        ws.sheet_view.showGridLines = False
        if headers:
            ws.freeze_panes = 'A2'
            ws.print_title_rows = '1:1'
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0

        base_font = Font(name=body_font_name, size=11, color=text_argb)
        header_font = Font(name=body_font_name, size=11, bold=True, color=text_argb)
        # v1.7.1 minimal「墨白极简」落笔即样式: 表头底部 2pt 青色下边框 (excel_header='underline') —
        # 与 excel_beautify 的 minimal 表头语言一致, 让「不跑 beautify」的表也有极简装帧感.
        header_border = None
        if tokens.get("excel_header") == "underline":
            header_border = Border(bottom=Side(style="medium",
                                               color=style_tokens.argb(tokens["accent"])))

        n_cols = max([len(headers or [])] + [len(r) for r in data] + [0])

        # per-column profile decided BEFORE writing: number format + identifier (keep-as-text) flag.
        col_fmt: dict = {}
        ident_cols: set = set()
        for col in range(1, n_cols + 1):
            header_text = _cell_text(headers[col - 1]) if headers and col - 1 < len(headers) else ""
            sample = []
            for row in data:
                if col - 1 < len(row):
                    sample.append(row[col - 1])
                    if len(sample) >= 50:
                        break
            col_fmt[col] = _column_number_format(header_text, sample)
            if _is_identifier_column(header_text, [v for v in sample if v is not None and v != ""]):
                ident_cols.add(col)

        start_row = 1
        if headers:
            for col, header in enumerate(headers, 1):
                c = ws.cell(row=1, column=col, value=header)
                c.font = header_font
                if header_border is not None:
                    c.border = header_border
            start_row = 2

        # write data (coercing numeric-looking strings to real numbers; None stays an empty cell).
        for row_idx, row_data in enumerate(data, start_row):
            for col_idx, value in enumerate(row_data, 1):
                if value is None:
                    continue
                if col_idx in ident_cols and isinstance(value, str) and re.fullmatch(r"\s*[+-]?\d{12,}\s*", value):
                    coerced = value.strip()      # 12+ 位标识串(证件/卡号):数字化会显示成科学计数法,保留文本
                else:
                    coerced = _numeric_value(value)
                c = ws.cell(row=row_idx, column=col_idx, value=coerced)
                c.font = base_font
                if isinstance(value, str) and value.strip().endswith('%') and isinstance(c.value, (int, float)):
                    c.number_format = '0.0%'
                elif isinstance(c.value, str) and re.fullmatch(r"[+-]?\d+", c.value):
                    c.number_format = '@'

        # per-column number formats (heuristic) + content-fit widths (CJK-aware).
        for col in range(1, n_cols + 1):
            fmt = col_fmt.get(col)
            longest = 0
            # header width
            if headers and col - 1 < len(headers):
                longest = _disp_width(headers[col - 1])
            for r in range(start_row, start_row + len(data)):
                cell = ws.cell(row=r, column=col)
                if fmt is not None and isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool) and cell.number_format == 'General':
                    # percentage: values like '12%' were coerced to 12 (not 0.12); if the source was
                    # a fraction string we keep it. We store the raw number and format; for '12%' text
                    # coerced to 12, format 0.0% would show 1200% — so guard: only apply % when the
                    # coerced value is already a 0-1 fraction. Otherwise fall back to plain number.
                    if fmt == "0.0%" and isinstance(cell.value, (int, float)) and abs(cell.value) > 1:
                        cell.number_format = "0.0\"%\""  # show the number with a literal % suffix
                    else:
                        cell.number_format = fmt
                v = cell.value
                if v is not None:
                    disp = _disp_width(v)
                    # 把关直修(v1.7 审美关真机撞出):数字格式会加宽显示——"1250" 套上 ¥#,##0.00 变成
                    # "¥1,250.00",列宽若按【原始值】量,渲染出来就是 ######。这里按格式化后的近似宽度
                    # (千分位分隔符 + 小数位 + 货币/百分号 + 负号)取更大者。近似即可,+2 padding 兜底。
                    if fmt is not None and isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool):
                        f = str(cell.number_format or "")
                        try:
                            dec = 2 if "0.00" in f else (1 if "0.0" in f else 0)
                            body = f"{abs(float(cell.value)):,.{dec}f}"
                            symbol = 1 if any(s in f for s in ("¥", "$", "€", "％", "%")) else 0
                            sign = 1 if float(cell.value) < 0 else 0
                            disp = max(disp, len(body) + symbol + sign)
                        except Exception:
                            pass
                    longest = max(longest, disp)
            ws.column_dimensions[get_column_letter(col)].width = min(max(longest + 2, 8), 50)

        if headers and n_cols:
            ws.auto_filter.ref = f'A1:{get_column_letter(n_cols)}{max(1, len(data) + 1)}'
        office_io.atomic_save(path, wb.save)
        # v1.5.1: 补 output_path(== path), 见 write_document。
        return {"success": True, "path": os.path.abspath(path),
                "output_path": os.path.abspath(path), "rows": len(data), "style": resolved_style,
                "formula_status": "not_calculated", "visual_review_required": True}
    except Exception as e:
        return office_io.io_failure(e, path)


# --- PDF export (write_pdf) ---------------------------------------------------
# reportlab's default fonts (Helvetica et al.) carry no CJK glyphs, so Chinese text
# renders as tofu boxes unless we register a real CJK font. We resolve a font ONCE
# (module-level cache) via a fixed preference chain and reuse it for every export.
_PDF_FONT_CACHE: dict | None = None


def _pdf_font_candidates():
    """(registered name, regular file, bold file or None) in preference order. Windows first (the primary
    target; %WINDIR% respected), then the usual Linux / macOS CJK faces so a non-Windows box embeds a real
    font instead of relying on the reader's CID substitution."""
    win = os.environ.get("WINDIR") or os.environ.get("SystemRoot") or r"C:\Windows"
    wf = os.path.join(win, "Fonts")
    cands = [
        ("MSYaHei", os.path.join(wf, "msyh.ttc"), os.path.join(wf, "msyhbd.ttc")),
        ("SimSun", os.path.join(wf, "simsun.ttc"), None),
    ]
    if os.name != "nt":
        cands += [
            ("NotoSansCJK", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
             "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
            ("WQYZenHei", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", None),
            ("WQYMicroHei", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", None),
        ]
    return cands


def _resolve_cjk_font():
    """Register and cache a Chinese-capable font for reportlab. Returns a dict:

        {"name": <registered font name>, "warning": <optional str>}

    Preference chain (first that works wins):
      1. C:\\Windows\\Fonts\\msyh.ttc   (Microsoft YaHei, TTFont subfontIndex=0; msyhbd.ttc as bold)
      2. C:\\Windows\\Fonts\\simsun.ttc (SimSun,          TTFont subfontIndex=0)
      2b. (non-Windows) Noto Sans CJK / WenQuanYi when installed
      3. reportlab built-in UnicodeCIDFont('STSong-Light') — zero external files
         (the CID font is resolved by the PDF *reader*)
      4. Helvetica (Latin only, extreme fallback) + a warning that Chinese may not show

    The chosen face is also registered as a font FAMILY (bold -> real bold face when one exists, else the
    same face) so '<b>' / '<i>' in table headers and **bold** never fall back to Helvetica-Bold and drop
    the CJK glyphs.
    """
    global _PDF_FONT_CACHE
    if _PDF_FONT_CACHE is not None:
        return _PDF_FONT_CACHE

    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.fonts import addMapping

    def _family(name, bold_name):
        b = bold_name or name
        try:
            pdfmetrics.registerFontFamily(name, normal=name, bold=b, italic=name, boldItalic=b)
        except Exception:
            pass

    # 1 & 2: TrueType collections shipped with Windows (then Linux/macOS CJK faces).
    for font_name, ttc_path, bold_path in _pdf_font_candidates():
        if os.path.exists(ttc_path):
            try:
                pdfmetrics.registerFont(TTFont(font_name, ttc_path, subfontIndex=0))
                bold_name = None
                if bold_path and os.path.exists(bold_path):
                    try:
                        pdfmetrics.registerFont(TTFont(font_name + "-Bold", bold_path, subfontIndex=0))
                        bold_name = font_name + "-Bold"
                    except Exception:
                        bold_name = None
                _family(font_name, bold_name)
                _PDF_FONT_CACHE = {"name": font_name}
                return _PDF_FONT_CACHE
            except Exception:
                # Corrupt/unsupported collection -> fall through to the next candidate.
                pass

    # 3: reportlab's built-in Adobe CID font — no external file needed.
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _family("STSong-Light", None)
        _PDF_FONT_CACHE = {"name": "STSong-Light"}
        return _PDF_FONT_CACHE
    except Exception:
        pass

    # 4: extreme fallback — Latin only. Chinese will not render.
    _PDF_FONT_CACHE = {
        "name": "Helvetica",
        "warning": "未找到中文字体，中文可能无法显示",
    }
    return _PDF_FONT_CACHE


def _pdf_col_widths(headers, rows, avail, *, min_pt=34.0, cap_units=40):
    """Column widths (points) summing to `avail`, proportional to content length.

    Weight = 0.6*longest + 0.4*mean display width per column (CJK counts double), clamped to
    [4, cap_units] so one giant cell cannot starve its neighbours, and every column keeps at least
    `min_pt` (shrunk when there are too many columns) so Paragraph never sees a negative availWidth."""
    n = len(headers) if headers else (max((len(r) for r in rows), default=0))
    if n <= 0:
        return []
    weights = []
    for c in range(n):
        lens = [_disp_width(_cell_text(r[c])) if c < len(r) else 0 for r in rows]
        if headers and c < len(headers):
            lens.append(_disp_width(_cell_text(headers[c])) + 1)
        longest = max(lens, default=4)
        mean = sum(lens) / len(lens) if lens else 4
        weights.append(min(max(0.6 * longest + 0.4 * mean, 4), cap_units))
    min_pt = min(min_pt, avail / n)
    widths = [0.0] * n
    free = set(range(n))
    remaining = float(avail)
    while free:
        total = sum(weights[i] for i in free)
        pinned = [i for i in free if remaining * weights[i] / total < min_pt]
        if not pinned:
            for i in free:
                widths[i] = remaining * weights[i] / total
            break
        for i in pinned:
            widths[i] = min_pt
            remaining -= min_pt
            free.discard(i)
    return widths


@mcp.tool()
def write_pdf(
    path: str,
    content: str,
    title: str | None = None,
    table_headers: list[str | int | float] | None = None,
    table_data: list[list[str | int | float | bool | None]] | None = None,
    page_size: str = "A4",
    allow_protected: bool = False,
) -> dict:
    """Create or overwrite a PDF (.pdf) from markdown-lite text, with full Chinese support.

    content uses the same markdown-lite subset as write_document:
        '# ' .. '###### '      -> heading levels 1/2/3
        '- ' / '* ' / '+ '     -> bullet (indent 2+ spaces = nested)
        '1. ' (any number)     -> numbered point (separate lists restart)
        GFM pipe table / 'TABLE: a | b' block -> a bordered table (columns sized to content, cells wrap)
        **bold** *italic* `code` [text](https://url)  -> styled runs; links are clickable
        '> quote'  ```fence```  '---' -> quote / monospace block / rule
        blank line             -> vertical spacing

    If table_data is given, a table is rendered after the body (table_headers optional
    as the header row). Cells may be strings, numbers, booleans or null (null = empty).

    A Chinese-capable font is auto-registered (Microsoft YaHei -> SimSun -> reportlab's
    built-in STSong-Light CID font -> Helvetica as a last resort). Paragraphs use
    wordWrap='CJK' so Chinese lines break correctly; table columns are sized from the available page
    width in proportion to content, so long CJK / unbroken cells wrap instead of overflowing.

    Args:
        path: Output file path (must end with .pdf).
        content: Body text in markdown-lite (see above).
        title: Optional document title (rendered as the top heading).
        table_headers: Optional header row for the trailing table.
        table_data: Optional 2D list of rows for the trailing table.
        page_size: 'A4' or 'letter' (anything else falls back to A4).
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success', 'path' (abs), 'pages', 'font'. On the Helvetica fallback
        it also carries 'warning'. Missing reportlab -> {'error': install guidance}. A target held open
        by another program -> {'error', 'code': 'file_locked', 'hint'}.
    """
    if not str(path).lower().endswith(".pdf"):
        return {"error": "path must end with .pdf"}
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard

    # Lazy, guarded import — reportlab is an OPTIONAL offline dependency. Absent -> degrade.
    try:
        from reportlab.lib.pagesizes import A4, letter
        from reportlab.lib.units import mm
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import (
            SimpleDocTemplate,
            Paragraph,
            Spacer,
            Table,
            TableStyle,
        )
        from reportlab.platypus.flowables import HRFlowable
    except Exception:
        return {"error": "PDF 导出需要 reportlab。离线包已含，可运行 installer 重装；或 pip install reportlab"}

    try:
        font_info = _resolve_cjk_font()
        font_name = font_info["name"]

        # Paragraph() parses mini-HTML, so raw '&'/'<'/'>' in USER text (e.g. "R&D",
        # "<url>") would raise or misparse. Escape every user-supplied string; the only
        # markup we ever emit (<b>/<i>/<a>/<font>) is our own, wrapped OUTSIDE the escape.
        def _esc(s) -> str:
            return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        def _markup(text, force_bold=False) -> str:
            out = []
            for seg, fmt in office_markup.parse_inline(_cell_text(text)):
                url = fmt.get("url")
                if url and not office_markup.is_safe_url(url):
                    seg = f"{seg} ({url})"
                    url = None
                t = _esc(seg)
                if fmt.get("code"):
                    mono = "Courier" if seg.isascii() else font_name
                    t = f'<font name="{mono}" color="#9A3412">{t}</font>'
                if fmt.get("italic"):
                    t = f"<i>{t}</i>"
                if fmt.get("bold") or force_bold:
                    t = f"<b>{t}</b>"
                if url:
                    href = str(url).replace("&", "&amp;").replace('"', "&quot;")
                    t = f'<a href="{href}" color="#0563C1"><u>{t}</u></a>'
                out.append(t)
            return "".join(out)

        def _para(text, style, force_bold=False, **kw):
            try:
                return Paragraph(_markup(text, force_bold), style, **kw)
            except Exception:  # malformed-markup safety net: fall back to escaped plain text
                return Paragraph(_esc(_cell_text(text)), style, **kw)

        # page size: only 'A4' | 'letter'; anything else -> A4.
        psize = letter if str(page_size).lower() == "letter" else A4
        margin = 72
        avail_w = psize[0] - 2 * margin

        # Clone the sample stylesheet but force every style onto our CJK font, with
        # wordWrap='CJK' so Chinese wraps mid-run (no whitespace to break on).
        base = getSampleStyleSheet()

        def _cjk_style(src_name: str, name=None, **overrides) -> ParagraphStyle:
            src = base[src_name]
            return ParagraphStyle(
                name or f"CJK-{src_name}",
                parent=src,
                fontName=font_name,
                wordWrap="CJK",
                **overrides,
            )

        style_body = _cjk_style("BodyText")
        style_title = _cjk_style("Title")
        style_h = {1: _cjk_style("Heading1"), 2: _cjk_style("Heading2"), 3: _cjk_style("Heading3")}
        style_quote = _cjk_style("BodyText", name="CJK-Quote", leftIndent=16,
                                 textColor=colors.HexColor("#555555"))
        style_code = _cjk_style("BodyText", name="CJK-Code", leftIndent=10, fontSize=9, leading=11,
                                backColor=colors.HexColor("#F2F2F2"))
        style_cells = {a: _cjk_style("BodyText", name=f"CJK-Cell-{a}", fontSize=9.5, leading=12,
                                     alignment={"left": 0, "center": 1, "right": 2}[a])
                       for a in ("left", "center", "right")}

        def _list_style(level):
            return _cjk_style("BodyText", name=f"CJK-List-{level}", leftIndent=18 * (level + 1),
                              bulletIndent=18 * level + 4, bulletFontName=font_name)

        list_styles = {lv: _list_style(lv) for lv in (0, 1, 2)}
        bullet_chars = {0: "•", 1: "–", 2: "·"}

        def _table(headers, rows, aligns=None):
            n_cols = max(len(headers or []), max((len(r) for r in rows), default=0))
            if n_cols == 0:
                return None
            hdr = list(headers or [])
            data_rows = [(list(r) + [""] * n_cols)[:n_cols] for r in rows]
            widths = _pdf_col_widths((hdr + [""] * n_cols)[:n_cols] if hdr else None, data_rows, avail_w)
            if not widths:
                return None

            def _al(c):
                return style_cells[aligns[c] if aligns and c < len(aligns) and aligns[c] in style_cells else "left"]

            cells = []
            if hdr:
                cells.append([_para(h, _al(c), force_bold=True) for c, h in enumerate((hdr + [""] * n_cols)[:n_cols])])
            for r in data_rows:
                cells.append([_para(v, _al(c)) for c, v in enumerate(r)])
            tbl = Table(cells, colWidths=widths, repeatRows=1 if hdr else 0)
            tbl.setStyle(
                TableStyle(
                    [
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("BACKGROUND", (0, 0), (-1, 0),
                         colors.whitesmoke if hdr else colors.white),
                        ("FONTNAME", (0, 0), (-1, -1), font_name),
                        ("LEFTPADDING", (0, 0), (-1, -1), 4),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]
                )
            )
            return tbl

        story = []

        if title:
            story.append(Paragraph(_esc(title), style_title))
            story.append(Spacer(1, 6 * mm))

        counters: dict = {}
        for blk in office_markup.parse_blocks(str(content)):
            kind = blk[0]
            if kind == "blank":
                story.append(Spacer(1, 4 * mm))
            elif kind == "heading":
                story.append(_para(blk[2], style_h[blk[1]]))
            elif kind == "bullet":
                lv = min(blk[1], 2)
                story.append(_para(blk[2], list_styles[lv], bulletText=bullet_chars[lv]))
            elif kind == "number":
                _, lv, text, num, list_id, first = blk
                lv = min(lv, 2)
                if first or list_id not in counters:
                    counters[list_id] = num
                else:
                    counters[list_id] += 1
                story.append(_para(text, list_styles[lv], bulletText=f"{counters[list_id]}."))
            elif kind == "table":
                t = _table(blk[1], blk[2], blk[3])
                if t is not None:
                    story.append(Spacer(1, 2 * mm))
                    story.append(t)
                    story.append(Spacer(1, 2 * mm))
            elif kind == "quote":
                story.append(_para(blk[1], style_quote))
            elif kind == "code":
                lines = [ln.replace("\t", "    ") for ln in blk[1]] or [""]
                story.append(Paragraph("<br/>".join(_esc(ln).replace(" ", "&nbsp;") or "&nbsp;" for ln in lines),
                                       style_code))
            elif kind == "rule":
                story.append(HRFlowable(width="100%", thickness=0.6, color=colors.lightgrey,
                                        spaceBefore=3, spaceAfter=3))
            else:
                story.append(_para(blk[1], style_body))

        # Optional trailing table (headers + rows), same builder as in-content tables.
        if table_data:
            t = _table(table_headers, table_data)
            if t is not None:
                story.append(Spacer(1, 4 * mm))
                story.append(t)

        # Count pages via an onPage callback (robust across reportlab builds).
        _page_counter = {"n": 0}

        def _count_page(canvas, doc):
            _page_counter["n"] += 1

        def _build(target):
            _page_counter["n"] = 0
            d = SimpleDocTemplate(target, pagesize=psize, leftMargin=margin, rightMargin=margin)
            d.build(story, onFirstPage=_count_page, onLaterPages=_count_page)
            return d

        holder = {}

        def _writer(tmp):
            holder["doc"] = _build(tmp)

        office_io.atomic_save(path, _writer)
        pages = _page_counter["n"] or getattr(holder.get("doc"), "page", 1) or 1

        # v1.5.1: 补 output_path(== path), 见 write_document。
        out = {"success": True, "path": os.path.abspath(path), "output_path": os.path.abspath(path), "pages": pages, "font": font_name}
        if font_info.get("warning"):
            out["warning"] = font_info["warning"]
        return out
    except Exception as e:
        return office_io.io_failure(e, path)
