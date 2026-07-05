"""
Build offline installation package.

Run this script on a machine WITH internet access to download all dependencies
and create a self-contained offline installer zip.

Usage:
    python installer/build_offline_package.py

Output:
    ai-computer-control-offline.zip  (ready to deploy to offline machines)
"""

import os
import sys
import shutil
import subprocess
import zipfile
import urllib.request
import platform

# Config
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(PROJECT_ROOT, "build_offline")
PACKAGES_DIR = os.path.join(BUILD_DIR, "offline_packages")
PYTHON_DIR = os.path.join(BUILD_DIR, "python_embed")
PLAYWRIGHT_DIR = os.path.join(BUILD_DIR, "playwright_browsers")
OUTPUT_ZIP = os.path.join(PROJECT_ROOT, "ai-computer-control-offline.zip")

PYTHON_VERSION = "3.13.12"
PYTHON_EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def clean():
    """Clean previous build artifacts."""
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(PACKAGES_DIR, exist_ok=True)


def download_python_embed():
    """Download Python embedded distribution."""
    print("[1/5] Downloading Python embedded distribution...")
    os.makedirs(PYTHON_DIR, exist_ok=True)
    zip_path = os.path.join(PYTHON_DIR, "python_embed.zip")

    urllib.request.urlretrieve(PYTHON_EMBED_URL, zip_path)

    # Extract
    import zipfile as zf
    with zf.ZipFile(zip_path, "r") as z:
        z.extractall(PYTHON_DIR)
    os.remove(zip_path)

    # Enable pip in embedded Python by uncommenting import site
    pth_files = [f for f in os.listdir(PYTHON_DIR) if f.endswith("._pth")]
    for pth_file in pth_files:
        pth_path = os.path.join(PYTHON_DIR, pth_file)
        with open(pth_path, "r") as f:
            content = f.read()
        content = content.replace("#import site", "import site")
        with open(pth_path, "w") as f:
            f.write(content)

    # Download and install pip into embedded Python
    get_pip = os.path.join(PYTHON_DIR, "get-pip.py")
    urllib.request.urlretrieve(GET_PIP_URL, get_pip)

    python_exe = os.path.join(PYTHON_DIR, "python.exe")
    subprocess.run([python_exe, get_pip, "--no-warn-script-location"], check=True)
    os.remove(get_pip)

    print(f"  -> Python {PYTHON_VERSION} embedded ready")


def download_packages():
    """Download all Python package dependencies as wheels."""
    print("[2/5] Downloading Python packages...")
    # Download on current platform (Windows amd64) - no platform restriction needed
    # since we build on the same OS we deploy to
    subprocess.run(
        [
            sys.executable, "-m", "pip", "download",
            "--dest", PACKAGES_DIR,
            "-r", os.path.join(PROJECT_ROOT, "requirements_offline.txt"),
        ],
        check=True,
    )

    # Also download the project itself as a wheel
    subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "-w", PACKAGES_DIR, PROJECT_ROOT],
        check=True,
    )
    print(f"  -> Packages downloaded to {PACKAGES_DIR}")


def download_playwright_browser():
    """Download Playwright Chromium browser for offline use."""
    print("[3/5] Downloading Playwright Chromium browser...")
    os.makedirs(PLAYWRIGHT_DIR, exist_ok=True)

    env = os.environ.copy()
    env["PLAYWRIGHT_BROWSERS_PATH"] = PLAYWRIGHT_DIR

    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        env=env,
        check=True,
    )
    print(f"  -> Playwright Chromium downloaded to {PLAYWRIGHT_DIR}")


def copy_installer_scripts():
    """Copy installer scripts to build directory."""
    print("[4/5] Copying installer scripts...")
    shutil.copy2(
        os.path.join(PROJECT_ROOT, "installer", "install.bat"),
        os.path.join(BUILD_DIR, "install.bat"),
    )
    shutil.copy2(
        os.path.join(PROJECT_ROOT, "installer", "install.py"),
        os.path.join(BUILD_DIR, "install.py"),
    )
    # Copy MCP config template
    shutil.copy2(
        os.path.join(PROJECT_ROOT, "installer", "mcp_config_template.json"),
        os.path.join(BUILD_DIR, "mcp_config_template.json"),
    )


def create_zip():
    """Create the final offline installation zip."""
    print("[5/5] Creating offline package zip...")
    if os.path.exists(OUTPUT_ZIP):
        os.remove(OUTPUT_ZIP)

    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(BUILD_DIR):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, BUILD_DIR)
                zf.write(file_path, arcname)

    size_mb = os.path.getsize(OUTPUT_ZIP) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"Offline package created: {OUTPUT_ZIP}")
    print(f"Size: {size_mb:.1f} MB")
    print(f"{'='*60}")
    print(f"\nDeploy this zip to the offline machine and run install.bat")


def create_requirements():
    """Create requirements_offline.txt if it doesn't exist."""
    req_path = os.path.join(PROJECT_ROOT, "requirements_offline.txt")
    if not os.path.exists(req_path):
        # Fallback content only — the real, authoritative list is the checked-in requirements_offline.txt
        # (this branch fires only if that file was deleted). Keep in sync with it.
        with open(req_path, "w") as f:
            f.write("""# Core dependencies for ai-computer-control
mcp[cli]>=1.0.0
pyautogui>=0.9.54
Pillow>=10.0.0
pywin32>=306
psutil>=5.9.0
playwright>=1.40.0
python-docx>=1.0.0
openpyxl>=3.1.0
pdfplumber>=0.10.0
pyperclip>=1.8.0
reportlab>=4.0.0
uiautomation>=2.0.18
comtypes>=1.2.0
winsdk>=1.0.0b10
opencv-python-headless>=4.8.0
numpy>=1.26.0
pynput>=1.7.6
python-pptx>=0.6.23
matplotlib>=3.8.0
""")
    return req_path


def main():
    print("=" * 60)
    print("AI Computer Control - Offline Package Builder")
    print("=" * 60)

    create_requirements()
    clean()
    download_python_embed()
    download_packages()
    download_playwright_browser()
    copy_installer_scripts()
    create_zip()

    # Cleanup build dir
    print("\nCleaning up build directory...")
    shutil.rmtree(BUILD_DIR)
    print("Done!")


if __name__ == "__main__":
    main()
