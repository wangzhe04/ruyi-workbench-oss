'use strict';

const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { getFreePort } = require('../free-port');
const { processRows, processIdentity, sameProcess } = require('./windows-lifetime-processes.cjs');
const { fixedSpawnCommandLine } = require('./work-data-production-upload-process');

function events(dir) {
  return fs.readFileSync(path.join(dir, 'startup-events.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

async function closedDescriptor() {
  const pipe = 'ruyi-desktop-' + randomBytes(32).toString('hex');
  const name = '\\\\.\\pipe\\' + pipe;
  const owner = net.createServer();
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.listen(name, resolve);
  });
  assert.equal(owner.address(), name);
  await new Promise((resolve, reject) => owner.close(error => error ? reject(error) : resolve()));
  return { schema: 1, pipe, cap: randomBytes(32).toString('hex'), role: 'serve' };
}

async function listeningPorts(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance -Namespace root/StandardCimv2 " +
    '-ClassName MSFT_NetTCPConnection -Filter "State=2 AND OwningProcess=' + pid +
    '" | ForEach-Object { [int]$_.LocalPort }); ConvertTo-Json -Compress -InputObject $rows';
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  return JSON.parse(stdout);
}

async function checkFailure({ dir, entry, prepareScene, waitFor, runner }, mode, descriptor) {
  const caseDir = path.join(dir, mode);
  fs.mkdirSync(caseDir);
  const scene = prepareScene(caseDir);
  scene.env.RUYI_DESKTOP_CONTROL_V1 = mode === 'empty' ? '' : JSON.stringify(descriptor);
  const child = spawn(entry.executable, entry.args, {
    cwd: entry.cwd, env: scene.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  let terminal, diagnostic, original, spawnError;
  const consoles = [];
  const receipt = { mode, pid: child.pid };
  const retained = mode === 'closed-channel';
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => { terminal = { code, signal }; });
  try {
    diagnostic = retained ? /^work_data_setup\.native_helper_uncertain\r?$/m : /^Error: desktop_lifetime\.bootstrap_invalid\r?$/m;
    await waitFor(() => {
      if (spawnError) throw spawnError;
      if (diagnostic.test(stderr)) return true;
      if (terminal) throw Error(mode + ': missing startup diagnostic, exit ' + JSON.stringify(terminal));
      return false;
    }, 15000, mode + ' diagnostic');
    receipt.diagnostic = stderr.match(diagnostic)[0].trim();
    if (retained) {
      const rows = await processRows([child.pid], child.pid);
      original = rows.find(row => row.pid === child.pid);
      assert.equal(original?.parent, process.pid);
      assert.equal(original.image.toLowerCase(), entry.executable.toLowerCase());
      assert.equal(original.commandLine, fixedSpawnCommandLine(entry.executable, entry.args));
      receipt.owner = processIdentity(original);
      receipt.children = rows.filter(row => row.parent === child.pid).map(processIdentity);
      // Windows can create a console host for a hidden CLI. Track its original identity through exit.
      // Node's passive child observer independently detects any child requested by the application.
      const conhost = path.join(process.env.SystemRoot, 'System32/conhost.exe').toLowerCase();
      for (const row of receipt.children) {
        assert.equal(row.image?.toLowerCase(), conhost, 'only the system console host may accompany this CLI');
        assert.ok(BigInt(row.created) >= BigInt(original.created), 'console host belongs to this CLI creation');
        consoles.push(row);
      }
      assert.ok(consoles.length <= 1);
      receipt.listeningPorts = await listeningPorts(child.pid);
      assert.deepEqual(receipt.listeningPorts, []);
      assert.equal(terminal, undefined, 'the uncertain owner remains alive until fixture cleanup');
    } else {
      receipt.naturalExit = await waitFor(() => terminal, 10000, mode + ' natural exit');
      assert.deepEqual(receipt.naturalExit, { code: 1, signal: null });
    }
    const trace = events(caseDir);
    assert.deepEqual(trace, [{ pid: child.pid, kind: 'started', declaration: mode === 'empty' ? 'empty' : 'present' }],
      mode + ': no listen attempt or spawned child, including the model worker');
    receipt.runtimePublished = fs.existsSync(path.join(scene.data, 'runtime.json'));
    receipt.modelHomes = fs.existsSync(scene.homeRoot) ? fs.readdirSync(scene.homeRoot) : [];
    assert.equal(receipt.runtimePublished, false);
    assert.deepEqual(receipt.modelHomes, []);
  } finally {
    // Windows ChildProcess owns the handle to this exact CLI, including on a failed assertion.
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    if (child.pid) receipt.finalExit = await waitFor(() => terminal, 10000, mode + ' cleanup');
    if (original) {
      const originals = [original, ...consoles];
      await waitFor(async () => {
        const rows = await processRows(originals.map(row => row.pid));
        receipt.remaining = originals.filter(identity => rows.some(row => sameProcess(row, identity))).map(processIdentity);
        return receipt.remaining.length === 0;
      }, 10000, 'retained CLI and its attached console exit');
    }
    fs.writeFileSync(path.join(caseDir, 'startup-result.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  if (retained) {
    assert.deepEqual(receipt.finalExit, { code: null, signal: 'SIGTERM' });
    assert.deepEqual(receipt.remaining, [], 'fixture released its own retained CLI and console');
  }
  runner.ok(true, mode + (retained ? ' holds the unserved owner until fixture cleanup' : ' exits before service or model startup'));
}

async function checkHostBootstrap(input) {
  const { dir, prepareScene, runMode, waitFor, runner } = input;
  async function directEntry() {
    const observer = path.resolve(__dirname, '../fixtures/cli-host-bootstrap-observer.cjs');
    return { ...input.entry, args: ['--require', observer, ...input.entry.args, '--port', String(await getFreePort())] };
  }
  // Exercise a real service, model and graceful shutdown; ensure both passive observers actually saw them.
  await runMode(dir, null, await directEntry(), 'graceful');
  const controlDir = path.join(dir, 'graceful');
  const before = JSON.parse(fs.readFileSync(path.join(controlDir, 'before.json'), 'utf8'));
  const [cli, worker] = before.originals;
  const trace = events(controlDir);
  assert.deepEqual(trace[0], { pid: cli.pid, kind: 'started', declaration: 'unset' });
  assert.ok(trace.some(row => row.pid === cli.pid && row.kind === 'listen-attempt'));
  assert.ok(trace.some(row => row.pid === cli.pid && row.kind === 'listening' && row.host === '127.0.0.1' && row.port === before.port));
  assert.ok(trace.some(row => row.pid === cli.pid && row.kind === 'child' && row.child === worker.pid));
  runner.ok(true, 'unset descriptor publishes the direct CLI and starts its verified Gemma worker');
  const closed = await closedDescriptor();
  for (const mode of ['unsupported-schema', 'empty', 'closed-channel']) {
    const descriptor = mode === 'unsupported-schema' ? { ...closed, schema: 0 } : closed;
    await checkFailure({ dir, entry: await directEntry(), prepareScene, waitFor, runner }, mode, descriptor);
  }
}

module.exports = { checkHostBootstrap };
