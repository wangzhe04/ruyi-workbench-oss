#!/usr/bin/env node
'use strict';

// Release-contract regression tests. The heavyweight build/install replay is run by the release
// workflow; these assertions keep future refactors from silently reintroducing sdists or target-side
// compilation into the "full offline" path.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const builder = read('mcp/ai-computer-control/installer/build_offline_package.py');
const installer = read('mcp/ai-computer-control/installer/install.py');
const installBat = read('mcp/ai-computer-control/installer/install.bat');
const updater = read('mcp/ai-computer-control/installer/update.bat');
const packager = read('ruyi-workbench/tools/package-offline.ps1');
const pyproject = read('mcp/ai-computer-control/pyproject.toml');
const requirements = read('mcp/ai-computer-control/requirements_offline.txt');
const packageJson = JSON.parse(read('ruyi-workbench/package.json'));
const boot = read('ruyi-workbench/app/src/00-boot.js');
const configRuntime = read('ruyi-workbench/app/src/01-config.js');

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label); }
}

ok(/PYTHON_VERSION[^\n]+3\.12\.10/.test(builder), 'builder pins CPython 3.12 with a published winsdk wheel');
ok(/winsdk-1\.0\.0b10-cp312-cp312-win_amd64\.whl/.test(builder) &&
   /winsdk\.windows\.media\.ocr/.test(builder) && /requiredImports/.test(builder),
  'builder requires the exact cp312 winsdk wheel and imports the real Windows.Media.Ocr projection');
ok(/"pip",\s*"wheel"/.test(builder) && /wheel cache contains source\/non-wheel artifacts/.test(builder), 'builder converts dependencies to a wheel-only cache');
ok((builder.match(/--no-index/g) || []).length >= 1 && /--only-binary=:all:/.test(builder), 'builder performs a binary-only no-index replay');
ok(/sys\.path\[:\]=/.test(builder) && /site\.addsitedir/.test(builder) && /"-S",\s*"-X",\s*"utf8"/.test(builder), 'empty-target probe excludes hydrated packages while honoring target wheel .pth files');
ok(/offline-manifest\.json/.test(builder) && /sha256/.test(builder), 'builder emits a checksummed manifest');

ok(/verify_offline_payload/.test(installer) && /checksum mismatch/.test(installer), 'installer verifies the offline manifest before activation');
ok(/IncompletePackageError/.test(installer) && /never run it inside the ZIP preview/.test(installer),
  'installer turns incomplete extraction into an actionable first-run error');
ok(/acc-install-latest\.log/.test(installer) && /Diagnostic log/.test(installer),
  'installer persists first-run diagnostics instead of losing the underlying exception');
ok(/verified \{index\}/.test(installer) && /flush=True/.test(installer),
  'long Full verification emits unbuffered progress so first launch does not look frozen');
ok(/def _native_path/.test(installer) && /\\\\\\\\\?\\\\/.test(installer), 'installer verifies and copies deep Chromium trees with Win32 extended paths');
ok(/\[command,\s*"-I",\s*"-B",\s*"-X",\s*"utf8"/.test(installer),
  'installer import probes are isolated from ambient packages and cannot mutate the signed payload with bytecode');
ok(/runtime[^\n]+python/.test(installer) && /install_bundled_runtime/.test(installer), 'installer atomically deploys the pre-hydrated runtime');
ok(/--ensure/.test(installer) && /payloadSha256/.test(installer) && /refreshing MCP registration/.test(installer), 'installer supports an idempotent fast first-launch ensure mode');
ok(/winsdk\.windows\.media\.ocr/.test(installer) && /requiredImports/.test(installer) &&
   /ACC\/winsdk OCR import check/.test(installer),
  'installer refuses cached, bundled, copied, or fallback runtimes without the Full OCR capability');
ok(/source archives and cannot install safely/.test(installer) && /--only-binary=:all:/.test(installer), 'legacy fallback refuses source archives and compilation');
ok(/-r", REQUIREMENTS_FILE, "ai-computer-control"/.test(installer), 'fallback installs the full feature requirements plus ACC wheel');
ok(/python_embed\\python\.exe/.test(installBat), 'one-click launcher prefers bundled Python over system Python');
ok(/uiautomation comtypes winsdk/.test(updater) && /offline_packages/.test(updater) && /--no-index/.test(updater),
  'incremental offline updater finds Full wheel caches and installs winsdk with UIA dependencies');
ok(/AUTO_DEPS/.test(updater) && /winsdk-1\.0\.0b10-cp312-cp312-win_amd64\.whl/.test(updater) &&
   (updater.match(/winsdk\.windows\.media\.ocr/g) || []).length >= 2,
  'code overlays auto-repair and verify the pinned WinSDK OCR runtime instead of silently succeeding without it');

ok(/\[switch\]\$BuildAccOffline/.test(packager) && /offline-manifest\.json/.test(packager), 'Ruyi full packager requires or builds a verified ACC payload');
ok(/Refusing to create a source-only package labeled full\/offline/.test(packager), 'Ruyi refuses misleading source-only full packages');
ok(/python\.exe" -u -B -X utf8 .*install\.py" --ensure/.test(packager) && /Desktop-control setup failed/.test(packager),
  'full-package launcher keeps the signed payload immutable while installing and registering ACC');
ok(/RUYI_BUNDLED_PYTHON/.test(packager) && /PATH=%ACC_ROOT%\\python_embed;%PATH%/.test(packager) &&
   /PYTHONDONTWRITEBYTECODE=1/.test(packager),
  'Full launcher exposes the verified embedded Python to ordinary offline task commands');
ok(/function exposeBundledPythonRuntime\(\)/.test(boot) && /process\.env\.PYTHON = pythonExe/.test(boot) &&
   /process\.env\.PATH = \[pythonDir/.test(boot) && /RUYI_BUNDLED_PYTHON/.test(boot),
  'server boot exposes bundled Python for direct Ruyi.exe and bundled-Node startup paths');
ok(/PACKAGE INCOMPLETE/.test(packager) && /Do not run Start-Workbench\.cmd from inside the ZIP preview/.test(packager),
  'Full and Slim launchers preflight missing extraction files with a clear recovery path');
ok(/Desktop-control setup failed[\s\S]+base Workbench will still start/.test(packager) &&
   !/Desktop-control setup failed[\s\S]{0,300}exit \/b 1/.test(packager),
  'ACC setup failure degrades to the base Workbench instead of blocking first launch');
ok(/runtime\\node\\node\.exe/.test(packager) && /Refusing to create a package without/.test(packager),
  'packager and launcher require the bundled Node runtime for deterministic Slim and Full startup');
ok(/README-START-HERE\.txt/.test(packager), 'both packages include visible extract-before-running instructions');
ok(/Copy-LongTree/.test(packager) && /robocopy\.exe/.test(packager) && /tar\.exe/.test(packager), 'full-package assembly handles Chromium paths beyond legacy MAX_PATH');
ok(/@archiveRoots/.test(packager) && /Explorer-incompatible/.test(packager) && /ZipFile\]::OpenRead/.test(packager), 'offline ZIP avoids Explorer-invisible dot entries and verifies every archive before release');
ok(/explorerDefaultPathBudget\s*=\s*200/.test(packager) && /projectedExplorerPath/.test(packager) && /Use a shorter -Variant/.test(packager), 'packager rejects release names that make deep ACC paths unsafe for Windows Explorer');
ok(/verify_offline_payload/.test(packager) && /ACC staged manifest verification failed/.test(packager), 'full-package assembly verifies the signed ACC manifest before release');
ok(/Assert-FullAccOcrPayload/.test(packager) &&
   /winsdk-\$requiredVersion-cp312-cp312-win_amd64\.whl/.test(packager) &&
   /import openpyxl; import xlsxwriter; import docx; import pptx/.test(packager) &&
   /winsdk\.windows\.media\.ocr/.test(packager) &&
   /manifest does not integrity-cover required OCR payload/.test(packager),
  'Ruyi Full packager requires the OCR wheel, live imports, and manifest coverage before emitting a ZIP');
ok(/Remove-LongTree/.test(packager) && /Refusing to remove path outside package output root/.test(packager), 'long-path cleanup is constrained to the package output root');
ok(/\.Extension -ne '\.zip'/.test(packager), 'full package excludes nested local ACC zip build artifacts');
ok(/variantLooksFull/.test(packager) && /named Full must use -IncludeAcc/.test(packager),
  'a Full-labeled package cannot be emitted without ACC and WinSDK');
ok(/if \(-not \$SkipExeBuild -and \(Test-Path \$exe\)\)/.test(packager), 'SkipExeBuild cannot package a stale dist/Ruyi.exe');
ok(/requires-python = ">=3\.12"/.test(pyproject), 'ACC metadata supports the bundled Python 3.12 runtime');
ok(/mcp\[cli\]>=1\.0\.0,<2\.0\.0/.test(pyproject) && /^mcp\[cli\]>=1\.0\.0,<2\.0\.0$/m.test(requirements),
  'ACC pins the compatible MCP 1.x API instead of accepting the breaking MCP 2.x surface');
ok(/^winsdk==1\.0\.0b10$/m.test(requirements), 'Full offline requirements pin the verified winsdk cp312 release exactly');
ok(/"openpyxl"/.test(builder) && /"xlsxwriter"/.test(builder) && /"docx"/.test(builder) &&
   /"pptx"/.test(builder) && /"pdfplumber"/.test(builder) && /"openpyxl"/.test(installer) &&
   /"xlsxwriter"/.test(installer) && /"pptx"/.test(installer) && /"pandas"/.test(builder) &&
   /"pypdf"/.test(builder) && /"PyPDF2"/.test(installer) && /"requests"/.test(installer) && /"bs4"/.test(installer),
  'builder and target installer agree that Full covers the common document runtime, not only ACC core');
ok(/^pandas>=2\.2\.0$/m.test(requirements) && /^pypdf>=5\.0\.0$/m.test(requirements) &&
   /^PyPDF2>=3\.0\.1$/m.test(requirements) && /^requests>=2\.31\.0$/m.test(requirements) &&
   /^beautifulsoup4>=4\.12\.0$/m.test(requirements),
  'Full offline requirements include common data, PDF, HTTP, and HTML parsing libraries');
ok(/-IncludeAcc\s+-Variant full/.test(packageJson.scripts['package:offline']) &&
   /-IncludeAcc\s+-Variant full/.test(packageJson.scripts['package:offline:full']) &&
   /-IncludeAcc\s+-BuildAccOffline\s+-Variant full/.test(packageJson.scripts['package:offline:full:fresh']) &&
   /-Variant slim/.test(packageJson.scripts['package:offline:slim']),
  'default offline packaging means Full, with explicit fresh-Full and Slim commands');
ok(/__RUYI_ACC_FULL__/.test(configRuntime) && /installed-full-runtime/.test(configRuntime) &&
   /offline-embedded-runtime/.test(configRuntime) && /capability === 'full'/.test(configRuntime),
  'desktop MCP autodetection prefers bundled then installed WinSDK-capable runtimes over core-only system Python');

console.log('\nACC OFFLINE INSTALLER CONTRACT: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exit(failures ? 1 : 0);
