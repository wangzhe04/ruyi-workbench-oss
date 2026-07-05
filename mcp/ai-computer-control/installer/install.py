"""
Offline installation script.
This script is bundled inside the offline zip and runs on the target machine.
"""

import os
import sys
import json
import shutil
import subprocess


INSTALL_DIR = os.path.join(os.environ.get("LOCALAPPDATA", "C:\\Users\\Public"), "ai-computer-control")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGES_DIR = os.path.join(SCRIPT_DIR, "offline_packages")
PYTHON_EMBED_DIR = os.path.join(SCRIPT_DIR, "python_embed")
PLAYWRIGHT_DIR = os.path.join(SCRIPT_DIR, "playwright_browsers")
VENV_DIR = os.path.join(INSTALL_DIR, "venv")


def find_python():
    """Find Python executable - prefer system Python, fallback to embedded."""
    # Try system Python
    for cmd in ["python", "python3", "py"]:
        try:
            result = subprocess.run(
                [cmd, "--version"], capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and "3.1" in result.stdout:
                return cmd
        except Exception:
            continue

    # Use embedded Python
    embedded = os.path.join(PYTHON_EMBED_DIR, "python.exe")
    if os.path.exists(embedded):
        return embedded

    return None


def create_venv(python_exe):
    """Create virtual environment."""
    print("[1/4] Creating virtual environment...")
    if os.path.exists(VENV_DIR):
        shutil.rmtree(VENV_DIR)

    subprocess.run([python_exe, "-m", "venv", VENV_DIR], check=True)

    # If using embedded Python without venv module, copy embedded + install pip
    if not os.path.exists(os.path.join(VENV_DIR, "Scripts", "python.exe")):
        os.makedirs(VENV_DIR, exist_ok=True)
        shutil.copytree(PYTHON_EMBED_DIR, os.path.join(VENV_DIR, "Scripts"), dirs_exist_ok=True)

    print(f"  -> Virtual environment created at {VENV_DIR}")


def install_packages():
    """Install all packages from offline cache."""
    print("[2/4] Installing Python packages (offline)...")
    pip_exe = os.path.join(VENV_DIR, "Scripts", "pip.exe")

    subprocess.run(
        [
            pip_exe, "install",
            "--no-index",
            "--find-links", PACKAGES_DIR,
            "--no-deps",
        ] + _list_wheels(),
        check=True,
    )
    print("  -> All packages installed")


def _list_wheels():
    """List all wheel files in the packages directory."""
    wheels = []
    for f in os.listdir(PACKAGES_DIR):
        if f.endswith(".whl") or f.endswith(".tar.gz"):
            wheels.append(os.path.join(PACKAGES_DIR, f))
    return wheels


def setup_playwright():
    """Set up Playwright browser from offline cache."""
    print("[3/4] Setting up Playwright browser...")
    target_dir = os.path.join(INSTALL_DIR, "playwright_browsers")

    if os.path.exists(PLAYWRIGHT_DIR):
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)
        shutil.copytree(PLAYWRIGHT_DIR, target_dir)

        # Set environment variable for Playwright
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = target_dir
        print(f"  -> Playwright browser installed to {target_dir}")
    else:
        print("  -> Playwright browser not found in package, skipping")


def configure_mcp():
    """Register as MCP server in common AI tool configurations."""
    print("[4/4] Configuring MCP server...")
    python_exe = os.path.join(VENV_DIR, "Scripts", "python.exe")
    playwright_path = os.path.join(INSTALL_DIR, "playwright_browsers")

    mcp_config = {
        "mcpServers": {
            "ai-computer-control": {
                "command": python_exe.replace("\\", "/"),
                "args": ["-m", "ai_computer_control"],
                "env": {
                    "PLAYWRIGHT_BROWSERS_PATH": playwright_path.replace("\\", "/")
                }
            }
        }
    }

    # Write config to install directory
    config_path = os.path.join(INSTALL_DIR, "mcp_config.json")
    with open(config_path, "w") as f:
        json.dump(mcp_config, f, indent=2)

    # Try to update Claude Code config
    claude_config_dir = os.path.join(os.environ.get("APPDATA", ""), "Claude")
    claude_config_path = os.path.join(claude_config_dir, "claude_desktop_config.json")

    if os.path.exists(claude_config_dir):
        try:
            existing = {}
            if os.path.exists(claude_config_path):
                with open(claude_config_path, "r") as f:
                    existing = json.load(f)

            if "mcpServers" not in existing:
                existing["mcpServers"] = {}

            existing["mcpServers"]["ai-computer-control"] = mcp_config["mcpServers"]["ai-computer-control"]

            with open(claude_config_path, "w") as f:
                json.dump(existing, f, indent=2)
            print(f"  -> Claude Desktop config updated: {claude_config_path}")
        except Exception as e:
            print(f"  -> Could not update Claude config: {e}")

    print(f"  -> MCP config saved to: {config_path}")
    print(f"\n  To use with other AI tools, add this to your MCP config:")
    print(f"  {json.dumps(mcp_config['mcpServers']['ai-computer-control'], indent=2)}")


def create_start_script():
    """Create a start.bat for manual server launch."""
    python_exe = os.path.join(VENV_DIR, "Scripts", "python.exe")
    playwright_path = os.path.join(INSTALL_DIR, "playwright_browsers")

    start_bat = os.path.join(INSTALL_DIR, "start_server.bat")
    with open(start_bat, "w") as f:
        f.write(f"""@echo off
set PLAYWRIGHT_BROWSERS_PATH={playwright_path}
"{python_exe}" -m ai_computer_control
""")
    print(f"\n  Manual start script: {start_bat}")


def main():
    print("=" * 60)
    print("AI Computer Control - Offline Installer")
    print("=" * 60)
    print(f"Install directory: {INSTALL_DIR}\n")

    os.makedirs(INSTALL_DIR, exist_ok=True)

    python_exe = find_python()
    if not python_exe:
        print("ERROR: No Python found and no embedded Python in package.")
        print("Please install Python 3.10+ first.")
        sys.exit(1)

    print(f"Using Python: {python_exe}\n")

    create_venv(python_exe)
    install_packages()
    setup_playwright()
    configure_mcp()
    create_start_script()

    print(f"\n{'='*60}")
    print("Installation complete!")
    print(f"{'='*60}")
    print(f"\nInstalled to: {INSTALL_DIR}")
    print(f"MCP Server is ready. Restart your AI tool to connect.")


if __name__ == "__main__":
    main()
