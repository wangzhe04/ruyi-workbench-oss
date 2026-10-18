'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

test('compiled desktop isolates explicit data roots and retains default desktop compatibility', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-desktop-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, 'Probe.cs'), exe = path.join(root, 'probe.exe');
  fs.writeFileSync(probe, 'namespace RuyiDesktop { class IsolationProbe { static void Main(string[] args) { if (args.Length == 1) { System.Console.WriteLine(DesktopIsolation.ResolveExplicitRoot(args[0], @"E:\\fixture\\app")); return; } System.Console.WriteLine(DesktopIsolation.ExplicitDataRoot() ?? "DEFAULT"); System.Console.WriteLine(DesktopIsolation.MutexName()); System.Console.WriteLine(DesktopIsolation.WebViewUserData()); } } }');
  const source = path.resolve(__dirname, '../../ruyi-workbench/desktop/RuyiDesktop.cs');
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  cp.execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/main:RuyiDesktop.IsolationProbe', '/out:' + exe,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', source, probe], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  const run = (primary, legacy) => {
    const env = { ...process.env }; delete env.RUYI_HOME; delete env.WIN_CLAUDE_WORKBENCH_HOME;
    if (primary !== undefined) env.RUYI_HOME = primary;
    if (legacy !== undefined) env.WIN_CLAUDE_WORKBENCH_HOME = legacy;
    return cp.execFileSync(exe, [], { env, windowsHide: true, cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/);
  };
  const defaults = run();
  assert.equal(defaults[0], 'DEFAULT');
  assert.equal(defaults[1], 'Local\\RuyiWorkbenchDesktopShell');
  assert.ok(defaults[2].endsWith('Ruyi\\EBWebView'));
  const a = path.join(root, 'data-a'), b = path.join(root, 'data-b');
  const first = run(a, b), second = run(b), legacy = run(undefined, a);
  assert.equal(first[0], a, 'primary environment wins');
  assert.deepEqual(legacy, first, 'legacy environment selects the same isolated installation');
  assert.equal(first[2], path.join(a, 'desktop/EBWebView'));
  assert.notEqual(first[1], second[1], 'different roots have independent mutexes');
  assert.notEqual(first[1], defaults[1], 'isolated copy does not collide with an existing default desktop');
  assert.equal(run(a.toUpperCase() + path.sep)[1], first[1], 'case and trailing slash cannot bypass same-root mutex');
  assert.equal(run(path.join(a, '..', 'data-a'))[1], first[1], 'dot segments normalize to the same mutex');
  const relative = run('relative-data');
  assert.equal(relative[0], path.join(root, 'relative-data'), 'relative root follows the server base directory, not caller cwd');
  assert.equal(relative[2], path.join(root, 'relative-data/desktop/EBWebView'));
  assert.deepEqual(run('', a), legacy, 'empty primary environment falls back to the legacy root');
  assert.equal(run('C:\\')[0], 'C:\\', 'drive root stays absolute');
  assert.equal(cp.execFileSync(exe, ['\\root-relative'], { windowsHide: true, cwd: os.tmpdir(), encoding: 'utf8' }).trim(), 'E:\\root-relative', 'root-relative path uses the server base drive');
  assert.throws(() => run('C:ambiguous'), /Command failed/, 'ambiguous drive-relative paths are rejected');
  assert.throws(() => run('invalid|path'), /Command failed/, 'invalid explicit roots cannot fall back to real desktop state');
});
