'use strict';
// ACC installer stdlib suite. No ACC/native import is performed: the Python
// suite imports the real installer and mocks subprocess.run around owned files.
// Only absolute regular Python binaries are considered, never Store aliases or py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const REPO = path.resolve(__dirname, '../..');
const INSTALLER = path.join(REPO, 'mcp/ai-computer-control/installer/install.py');
const SUITE = path.join(REPO, 'mcp/ai-computer-control/installer/tests/test_install_runtime.py');
const PYTHON_PROBE = 'import sys, unittest, unittest.mock, importlib.util, tempfile; assert sys.version_info >= (3, 12); print(sys.executable)';
const OPTIONS = { windowsHide: true, shell: false, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 };

function candidateFile(file) {
  if (!file || !path.isAbsolute(file) || /[\\/]WindowsApps(?:[\\/]|$)/i.test(file)) return false;
  try { const row = fs.statSync(file); return row.isFile() && row.size > 0; } catch { return false; }
}
function findPython() {
  const explicit = process.env.RUYI_TEST_ACC_INSTALLER_PYTHON;
  if (explicit) assert.ok(candidateFile(explicit), 'RUYI_TEST_ACC_INSTALLER_PYTHON must name an absolute non-Store Python binary');
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const candidates = explicit ? [explicit] : [
    path.join(REPO, 'mcp/ai-computer-control/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => {
      const clean = dir.replace(/^"|"$/g, '');
      return path.isAbsolute(clean) ? names.map(name => path.join(clean, name)) : [];
    }),
  ];
  const seen = new Set();
  const probeDeadline = Date.now() + 20000;
  for (const candidate of candidates) {
    if (!candidateFile(candidate)) continue;
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    const remaining = probeDeadline - Date.now();
    if (remaining <= 0) break;
    const result = cp.spawnSync(candidate, ['-I', '-B', '-X', 'utf8', '-c', PYTHON_PROBE], { ...OPTIONS, timeout: Math.max(1, remaining) });
    if (result.status === 0 && !result.signal && !result.error) {
      const actual = String(result.stdout || '').trim();
      if (candidateFile(actual)) return actual;
    }
    if (explicit) assert.fail('Explicit installer test Python failed the isolated stdlib/version probe');
  }
  return null;
}

test('ACC offline installer warm/cold import policy and real rollback files', { timeout: 45000 }, t => {
  const python = findPython();
  if (!python) { t.skip('Python >=3.12 stdlib runtime unavailable (no Store aliases or launcher attempted)'); return; }
  const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(INSTALLER)).digest('hex');
  const result = cp.spawnSync(python, ['-I', '-B', '-X', 'utf8', SUITE, '--installer', INSTALLER], OPTIONS);
  const output = String(result.stdout || '') + String(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 0, output);
  assert.match(output, new RegExp('INSTALLER_SOURCE_SHA256 ' + sourceSha + '(?:\\r?\\n)'));
  assert.match(output, /Ran 12 tests in /);
  assert.match(output, /(?:^|\n)OK\s*$/);
  assert.doesNotMatch(output, /(?:skipped=|unexpected success|FAILED)/i);
});
