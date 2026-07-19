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

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label); }
}

ok(/PYTHON_VERSION[^\n]+3\.12\.10/.test(builder), 'builder pins CPython 3.12 with a published winsdk wheel');
ok(/"pip",\s*"wheel"/.test(builder) && /wheel cache contains source\/non-wheel artifacts/.test(builder), 'builder converts dependencies to a wheel-only cache');
ok((builder.match(/--no-index/g) || []).length >= 1 && /--only-binary=:all:/.test(builder), 'builder performs a binary-only no-index replay');
ok(/sys\.path\[:\]=/.test(builder) && /site\.addsitedir/.test(builder) && /"-S",\s*"-X",\s*"utf8"/.test(builder), 'empty-target probe excludes hydrated packages while honoring target wheel .pth files');
ok(/offline-manifest\.json/.test(builder) && /sha256/.test(builder), 'builder emits a checksummed manifest');

ok(/verify_offline_payload/.test(installer) && /checksum mismatch/.test(installer), 'installer verifies the offline manifest before activation');
ok(/def _native_path/.test(installer) && /\\\\\\\\\?\\\\/.test(installer), 'installer verifies and copies deep Chromium trees with Win32 extended paths');
ok(/runtime[^\n]+python/.test(installer) && /install_bundled_runtime/.test(installer), 'installer atomically deploys the pre-hydrated runtime');
ok(/--ensure/.test(installer) && /payloadSha256/.test(installer) && /refreshing MCP registration/.test(installer), 'installer supports an idempotent fast first-launch ensure mode');
ok(/source archives and cannot install safely/.test(installer) && /--only-binary=:all:/.test(installer), 'legacy fallback refuses source archives and compilation');
ok(/-r", REQUIREMENTS_FILE, "ai-computer-control"/.test(installer), 'fallback installs the full feature requirements plus ACC wheel');
ok(/python_embed\\python\.exe/.test(installBat), 'one-click launcher prefers bundled Python over system Python');
ok(/uiautomation comtypes winsdk/.test(updater) && /offline_packages/.test(updater) && /--no-index/.test(updater),
  'incremental offline updater finds Full wheel caches and installs winsdk with UIA dependencies');

ok(/\[switch\]\$BuildAccOffline/.test(packager) && /offline-manifest\.json/.test(packager), 'Ruyi full packager requires or builds a verified ACC payload');
ok(/Refusing to create a source-only package labeled full\/offline/.test(packager), 'Ruyi refuses misleading source-only full packages');
ok(/python\.exe" -B -X utf8 .*install\.py" --ensure/.test(packager) && /ACC installation failed/.test(packager), 'full-package launcher keeps the signed payload immutable while installing and registering ACC');
ok(/Copy-LongTree/.test(packager) && /robocopy\.exe/.test(packager) && /tar\.exe/.test(packager), 'full-package assembly handles Chromium paths beyond legacy MAX_PATH');
ok(/@archiveRoots/.test(packager) && /Explorer-incompatible/.test(packager) && /ZipFile\]::OpenRead/.test(packager), 'offline ZIP avoids Explorer-invisible dot entries and verifies every archive before release');
ok(/explorerDefaultPathBudget\s*=\s*200/.test(packager) && /projectedExplorerPath/.test(packager) && /Use a shorter -Variant/.test(packager), 'packager rejects release names that make deep ACC paths unsafe for Windows Explorer');
ok(/verify_offline_payload/.test(packager) && /ACC staged manifest verification failed/.test(packager), 'full-package assembly verifies the signed ACC manifest before release');
ok(/Remove-LongTree/.test(packager) && /Refusing to remove path outside package output root/.test(packager), 'long-path cleanup is constrained to the package output root');
ok(/\.Extension -ne '\.zip'/.test(packager), 'full package excludes nested local ACC zip build artifacts');
ok(/if \(-not \$SkipExeBuild -and \(Test-Path \$exe\)\)/.test(packager), 'SkipExeBuild cannot package a stale dist/Ruyi.exe');
ok(/requires-python = ">=3\.12"/.test(pyproject), 'ACC metadata supports the bundled Python 3.12 runtime');

console.log('\nACC OFFLINE INSTALLER CONTRACT: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exit(failures ? 1 : 0);
