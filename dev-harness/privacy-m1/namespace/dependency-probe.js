'use strict';
// Read-only inventory. No VM/distro/container is started and no feature is enabled.
const cp = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { killOwnTree } = require('../../lib/kill-own-tree');

const INVENTORY_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$r = [ordered]@{}
try { $s = Get-CimInstance Win32_ComputerSystem; $r.hypervisorPresent = [bool]$s.HypervisorPresent } catch { $r.hypervisorPresent = 'unknown' }
try { $o = Get-CimInstance Win32_OperatingSystem; $r.os = @{ caption=$o.Caption; version=$o.Version; architecture=$o.OSArchitecture } } catch { $r.os = 'unknown' }
$r.sandboxBinary = Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe')
$r.features = @{}
foreach ($n in @('Containers-DisposableClientVM','Microsoft-Hyper-V-All','Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
  try { $r.features[$n] = [string](Get-WindowsOptionalFeature -Online -FeatureName $n).State } catch { $r.features[$n] = 'unknown:' + $_.Exception.GetType().Name }
}
$r.tools = @{}
foreach ($n in @('wsl.exe','docker.exe','podman.exe','VBoxManage.exe','vmrun.exe','qemu-system-x86_64.exe','Get-VM','Get-VMSwitch')) { $r.tools[$n] = [bool](Get-Command $n -ErrorAction SilentlyContinue) }
if ($r.tools['Get-VM']) { try { $r.hypervVMs = @(Get-VM | ForEach-Object { [string]$_.State }); $r.hypervVMCount = $r.hypervVMs.Count } catch { $r.hypervVMs = 'unknown:' + $_.Exception.GetType().Name } }
$r | ConvertTo-Json -Depth 5 -Compress
`;

function runBounded(command, args, { cwd, timeoutMs = 12000, maxBytes = 32768 } = {}) {
  return new Promise(resolve => {
    const child = cp.spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, reason = null, cleanup = null, fallback;
    const stop = why => { if (!reason) {
      reason = why; cleanup = killOwnTree(child);
      fallback = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        resolve({ exitCode: null, signal: null, reason: reason + ':close-unconfirmed', stdout, stderr, cleanup });
      }, 3000);
    } };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { stop('output-limit'); return; }
        if (key === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      });
    }
    child.on('error', () => { reason = reason || 'spawn-error'; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      resolve({ exitCode, signal, reason, stdout, stderr, cleanup });
    });
  });
}

async function probe() {
  if (process.platform !== 'win32') return { schemaVersion: 1, platform: process.platform, status: 'unsupported', isolationPassed: false };
  const own = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-namespace-deps-'));
  let report;
  try {
    const inventory = await runBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', INVENTORY_PS], { cwd: own });
    let facts = null;
    if (!inventory.reason && inventory.exitCode === 0) { try { facts = JSON.parse(inventory.stdout.replace(/^\uFEFF/, '').trim()); } catch { /* retain unknown */ } }
    const wsl = {};
    if (facts && facts.tools['wsl.exe']) {
      // These enumerate registrations/status only; never invoke a distribution shell.
      for (const [name, args] of [['status', ['--status']], ['list', ['--list', '--quiet']]]) {
        const result = await runBounded('wsl.exe', args, { cwd: own });
        // Do not retain user-selected distro names or arbitrary command output.
        wsl[name] = { exitCode: result.exitCode, reason: result.reason, cleanup: result.cleanup,
          nonemptyOutput: Boolean(result.stdout.replace(/\0/g, '').trim()) };
      }
    }
    report = { schemaVersion: 1, observedAt: new Date().toISOString(), platform: process.platform,
      probeSha256: crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),
      status: facts ? 'inventory-only' : 'unknown', facts, wsl,
      inventoryCommand: { exitCode: inventory.exitCode, reason: inventory.reason, cleanup: inventory.cleanup },
      isolationPassed: false, guestStarted: false,
      blockers: ['No dedicated guest image or verified namespace configured', 'No enforced broker-only guest network configured', 'No synthetic host-secret/descendant/manual-mount or lifecycle negative tests executed'],
      unknown: ['Offline image availability and redistribution terms', 'Guest CLI/runtime availability', 'Hyper-V VM access and Hyper-V socket broker enforceability', 'Docker daemon/container isolation availability (executable discovery only)', 'WSL version and isolation (status success is not a security boundary)'] };
  } finally {
    const resolved = path.resolve(own), parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('ruyi-namespace-deps-')) throw new Error('cleanup-root-rejected');
    await fs.rm(resolved, { recursive: true, force: true });
    if (report) report.cleanup = { temporaryDirectoryAbsent: !(await fs.stat(resolved).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })),
      commandCloseConfirmed: report.inventoryCommand.reason !== 'timeout:close-unconfirmed' && report.inventoryCommand.reason !== 'output-limit:close-unconfirmed' && Object.values(report.wsl).every(r => !String(r.reason).includes('close-unconfirmed')) };
  }
  return report;
}

if (require.main === module) probe().then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')).catch(e => { console.error(e.name); process.exitCode = 1; });
module.exports = { runBounded, probe, INVENTORY_PS };
