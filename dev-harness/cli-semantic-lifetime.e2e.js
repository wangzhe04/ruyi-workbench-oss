'use strict';

require('./lib/self-isolate-home.js');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { createRunner } = require('./lib/harness.js');
const { releaseEnvironment } = require('./lib/release-checks.js');
const { fixedSpawnCommandLine } = require('./lib/work-data-production-upload-process.js');
const { processRows, sameProcess, processIdentity } = require('./lib/windows-lifetime-processes.cjs');
const { requestJson } = require('./lib/lifetime-loopback-json.cjs');

const assetProfile = process.env.RUYI_TEST_GEMMA2_ROOT;
const workbench = path.resolve(__dirname, '../ruyi-workbench');
const runner = createRunner('CLI SEMANTIC LIFETIME');
const actionReceipts = {
  'ctrl-c': 'ctrl-c-written',
  terminate: 'cli-terminated',
  'terminal-close': 'terminal-closed'
};

async function waitFor(read, timeout, label, failed = () => false) {
  const end = Date.now() + timeout;
  do {
    if (failed()) throw Error(label + ': process exited early');
    const value = await read();
    if (value) return value;
    await delay(50);
  } while (Date.now() < end);
  throw Error(label + ': timed out');
}

function prepareScene(dir) {
  const data = path.join(dir, 'data'), profile = path.join(dir, 'profile');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:SystemRoot|WINDIR|ComSpec|PATH|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  const env = releaseEnvironment(path.join(dir, 'home'), data, inherited);
  fs.mkdirSync(data);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    configSchema: 14, locale: 'en-US', semanticRetrievalV1: true, workDataEncryptionV1: false,
    engineMode: 'print', claudePath: process.execPath, kimiPath: process.execPath,
    stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
    importAgentInstructions: false, includeWorkbenchMcp: false, externalMcpServers: [],
    desktopMcp: { enabled: false, autodetect: false }, providers: [], defaultWorkspace: dir
  }));
  const lock = fs.readFileSync(path.join(assetProfile, 'asset-lock.json'));
  fs.writeFileSync(path.join(profile, 'asset-lock.json'), lock, { flag: 'wx' });
  Object.assign(env, {
    WCW_TEST_NO_NET_ANCHORS: '1', RUYI_SEMANTIC_BACKEND: 'gemma2', RUYI_SEMANTIC_GEMMA2_ROOT: profile,
    RUYI_SEMANTIC_GEMMA2_LOCK_SHA256: createHash('sha256').update(lock).digest('hex')
  });
  return { data, env, model: JSON.parse(lock), homeRoot: path.join(profile, 'resident-homes') };
}

function gracefulPreload(dir) {
  // Windows does not deliver external SIGTERM. Inject just that event into the
  // production process on the fixture's private pipe. The real handler exits.
  const preload = path.join(dir, 'fixture-sigterm.cjs');
  fs.writeFileSync(preload, [
    "process.stdin.once('end', () => {",
    "  if (!process.listenerCount('SIGTERM')) throw Error('production SIGTERM handler missing');",
    "  console.log('fixture-sigterm');",
    "  process.emit('SIGTERM');",
    "});",
    'process.stdin.resume();',
    "console.log('fixture-sigterm-armed');"
  ].join('\n'));
  return preload;
}

function prepareEntry(dir, packaged) {
  if (!packaged) return {
    executable: process.execPath, args: [path.join(workbench, 'app/server.js'), 'serve'],
    cwd: workbench, launchMode: 'node'
  };
  const source = path.join(workbench, 'dist/Ruyi.exe');
  const cwd = path.join(dir, 'packaged CLI');
  fs.mkdirSync(cwd);
  const executable = path.join(cwd, 'Ruyi.exe');
  fs.copyFileSync(source, executable, fs.constants.COPYFILE_EXCL);
  // The package resolves its fixed providers beside the executable.
  const sidecar = path.join(cwd, 'semantic-runtime');
  fs.mkdirSync(sidecar);
  for (const file of ['gemma2-provider.cjs', 'gemma2-profile-validation.cjs']) {
    fs.copyFileSync(path.join(workbench, 'semantic-runtime', file), path.join(sidecar, file));
  }
  return {
    executable, args: ['serve'], cwd, launchMode: 'exe',
    sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
  };
}

async function observeReady(scene, entry, pid, stopped) {
  const runtimePath = path.join(scene.data, 'runtime.json');
  const runtime = await waitFor(() => fs.existsSync(runtimePath) && JSON.parse(fs.readFileSync(runtimePath, 'utf8')),
    30000, 'production CLI runtime', stopped);
  assert.equal(runtime.pid, pid, 'runtime belongs to this CLI');
  assert.equal(runtime.host, '127.0.0.1', 'CLI listens only on loopback');
  assert.equal(runtime.launchMode, entry.launchMode, 'runtime uses the requested production entry');
  await waitFor(async () => {
    const response = await requestJson('http://127.0.0.1:' + runtime.port, runtime.token, '/api/status');
    assert.equal(response.status, 200, 'semantic status HTTP');
    assert.equal(response.value.isPkg, entry.launchMode === 'exe', 'status confirms the packaged or Node runtime');
    const { semanticRuntime } = response.value;
    assert.ok(['loading', 'ready'].includes(semanticRuntime?.state), 'semantic status: ' + JSON.stringify(semanticRuntime));
    return semanticRuntime.state === 'ready';
  }, 30000, 'real EmbeddingGemma 2 warmup', stopped);
  return runtime;
}

async function requestMaintenance(dir, url, token) {
  const initial = await requestJson(url, token, '/api/work-data/status');
  assert.equal(initial.status, 200, 'maintenance status HTTP');
  assert.equal(initial.value.capabilities?.worker, true, 'production maintenance worker available');
  assert.equal(initial.value.job, null, 'no existing maintenance job');
  const backupDirectory = path.join(dir, 'backups');
  fs.mkdirSync(backupDirectory);
  const result = await requestJson(url, token, '/api/work-data/jobs', {
    operation: 'export', password: 'synthetic SR6 packaged export password', backupDirectory,
    expectedAuthority: initial.value.authority
  });
  assert.equal(result.status, 202, 'maintenance accepted: ' + (result.value.error?.code || 'export'));
  assert.match(result.value.job?.id || '', /^[a-f0-9]{48}$/, 'accepted maintenance job');
  return { id: result.value.job.id, operation: 'export' };
}

async function runMode(root, probe, entry, mode) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir);
  const scene = prepareScene(dir);
  const maintenance = mode === 'maintenance', terminalClose = mode === 'terminal-close';
  const abnormal = mode === 'terminate' || terminalClose;
  const conpty = mode !== 'graceful';
  let args = entry.args;
  if (!conpty) {
    const preload = gracefulPreload(dir);
    args = ['--require', preload, ...args];
  }
  const commandLine = fixedSpawnCommandLine(entry.executable, args);
  const probeArgs = [entry.executable, commandLine, ...(maintenance ? ['maintenance'] : [])];
  const child = spawn(conpty ? probe : entry.executable, conpty ? probeArgs : args,
    { cwd: entry.cwd, env: scene.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let terminal, spawnError, remaining, stderr = '', stdoutEOF = false, stderrEOF = false;
  const events = readline.createInterface({ input: child.stdout });
  events.on('line', line => {
    if (Object.values(actionReceipts).includes(line)
      || /^(?:started |exited |console-released$|fixture-job-ended$|fixture-sigterm(?:-armed)?$)/.test(line)) lines.push(line);
  });
  child.stdout.once('end', () => { stdoutEOF = true; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stderr.once('end', () => { stderrEOF = true; });
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => { terminal = { code, signal }; });
  const stopped = () => {
    if (spawnError) throw spawnError;
    return Boolean(terminal);
  };
  const checkpoint = (name, value) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

  try {
    const started = conpty ? await waitFor(() => lines.map(line => /^started (\d+) (\d+)$/.exec(line)).find(Boolean),
      15000, 'ConPTY launches CLI', stopped) : null;
    const pid = conpty ? Number(started[1]) : child.pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'owned CLI pid');
    const { port, token } = await observeReady(scene, entry, pid, stopped);
    const rows = await processRows([pid], pid);
    const cli = rows.find(row => row.pid === pid);
    assert.equal(cli?.parent, conpty ? child.pid : process.pid, 'CLI belongs to this fixture');
    assert.equal(cli.image.toLowerCase(), entry.executable.toLowerCase(), 'CLI executable');
    assert.equal(cli.commandLine, commandLine, 'direct production CLI command');
    if (conpty) assert.equal(cli.nativeCreated, started[2], 'CLI creation time matches the held process handle');
    const { node, workerFile } = scene.model;
    const workerCommand = fixedSpawnCommandLine(node.file, [workerFile]).toLowerCase();
    const workers = rows.filter(row => row.parent === pid && row.image?.toLowerCase() === node.file.toLowerCase()
      && row.commandLine?.toLowerCase() === workerCommand);
    assert.equal(workers.length, 1, 'CLI has its real pinned model worker');
    const originals = [cli, workers[0]].map(processIdentity);
    assert.ok(originals.every(row => /^\d+$/.test(row.created)), 'Windows records both original creations');
    const homes = fs.readdirSync(scene.homeRoot);
    assert.equal(homes.length, 1, 'model owns one private resident home');
    checkpoint('before', { mode, port, launchMode: entry.launchMode, executableSha256: entry.sha256,
      originals, cliNativeCreated: cli.nativeCreated, state: 'ready', homeCount: 1 });

    let cliExitCode;
    if (conpty) {
      assert.ok(!stopped() && !lines.some(line => line.startsWith('exited ')), 'ConPTY is active before the exit request');
      if (maintenance) {
        child.stdin.write('wait-maintenance\n');
        checkpoint('maintenance-accepted', await requestMaintenance(dir, 'http://127.0.0.1:' + port, token));
      } else child.stdin.write(mode + '\n');
      const exited = await waitFor(() => lines.map(line => /^exited (\d+)$/.exec(line)).find(Boolean),
        maintenance ? 65000 : 35000, 'original CLI exits after ' + mode, stopped);
      assert.deepEqual(lines.slice(0, lines.indexOf(exited[0])).filter(line => Object.values(actionReceipts).includes(line)),
        maintenance ? [] : [actionReceipts[mode]], 'only the requested native exit action precedes CLI exit');
      cliExitCode = Number(exited[1]);
      if (!terminalClose) assert.equal(cliExitCode, abnormal ? 73 : 0, 'original CLI reports the requested exit code');
    } else {
      assert.ok(lines.includes('fixture-sigterm-armed'), 'fixture preloaded the graceful trigger');
      child.stdin.end();
      await waitFor(() => terminal, 30000, 'CLI exits after graceful shutdown request');
      assert.ok(lines.includes('fixture-sigterm'), 'fixture dispatched the production SIGTERM handler');
      cliExitCode = terminal.code;
    }
    const exitedOriginals = async () => {
      const rows = await processRows(originals.map(row => row.pid));
      remaining = originals.filter(identity => rows.some(row => sameProcess(row, identity)));
      return remaining.length === 0;
    };
    if (abnormal) await waitFor(exitedOriginals, 15000, 'original CLI and model exit after ' + mode, stopped);
    else assert.ok(await exitedOriginals(), 'original CLI and model both exited');
    const remainingHomes = fs.readdirSync(scene.homeRoot);
    const homeCount = remainingHomes.length;
    const originalHomeRemoved = !remainingHomes.includes(homes[0]);
    if (!abnormal) assert.ok(originalHomeRemoved, 'original model resident home is removed by the CLI');
    if (!maintenance && !abnormal) assert.equal(homeCount, 0, 'no model resident homes remain');
    const exitProof = { cliExitCode, remaining, homeCount, originalHomeRemoved };
    if (conpty) {
      assert.ok(!stopped() && !lines.includes('console-released'), 'process and home checks precede probe release');
      checkpoint(terminalClose ? 'before-controller-release' : 'before-console-release', { observations: [...lines], ...exitProof });
      child.stdin.end('release\n');
      await waitFor(() => terminal, 15000, 'pseudoconsole release');
      assert.ok(lines.includes('console-released'), 'fixture releases its console after acceptance');
      if (maintenance) assert.ok(lines.includes('fixture-job-ended'), 'fixture job settles detached maintenance processes separately');
    }
    assert.deepEqual(terminal, { code: 0, signal: null }, conpty ? 'probe exits zero' : 'CLI exits zero');
    assert.ok(stdoutEOF && stderrEOF, 'both controller streams reached EOF');
    checkpoint('after', { terminal, stdoutEOF, stderrEOF, ...exitProof, observations: lines });
    if (abnormal) {
      console.log(mode + ': CLI exit ' + cliExitCode + ', resident home ' + (originalHomeRemoved ? 'removed' : 'retained'));
      runner.ok(true, mode + ' leaves neither original CLI nor model process');
    } else {
      runner.ok(true, maintenance ? 'production maintenance normally exits the original packaged CLI and cleans up its real model'
        : conpty ? 'terminal Ctrl+C reaps the real CLI and model before closing the pseudoconsole'
        : 'production graceful handler reaps the real CLI and model after fixture SIGTERM dispatch');
    }
  } catch (error) {
    checkpoint('failure', { message: error.message, terminal, remaining, observations: lines, stderr, stdoutEOF, stderrEOF });
    child.stdin.end();
    child.unref();
    child.stdout.unref?.();
    child.stderr.unref?.();
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const packaged = args.includes('--pkg'), abnormal = args.includes('--abnormal');
  assert.equal(args.length, Number(packaged) + Number(abnormal), 'use [--pkg] [--abnormal]');
  if (!args.length && (process.platform !== 'win32' || !assetProfile)) {
    console.log('SKIP CLI SEMANTIC LIFETIME: requires Windows and RUYI_TEST_GEMMA2_ROOT');
    return;
  }
  assert.ok(process.platform === 'win32', 'CLI lifetime acceptance requires Windows');
  assert.ok(assetProfile && path.isAbsolute(assetProfile), 'RUYI_TEST_GEMMA2_ROOT is an absolute profile directory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-semantic-lifetime-'));
  console.log('CLI lifetime evidence: ' + dir);
  const probe = path.join(dir, 'cli-console-probe.exe');
  const entry = prepareEntry(dir, packaged);
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + probe, path.join(__dirname, 'fixtures/cli-console-probe.cs')],
    { windowsHide: true, timeout: 30000 });
  const modes = abnormal ? ['terminate', 'terminal-close'] : [packaged ? 'maintenance' : 'graceful', 'ctrl-c'];
  for (const mode of modes) {
    try { await runMode(dir, probe, entry, mode); }
    catch (error) { runner.fail(mode + ': ' + error.stack); }
  }
  runner.done();
}
main().catch(error => { runner.fail(error.stack); runner.done(); });
