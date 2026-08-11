(async () => {
'use strict';
// Native code-editor diff + turn workspace baseline. Offline and desktop-safe: the route runs with a
// test-only capture seam, so no real IDE window is opened.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), `ruyi-external-diff-${process.pid}`);
const BASE_HOME = path.join(HOME, 'baseline-home');
const BASE_WS = path.join(HOME, 'baseline-work');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(BASE_HOME, { recursive: true });
fs.mkdirSync(BASE_WS, { recursive: true });
process.env.RUYI_HOME = BASE_HOME;
const srv = require(path.join(WB, 'app', 'server.js'));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(port, method, route, payload, headers = {}) {
  return new Promise(resolve => {
    const data = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 6000,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, json, raw }); });
    });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function waitHealth(port) {
  for (let i = 0; i < 50; i++) {
    const result = await request(port, 'GET', '/health');
    if (result.status === 200) return true;
    await sleep(120);
  }
  return false;
}

try {
  // Pure safety/argv contracts: a script host is never accepted as an editor; supported IDEs receive each
  // path as a distinct argv element (no cmd.exe / shell string).
  ok(srv.executableFromAssociationCommand('"C:\\Program Files\\Editor\\Code.exe" "%1"') === 'C:\\Program Files\\Editor\\Code.exe',
    'association command extracts the executable without evaluating placeholders');
  ok(srv.classifyCodeEditorExecutable('C:\\Windows\\System32\\WScript.exe') === null,
    'WScript file association is rejected');
  const editor = srv.classifyCodeEditorExecutable('C:\\Apps\\Cursor\\Cursor.exe');
  const spawnSpec = srv.buildCodeEditorSpawn({ ...editor, source: 'unit' }, 'diff', 'C:\\before a.py', 'C:\\after & b.py');
  ok(spawnSpec.ok && spawnSpec.mode === 'diff' && spawnSpec.args[0] === '--reuse-window'
    && spawnSpec.args[2] === 'C:\\before a.py' && spawnSpec.args[3] === 'C:\\after & b.py',
  'VS Code family diff uses a shell-free argv array');
  const changesUi = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'artifact-changes.js'), 'utf8');
  const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'en-US.json'), 'utf8'));
  ok(changesUi.includes("api('/api/checkpoints/open-external'") && changesUi.includes("t('changes.openTurnExternalDiff')")
    && changesUi.includes("t('changes.openExternalDiff')"), 'change center exposes per-file and per-turn native diff actions');
  ok(zh['changes.openExternalDiff'] && en['changes.openExternalDiff'] && zh['toast.externalDiffFailed'] && en['toast.externalDiffFailed'],
    'native diff actions and outcomes are localized');

  // Non-Git baseline simulates a Claude native Edit that bypasses TOOL_DISPATCH.
  const baselineFile = path.join(BASE_WS, 'native-edit.ts');
  const baselineBefore = 'export const value = 1;\n';
  fs.writeFileSync(baselineFile, baselineBefore, 'utf8');
  const baseline = await srv.captureWorkspaceTurnBaseline(BASE_WS);
  fs.writeFileSync(baselineFile, 'export const value = 2;\n', 'utf8');
  const reconciled = await srv.reconcileWorkspaceTurnBaseline(baseline, 'session_baseline01', 4);
  const baselineIndex = JSON.parse(fs.readFileSync(path.join(BASE_HOME, 'checkpoints', 'session_baseline01', 'index.json'), 'utf8'));
  const baselineGz = fs.readFileSync(path.join(BASE_HOME, 'checkpoints', 'session_baseline01', '4-0.gz'));
  ok(reconciled.recorded === 1 && baselineIndex[0].tool === 'turn_baseline' && baselineIndex[0].op === 'modify',
    'turn baseline records native/out-of-dispatch source edits');
  ok(zlib.gunzipSync(baselineGz).toString('utf8') === baselineBefore,
    'turn baseline stores the exact pre-turn content');

  // A hard startup budget produces an explicit marker instead of delaying the model indefinitely. Advance
  // Date.now deterministically across the budget without building a huge fixture or sleeping in the harness.
  const budgetWs = path.join(HOME, 'budget-work');
  fs.mkdirSync(budgetWs, { recursive: true });
  fs.writeFileSync(path.join(budgetWs, 'large-repo-sentinel.js'), 'export {}\n', 'utf8');
  const realDateNow = Date.now;
  const oldBudget = process.env.RUYI_WORKSPACE_BASELINE_BUDGET_MS;
  let virtualNow = realDateNow();
  let budgetBaseline;
  process.env.RUYI_WORKSPACE_BASELINE_BUDGET_MS = '250';
  try {
    Date.now = () => { virtualNow += 500; return virtualNow; };
    budgetBaseline = await srv.captureWorkspaceTurnBaseline(budgetWs);
  } finally {
    Date.now = realDateNow;
    if (oldBudget === undefined) delete process.env.RUYI_WORKSPACE_BASELINE_BUDGET_MS;
    else process.env.RUYI_WORKSPACE_BASELINE_BUDGET_MS = oldBudget;
  }
  ok(budgetBaseline && budgetBaseline.kind === 'budget' && budgetBaseline.truncated
    && budgetBaseline.truncatedReason === 'time_budget', 'workspace baseline degrades explicitly when its startup budget expires');

  // Partial baselines may compare captured paths, but must not call an unseen pre-existing file a new turn
  // creation. This keeps a timeout honest even when a repository was already dirty before the turn.
  const partialWs = path.join(HOME, 'partial-work');
  fs.mkdirSync(partialWs, { recursive: true });
  const coveredFile = path.join(partialWs, 'covered.ts');
  const unseenFile = path.join(partialWs, 'unseen.ts');
  fs.writeFileSync(coveredFile, 'export const covered = 1;\n', 'utf8');
  fs.writeFileSync(unseenFile, 'export const unseen = 1;\n', 'utf8');
  const partialBaseline = await srv.captureWorkspaceTurnBaseline(partialWs);
  for (const [key, row] of partialBaseline.files) {
    if (path.resolve(row.path) === path.resolve(unseenFile)) partialBaseline.files.delete(key);
  }
  partialBaseline.truncated = true;
  partialBaseline.truncatedReason = 'time_budget';
  fs.writeFileSync(coveredFile, 'export const covered = 2;\n', 'utf8');
  fs.writeFileSync(unseenFile, 'export const unseen = 2;\n', 'utf8');
  const partialResult = await srv.reconcileWorkspaceTurnBaseline(partialBaseline, 'session_partialbaseline01', 6);
  const partialIndex = JSON.parse(fs.readFileSync(path.join(BASE_HOME, 'checkpoints', 'session_partialbaseline01', 'index.json'), 'utf8'));
  ok(partialResult.recorded === 1 && partialResult.truncated && partialIndex.length === 1
    && path.resolve(partialIndex[0].path) === path.resolve(coveredFile), 'partial baseline records only paths with an exact pre-turn snapshot');

  // Git optimization must preserve a pre-existing dirty working-tree value, not compare the turn against
  // HEAD and accidentally include the user's older edit in this turn's diff.
  const gitAvailable = cp.spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  if (gitAvailable) {
    const gitWs = path.join(HOME, 'git-work');
    fs.mkdirSync(gitWs, { recursive: true });
    const gitFile = path.join(gitWs, 'dirty.js');
    fs.writeFileSync(gitFile, 'const value = 0;\n', 'utf8');
    cp.execFileSync('git', ['init', '-q'], { cwd: gitWs, windowsHide: true });
    cp.execFileSync('git', ['add', '--', 'dirty.js'], { cwd: gitWs, windowsHide: true });
    cp.execFileSync('git', ['-c', 'user.name=Ruyi Test', '-c', 'user.email=ruyi@example.invalid', 'commit', '-qm', 'base'], { cwd: gitWs, windowsHide: true });
    fs.writeFileSync(gitFile, 'const value = 1; // user change before turn\n', 'utf8');
    const gitBaseline = await srv.captureWorkspaceTurnBaseline(gitWs);
    fs.writeFileSync(gitFile, 'const value = 2; // changed in turn\n', 'utf8');
    const gitReconciled = await srv.reconcileWorkspaceTurnBaseline(gitBaseline, 'session_gitbaseline01', 5);
    const gitBefore = zlib.gunzipSync(fs.readFileSync(path.join(BASE_HOME, 'checkpoints', 'session_gitbaseline01', '5-0.gz'))).toString('utf8');
    ok(gitBaseline && gitBaseline.kind === 'git' && gitReconciled.recorded === 1,
      'Git workspace uses the lightweight baseline path');
    ok(gitBefore === 'const value = 1; // user change before turn\n',
      'Git baseline excludes pre-existing user changes from the turn diff');
  } else {
    ok(true, 'Git baseline case skipped because Git is unavailable');
  }

  // HTTP route: materialize before/current paths and hand them to the preferred native editor. The test seam
  // captures argv instead of spawning a desktop application.
  const routeHome = path.join(HOME, 'route-home');
  const routeWs = path.join(HOME, 'route-work');
  const capturePath = path.join(HOME, 'editor-spawn.json');
  fs.mkdirSync(routeHome, { recursive: true });
  fs.mkdirSync(routeWs, { recursive: true });
  fs.writeFileSync(path.join(routeHome, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'bypass', defaultWorkspace: routeWs }, null, 2));
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: routeHome, RUYI_TEST_HOOKS: '1', RUYI_TEST_CODE_EDITOR: process.execPath,
      RUYI_TEST_EXTERNAL_EDITOR_CAPTURE: capturePath },
  });
  wb.stderr.on('data', chunk => String(chunk).split(/\r?\n/).forEach(line => line.trim() && console.log('[wb!] ' + line.trim())));
  try {
    ok(await waitHealth(port), 'workbench listening');
    const bootstrap = await request(port, 'POST', '/api/bootstrap', {});
    const token = bootstrap.json && bootstrap.json.token;
    const auth = { 'x-wcw-token': token };
    const created = await request(port, 'POST', '/api/sessions', { title: 'external diff', cwd: routeWs }, auth);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(created.status === 200 && !!sid, 'fixture session created');

    // The server deliberately hands the realpath (canonical long form) of the checkpoint path to the editor
    // (guardWorkspacePath resolves 8.3 short names / junctions). Compare canonical spellings, not raw strings.
    const samePath = (a, b) => {
      try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); }
      catch { return false; }
    };
    const source = path.join(routeWs, 'sample.py');
    const before = 'answer = 41\n';
    const after = 'answer = 42\n';
    fs.writeFileSync(source, after, 'utf8');
    const checkpointDir = path.join(routeHome, 'checkpoints', sid);
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, '2-0.gz'), zlib.gzipSync(Buffer.from(before, 'utf8')));
    fs.writeFileSync(path.join(checkpointDir, 'index.json'), JSON.stringify([
      { turnSeq: 2, entrySeq: 0, tool: 'turn_baseline', path: source, op: 'modify', bytes: Buffer.byteLength(before), ts: new Date().toISOString() },
    ], null, 2));

    const noToken = await request(port, 'POST', '/api/checkpoints/open-external', { sessionId: sid, turnSeq: 2, entrySeq: 0, action: 'diff' });
    ok(noToken.status === 403, 'external editor route requires token');
    const opened = await request(port, 'POST', '/api/checkpoints/open-external', { sessionId: sid, turnSeq: 2, entrySeq: 0, action: 'diff' }, auth);
    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    ok(opened.status === 200 && opened.json && opened.json.opened[0].mode === 'diff', 'external diff route succeeds');
    ok(captured.command === process.execPath && captured.args[0] === '--reuse-window' && captured.args[1] === '--diff'
      && samePath(captured.args[3], source), 'route hands current source path to native editor');
    ok(fs.readFileSync(captured.args[2], 'utf8') === before, 'route materializes exact before snapshot for native diff');

    const openCurrent = await request(port, 'POST', '/api/checkpoints/open-external', { sessionId: sid, turnSeq: 2, entrySeq: 0, action: 'open' }, auth);
    const capturedOpen = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    ok(openCurrent.status === 200 && capturedOpen.mode === 'open' && capturedOpen.args.length === 1 && samePath(capturedOpen.args[0], source),
      'open action uses the current code file in the preferred editor');
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(250);
  }
} catch (error) {
  fail += 1;
  console.log('ERROR ' + (error && error.stack || error));
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nEXTERNAL-CODE-DIFF E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
