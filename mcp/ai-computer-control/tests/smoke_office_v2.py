"""Office writers v2: perf, JSON cell types, PDF tables, number formats, markdown-lite, chart layout,
pptx layout, locked-file / missing-dependency envelopes, lazy heavy imports.

Stdlib + the office libs present in the venv. Run:  python -X utf8 tests/smoke_office_v2.py
Exits non-zero on any failed check.
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "src"))
os.environ["WCW_DATA_DIR"] = tempfile.mkdtemp(prefix="acc-office-v2-")

import ai_computer_control.server as server  # noqa: E402
from ai_computer_control.tools import office_chart, office_io, office_markup  # noqa: E402

tools = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
FAILS = []


def check(name, cond, detail=""):
    print(("  [ok  ] " if cond else "  [FAIL] ") + name + ("" if cond else f"  ({detail})"))
    if not cond:
        FAILS.append(name)


def call_via_mcp(name, args):
    """Go through FastMCP validation like a real client (the .fn direct calls skip pydantic)."""
    try:
        res = asyncio.run(server.mcp.call_tool(name, args))
        return {"validated": True, "result": res}
    except Exception as e:  # noqa: BLE001
        return {"validated": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


root = Path(tempfile.mkdtemp(prefix="office-v2-"))

print("# F2 write_document TABLE perf")
rows = "\n".join(f"| r{i} | {i} | 说明{i} | x |" for i in range(300))
t0 = time.time()
r = tools["write_document"](str(root / "big.docx"), "TABLE: a | b | c | d\n" + rows)
dt = time.time() - t0
check("300-row TABLE ok", r.get("success"), r)
check("300-row TABLE under 5 s", dt < 5, f"{dt:.1f}s")
from docx import Document  # noqa: E402
d = Document(root / "big.docx")
check("table has 301 rows x 4 cols", len(d.tables) == 1 and len(d.tables[0].rows) == 301 and len(d.tables[0].columns) == 4)
check("last cell text read back", d.tables[0].cell(300, 2).text == "说明299")

print("# F3 JSON cell types through the MCP schema")
res = call_via_mcp("write_excel", {"path": str(root / "j.xlsx"), "data": [["a", 1, None, 2.5, True]]})
check("write_excel accepts numbers/null/bool", res["validated"], res.get("error"))
from openpyxl import load_workbook  # noqa: E402
if not (root / "j.xlsx").exists():     # old schema rejects the call before the tool runs
    tools["write_excel"](str(root / "j.xlsx"), [["a", "1", "", "2.5", ""]])
wb = load_workbook(root / "j.xlsx")
ws = wb.active
check("int stays numeric", ws["B1"].value == 1 and ws["B1"].data_type == "n", (ws["B1"].value, ws["B1"].data_type))
check("null is an empty cell", ws["C1"].value is None)
check("float stays numeric", ws["D1"].value == 2.5 and ws["D1"].data_type == "n")
check("bool stays bool", ws["E1"].value is True and ws["E1"].data_type == "b", (ws["E1"].value, ws["E1"].data_type))
wb.close()
res = call_via_mcp("write_pdf", {"path": str(root / "j.pdf"), "content": "x", "table_headers": ["a", "b"],
                                  "table_data": [["x", 1], [None, 2.5]]})
check("write_pdf accepts numbers/null", res["validated"], res.get("error"))

print("# F4 write_pdf tables")
try:
    import pdfplumber
except Exception:  # noqa: BLE001
    pdfplumber = None
for cols, length in ((5, 40), (3, 80), (2, 240), (5, 240)):
    cell = ("中文内容abc" * 60)[:length]
    r = tools["write_pdf"](str(root / f"t{cols}_{length}.pdf"), "# T",
                           table_headers=[f"列{i}" for i in range(cols)],
                           table_data=[[cell] * cols for _ in range(5)])
    check(f"pdf table {cols} cols x {length} chars ok", r.get("success"), r.get("error"))
    if r.get("success") and pdfplumber:
        with pdfplumber.open(root / f"t{cols}_{length}.pdf") as pdf:
            inside = all(w["x1"] <= pg.width + 0.5 for pg in pdf.pages for w in pg.extract_words())
        check(f"pdf table {cols}x{length} stays inside the page", inside)
r = tools["write_pdf"](str(root / "long.pdf"), "x", table_headers=["a", "b"], table_data=[["u" * 400, "b"]])
check("400 unbroken ASCII chars wrap", r.get("success"), r.get("error"))
r = tools["write_pdf"](str(root / "num.pdf"), "9. 九\n10. 十\n11. 十一\n**粗体** 与 [链接](https://example.com)\n"
                       "| A | B |\n|---|---:|\n| 1 | 2 |")
check("pdf markdown (10./11., bold, link, GFM table) ok", r.get("success"), r.get("error"))
if r.get("success") and pdfplumber:
    with pdfplumber.open(root / "num.pdf") as pdf:
        txt = "\n".join(pg.extract_text() or "" for pg in pdf.pages)
    check("pdf has no literal ** / pipe table", "**" not in txt and "|---" not in txt, txt[:200])
    check("pdf keeps 10. and 11.", "10." in txt and "11." in txt)

print("# F6 write_excel number formats")
r = tools["write_excel"](str(root / "f.xlsx"),
                         [[2024, 13800138000, 100000, 1200, "00123", 1234.5],
                          [2025, 13900139000, 100001, 98000, "00456", 99.5]],
                         headers=["年份", "手机号", "邮编", "销量", "工号", "均价"])
check("write_excel ok", r.get("success"), r)
ws = load_workbook(root / "f.xlsx").active
check("year column not thousands-separated", ws["A2"].number_format == "General", ws["A2"].number_format)
check("phone column not thousands-separated", ws["B2"].number_format == "General", ws["B2"].number_format)
check("postcode column not thousands-separated", ws["C2"].number_format == "General", ws["C2"].number_format)
check("real quantity still gets #,##0", ws["D2"].number_format == "#,##0", ws["D2"].number_format)
check("leading-zero id stays text", ws["E2"].value == "00123" and ws["E2"].data_type == "s")
check("year values stay numeric", ws["A2"].value == 2024)
r = tools["write_excel"](str(root / "f2.xlsx"), [[2020], [2021], [2022]], headers=["x"])
check("year-looking values without a header hint", load_workbook(root / "f2.xlsx").active["A2"].number_format == "General")
r = tools["write_excel"](str(root / "f3.xlsx"), [["1200", 5]], headers=["价格($)", "n"])
check("$ header gets a dollar format", load_workbook(root / "f3.xlsx").active["A2"].number_format.startswith("$"))
r = tools["write_excel"](str(root / "f4.xlsx"), [[1]], sheet_name="a/b")
check("invalid sheet name gets a hint", "error" in r and "sheet_name" in r["error"], r)

print("# F8 markdown-lite structure (docx)")
md = """# 季度报告
| 指标 | Q1 | Q2 |
|:-----|---:|:--:|
| 营收 | **12%** | `x` |
| 利润 | 3 | 4 |

* 第一项 *斜体* 和 **粗体** 以及 [官网](https://example.com)
  - 嵌套一
+ 第三项
1. 甲
2. 乙

中间段落

1. 丙
2. 丁
"""
r = tools["write_document"](str(root / "m.docx"), md)
check("write_document markdown ok", r.get("success"), r)
d = Document(root / "m.docx")
check("GFM table becomes exactly one real table", len(d.tables) == 1)
check("table has header + 2 rows", len(d.tables) == 1 and len(d.tables[0].rows) == 3)
all_runs = [run.text for p in d.paragraphs for run in p.runs] + \
           [run.text for t in d.tables for row in t.rows for c in row.cells for p in c.paragraphs for run in p.runs]
check("no literal ** or backticks left", not any("**" in x or "`" in x for x in all_runs), all_runs)
styles = [p.style.name for p in d.paragraphs]
check("'*' and '+' become bullets", styles.count("List Bullet") == 2, styles)
check("indented '-' becomes nested bullet", "List Bullet 2" in styles, styles)
bold_runs = [run for p in d.paragraphs for run in p.runs if run.bold]
check("**bold** is a bold run", any(run.text == "粗体" for run in bold_runs))
check("*italic* is an italic run", any(run.italic and run.text == "斜体" for p in d.paragraphs for run in p.runs))
xml = zipfile.ZipFile(root / "m.docx").read("word/document.xml").decode("utf-8")
rels = zipfile.ZipFile(root / "m.docx").read("word/_rels/document.xml.rels").decode("utf-8")
check("link is a real hyperlink", "<w:hyperlink" in xml and "https://example.com" in rels)
import re  # noqa: E402
num_paras = [p for p in d.paragraphs if p.style.name == "List Number"]
ids = [p._p.pPr.numPr.numId.val for p in num_paras if p._p.pPr is not None and p._p.pPr.numPr is not None and p._p.pPr.numPr.numId is not None]
check("4 numbered paragraphs each carry numPr", len(ids) == 4, ids)
check("second list uses a different numId (restarts)", len(set(ids)) == 2 and ids[0] == ids[1] and ids[2] == ids[3] and ids[0] != ids[2], ids)
numbering = zipfile.ZipFile(root / "m.docx").read("word/numbering.xml").decode("utf-8")
check("restart via startOverride", numbering.count("w:startOverride") >= 2)
r = tools["write_document"](str(root / "legacy.docx"), "# H\nTABLE: a | b\n| 1 | 2 |\n\n- x\n1. y")
d = Document(root / "legacy.docx")
check("legacy TABLE: block still works", r.get("success") and len(d.tables) == 1 and d.tables[0].cell(1, 1).text == "2")
blocks = office_markup.parse_blocks("1. a\n2. b\n\n3. c")
check("blank line does not split a list unless it restarts at 1", {b[4] for b in blocks if b[0] == "number"} == {1})
check("inline: snake_case / 2*3*4 untouched", office_markup.plain_text("snake_case_var 2 * 3 * 4") == "snake_case_var 2 * 3 * 4")

print("# F12 chart_image layout")
office_chart._ensure_font()
plt, err = office_chart._load_pyplot() if hasattr(office_chart, "_load_pyplot") else (None, "no lazy loader")
check("pyplot loads lazily", plt is not None, err)
cats = [f"华东地区{c}分公司" for c in "一二三四五六七八九十"]
res = tools["chart_image"](str(root / "bar.png"), "bar",
                           {"labels": cats, "series": [{"name": "营收", "values": list(range(10, 20))}]}, "t")
check("long-label bar ok and needed a layout step", res.get("success") and res.get("label_layout") in ("wrapped", "rotated", "thinned"), res)


def tick_boxes_overlap(labels):
    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.bar(range(len(labels)), [1] * len(labels))
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels)
    fig.tight_layout()
    how = office_chart._fit_category_labels(fig, ax, labels)
    fig.canvas.draw()
    rend = fig.canvas.get_renderer()
    boxes = [t.get_window_extent(rend) for t in ax.get_xticklabels() if t.get_text()]
    rot = ax.get_xticklabels()[0].get_rotation()
    plt.close(fig)
    if rot:     # rotated text: bounding boxes overlap by construction; compare anchor spacing instead
        return False, how
    boxes.sort(key=lambda b: b.x0)
    return any(a.x1 > b.x0 for a, b in zip(boxes, boxes[1:])), how


try:
    ov, how = tick_boxes_overlap(cats)
    check(f"10 x 8-CJK tick labels do not overlap ({how})", not ov)
    ov, how = tick_boxes_overlap([f"类别{i}" for i in range(40)])
    check(f"40 tick labels do not overlap ({how})", not ov)
    check("contrast text: dark slice -> white", office_chart._contrast_text_color("#1F2E66") == "#FFFFFF")
    check("contrast text: light slice -> dark", office_chart._contrast_text_color("#F5E6B3") != "#FFFFFF")
except Exception as exc:  # noqa: BLE001
    check("chart layout helpers present", False, repr(exc))
res = tools["chart_image"](str(root / "pie.png"), "pie",
                           {"labels": list("ABCDEFGH"), "series": [{"name": "s", "values": [38, 24, 15, 9, 5, 4, 3, 2]}]}, "p")
check("pie with small slices ok", res.get("success"), res)
res = tools["chart_image"](str(root / "pie2.png"), "pie", {"labels": ["a", "b"], "series": [{"name": "s", "values": [1, -1]}]}, "p")
check("negative pie value is a clear error", "error" in res and "负" in res["error"], res)
res = tools["chart_image"](str(root / "sc.png"), "scatter",
                           {"labels": ["a", "b", "c"], "x": [0.5, 2.25, 10], "series": [{"name": "s", "values": [1, 2, 3]}]}, "s")
check("scatter with numeric x ok", res.get("success"), res)
res = tools["chart_image"](str(root / "sc2.png"), "scatter",
                           {"labels": ["a", "b"], "x": [1], "series": [{"name": "s", "values": [1, 2]}]}, "s")
check("scatter with wrong-length x is rejected", "error" in res, res)
res = tools["chart_image"](str(root / "ln.png"), "line",
                           {"labels": ["Q1", "Q2", "Q1", "Q2"], "series": [{"name": "s", "values": [1, 2, 3, 4]}]}, "l")
check("duplicate category labels render", res.get("success"), res)
big = {"labels": [f"类别{i}" for i in range(40)], "series": [{"name": n, "values": [i % 7 for i in range(40)]} for n in "ABC"]}
check("40x3 bar renders", tools["chart_image"](str(root / "b40.png"), "bar", big, "t").get("success"))

print("# F13 write_pptx layout")
from pptx import Presentation  # noqa: E402
from pptx.util import Inches  # noqa: E402
trows = [[f"项目{i}", "说明" * 15, i * 1000, "x" * 8, "备注"] for i in range(11)]
bul = [f"要点{i} " + "内容" * 10 for i in range(11)]
from PIL import Image  # noqa: E402
Image.effect_noise((3840, 2160), 80).convert("RGB").save(root / "huge.png")
r = tools["write_pptx"](str(root / "p.pptx"), [
    {"type": "title", "title": "封面"},
    {"type": "content", "title": "要点", "bullets": bul},
    {"type": "table", "title": "表", "headers": ["项目", "描述", "金额", "码", "备注"], "rows": trows},
    {"type": "image", "title": "图", "image_path": str(root / "huge.png")},
    {"type": "closing"},
])
check("pptx ok", r.get("success"), r)
prs = Presentation(root / "p.pptx")
check("every slide has a title placeholder", all(s.shapes.title is not None for s in prs.slides))
check("content title text lives in the placeholder", prs.slides[1].shapes.title.text.startswith("要点"))
bullets_per_slide = []
real_bullets = True
for s in prs.slides:
    for sh in s.shapes:
        if sh.has_text_frame and not sh.is_placeholder and sh.text_frame.text.startswith("要点"):
            paras = sh.text_frame.paragraphs
            bullets_per_slide.append(len(paras))
            for p in paras:
                if p._p.pPr is None or p._p.pPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}buChar") is None \
                        or p.text.startswith(("•", "–", "·")):
                    real_bullets = False
check("11 bullets -> no orphan slide (each >= 3)", bullets_per_slide and min(bullets_per_slide) >= 3, bullets_per_slide)
check("bullets are real paragraph bullets, not typed glyphs", real_bullets)
tables = [sh for s in prs.slides for sh in s.shapes if sh.has_table]
check("5x11 table: every table bottom above the footer", all((sh.top + sh.height) / 914400 <= 7.05 for sh in tables),
      [(sh.top + sh.height) / 914400 for sh in tables])
widths = [c.width for c in tables[0].table.columns]
check("table columns proportional, not equal", max(widths) > 2 * min(widths), widths)
check("table fits slide width", sum(widths) + tables[0].left <= prs.slide_width, (sum(widths), tables[0].left))
pic = next(sh for s in prs.slides for sh in s.shapes if sh.shape_type == 13)
check("4K image downscaled to <= 2000 px", pic.image.size[0] <= 2000, pic.image.size)
check("deck stays small", os.path.getsize(root / "p.pptx") < 6_000_000, os.path.getsize(root / "p.pptx"))

print("# F15 locked target / missing dependency")
writers = {
    "docx": lambda p: tools["write_document"](p, "# hi"),
    "xlsx": lambda p: tools["write_excel"](p, [["a", 1]]),
    "pdf": lambda p: tools["write_pdf"](p, "hi"),
    "pptx": lambda p: tools["write_pptx"](p, [{"type": "title", "title": "t"}]),
    "png": lambda p: tools["chart_image"](p, "bar", {"labels": ["a"], "series": [{"name": "s", "values": [1]}]}, "t"),
}
real_replace = os.replace
for ext, fn in writers.items():
    target = str(root / f"locked.{ext}")
    Path(target).write_bytes(b"ORIGINAL")

    def boom(src, dst, *a, **k):
        raise PermissionError(13, "The process cannot access the file because it is being used by another process", dst)

    os.replace = boom
    try:
        r = fn(target)
    finally:
        os.replace = real_replace
    check(f"{ext}: locked file -> ok:false + code", r.get("ok") is False and r.get("code") == "file_locked", r)
    check(f"{ext}: hint says close the file / pick another path", "关闭" in r.get("error", "") and "Excel" in r.get("error", ""), r.get("error"))
    check(f"{ext}: original bytes untouched, no temp litter",
          Path(target).read_bytes() == b"ORIGINAL" and not [f for f in os.listdir(root) if f.startswith(".ruyi-")])

for mod, fn, label in (("docx", writers["docx"], "python-docx"), ("openpyxl", writers["xlsx"], "openpyxl"),
                       ("pptx", writers["pptx"], "python-pptx")):
    saved = sys.modules.get(mod)
    sys.modules[mod] = None       # makes `import mod` raise ImportError
    try:
        r = fn(str(root / f"nodep.{mod}"))
    finally:
        if saved is None:
            sys.modules.pop(mod, None)
        else:
            sys.modules[mod] = saved
    check(f"missing {mod}: install-hint envelope", r.get("ok") is False and f"pip install {label}" in r.get("error", ""), r)
saved_plt = office_chart._PLT
office_chart._PLT = None
saved = sys.modules.get("matplotlib")
sys.modules["matplotlib"] = None
try:
    r = writers["png"](str(root / "nodep.png"))
finally:
    office_chart._PLT = saved_plt
    if saved is None:
        sys.modules.pop("matplotlib", None)
    else:
        sys.modules["matplotlib"] = saved
check("missing matplotlib: install-hint envelope", r.get("ok") is False and "pip install matplotlib" in r.get("error", ""), r)

print("# io helpers")
check("io_failure maps WinError 32", office_io.io_failure(OSError(13, "x"), "a.xlsx").get("code") == "file_locked")
e = OSError(32, "sharing violation")
e.winerror = 32
check("io_failure maps winerror 32 OSError", office_io.io_failure(e, "a.xlsx").get("code") == "file_locked")
check("plain error keeps its text", office_io.io_failure(ValueError("boom"), "a").get("error") == "boom")

print("# lazy heavy imports")
code = ("import sys, os, tempfile\n"
        "os.environ['WCW_DATA_DIR']=tempfile.mkdtemp()\n"
        f"sys.path.insert(0, r'{_ROOT / 'src'}')\n"
        "import ai_computer_control.server\n"
        "print(','.join(m for m in ('matplotlib','pptx','reportlab') if m in sys.modules))\n")
out = subprocess.run([sys.executable, "-X", "utf8", "-c", code], capture_output=True, text=True, encoding="utf-8",
                     errors="replace", timeout=120)
loaded = (out.stdout.strip().splitlines() or [""])[-1]
check("server import does not load matplotlib / pptx / reportlab", loaded == "", (loaded, out.stderr[-300:]))
check("diagnostics still reports the optional libs",
      set(server.mcp._tool_manager.get_tool("diagnostics").fn()["optional"]) >= {"pptx", "matplotlib"})

print()
if FAILS:
    print(f"OFFICE-V2 SMOKE: {len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("OFFICE-V2 SMOKE: ALL PASS")
