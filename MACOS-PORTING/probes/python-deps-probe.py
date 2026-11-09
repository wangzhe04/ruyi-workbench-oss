"""P0 dependency experiment. Installs only into a new temporary venv, never edits ACC.
Run with Python 3.12. Network is used for dependency preparation, not product runtime.
Desktop input modules are NOT imported or exercised (avoid TCC prompts).
"""
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import signal
import sys
import tempfile
import venv

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "MACOS-PORTING/evidence/P0/python"


def isolated_env(scratch):
    child_env = dict(os.environ)
    for key, dirname in {"HOME": "home", "USERPROFILE": "home", "XDG_CACHE_HOME": "cache",
                         "XDG_CONFIG_HOME": "config", "MPLCONFIGDIR": "matplotlib", "PIP_CACHE_DIR": "pip-cache"}.items():
        directory = scratch / dirname
        directory.mkdir(exist_ok=True)
        child_env[key] = str(directory)
    child_env["PIP_CONFIG_FILE"] = os.devnull
    return child_env


def run_command(argv, log_path, child_env, timeout):
    with log_path.open("w") as log:
        child = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT,
                                 env=child_env, start_new_session=True)
        result = {}
        try:
            result = {"exitCode": child.wait(timeout=timeout), "timedOut": False}
        except subprocess.TimeoutExpired:
            result = {"exitCode": None, "timedOut": True}
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                result["groupCleanup"] = "signal_sent_to_owned_group"
            except ProcessLookupError:
                result["groupCleanup"] = "already_exited"
            child.wait(timeout=10)
        return result


def self_test():
    # Exercise a real pip-like process tree without installing packages or touching user state.
    with tempfile.TemporaryDirectory(prefix="ruyi-p0-python-selftest-") as directory:
        scratch = Path(directory)
        environment = isolated_env(scratch)
        script = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']); print(p.pid,flush=True); time.sleep(30)"
        result = run_command([sys.executable, "-c", script], scratch / "tree.txt", environment, 1)
        descendant = int((scratch / "tree.txt").read_text().strip())
        state = subprocess.run(["ps", "-p", str(descendant), "-o", "stat="], capture_output=True, text=True).stdout.strip()
        assert result["timedOut"] and (not state or state.startswith("Z")), (result, state)
        assert all(environment[key].startswith(str(scratch)) for key in ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "MPLCONFIGDIR", "PIP_CACHE_DIR"])
        probe = run_command([sys.executable, "-c", "import os;print(os.environ['HOME']);print(os.environ['MPLCONFIGDIR'])"], scratch / "env.txt", environment, 5)
        assert probe["exitCode"] == 0 and all(line.startswith(str(scratch)) for line in (scratch / "env.txt").read_text().splitlines())
        print(json.dumps({"ok": True, "ownedDescendantStopped": True, "isolatedChildEnvironment": True, "timeout": result}, indent=2))


def main():
    if sys.version_info[:2] != (3, 12) or sys.platform != "darwin":
        raise SystemExit("Use Python 3.12 on macOS")
    OUT.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="ruyi-p0-python-"))
    venv.create(scratch / "venv", with_pip=True)
    python = scratch / "venv/bin/python"
    child_env = isolated_env(scratch)
    report = {"python": sys.version, "platform": platform.platform(), "arch": platform.machine(),
              "scratch": str(scratch), "scope": "hypothetical portable dependency split; current ACC package unchanged"}

    def command(label, argv, timeout=300):
        report[label] = run_command(argv, OUT / (label + ".txt"), child_env, timeout)
        (OUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    command("current-package-dry-run", [str(python), "-m", "pip", "--disable-pip-version-check", "install", "--dry-run", str(ROOT / "mcp/ai-computer-control")])
    excluded = {"pywin32", "uiautomation", "comtypes", "winsdk"}
    selected = []
    for line in (ROOT / "mcp/ai-computer-control/requirements_offline.txt").read_text().splitlines():
        line = line.split("#")[0].strip()
        name = line.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip()
        if line and name not in excluded:
            selected.append(line)
    report["excludedWindowsDependencies"] = sorted(excluded)
    requirements = OUT / "portable-requirements.txt"
    requirements.write_text("\n".join(selected) + "\n")
    command("portable-install", [str(python), "-m", "pip", "--disable-pip-version-check", "install", "-r", str(requirements)], timeout=600)
    if report["portable-install"]["exitCode"] == 0:
        command("resolved-freeze", [str(python), "-m", "pip", "--disable-pip-version-check", "freeze"])
        source = r'''
import importlib, importlib.metadata, json, tempfile
from pathlib import Path
modules = ['mcp.server.fastmcp','PIL.Image','psutil','docx','openpyxl','pdfplumber',
 'playwright.sync_api','reportlab','cv2','numpy','pptx','matplotlib','pandas','pypdf']
results = {}
for name in modules:
 try: importlib.import_module(name); results[name] = 'imported'
 except Exception as error: results[name] = type(error).__name__ + ': ' + str(error)
with tempfile.TemporaryDirectory(prefix='ruyi-p0-documents-') as folder:
 from docx import Document
 from openpyxl import Workbook, load_workbook
 from pptx import Presentation
 from reportlab.pdfgen import canvas
 import pdfplumber
 p = Path(folder)
 d = Document(); d.add_paragraph('P0 中文文档 fixture'); d.save(p/'sample.docx')
 w = Workbook(); w.active.append(['P0', 42]); w.save(p/'sample.xlsx')
 slide = Presentation(); slide.slides.add_slide(slide.slide_layouts[0]); slide.save(p/'sample.pptx')
 pdf = canvas.Canvas(str(p/'sample.pdf')); pdf.drawString(72,720,'P0 PDF fixture'); pdf.save()
 results['docxRoundtrip'] = Document(p/'sample.docx').paragraphs[0].text == 'P0 中文文档 fixture'
 results['xlsxRoundtrip'] = load_workbook(p/'sample.xlsx').active['B1'].value == 42
 results['pptxRoundtrip'] = len(Presentation(p/'sample.pptx').slides) == 1
 with pdfplumber.open(p/'sample.pdf') as doc: results['pdfRoundtrip'] = 'P0 PDF fixture' in doc.pages[0].extract_text()
results['desktopModules'] = 'pyautogui/pynput installed only; no input/capture/permission request'
results['browserRuntime'] = 'Playwright package only; no Chromium download or launch'
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(v == 'imported' for k,v in results.items() if k in modules)
assert all(results[k] for k in ['docxRoundtrip','xlsxRoundtrip','pptxRoundtrip','pdfRoundtrip'])
'''
        command("portable-smoke", [str(python), "-c", source])
    report["cleanup"] = "temporary venv retained for reproducibility; no global packages installed"
    (OUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report.get("portable-smoke", {}).get("exitCode") == 0 else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        raise SystemExit(main())
