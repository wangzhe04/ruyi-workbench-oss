"""Independently inspect retained P3-02 artifacts and native image extraction.

Usage: python tests/verify_macos_office_sample.py <isolated sample directory>
Rendering with LibreOffice/Poppler is performed separately, with private profiles.
Uses different readers from the PDF/chart writers; does not accept file size as proof.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
root = Path(sys.argv[1]).resolve()
sample = json.loads((ROOT / "tests/fixtures/macos-office-sample.json").read_text())
assert root.is_dir()

from docx import Document
from docx.shared import Inches
from openpyxl import load_workbook
from openpyxl.drawing.image import Image as SheetImage
from pptx import Presentation
from PIL import Image
import pdfplumber
from pdfminer.pdftypes import resolve1
from matplotlib.ft2font import FT2Font
from ai_computer_control.tools import office_style, office_chart, document

checks = []
def check(condition, label):
    assert condition, label
    checks.append(label)
    print("PASS " + label)

def embedded_fonts(pdf):
    found = []
    with pdfplumber.open(pdf) as doc:
        for page in doc.pages:
            for font in resolve1(page.page_obj.resources.get("Font", {})).values():
                font = resolve1(font)
                for candidate in [font] + [resolve1(v) for v in font.get("DescendantFonts", [])]:
                    descriptor = resolve1(candidate.get("FontDescriptor", {}))
                    for key in ("FontFile", "FontFile2", "FontFile3"):
                        if key in descriptor:
                            stream = resolve1(descriptor[key])
                            found.append({"name": str(candidate.get("BaseFont")), "bytes": len(stream.get_data())})
    return found

word = Document(root / "report.docx")
check(word.tables[0].cell(1, 0).text == "上海" and word.tables[0].cell(3, 2).text == "16",
      "independent DOCX reader preserves Chinese table rows and numbers")
check(word.styles["Normal"].font.name == office_style.get_style("business")["body_font"] != "微软雅黑",
      "DOCX uses an installed Mac CJK family")
book = load_workbook(root / "data.xlsx")
sheet = book.active
check(list(sheet.values) == [tuple(sample["headers"])] + [tuple(r) for r in sample["rows"]],
      "independent XLSX reader matches every source header, string and numeric value")
check(len(sheet._charts) == 1 and sheet["A1"].font.name == word.styles["Normal"].font.name,
      "XLSX contains its native chart and the Mac CJK font")
slides = Presentation(root / "slides.pptx")
check(len(slides.slides) == 3, "independent PPTX reader finds all three specified slides")
tables = [shape.table for slide in slides.slides for shape in slide.shapes if shape.has_table]
check(tables[0].cell(1, 0).text == "上海" and tables[0].cell(3, 2).text == "16",
      "PPTX data table matches the source values")
check(all(s.top + s.height <= slides.slide_height + 10 and s.left + s.width <= slides.slide_width + 10
          for slide in slides.slides for s in slide.shapes), "PPTX shapes stay within the slide bounds")
with Image.open(root / "chart.png") as image:
    check(image.width >= 1000 and image.height >= 500 and any(lo < hi for lo, hi in image.convert("RGB").getextrema()),
          "chart is a real high-resolution raster with visible content")
font = office_style.font_chain()
charmap = FT2Font(font["path"]).get_charmap()
labels = "季度数据对比城市数量上海北京深圳第一二"
check(all(ord(c) in charmap for c in labels), "selected chart font contains every Chinese sample label glyph")
resources = embedded_fonts(root / "summary.pdf")
check(bool(resources) and all(f["bytes"] > 100 for f in resources),
      "independent PDF resources contain actual embedded font streams")
with pdfplumber.open(root / "summary.pdf") as pdf:
    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
check(all(s in text for s in ("如意", "Ruyi", "上海", "北京", "深圳")),
      "independent PDF text extraction retains Chinese, English and table data")

# Native image reader fixtures add the exact chart to DOCX/XLSX. PPTX already
# embeds it through the production writer. Original generated artifacts remain.
word.add_picture(str(root / "chart.png"), width=Inches(5.5))
word.save(root / "source-with-image.docx")
sheet.add_image(SheetImage(str(root / "chart.png")), "A20")
book.save(root / "source-with-image.xlsx"); book.close()
options = {"offset": 0, "limit": 30000, "includeImages": True, "imageOffset": 0,
           "imageLimit": 8, "pageOffset": 1, "pageLimit": 2}
worker = ROOT.parents[1] / "ruyi-workbench/resources/native-file-read.py"
png_hash = hashlib.sha256((root / "chart.png").read_bytes()).hexdigest()
for name in ("source-with-image.docx", "source-with-image.xlsx", "slides.pptx", "summary.pdf"):
    process = subprocess.run([sys.executable, str(worker), str(root / name), json.dumps(options)],
                             capture_output=True, text=True, timeout=30, check=True)
    value = json.loads(process.stdout)
    check(value["ok"] and value["images"] and not value.get("imageWarnings"),
          name + " native reader extracts images without warnings")
    data = base64.b64decode(value["images"][0]["data"], validate=True)
    if name != "summary.pdf":
        check(hashlib.sha256(data).hexdigest() == png_hash, name + " embedded image bytes match the source chart")
    else:
        with Image.open(io.BytesIO(data)) as image:
            check(image.width > 500 and image.height > 500, "native PDF reader returns an actual page raster")

# Font-error diagnostics are exercised in this dedicated process after artifact
# inspection so the test cannot poison the writer's font cache during generation.
with patch.object(document, "_PDF_FONT_CACHE", None), patch.object(document, "_pdf_font_candidates", return_value=[]):
    fallback = document.write_pdf(str(root / "font-fallback.pdf"), "中文字体缺失提示")
    check(fallback.get("warning") and not embedded_fonts(root / "font-fallback.pdf"),
          "missing embeddable CJK font returns an accurate reader-font warning")
blank = document.write_pdf(str(root / "blank.pdf"), "")
check(blank.get("success") and not embedded_fonts(root / "blank.pdf"),
      "blank PDF is inspected as having no font resources; selection is not treated as embedding proof")
with patch.object(office_style, "_FONT_CHAIN_CACHE", {"family": "Broken", "path": str(root / "missing-font.ttf")}), \
     patch.object(office_chart, "_FONT_READY", False), patch.object(office_chart, "_FONT_INFO", None):
    first, second = office_chart._ensure_font(), office_chart._ensure_font()
    check(first.get("warning") and second == first and first["path"] is None,
          "unreadable chart font keeps its accurate warning across cached calls")
with patch.object(office_style.sys, "platform", "win32"):
    check(office_style.get_style("business")["body_font"] == "微软雅黑", "Windows Office style retains its original font contract")

with tempfile.TemporaryDirectory(prefix="stale-render-control-", dir=root) as tmp:
    control = Path(tmp)
    (control / "renders").mkdir()
    for name, suffix in (("report", "docx"), ("data", "xlsx"), ("slides", "pptx")):
        (control / f"{name}.{suffix}").write_bytes(b"invalid current input")
        (control / "renders" / f"{name}.pdf").write_bytes(b"%PDF-stale previous output")
    result = subprocess.run(["node", str(ROOT.parents[1] / "MACOS-PORTING/probes/render-office-samples.cjs"), str(control)],
                            env=dict(os.environ, RUYI_OFFICE_RENDERER="/usr/bin/true"),
                            capture_output=True, text=True, timeout=30)
    check(result.returncode != 0, "zero-exit renderer cannot accept stale PDF outputs as a fresh render")

report = {"checks": checks, "count": len(checks), "embeddedFonts": resources, "chartSourceSha256": png_hash,
          "limits": ["Sample glyph coverage is not universal Unicode coverage", "Office renderer and visual checks are recorded separately"]}
(root / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print("MACOS OFFICE INDEPENDENT VERIFICATION: ALL PASS")
