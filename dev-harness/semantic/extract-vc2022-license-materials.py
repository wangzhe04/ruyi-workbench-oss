"""Stdlib DOCX/XML and official REDIST HTML text extraction; no executable loading."""
import hashlib
import html.parser
import json
import pathlib
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path("output/semantic-rank-redist-licenses-v1")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save_or_verify(file, data):
    if file.exists():
        assert file.read_bytes() == data, str(file)
    else:
        with file.open("xb") as stream:
            stream.write(data)


class MainText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.active = False
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "main":
            self.active = True
        if self.active and tag in ["script", "style", "svg"]:
            self.skip += 1
        if self.active and not self.skip and tag in ["p", "li", "h1", "h2", "h3", "h4", "br", "tr"]:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.active and tag in ["script", "style", "svg"]:
            self.skip -= 1
        if self.active and not self.skip and tag in ["p", "li", "h1", "h2", "h3", "h4", "tr"]:
            self.parts.append("\n")
        if tag == "main":
            self.active = False

    def handle_data(self, data):
        if self.active and not self.skip:
            self.parts.append(data)


records = []
for name in ["buildtools-2022-updated-202403.docx", "vcruntime-2015-2022.docx"]:
    source = ROOT / name
    with zipfile.ZipFile(source) as archive:
        assert len(archive.infolist()) < 256
        assert sum(item.file_size for item in archive.infolist()) < 4000000
        xml = archive.read("word/document.xml")
        tree = ET.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for para in tree.findall(".//w:body//w:p", ns):
            text = "".join(node.text or "" for node in para.findall(".//w:t", ns))
            if text.strip():
                paragraphs.append({"paragraph": len(paragraphs) + 1, "text": text})
        text = "\n".join("P%03d %s" % (p["paragraph"], p["text"]) for p in paragraphs) + "\n"
        target = ROOT / (source.stem + ".txt")
        save_or_verify(target, text.encode("utf8"))
        save_or_verify(ROOT / (source.stem + "-paragraphs.json"), (json.dumps(paragraphs, indent=2, ensure_ascii=False) + "\n").encode("utf8"))
        records.append({"source": str(source), "sourceSha256": sha(source.read_bytes()), "documentXmlSha256": sha(xml), "text": str(target), "textBytes": target.stat().st_size, "textSha256": sha(target.read_bytes()), "paragraphs": len(paragraphs), "numbering": "P indices are extraction references, not synthesized legal section labels; DOCX numbering remains in original ZIP."})

source = ROOT / "vs2022-redistribution.html"
parser = MainText()
parser.feed(source.read_text(encoding="utf8"))
lines = [re.sub(r"\s+", " ", line).strip() for line in "".join(parser.parts).splitlines()]
lines = [line for line in lines if line]
assert "Distributable Code for Visual Studio 2022" in " ".join(lines)
assert any("Microsoft_VC143_OpenMP" in line for line in lines)
assert any("\\VC\\redist" in line for line in lines)
text = "\n".join("L%03d %s" % (i + 1, line) for i, line in enumerate(lines)) + "\n"
target = ROOT / "vs2022-redistribution.txt"
save_or_verify(target, text.encode("utf8"))
records.append({"source": str(source), "sourceSha256": sha(source.read_bytes()), "text": str(target), "textBytes": target.stat().st_size, "textSha256": sha(target.read_bytes()), "lines": len(lines)})
result = {"schemaVersion": 1, "stdlibOnly": True, "macrosExecuted": False, "externalLinksFetched": False, "records": records, "toolSha256": sha(pathlib.Path(__file__).read_bytes())}
save_or_verify(ROOT / "extraction-r2.json", (json.dumps(result, indent=2) + "\n").encode("utf8"))
print(json.dumps({"documents": len(records), "outputsVerified": True, "record": str(ROOT / "extraction-r2.json")}))
