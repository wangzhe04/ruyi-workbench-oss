"""Build and verify a genuinely offline AI Computer Control package.

The release contains a pre-hydrated CPython runtime, a wheel-only repair cache,
and the matching Playwright browser.  Target machines never need Python, pip,
a compiler, or network access.

Usage:
    python installer/build_offline_package.py [--keep-build]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(PROJECT_ROOT, "build_offline")
PACKAGES_DIR = os.path.join(BUILD_DIR, "offline_packages")
PYTHON_DIR = os.path.join(BUILD_DIR, "python_embed")
PLAYWRIGHT_DIR = os.path.join(BUILD_DIR, "playwright_browsers")
VALIDATION_DIR = os.path.join(BUILD_DIR, ".offline-validation")
OUTPUT_ZIP = os.path.join(PROJECT_ROOT, "ai-computer-control-offline.zip")

# CPython 3.12 is deliberate: winsdk publishes a Windows wheel for cp312 but not
# cp313.  Using 3.13 made pip fall back to a source build on the offline machine.
PYTHON_VERSION = os.environ.get("ACC_OFFLINE_PYTHON_VERSION", "3.12.10")
PYTHON_EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
IMPORT_PROBE = (
    "from mcp.server.fastmcp import FastMCP; "
    "import ai_computer_control.server; "
    "import pyautogui, playwright, winsdk"
)


def run(args, *, env=None, cwd=None):
    printable = " ".join(f'"{x}"' if " " in str(x) else str(x) for x in args)
    print(f"  $ {printable}")
    subprocess.run(args, env=env, cwd=cwd, check=True)


def clean():
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(PACKAGES_DIR, exist_ok=True)


def download_python_embed():
    print("[1/7] Preparing bundled CPython runtime...")
    os.makedirs(PYTHON_DIR, exist_ok=True)
    archive = os.path.join(PYTHON_DIR, "python_embed.zip")
    urllib.request.urlretrieve(PYTHON_EMBED_URL, archive)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(PYTHON_DIR)
    os.remove(archive)

    for name in os.listdir(PYTHON_DIR):
        if not name.endswith("._pth"):
            continue
        pth = os.path.join(PYTHON_DIR, name)
        with open(pth, "r", encoding="utf-8") as f:
            content = f.read()
        content = content.replace("#import site", "import site")
        with open(pth, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)

    get_pip = os.path.join(PYTHON_DIR, "get-pip.py")
    urllib.request.urlretrieve(GET_PIP_URL, get_pip)
    python_exe = os.path.join(PYTHON_DIR, "python.exe")
    run([python_exe, get_pip, "--no-warn-script-location"])
    os.remove(get_pip)
    run([python_exe, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
    print(f"  -> Bundled Python {PYTHON_VERSION} ready")
    return python_exe


def build_wheelhouse(python_exe):
    print("[2/7] Building wheel-only dependency cache...")
    requirements = os.path.join(PROJECT_ROOT, "requirements_offline.txt")
    # `pip wheel`, not `pip download`: projects published only as sdists (PyAutoGUI
    # and friends) are converted on the online build machine, never on the target.
    run([
        python_exe, "-m", "pip", "wheel", "--prefer-binary",
        "--wheel-dir", PACKAGES_DIR, "-r", requirements,
    ])
    run([
        python_exe, "-m", "pip", "wheel", "--no-deps",
        "--wheel-dir", PACKAGES_DIR, PROJECT_ROOT,
    ])
    bad = sorted(name for name in os.listdir(PACKAGES_DIR) if not name.lower().endswith(".whl"))
    if bad:
        raise RuntimeError("wheel cache contains source/non-wheel artifacts: " + ", ".join(bad))
    if not any(name.lower().startswith("ai_computer_control-") for name in os.listdir(PACKAGES_DIR)):
        raise RuntimeError("project wheel is missing from offline cache")
    print(f"  -> {len(os.listdir(PACKAGES_DIR))} wheels ready; no source archives")


def offline_install_args(python_exe, target=None):
    args = [
        python_exe, "-m", "pip", "install", "--no-index",
        "--find-links", PACKAGES_DIR, "--only-binary=:all:",
    ]
    if target:
        args += ["--target", target]
    args += ["-r", os.path.join(PROJECT_ROOT, "requirements_offline.txt"), "ai-computer-control"]
    return args


def hydrate_runtime(python_exe):
    print("[3/7] Hydrating bundled runtime from the offline cache...")
    run(offline_install_args(python_exe))
    run([python_exe, "-m", "pip", "check"])
    run([python_exe, "-X", "utf8", "-c", IMPORT_PROBE])
    print("  -> Runtime imports and dependency graph verified")


def download_playwright_browser(python_exe):
    print("[4/7] Downloading the browser matching bundled Playwright...")
    os.makedirs(PLAYWRIGHT_DIR, exist_ok=True)
    env = os.environ.copy()
    env["PLAYWRIGHT_BROWSERS_PATH"] = PLAYWRIGHT_DIR
    run([python_exe, "-m", "playwright", "install", "chromium"], env=env)
    if not os.listdir(PLAYWRIGHT_DIR):
        raise RuntimeError("Playwright reported success but browser payload is empty")
    print("  -> Chromium payload ready")


def copy_installer_files():
    print("[5/7] Copying installer and lock inputs...")
    for name in ("install.bat", "install.py", "mcp_config_template.json"):
        shutil.copy2(os.path.join(PROJECT_ROOT, "installer", name), os.path.join(BUILD_DIR, name))
    shutil.copy2(
        os.path.join(PROJECT_ROOT, "requirements_offline.txt"),
        os.path.join(BUILD_DIR, "requirements_offline.txt"),
    )


def validate_air_gapped_install(python_exe):
    print("[6/7] Replaying installation with --no-index in an empty target...")
    if os.path.exists(VALIDATION_DIR):
        shutil.rmtree(VALIDATION_DIR)
    os.makedirs(VALIDATION_DIR)
    run(offline_install_args(python_exe, VALIDATION_DIR))
    env = os.environ.copy()
    env["PYTHONPATH"] = VALIDATION_DIR
    env["PLAYWRIGHT_BROWSERS_PATH"] = PLAYWRIGHT_DIR
    # Embedded Python's ._pth can force `import site` even with -S. Replace
    # sys.path explicitly so the hydrated runtime cannot mask a missing wheel.
    stdlib_zip = os.path.join(PYTHON_DIR, "python" + "".join(PYTHON_VERSION.split(".")[:2]) + ".zip")
    # addsitedir processes only the validation target's .pth files (notably
    # pywin32.pth), preserving real wheel-install semantics without admitting
    # the hydrated runtime's Lib/site-packages.
    isolated_probe = (
        f"import sys, site; sys.path[:]={repr([stdlib_zip, PYTHON_DIR])}; "
        f"site.addsitedir({VALIDATION_DIR!r}); {IMPORT_PROBE}"
    )
    run([python_exe, "-S", "-X", "utf8", "-c", isolated_probe], env=env)
    shutil.rmtree(VALIDATION_DIR)
    print("  -> Empty-target offline replay passed")


def write_manifest():
    files = []
    for root, dirs, names in os.walk(BUILD_DIR):
        dirs[:] = [d for d in dirs if d != ".offline-validation"]
        for name in names:
            if name == "offline-manifest.json":
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, BUILD_DIR).replace("\\", "/")
            digest = hashlib.sha256()
            with open(full, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    digest.update(chunk)
            files.append({"path": rel, "bytes": os.path.getsize(full), "sha256": digest.hexdigest()})
    files.sort(key=lambda x: x["path"])
    manifest = {
        "schema": 1,
        "name": "AI Computer Control Offline Runtime",
        "pythonVersion": PYTHON_VERSION,
        "wheelOnly": True,
        "fileCount": len(files),
        "files": files,
    }
    with open(os.path.join(BUILD_DIR, "offline-manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def create_zip():
    print("[7/7] Creating verified offline package...")
    write_manifest()
    if os.path.exists(OUTPUT_ZIP):
        os.remove(OUTPUT_ZIP)
    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for root, _, files in os.walk(BUILD_DIR):
            for name in files:
                full = os.path.join(root, name)
                zf.write(full, os.path.relpath(full, BUILD_DIR))
    print(f"  -> {OUTPUT_ZIP} ({os.path.getsize(OUTPUT_ZIP) / 1024 / 1024:.1f} MB)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-build", action="store_true", help="keep build_offline for embedding in Ruyi")
    args = parser.parse_args()
    print("=" * 60)
    print("AI Computer Control - Verified Offline Package Builder")
    print("=" * 60)
    clean()
    try:
        python_exe = download_python_embed()
        build_wheelhouse(python_exe)
        hydrate_runtime(python_exe)
        download_playwright_browser(python_exe)
        copy_installer_files()
        validate_air_gapped_install(python_exe)
        create_zip()
    finally:
        if not args.keep_build and os.path.exists(BUILD_DIR):
            shutil.rmtree(BUILD_DIR)
    print("Done. Target installation requires no system Python and no network.")


if __name__ == "__main__":
    main()
