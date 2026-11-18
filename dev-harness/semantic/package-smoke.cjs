'use strict';
// Manual opt-in real Windows EXE + bundled Node semantic smoke; synthetic data only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const { releaseEnvironment } = require('../lib/release-checks');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('../lib/kill-own-tree');
const { getFreePort } = require('../free-port');
const { createRunner } = require('../lib/harness');
const { setTimeout: pause } = require('node:timers/promises');
const sha = async file => { const hash = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) hash.update(data); return hash.digest('hex'); };
function disjoint(a, b) { const rel = path.relative(a, b); return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel); }
async function until(work, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await pause(120); }
  throw Error(label + ': deadline exceeded');
}
async function within(promise, timeout, label) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function table() { const value = snapshotProcessTable(); assert.ok(value, 'Windows process snapshot unavailable'); return value; }
function alive(actor, rows = table()) { return rows.some(row => row.pid === actor.pid && row.created === actor.created); }
const fixtures = [
  { id: 'heat', text: '设备发生高温报警时应切断电源，等待机壳完全冷却后检查散热风扇。', query: '机器过热后要怎么处理？' },
  { id: 'travel', text: 'Employees submit travel receipts to finance before Friday; reimbursement arrives next month.', query: '出差垫付的钱怎样报销？' },
  { id: 'password', text: '忘记口令时使用已绑定邮箱的验证码重设登录密码。', query: 'I cannot remember the credential for signing in.' },
  { id: 'distractor', text: 'The observatory measures the brightness of distant stars every clear evening.' },
];
async function run(stage, output, { faults = false } = {}) {
  assert.equal(process.platform, 'win32', 'Real Windows package required');
  assert.ok(path.isAbsolute(stage) && path.isAbsolute(output)); stage = path.resolve(stage); output = path.resolve(output);
  assert.ok(disjoint(stage, output) && disjoint(output, stage), 'Stage and output must be disjoint');
  assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Use a new or empty output directory');
  assert.ok(!fs.lstatSync(stage).isSymbolicLink()); fs.mkdirSync(output, { recursive: true });
  const exe = path.join(stage, 'Ruyi.exe'), node = path.join(stage, 'runtime/node/node.exe'), runtimeRoot = path.join(stage, 'semantic-runtime');
  for (const file of [exe, node, path.join(runtimeRoot, 'worker.cjs'), path.join(runtimeRoot, 'verify.cjs')]) assert.ok(fs.statSync(file).isFile(), 'Missing package member');
  const lock = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'models.lock.json'), 'utf8'));
  const model = lock.models.find(item => item.id === lock.defaultModel); assert.ok(model?.files?.length);
  const protectedFiles = [exe, node, path.join(stage, 'app/server.js'), path.join(runtimeRoot, 'worker.cjs'), path.join(runtimeRoot, 'models.lock.json'), ...model.files.map(file => path.join(runtimeRoot, 'models', model.id, file.path))];
  const before = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [path.relative(stage, file).replaceAll('\\', '/'), await sha(file)])));
  const runner = createRunner('SEMANTIC PACKAGE SMOKE');
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), stage, status: 'RUNNING', hashes: before, checks: [], scenarios: [],
    bounds: ['Real packaged EXE, bundled Node and authenticated HTTP; no Desktop GUI or installer/upgrade claim.', 'Only synthetic isolated plaintext data; not the encrypted migration qualification.', 'Runtime model loading is network-disabled and invalid proxy/offline environment is supplied; no OS firewall or OS air-gap assertion.', 'Server termination uses test-owned process-tree cleanup; model-disable worker exit is separately observed.', 'Embedded-source binding additionally relies on the packager build receipt; matching staged server.js alone does not prove embedded provenance.'] };
  const save = () => fs.writeFileSync(path.join(output, 'semantic-package-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const check = (condition, label) => { runner.ok(condition, label); report.checks.push({ label, passed: !!condition }); save(); assert.ok(condition, label); };
  const children = [];
  const cleanEnv = (home, data, extra = {}) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|SystemDrive|WINDIR|Path|PATHEXT|ComSpec|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
    return { ...releaseEnvironment(home, data, inherited), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', ...extra };
  };
  const held = (command, args, env, label) => {
    const child = cp.spawn(command, args, { cwd: stage, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const row = { child, exited: false, closed: null, error: null, label };
    row.closed = new Promise(resolve => child.once('close', (code, signal) => { row.exited = true; row.close = { code, signal }; resolve(row.close); }));
    child.on('error', error => { row.error = error; });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => fs.appendFileSync(path.join(output, label + '-' + stream + '.log'), bytes));
    children.push(row); return row;
  };
  async function stop(row) {
    if (!row.exited) { row.cleanup = await killOwnTree(row.child); await within(row.closed, 15000, 'Owned process did not close'); }
  }
  async function launch(label, data, rootOverride) {
    const dir = path.join(output, label); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(data, { recursive: true });
    const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
    const env = cleanEnv(path.join(dir, 'home'), data, rootOverride ? { RUYI_SEMANTIC_RUNTIME_ROOT: rootOverride } : {});
    if (!fs.existsSync(path.join(data, 'config.json'))) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: 14, privacyModeV1: 'off', credentialEncryptionV1: false, workDataEncryptionV1: false,
      semanticRetrievalV1: true, sessionSearchIndexV1: true, permissionMode: 'bypass', defaultWorkspace: workspace,
      workspaces: [{ path: workspace, read: true, write: true, execute: false }], providers: [], activeProvider: '',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, autoImportKimiCodeMcp: false, enableMcpDropIn: false,
      schedulerEnabledV1: false, stewardEnabledV1: false, importAgentInstructions: false, desktopMcp: { enabled: false, autodetect: false },
    }));
    const port = await getFreePort(), actor = held(exe, ['serve', '--port', String(port)], env, label);
    let token;
    const request = async (route, body, authenticated = true) => {
      const response = await fetch('http://127.0.0.1:' + port + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(authenticated && token ? { 'x-wcw-token': token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
      const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
      return { status: response.status, json };
    };
    const runtime = await until(async () => {
      if (actor.error) throw actor.error; if (actor.exited) throw Error('EXE exited before health');
      let info; try { info = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
      if (info.pid !== actor.child.pid || info.port !== port || !info.token || !info.overlayId) return false;
      try { const health = await request('/health'); return health.status === 200 && health.json?.overlayId === info.overlayId && info; } catch (error) { if (error.cause?.code === 'ECONNREFUSED' || ['TimeoutError', 'AbortError'].includes(error.name)) return false; throw error; }
    }, 'EXE health', 90000); token = runtime.token;
    const scenario = { label, pid: actor.child.pid, port, overlayId: runtime.overlayId, states: [] }; report.scenarios.push(scenario); save();
    const status = await request('/api/status');
    check(status.status === 200 && path.resolve(status.json.dataRoot) === data && path.resolve(status.json.exePath).toLowerCase() === exe.toLowerCase(), label + ': actual EXE owns isolated data and status');
    const denied = await request('/api/sessions/search?q=reimbursement', undefined, false); check(denied.status === 403, label + ': unauthenticated search is refused');
    const bootstrap = await request('/api/bootstrap', {}); check(bootstrap.status === 200 && bootstrap.json?.token === token, label + ': bootstrap matches exact owned runtime token');
    const search = async query => { const response = await request('/api/sessions/search?q=' + encodeURIComponent(query) + '&limit=5'); assert.equal(response.status, 200); assert.equal(response.json?.ok, true); scenario.states.push(response.json.semantic?.status || 'missing'); save(); return response.json; };
    return { actor, request, search, scenario, workspace };
  }
  async function seed(app) {
    const result = new Map();
    for (const fixture of fixtures) { const created = await app.request('/api/sessions', { title: 'Fixture ' + fixture.id, cwd: app.workspace,
      messages: [{ role: 'user', id: 'message-1', content: fixture.text }], providerHistory: [] });
      assert.equal(created.status, 200); assert.ok(created.json?.session?.id);
      const committed = await app.request('/api/sessions/' + created.json.session.id);
      assert.equal(committed.status, 200); assert.ok(committed.json.session.messages.some(row => row.role === 'user' && row.content === fixture.text), 'Synthetic body must be committed, not merely a created title');
      result.set(fixture.id, created.json.session.id); }
    check(true, app.scenario.label + ': all synthetic message bodies are re-read through authenticated HTTP after seeding');
    return result;
  }
  async function semanticChecks(app, ids, label) {
    const results = [];
    for (const fixture of fixtures.filter(row => row.query)) {
      const result = await until(async () => { const found = await app.search(fixture.query); return found.semantic?.status === 'ready' && found.semantic.coverage === 'complete' && found; }, label + ' semantic readiness');
      const hit = result.results.find(row => row.reference?.sessionId === ids.get(fixture.id));
      check(!!hit && typeof hit.semanticScore === 'number' && hit.reference.matchKind === 'semantic', label + ': semantic target ' + fixture.id + ' is found');
      const history = await app.request('/api/sessions/' + ids.get(fixture.id)); assert.equal(history.status, 200);
      const message = history.json.session.messages.find(row => row.id === hit.reference.messageId) || history.json.session.messages[0];
      check(message?.content?.slice(hit.reference.snippetStart, hit.reference.snippetEnd) === hit.snippet && /^[a-f0-9]{64}$/.test(hit.reference.contentRevision || ''), label + ': target ' + fixture.id + ' carries a verified original excerpt');
      results.push({ id: fixture.id, semanticScore: hit.semanticScore, reference: hit.reference, snippet: hit.snippet });
    }
    app.scenario.results = results; save();
    const workers = ownDescendants(table(), app.actor.child.pid).descendants.filter(row => row.name?.toLowerCase() === 'node.exe');
    check(workers.length === 1, label + ': exactly one bundled Node worker is observed'); app.scenario.worker = { pid: workers[0].pid, created: String(workers[0].created) };
    return workers[0];
  }
  try {
    const verify = held(node, [path.join(runtimeRoot, 'verify.cjs'), runtimeRoot], cleanEnv(path.join(output, 'verify-home'), path.join(output, 'verify-data')), 'bundled-node-verify');
    const verifyExit = await within(verify.closed, 30000, 'Bundled Node verify timeout');
    check(verifyExit.code === 0, 'bundled Node verifies actual package model and full dependency inventory');
    const data = path.join(output, 'primary-data'), app = await launch('primary', data), ids = await seed(app);
    const worker = await semanticChecks(app, ids, 'primary');
    app.scenario.loadingObserved = app.scenario.states.includes('loading');
    check(app.scenario.states.includes('ready'), app.scenario.loadingObserved ? 'first actual search exposes cold loading before warm readiness' : 'cold search reached ready before a loading state was observed');
    const changed = await app.request('/api/config', { semanticRetrievalV1: false }); assert.equal(changed.status, 200);
    const disabled = await app.search('reimbursement'); check(disabled.semantic?.status === 'disabled' && disabled.results.some(row => row.id === ids.get('travel')), 'model disable retains lexical search');
    await until(() => !alive(worker), 'disabled worker exit', 15000); check(true, 'model disable reaps the exact observed worker');
    const enabled = await app.request('/api/config', { semanticRetrievalV1: true }); assert.equal(enabled.status, 200);
    const replacement = await semanticChecks(app, ids, 'reenabled'); check(replacement.pid !== worker.pid || replacement.created !== worker.created, 're-enable creates a distinct owned worker');
    await stop(app.actor); check(!alive(replacement), 'test-owned server cleanup leaves no observed worker');
    const restarted = await launch('restarted', data); const restartedWorker = await semanticChecks(restarted, ids, 'restarted'); await stop(restarted.actor);
    check(!alive(restartedWorker), 'fresh EXE restart searches preserved sources and releases its observed worker');
    if (faults) {
      const faultRoot = path.join(output, 'fault-runtime'); fs.cpSync(runtimeRoot, faultRoot, { recursive: true });
      for (const fault of ['missing', 'corrupt']) {
        const target = path.join(faultRoot, 'models', model.id, fault === 'missing' ? 'onnx/model_quantized.onnx' : 'config.json');
        if (fault === 'missing') fs.renameSync(target, target + '.retained');
        else { const handle = fs.openSync(target, 'r+'); fs.writeSync(handle, Buffer.from('!'), 0, 1, 0); fs.closeSync(handle); }
        const broken = await launch(fault, path.join(output, fault + '-data'), faultRoot), faultIds = await seed(broken);
        const fallback = await until(async () => { const result = await broken.search('reimbursement'); return result.semantic?.status === 'unavailable' && result; }, fault + ' unavailable fallback');
        check(fallback.results.some(row => row.id === faultIds.get('travel')), fault + ': damaged local asset preserves authenticated lexical search');
        await stop(broken.actor);
        if (fault === 'missing') fs.renameSync(target + '.retained', target); else fs.copyFileSync(path.join(runtimeRoot, 'models', model.id, 'config.json'), target);
      }
    }
    const after = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [path.relative(stage, file).replaceAll('\\', '/'), await sha(file)])));
    check(JSON.stringify(before) === JSON.stringify(after), 'original stage binaries, code, locks and model assets remain unchanged');
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error.message); runner.fail(report.error); }
  finally {
    report.cleanup = [];
    for (const actor of children.slice().reverse()) { try { await stop(actor); report.cleanup.push({ label: actor.label, ...actor.close, cleanup: actor.cleanup }); } catch (error) { report.status = 'FAIL'; report.cleanup.push({ label: actor.label, error: error.message }); runner.fail('owned cleanup failed'); } }
    report.finishedAt = new Date().toISOString(); save(); runner.done();
  }
  return report;
}
if (require.main === module) {
  const args = process.argv.slice(2), value = flag => args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
  const stage = value('--stage'), output = value('--output');
  if (!stage || !output) { console.error('Usage: node package-smoke.cjs --stage <absolute-fresh-stage> --output <absolute-new-output> [--faults]'); process.exitCode = 1; }
  else run(stage, output, { faults: args.includes('--faults') }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
module.exports = { run };
