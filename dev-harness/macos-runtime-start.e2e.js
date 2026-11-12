'use strict';
require('./lib/self-isolate-home.js');
// Real serve and HTTP routes with only the OS opener replaced. Never opens the user's applications.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS RUNTIME START');
const { ok } = t;
const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'ruyi-p1-'));
process.env.RUYI_HOME = path.join(root, 'unit-data');
const S = loadServerInternals(['platformRuntimeEnvironment', 'platformOpenSpawn', 'buildRevealSpawn',
  'desktopPythonCandidates', 'rgProbeCandidates', 'bundledNodeExe', 'DesktopShell', 'CONFIG_SCHEMA']);
const wb = path.resolve(__dirname, '..', 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let bundledChild;
let bundledHome;
let output = '';
async function until(fn) {
  const deadline = Date.now() + 20000;
  do { const value = await fn(); if (value) return value; await sleep(50); } while (Date.now() < deadline);
  throw new Error('condition timed out\n' + output.slice(-2000));
}

(async () => {
  try {
    const env = S.platformRuntimeEnvironment({ PATH: ':/custom/bin:relative:/custom/bin', KEEP: 'yes' }, 'darwin', '/runtime/bin/node');
    ok(env.PATH === '/runtime/bin:/custom/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      && env.KEEP === 'yes', 'Mac PATH uses absolute entries, fixed fallbacks and the running Node');
    ok(S.platformRuntimeEnvironment({ PATH: 'C:\\tools;;.' }, 'win32').PATH === 'C:\\tools;;.', 'Windows PATH stays byte-for-byte compatible');
    const target = '/tmp/中文 空格😀;&$(touch ignored).txt';
    const open = S.platformOpenSpawn(target, 'open', 'darwin');
    ok(open.command === '/usr/bin/open' && JSON.stringify(open.args) === JSON.stringify(['--', target]), 'Mac open passes Unicode/metacharacters as one literal argument');
    const reveal = S.buildRevealSpawn('open', '/tmp/恶意.command', 'darwin');
    ok(reveal.mode === 'select' && reveal.degraded && reveal.args[0] === '-R', 'Mac executable scripts degrade to Finder selection');
    ok(S.platformOpenSpawn('/tmp/危险.app', 'open', 'darwin').args[0] === '-R', 'Mac app bundles cannot launch through generic open');
    const win = S.buildRevealSpawn('select', 'C:\\ws\\a.txt', 'win32');
    ok(win.command === 'explorer.exe' && win.args[0] === '/select,C:\\ws\\a.txt', 'Windows Explorer selection contract is retained');
    const winBrowser = S.platformOpenSpawn('http://127.0.0.1/', 'browser', 'win32');
    ok(winBrowser.command === 'cmd.exe' && winBrowser.args.join('|') === '/c|start||http://127.0.0.1/', 'Windows startup browser argv is retained');
    ok(S.bundledNodeExe() === process.execPath, 'source-run MCP reuses its running Node executable');
    if (process.platform !== 'darwin') {
      console.log('SKIP real Mac launcher and Finder route integration require macOS');
      return;
    }
    const candidates = S.desktopPythonCandidates('/tmp/acc');
    ok(candidates.some(c => c.command === '/tmp/acc/.venv/bin/python3')
      && !candidates.some(c => /python\.exe$/.test(c.command)), 'Mac Python discovery uses POSIX runtime and venv layouts');
    ok(S.rgProbeCandidates().some(c => c.command === '/opt/homebrew/bin/rg'), 'ripgrep discovery consumes the augmented runtime PATH');

    const data = path.join(root, 'data');
    const workspace = path.join(root, '工作 区😀');
    fs.mkdirSync(data); fs.mkdirSync(workspace);
    const textFile = path.join(workspace, '中文;&.txt');
    const scriptFile = path.join(workspace, '脚本.command');
    const appBundle = path.join(workspace, '程序.app');
    fs.writeFileSync(textFile, 'fixture'); fs.writeFileSync(scriptFile, 'exit 99'); fs.mkdirSync(appBundle);
    const bundleAlias = path.join(workspace, 'bundle-alias');
    fs.symlinkSync(appBundle, bundleAlias);
    const originalSpawn = cp.spawn;
    let aliasArgs;
    try {
      cp.spawn = function(command, args, options) {
        if (command === '/usr/bin/open') {
          aliasArgs = args;
          return originalSpawn.call(this, process.execPath, ['-e', 'process.exit(0)'], options);
        }
        return originalSpawn.call(this, command, args, options);
      };
      const shown = await S.DesktopShell.revealInExplorer(bundleAlias, 'open');
      ok(shown && aliasArgs[0] === '-R' && aliasArgs.at(-1) === fs.realpathSync(appBundle), 'fixed-directory opener resolves aliases before refusing bundle execution');
    } finally { cp.spawn = originalSpawn; }
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: S.CONFIG_SCHEMA, defaultWorkspace: workspace, workspaces: [{ path: workspace }],
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [], providers: [],
    }));
    // Profiles are fixtures. A GUI startup must not execute either of them.
    const marker = path.join(root, 'profile-ran');
    for (const name of ['.profile', '.bash_profile', '.zprofile', '.zshrc']) {
      fs.writeFileSync(path.join(process.env.HOME, name), 'touch "' + marker + '"\n');
    }
    const callsFile = path.join(root, 'open.jsonl');
    const failureFile = path.join(root, 'fail-open');
    const preload = path.join(root, 'opener.cjs');
    fs.writeFileSync(preload, `const cp = require('child_process');
const fs = require('fs');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (command === '/usr/bin/open') {
    fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command, args}) + '\\n');
    if (fs.existsSync(${JSON.stringify(failureFile)}) && fs.readFileSync(${JSON.stringify(failureFile)}, 'utf8') === 'missing') {
      return original.call(this, ${JSON.stringify(path.join(root, 'missing-opener'))}, args, options);
    }
    return original.call(this, process.execPath, ['-e', 'process.exit(' + (fs.existsSync(${JSON.stringify(failureFile)}) ? '1' : '0') + ')'], options);
  }
  if (/^(cmd|explorer|powershell)\\.exe$/i.test(command)) throw new Error('Windows opener attempted on Mac');
  return original.call(this, command, args, options);
};
`);
    const port = await getFreePort();
    const launchHome = fixtureChildEnv();
    const localBin = path.join(launchHome.HOME, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(localBin, 'node'));
    child = cp.spawn(path.join(wb, 'start-macos.command'), ['--port', String(port)], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...launchHome, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data,
        RUYI_NODE_PATH: '', PATH: '/usr/bin:/bin', TMPDIR: root,
        NODE_OPTIONS: '--require=' + preload },
    });
    child.on('error', error => { output += error.stack; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).json()).ok; }
      catch { return false; }
    });
    ok(true, 'Mac launcher starts the real service from a clean PATH and unrelated cwd');
    const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    await until(() => calls().length);
    ok(calls()[0].args.join('|') === `--|http://127.0.0.1:${port}/`, '--open delegates the actual service URL to the Mac opener');
    ok(!fs.existsSync(marker), 'startup does not source user profiles');
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const token = html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/)[1];
    const openPath = await (await fetch(`http://127.0.0.1:${port}/api/open-path`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
      body: JSON.stringify({ target: 'data' }),
    })).json();
    ok(openPath.ok && calls().at(-1).args.at(-1) === fs.realpathSync(data), 'fixed data-directory menu uses the Mac file manager');
    const scriptAlias = path.join(workspace, 'script-alias');
    fs.symlinkSync(scriptFile, scriptAlias);
    for (const cwd of [scriptFile, scriptAlias]) {
      const sessionResponse = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
        body: JSON.stringify({ title: 'directory-validation', cwd }),
      })).json();
      if (!sessionResponse.session?.id) throw new Error('session fixture creation failed');
      const previousCalls = calls().length;
      const response = await fetch(`http://127.0.0.1:${port}/api/open-path`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
        body: JSON.stringify({ target: 'workspace', sessionId: sessionResponse.session.id }),
      });
      const result = await response.json();
      ok(response.status === 404 && !result.ok && calls().length === previousCalls,
        'workspace directory menu rejects script or script symlink without invoking opener: ' + path.basename(cwd));
    }
    const post = async (body, auth = true) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/file/reveal`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-wcw-token': token } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    };
    ok((await post({ path: textFile }, false)).status === 403, 'reveal retains token authentication');
    ok((await post({ path: textFile })).body.ok && calls().at(-1).args.at(-1) === fs.realpathSync(textFile), 'HTTP reveal opens a canonical in-workspace Unicode document');
    const script = await post({ path: scriptFile });
    ok(script.body.ok && script.body.degradedTo === 'select' && calls().at(-1).args[0] === '-R', 'HTTP reveal reports script selection instead of execution');
    ok((await post({ path: appBundle })).body.degradedTo === 'select', 'HTTP reveal selects an application bundle');
    const before = calls().length;
    const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
    const link = path.join(workspace, 'link.txt'); fs.symlinkSync(outside, link);
    ok((await post({ path: outside })).status === 403 && (await post({ path: link })).status === 403, 'outside paths and escaping symlinks remain denied');
    ok((await post({ path: path.join(data, 'config.json') })).status === 403 && calls().length === before, 'sensitive data stays denied without spawning an opener');
    fs.writeFileSync(failureFile, 'fail');
    ok((await post({ path: textFile })).body.ok === false, 'nonzero Mac opener exit is reported as failure');
    fs.writeFileSync(failureFile, 'missing');
    ok((await post({ path: textFile })).body.ok === false, 'missing Mac opener is reported as failure');
    ok((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok, 'opener failure leaves the service healthy');

    const bundle = path.join(root, '如意 安装😀');
    fs.mkdirSync(path.join(bundle, 'app'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime', 'node', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime', 'macos'), { recursive: true });
    fs.copyFileSync(path.join(wb, 'start-macos.command'), path.join(bundle, 'start-macos.command'));
    fs.copyFileSync(path.join(wb, 'app', 'server.js'), path.join(bundle, 'app', 'server.js'));
    fs.cpSync(path.join(wb, 'app', 'public'), path.join(bundle, 'app', 'public'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(bundle, 'runtime', 'node', 'bin', 'node'));
    fs.copyFileSync(path.join(wb, 'runtime', 'macos', 'ruyi-process-helper'), path.join(bundle, 'runtime', 'macos', 'ruyi-process-helper'));
    fs.chmodSync(path.join(bundle, 'start-macos.command'), 0o755);
    fs.chmodSync(path.join(bundle, 'runtime', 'node', 'bin', 'node'), 0o755);
    fs.chmodSync(path.join(bundle, 'runtime', 'macos', 'ruyi-process-helper'), 0o755);
    const isolated = fixtureChildEnv({ perTest: true }); bundledHome = isolated.home;
    const bundleData = path.join(root, 'bundle-data'); fs.mkdirSync(bundleData);
    fs.copyFileSync(path.join(data, 'config.json'), path.join(bundleData, 'config.json'));
    for (const name of ['.profile', '.bash_profile', '.zprofile', '.zshrc']) {
      fs.writeFileSync(path.join(bundledHome, name), 'touch "' + marker + '"\n');
    }
    fs.unlinkSync(failureFile);
    const bundlePort = await getFreePort();
    const bundlePreload = path.join(root, 'bundle-opener.cjs');
    const identityFile = path.join(root, 'bundle-node.json');
    fs.writeFileSync(bundlePreload, `require(${JSON.stringify(preload)}); require('fs').writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({execPath:process.execPath,cwd:process.cwd(),argv:process.argv}));`);
    bundledChild = cp.spawn(path.join(bundle, 'start-macos.command'), ['--port', String(bundlePort)], {
      cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...isolated.env, RUYI_HOME: path.relative(bundle, bundleData), WIN_CLAUDE_WORKBENCH_HOME: bundleData,
        RUYI_NODE_PATH: '', PATH: '/usr/bin:/bin', TMPDIR: root, NODE_OPTIONS: '--require=' + bundlePreload },
    });
    bundledChild.on('error', error => { output += error.stack; });
    for (const stream of [bundledChild.stdout, bundledChild.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${bundlePort}/health`, { signal: AbortSignal.timeout(500) })).json()).ok; }
      catch { return false; }
    });
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    ok(fs.realpathSync(identity.execPath) === fs.realpathSync(path.join(bundle, 'runtime', 'node', 'bin', 'node')),
      'relocated Unicode/space installation starts the copied bundled Node with a clean PATH');
    ok(fs.realpathSync(identity.cwd) === fs.realpathSync(bundle) && !fs.existsSync(marker),
      'relocated launcher establishes its own cwd without reading isolated profiles');
    await until(() => calls().some(call => call.args.at(-1) === `http://127.0.0.1:${bundlePort}/`));
    ok(true, 'relocated real service delegates its own URL through the intercepted opener');

    const bundleStatus = async () => (await fetch(`http://127.0.0.1:${bundlePort}/api/status`, { signal: AbortSignal.timeout(10000) })).json();
    const readyStatus = await until(async () => { const status = await bundleStatus(); return status.runtime?.capabilities?.['process.supervisor']?.ready && status; });
    ok(path.isAbsolute(readyStatus.dataRoot) && fs.realpathSync(readyStatus.dataRoot) === fs.realpathSync(bundleData),
      'relative RUYI_HOME resolves to the actual absolute data root before execution-ledger initialization');
    ok(readyStatus.runtime.capabilities['shell.exec'].ready, 'relocated service discovers the copied native helper beside bundled Node');
    const bundleHelper = path.join(bundle, 'runtime', 'macos', 'ruyi-process-helper');
    fs.unlinkSync(bundleHelper);
    const missingHelper = await bundleStatus();
    ok(!missingHelper.runtime.capabilities['process.supervisor'].ready && !missingHelper.runtime.capabilities['shell.exec'].ready,
      'missing relocated helper disables managed execution while HTTP remains available');
    fs.copyFileSync(path.join(wb, 'runtime', 'macos', 'ruyi-process-helper'), bundleHelper); fs.chmodSync(bundleHelper, 0o755);
    await until(async () => (await bundleStatus()).runtime?.capabilities?.['process.supervisor']?.ready);
    ok(true, 'restoring relocated helper recovers runtime readiness without restarting service');

    const systemNodes = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/bin/node'];
    if (!systemNodes.some(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } })) {
      const emptyInstall = path.join(root, 'missing-runtime'); fs.mkdirSync(emptyInstall);
      fs.copyFileSync(path.join(wb, 'start-macos.command'), path.join(emptyInstall, 'start-macos.command'));
      fs.chmodSync(path.join(emptyInstall, 'start-macos.command'), 0o755);
      const missing = cp.spawnSync(path.join(emptyInstall, 'start-macos.command'), [], {
        cwd: '/', encoding: 'utf8', timeout: 10000,
        env: { ...isolated.env, RUYI_NODE_PATH: '', PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=' + preload },
      });
      ok(missing.status === 1 && /未找到 Node/.test(missing.stderr), 'missing bundled, user and system Node produces an actionable startup error');
    } else console.log('SKIP automatic missing-Node case because a system fallback Node is installed');
    const invalidNode = path.join(root, 'invalid-node'); fs.writeFileSync(invalidNode, '#!/bin/sh\nexit 1\n'); fs.chmodSync(invalidNode, 0o755);
    for (const candidate of [path.join(root, 'missing-node'), invalidNode]) {
      const beforeFailure = calls().length;
      const result = cp.spawnSync(path.join(bundle, 'start-macos.command'), [], {
        cwd: '/', encoding: 'utf8', timeout: 10000,
        env: { ...isolated.env, RUYI_NODE_PATH: candidate, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=' + preload },
      });
      ok(result.status === 1 && /Node/.test(result.stderr) && calls().length === beforeFailure,
        'invalid explicit Node fails before service or opener launch: ' + path.basename(candidate));
    }

  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const owned of [child, bundledChild]) {
      if (!owned) continue;
      killOwnTree(owned);
      if (owned.exitCode === null && owned.signalCode === null) await new Promise(resolve => owned.once('close', resolve));
    }
    if (bundledHome) fs.rmSync(bundledHome, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
