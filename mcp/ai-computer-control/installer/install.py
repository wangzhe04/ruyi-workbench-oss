"""One-click, network-free installer for AI Computer Control.

New packages carry a pre-hydrated embedded runtime.  The installer copies that
runtime atomically and verifies imports; it never asks the target machine to
compile an sdist.  A wheel-only legacy fallback remains for custom packages.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import traceback


INSTALL_DIR = os.environ.get("ACC_INSTALL_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA", "C:\\Users\\Public"), "ai-computer-control"
)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGES_DIR = os.path.join(SCRIPT_DIR, "offline_packages")
REQUIREMENTS_FILE = os.path.join(SCRIPT_DIR, "requirements_offline.txt")
PYTHON_EMBED_DIR = os.path.join(SCRIPT_DIR, "python_embed")
PLAYWRIGHT_DIR = os.path.join(SCRIPT_DIR, "playwright_browsers")
MANIFEST_FILE = os.path.join(SCRIPT_DIR, "offline-manifest.json")
INSTALL_STATE_FILE = os.path.join(INSTALL_DIR, "install-state.json")
RUNTIME_DIR = os.path.join(INSTALL_DIR, "runtime", "python")
VENV_DIR = os.path.join(INSTALL_DIR, "venv")  # legacy/custom-package fallback
IMPORT_PROBE = "from mcp.server.fastmcp import FastMCP; import ai_computer_control.server"
ERROR_LOG = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "C:\\Users\\Public",
    "Ruyi", "logs", "acc-install-latest.log",
)


class IncompletePackageError(RuntimeError):
    """The ZIP was run without full extraction, or extraction skipped a file."""


def _run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def _native_path(path):
    """Use Win32 extended paths for deep Chromium/runtime trees."""
    full = os.path.abspath(path)
    if os.name != "nt" or full.startswith("\\\\?\\"):
        return full
    if full.startswith("\\\\"):
        return "\\\\?\\UNC\\" + full[2:]
    return "\\\\?\\" + full


def _python_ok(command, require_acc=False):
    code = IMPORT_PROBE if require_acc else "import sys; assert sys.version_info >= (3, 12)"
    try:
        result = subprocess.run(
            [command, "-B", "-X", "utf8", "-c", code],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        return result.returncode == 0
    except Exception:
        return False


def verify_offline_payload():
    """Verify the builder manifest before copying executable code."""
    if not os.path.isfile(MANIFEST_FILE):
        return False  # legacy package: wheel checks below are the available guard
    print("[0/4] Verifying offline package integrity...")
    with open(MANIFEST_FILE, "r", encoding="utf-8-sig") as f:
        manifest = json.load(f)
    if manifest.get("wheelOnly") is not True or not isinstance(manifest.get("files"), list):
        raise RuntimeError("offline-manifest.json is invalid or not wheel-only")
    root = os.path.realpath(SCRIPT_DIR)
    files = manifest["files"]
    print(f"  -> Checking {len(files)} packaged files. This may take a moment...", flush=True)
    for index, entry in enumerate(files, 1):
        rel = str(entry.get("path") or "").replace("/", os.sep)
        full = os.path.realpath(os.path.join(root, rel))
        if os.path.commonpath([root, full]) != root:
            raise RuntimeError(f"unsafe manifest path: {rel}")
        native = _native_path(full)
        if not os.path.isfile(native) or os.path.getsize(native) != int(entry.get("bytes", -1)):
            raise IncompletePackageError(
                "offline payload is missing or truncated: "
                + rel
                + "\nThe ZIP was not fully extracted. Extract the entire package to a short path "
                + r"such as C:\Ruyi; never run it inside the ZIP preview or choose Skip."
            )
        digest = hashlib.sha256()
        with open(native, "rb") as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest().lower() != str(entry.get("sha256") or "").lower():
            raise IncompletePackageError(
                "offline payload checksum mismatch: "
                + rel
                + "\nThe extraction or download is incomplete. Verify the release SHA256 and "
                + r"extract again to a short path such as C:\Ruyi."
            )
        if index % 1000 == 0:
            print(f"     verified {index}/{len(files)} files", flush=True)
    print(f"  -> Verified {len(files)} files", flush=True)
    return True


def _payload_id():
    if not os.path.isfile(MANIFEST_FILE):
        return "legacy"
    digest = hashlib.sha256()
    with open(MANIFEST_FILE, "rb") as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installed_runtime_ready():
    """Fast first-launch guard used by Ruyi's one-click launcher."""
    python_exe = os.path.join(RUNTIME_DIR, "python.exe")
    if not _python_ok(python_exe, require_acc=True):
        return None
    try:
        with open(INSTALL_STATE_FILE, "r", encoding="utf-8-sig") as f:
            state = json.load(f)
        if state.get("payloadSha256") != _payload_id():
            return None
    except Exception:
        return None
    if os.path.isdir(PLAYWRIGHT_DIR):
        installed_browsers = os.path.join(INSTALL_DIR, "playwright_browsers")
        if not os.path.isdir(installed_browsers) or not os.listdir(installed_browsers):
            return None
    return python_exe


def write_install_state(python_exe):
    state = {
        "schema": 1,
        "payloadSha256": _payload_id(),
        "python": python_exe.replace("\\", "/"),
    }
    with open(INSTALL_STATE_FILE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def bundled_python():
    candidate = os.path.join(PYTHON_EMBED_DIR, "python.exe")
    return candidate if os.path.isfile(candidate) and _python_ok(candidate, require_acc=True) else None


def install_bundled_runtime(source_python):
    """Copy the hydrated runtime with rollback if activation/probing fails."""
    print("[1/4] Installing bundled Python runtime...", flush=True)
    runtime_parent = os.path.dirname(RUNTIME_DIR)
    os.makedirs(runtime_parent, exist_ok=True)
    staging = os.path.join(runtime_parent, f"python.new-{os.getpid()}-{int(time.time())}")
    backup = os.path.join(runtime_parent, "python.previous")
    if os.path.exists(staging):
        shutil.rmtree(staging)
    shutil.copytree(_native_path(PYTHON_EMBED_DIR), _native_path(staging))
    staging_python = os.path.join(staging, "python.exe")
    if not _python_ok(staging_python, require_acc=True):
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError("bundled runtime failed its ACC import check after copying")

    if os.path.exists(backup):
        shutil.rmtree(backup)
    moved_old = False
    try:
        if os.path.exists(RUNTIME_DIR):
            os.replace(RUNTIME_DIR, backup)
            moved_old = True
        os.replace(staging, RUNTIME_DIR)
        final_python = os.path.join(RUNTIME_DIR, "python.exe")
        if not _python_ok(final_python, require_acc=True):
            raise RuntimeError("installed runtime failed its ACC import check")
        if moved_old:
            shutil.rmtree(backup, ignore_errors=True)
        print(f"  -> Runtime installed at {RUNTIME_DIR}")
        return final_python
    except Exception:
        shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
        if moved_old and os.path.exists(backup):
            os.replace(backup, RUNTIME_DIR)
        shutil.rmtree(staging, ignore_errors=True)
        raise


def find_system_python():
    """Find a Python >=3.12 for the wheel-only legacy fallback."""
    for argv in (["python"], ["python3"], ["py", "-3"]):
        try:
            result = subprocess.run(
                argv + ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 1)"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
            if result.returncode == 0:
                return argv
        except Exception:
            pass
    return None


def _resolve_real_python(venv_python_path):
    """Resolve Microsoft Store venv redirects while retaining a usable fallback."""
    if os.path.exists(venv_python_path):
        try:
            probe = subprocess.run(
                [venv_python_path, "-c", "import sys; print(sys.executable)"],
                capture_output=True, text=True, timeout=10,
            )
            real = probe.stdout.strip() if probe.returncode == 0 else ""
            if real and os.path.exists(real):
                return real
        except Exception:
            pass
    return venv_python_path


def create_legacy_venv(python_argv):
    print("[1/4] Creating fallback virtual environment...")
    if os.path.exists(VENV_DIR):
        shutil.rmtree(VENV_DIR)
    _run(python_argv + ["-m", "venv", VENV_DIR])
    venv_python = os.path.join(VENV_DIR, "Scripts", "python.exe")
    real_python = _resolve_real_python(venv_python)
    if not _python_ok(real_python):
        raise RuntimeError("created virtual environment is not runnable")
    return real_python


def install_from_wheel_cache(venv_python):
    """Legacy fallback, intentionally refusing every source distribution."""
    print("[2/4] Installing from wheel-only cache (offline)...")
    if not os.path.isdir(PACKAGES_DIR) or not os.path.isfile(REQUIREMENTS_FILE):
        raise RuntimeError("offline wheel cache or requirements_offline.txt is missing")
    non_wheels = sorted(
        name for name in os.listdir(PACKAGES_DIR)
        if os.path.isfile(os.path.join(PACKAGES_DIR, name)) and not name.lower().endswith(".whl")
    )
    if non_wheels:
        raise RuntimeError(
            "this offline package contains source archives and cannot install safely without a compiler: "
            + ", ".join(non_wheels)
            + ". Rebuild it with installer/build_offline_package.py."
        )
    _run([
        venv_python, "-m", "pip", "install", "--no-index",
        "--find-links", PACKAGES_DIR, "--only-binary=:all:",
        "-r", REQUIREMENTS_FILE, "ai-computer-control",
    ])
    _run([venv_python, "-m", "pip", "check"])
    if not _python_ok(venv_python, require_acc=True):
        raise RuntimeError("ACC import check failed after wheel installation")
    print("  -> Wheel-only installation verified")


def install_playwright_payload():
    print("[3/4] Installing Playwright browser payload...", flush=True)
    target = os.path.join(INSTALL_DIR, "playwright_browsers")
    if os.path.isdir(PLAYWRIGHT_DIR):
        if os.path.exists(target):
            shutil.rmtree(target)
        shutil.copytree(_native_path(PLAYWRIGHT_DIR), _native_path(target))
        print(f"  -> Browser payload installed at {target}")
    else:
        print("  -> Browser payload absent; browser tools will be unavailable")


def configure_mcp(python_exe):
    print("[4/4] Writing MCP configuration...", flush=True)
    os.makedirs(INSTALL_DIR, exist_ok=True)
    browser_path = os.path.join(INSTALL_DIR, "playwright_browsers")
    server = {
        "command": python_exe.replace("\\", "/"),
        "args": ["-X", "utf8", "-m", "ai_computer_control.server"],
        "env": {"PLAYWRIGHT_BROWSERS_PATH": browser_path.replace("\\", "/"), "PYTHONUTF8": "1"},
    }
    config = {"mcpServers": {"ai-computer-control": server}}
    config_path = os.path.join(INSTALL_DIR, "mcp_config.json")
    with open(config_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    claude_dir = os.path.join(os.environ.get("APPDATA", ""), "Claude")
    claude_config = os.path.join(claude_dir, "claude_desktop_config.json")
    if os.path.isdir(claude_dir):
        try:
            existing = {}
            if os.path.isfile(claude_config):
                with open(claude_config, "r", encoding="utf-8-sig") as f:
                    existing = json.load(f)
            if not isinstance(existing, dict):
                existing = {}
            existing.setdefault("mcpServers", {})["ai-computer-control"] = server
            with open(claude_config, "w", encoding="utf-8", newline="\n") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
            print(f"  -> Claude Desktop config updated: {claude_config}")
        except Exception as exc:
            print(f"  -> Claude Desktop config not changed: {exc}")

    start_bat = os.path.join(INSTALL_DIR, "start_server.bat")
    with open(start_bat, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(
            "@echo off\nchcp 65001 >nul 2>&1\n"
            f'set "PLAYWRIGHT_BROWSERS_PATH={browser_path}"\n'
            "set PYTHONUTF8=1\n"
            f'"{python_exe}" -X utf8 -m ai_computer_control.server\n'
        )
    print(f"  -> MCP config saved to {config_path}")


def main():
    print("=" * 60)
    print("AI Computer Control - Verified Offline Installer")
    print("=" * 60)
    print(f"Install directory: {INSTALL_DIR}\n")
    os.makedirs(INSTALL_DIR, exist_ok=True)

    if "--ensure" in sys.argv[1:]:
        ready_python = installed_runtime_ready()
        if ready_python:
            print("  -> Matching ACC runtime is already installed; refreshing MCP registration")
            configure_mcp(ready_python)
            print("ACC is ready.")
            return

    verified_manifest = verify_offline_payload()
    embedded = bundled_python()
    if embedded:
        python_exe = install_bundled_runtime(embedded)
    else:
        if verified_manifest:
            raise RuntimeError("verified package does not contain a usable hydrated Python runtime")
        print("  -> Legacy package detected; using wheel-only system-Python fallback")
        system_python = find_system_python()
        if not system_python:
            raise RuntimeError("no Python >=3.12 found and bundled runtime is unavailable")
        python_exe = create_legacy_venv(system_python)
        install_from_wheel_cache(python_exe)

    install_playwright_payload()
    configure_mcp(python_exe)
    write_install_state(python_exe)
    print("\n" + "=" * 60)
    print("Installation complete and import-verified.")
    print("=" * 60)
    print(f"Runtime: {python_exe}")
    print("Restart Ruyi/Claude Desktop to reconnect ACC.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            os.makedirs(os.path.dirname(ERROR_LOG), exist_ok=True)
            with open(ERROR_LOG, "w", encoding="utf-8", newline="\n") as log:
                log.write("AI Computer Control installation failed\n")
                log.write(f"Package root: {SCRIPT_DIR}\n")
                log.write(f"Install directory: {INSTALL_DIR}\n\n")
                log.write(traceback.format_exc())
        except Exception:
            pass
        print(f"\nERROR: {exc}", file=sys.stderr, flush=True)
        print(f"Package root: {SCRIPT_DIR}", file=sys.stderr, flush=True)
        print(f"Diagnostic log: {ERROR_LOG}", file=sys.stderr, flush=True)
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in {3, 5, 206}:
            print(
                "Recovery: fully extract the ZIP to C:\\Ruyi and retry. "
                "If access is denied, close old Ruyi/ACC processes first.",
                file=sys.stderr,
                flush=True,
            )
        sys.exit(1)
