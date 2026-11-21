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
const server = path.join(workbench, 'app/server.js');
const runner = createRunner('CLI SEMANTIC LIFETIME');

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

function gracefulArgs(dir) {
  // Windows does not deliver external SIGTERM. Inject just that event into the
  // production process on the fixture's private pipe. The real handler exits.
  const preload = path.join(dir, 'fixture-sigterm.cjs');
  fs.writeFileSync(preload, [
    "process.stdin.once('end', () => {",
    "  if (!process.listenerCount('SIGTERM')) throw Error('production SIGTERM handler missing');",
    "  console.log('fixture-sigterm');",
    "  process.emit('SIGTERM');",
    "});",
    'process.stdin.resume();'
  ].join('\n'));
  return ['--require', preload, server, 'serve'];
}

async function observeReady(scene, pid, stopped) {
  const runtimePath = path.join(scene.data, 'runtime.json');
  const runtime = await waitFor(() => fs.existsSync(runtimePath) && JSON.parse(fs.readFileSync(runtimePath, 'utf8')),
    30000, 'production CLI runtime', stopped);
  assert.equal(runtime.pid, pid, 'runtime belongs to this CLI');
  assert.equal(runtime.host, '127.0.0.1', 'CLI listens only on loopback');
  assert.equal(runtime.launchMode, 'node', 'runtime uses the direct Node entry');
  await waitFor(async () => {
    const response = await requestJson('http://127.0.0.1:' + runtime.port, runtime.token, '/api/status');
    assert.equal(response.status, 200, 'semantic status HTTP');
    const { semanticRuntime } = response.value;
    assert.ok(['loading', 'ready'].includes(semanticRuntime?.state), 'semantic status: ' + JSON.stringify(semanticRuntime));
    return semanticRuntime.state === 'ready';
  }, 30000, 'real EmbeddingGemma 2 warmup', stopped);
  return runtime.port;
}

async function runMode(root, probe, mode) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir);
  const scene = prepareScene(dir);
  const conpty = mode === 'ctrl-c';
  const args = conpty ? [process.execPath, server] : gracefulArgs(dir);
  const child = spawn(conpty ? probe : process.execPath, args,
    { cwd: workbench, env: scene.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let terminal, spawnError, stderr = '', stdoutEOF = false, stderrEOF = false;
  const events = readline.createInterface({ input: child.stdout });
  events.on('line', line => { if (/^(?:started |exited |ctrl-c-written$|console-released$|fixture-sigterm$)/.test(line)) lines.push(line); });
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
    const port = await observeReady(scene, pid, stopped);
    const rows = await processRows([pid], pid);
    const cli = rows.find(row => row.pid === pid);
    assert.equal(cli?.parent, conpty ? child.pid : process.pid, 'CLI belongs to this fixture');
    assert.equal(cli.image.toLowerCase(), process.execPath.toLowerCase(), 'CLI executable');
    assert.equal(cli.commandLine, conpty ? '"' + process.execPath + '" "' + server + '" serve'
      : fixedSpawnCommandLine(process.execPath, args), 'direct production CLI command');
    if (conpty) assert.equal(cli.nativeCreated, started[2], 'CLI creation time matches the held process handle');
    const { node, workerFile } = scene.model;
    const workerCommand = fixedSpawnCommandLine(node.file, [workerFile]).toLowerCase();
    const workers = rows.filter(row => row.parent === pid && row.image?.toLowerCase() === node.file.toLowerCase()
      && row.commandLine?.toLowerCase() === workerCommand);
    assert.equal(workers.length, 1, 'CLI has its real pinned model worker');
    const originals = [cli, workers[0]].map(processIdentity);
    assert.ok(originals.every(row => /^\d+$/.test(row.created)), 'Windows records both original creations');
    assert.equal(fs.readdirSync(scene.homeRoot).length, 1, 'model owns one private resident home');
    checkpoint('before', { mode, port, originals, cliNativeCreated: cli.nativeCreated, state: 'ready', homeCount: 1 });

    if (conpty) {
      assert.ok(!stopped() && !lines.some(line => line.startsWith('exited ')), 'ConPTY is active before Ctrl+C');
      child.stdin.write('ctrl-c\n');
      const exited = await waitFor(() => lines.find(line => line.startsWith('exited ')), 35000, 'CLI exits in active ConPTY', stopped);
      assert.ok(lines.includes('ctrl-c-written'), 'the console received Ctrl+C before exit');
      assert.equal(exited, 'exited 0', 'CLI exits zero in response to terminal Ctrl+C');
    } else {
      child.stdin.end();
      await waitFor(() => terminal, 30000, 'CLI exits after graceful shutdown request');
      assert.ok(lines.includes('fixture-sigterm'), 'fixture dispatched the production SIGTERM handler');
    }
    const remaining = await processRows(originals.map(row => row.pid));
    assert.ok(!originals.some(identity => remaining.some(row => sameProcess(row, identity))), 'original CLI and model both exited');
    const homeCount = fs.readdirSync(scene.homeRoot).length;
    assert.equal(homeCount, 0, 'model resident home is removed by the CLI');
    if (conpty) {
      assert.ok(!stopped() && !lines.includes('console-released'), 'process and home checks precede console release');
      checkpoint('before-console-release', { observations: [...lines], remaining: [], homeCount });
      child.stdin.end('release\n');
      await waitFor(() => terminal, 15000, 'pseudoconsole release');
      assert.ok(lines.includes('console-released'), 'fixture releases its console after acceptance');
    }
    assert.deepEqual(terminal, { code: 0, signal: null }, 'natural zero exit');
    assert.ok(stdoutEOF && stderrEOF, 'both controller streams reached EOF');
    checkpoint('after', { terminal, stdoutEOF, stderrEOF, remaining: [], homeCount, observations: lines });
    runner.ok(true, conpty ? 'terminal Ctrl+C reaps the real CLI and model before closing the pseudoconsole'
      : 'production graceful handler reaps the real CLI and model after fixture SIGTERM dispatch');
  } catch (error) {
    checkpoint('failure', { message: error.message, terminal, observations: lines, stderr, stdoutEOF, stderrEOF });
    child.stdin.end();
    child.unref();
    child.stdout.unref?.();
    child.stderr.unref?.();
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32' || !assetProfile) {
    console.log('SKIP CLI SEMANTIC LIFETIME: requires Windows and RUYI_TEST_GEMMA2_ROOT');
    return;
  }
  assert.ok(path.isAbsolute(assetProfile), 'RUYI_TEST_GEMMA2_ROOT is an absolute profile directory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-semantic-lifetime-'));
  console.log('CLI lifetime evidence: ' + dir);
  const probe = path.join(dir, 'cli-console-probe.exe');
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + probe, path.join(__dirname, 'fixtures/cli-console-probe.cs')],
    { windowsHide: true, timeout: 30000 });
  for (const mode of ['graceful', 'ctrl-c']) {
    try { await runMode(dir, probe, mode); }
    catch (error) { runner.fail(mode + ': ' + error.stack); }
  }
  runner.done();
}
main().catch(error => { runner.fail(error.stack); runner.done(); });
