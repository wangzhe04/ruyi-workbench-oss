'use strict';
// Manual, opt-in Windows package qualification; never a default E2E asset dependency.
// node .../offline-package-qualification.cjs --stage <absolute-dir> --zip <absolute.zip>
//   --output <new-or-empty-dir> --expected-server-sha <64 hex> [--python <absolute.exe>] [--full-media]
// Desktop files are inventoried only. No GUI launch, real account, installation,
// upgrade/rollback or all-descendant kernel-exit certification is performed.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
const crypto = require('node:crypto'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { createRunner } = require('./harness');
const { releaseEnvironment } = require('./release-checks');
const { startFakeProvider, textFrames, toolCallFrames } = require('./fake-openai-provider');
const { killOwnTree } = require('./kill-own-tree');
const { getFreePort } = require('../free-port');
const { observeHeldChild, knownClosed, knownCleanup, retainProviderStartup } = require('./external-bots-c2/actual-http-fixture.cjs');
const { assertSameDirectory } = require('./external-bots-c2/sealed-observer.cjs');
const { ownersClosed, retainUnknownOwners } = require('./offline-package-retention.cjs');
const BUDGET = Object.freeze({ archive: 600000, startup: 120000, productionChild: 90000, request: 90000, mediaPrepare: 180000, cleanup: 45000 });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fileHash(file) {
  const h = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) h.update(bytes); return h.digest('hex');
}
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]; assert.ok(['--stage', '--zip', '--output', '--expected-server-sha', '--python', '--full-media'].includes(name), 'unknown qualification argument');
    assert.ok(!Object.hasOwn(values, name), 'duplicate qualification argument');
    if (name === '--full-media') values[name] = true;
    else { assert.ok(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'argument value required'); values[name] = argv[++i]; }
  }
  for (const key of ['--stage', '--zip', '--output']) assert.ok(typeof values[key] === 'string' && path.isAbsolute(values[key]), key + ' must be absolute');
  assert.match(values['--expected-server-sha'] || '', /^[a-f0-9]{64}$/i);
  if (values['--python']) assert.ok(path.isAbsolute(values['--python']), '--python must be one absolute executable path, not a shell command');
  return { stage: path.resolve(values['--stage']), zip: path.resolve(values['--zip']), output: path.resolve(values['--output']),
    expectedServerSha: values['--expected-server-sha'].toLowerCase(), python: values['--python'] || 'py.exe', pythonArgs: values['--python'] ? [] : ['-3'], fullMedia: values['--full-media'] === true };
}
function safeRelative(name) {
  assert.ok(typeof name === 'string' && name && !name.includes('\\') && !name.startsWith('/'), 'unsafe archive/stage path');
  const parts = name.split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/[<>:"|?*\x00-\x1f]/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'unsafe Windows archive/stage path');
  return name;
}
async function census(root) {
  const files = [], directories = [], seen = new Set();
  const walk = async (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = safeRelative(prefix ? prefix + '/' + entry.name : entry.name), key = relative.toLowerCase();
      assert.ok(!seen.has(key), 'case-colliding stage paths'); seen.add(key);
      const file = path.join(dir, entry.name), st = fs.lstatSync(file);
      assert.ok(!st.isSymbolicLink(), 'stage links refused');
      if (st.isDirectory()) { directories.push(relative); await walk(file, relative); }
      else { assert.ok(st.isFile() && st.nlink === 1, 'stage must contain single-link regular files'); files.push({ path: relative, bytes: st.size, sha256: await fileHash(file) }); }
    }
  };
  await walk(root, '');
  return { files, directories, sha256: sha(JSON.stringify({ files, directories })) };
}
function validateZipReport(result, stage) {
  assert.equal(result.status, 'PASS'); assert.equal(result.crcReadToEof, true);
  assert.equal(result.files, stage.files.length); assert.equal(result.directories, stage.directories.length);
  assert.equal(result.bytes, stage.files.reduce((sum, row) => sum + row.bytes, 0));
  const seen = new Set(), directories = new Set(stage.directories.map(name => name.toLowerCase()));
  for (const row of result.rows) {
    const name = safeRelative(row.path), key = name.toLowerCase();
    assert.ok(!seen.has(key), 'duplicate ZIP report entry'); seen.add(key);
    assert.ok(['file', 'directory'].includes(row.kind), 'unknown ZIP entry kind');
    if (row.kind === 'directory') assert.ok(directories.has(key), 'unexpected ZIP directory');
  }
  const rows = result.rows.filter(row => row.kind === 'file').sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const expected = [...stage.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  assert.deepEqual(rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), expected, 'ZIP complete readback differs from original stage census');
  assert.equal(result.entries, result.rows.length);
}
function childEnv(home, data, nonce) {
  // Do not inherit provider credentials, profile paths or media/source overrides.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|SystemDrive|WINDIR|Path|PATHEXT|ComSpec|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  return { ...releaseEnvironment(home, data, inherited), RUYI_TEST_HOOKS: '0', NODE_OPTIONS: '', RUYI_PACKAGE_QUALIFICATION_NONCE: nonce };
}
async function within(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ': caller deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function plainSession(session) {
  // Mirror the real HTTP/child JSON boundary, including absent optional keys.
  return JSON.parse(JSON.stringify({ id: session.id, title: session.title, turnSeq: session.turnSeq,
    messages: session.messages, providerHistory: session.providerHistory, storageVersion: session.storageVersion }));
}
function successfulTurn(bytes) {
  const events = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const result = events.findLast(row => row.type === 'result');
  assert.ok(result?.ok === true && !result.aborted && !result.error && !events.some(row => row.type === 'error'), 'real packaged model/tool turn failed');
  return events;
}
function bitmap() {
  const width = 320, height = 192, bytes = Buffer.alloc(54 + width * height * 3);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  for (let i = 54; i < bytes.length; i += 3) { bytes[i] = 208; bytes[i + 1] = 128; bytes[i + 2] = 96; }
  return bytes;
}

async function qualify(options, runner = createRunner('OFFLINE PACKAGE QUALIFICATION')) {
  assert.equal(process.platform, 'win32', 'Windows real EXE and DPAPI qualification required');
  const { stage, zip, output, expectedServerSha } = options;
  const stageStat = fs.lstatSync(stage); assert.ok(stageStat.isDirectory() && !stageStat.isSymbolicLink());
  assertSameDirectory(stage, fs.realpathSync.native(stage));
  assert.ok(fs.statSync(zip).isFile());
  assert.ok(path.relative(stage, output).startsWith('..' + path.sep) || path.isAbsolute(path.relative(stage, output)), 'output cannot be inside the package stage');
  assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'output must be new or empty; old qualification evidence is never overwritten');
  if (fs.existsSync(output)) assert.ok(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink(), 'output must be an original directory');
  fs.mkdirSync(output, { recursive: true });
  const physicalStage = fs.realpathSync.native(stage), physicalOutput = fs.realpathSync.native(output);
  for (const [parent, child] of [[physicalStage, physicalOutput], [physicalOutput, physicalStage]]) {
    const relative = path.relative(parent, child);
    assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'stage/output physical trees must be disjoint');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(output, 'qualification-owner.json'), JSON.stringify({ nonce, stage }), { flag: 'wx' });
  const report = { schema: 1, status: 'RUNNING', startedAt: new Date().toISOString(), driverNode: process.version,
    stage, zip, expectedServerSha, fullMediaRequested: options.fullMedia, budgetsMs: BUDGET, checks: [], actors: [], scenarios: [],
    bounds: ['manual opt-in qualification, not a default test asset requirement', 'no GUI/Desktop interaction, installation or upgrade acceptance',
      'local synthetic provider only; no real account/platform', 'stage server pin is checked; embedded-source provenance additionally relies on the official build receipt', 'no all-descendant kernel-exit certification'] };
  const save = () => fs.writeFileSync(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
  const record = (type, value) => { report.checks.push({ type, ...value }); save(); };
  const check = (condition, label) => { assert.ok(condition, label); runner.ok(true, label); record(label, { status: 'PASS' }); };
  const actors = [];
  let phase = 'stage', primary, providerOwner, fake, scenario;
  const cleanupErrors = [];
  function held(command, argv, env, label, capture = true) {
    const child = cp.spawn(command, argv, { cwd: stage, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const row = observeHeldChild(child, label, { stdio: ['ignore', 'pipe', 'pipe'] }); row.stdout = []; row.outputBytes = 0; row.logErrors = [];
    child.on('error', error => { row.originalStartError = error; });
    for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
      try { fs.appendFileSync(path.join(output, label + '-' + name + '.log'), bytes); } catch (error) { row.logErrors.push(error.message); }
      if (capture && name === 'stdout') { row.outputBytes += bytes.length; if (row.outputBytes <= 8 * 1024 * 1024) row.stdout.push(Buffer.from(bytes)); }
    });
    actors.push(row); report.actors = actors.map(row => row.facts); save(); return row;
  }
  async function stop(row, deadline = Date.now() + BUDGET.cleanup) {
    if (!knownClosed(row)) {
      if (!row.facts.spawn && !row.facts.error && !row.facts.close) await until(() => row.facts.spawn || row.facts.error || row.facts.close,
        row.facts.role + ' original spawn/refusal', Math.max(1, deadline - Date.now()));
      if (row.child.exitCode === null && row.child.signalCode === null && row.facts.spawn) {
        row.killReceipt = killOwnTree(row.child);
        assert.ok(!row.killReceipt.skipped || row.killReceipt.skipped === 'root-exited', 'original child cleanup refused');
      }
      await within(row.closed, Math.max(1, deadline - Date.now()), row.facts.role + ' original close');
    }
    assert.ok(knownCleanup(row), row.facts.role + ': actual spawn/exit/close and original pipe EOF required');
    assert.equal(row.logErrors.length, 0, 'original child output evidence unavailable');
  }
  async function command(executable, argv, env, label, budget) {
    const row = held(executable, argv, env, label);
    await within(row.closed, budget, label);
    if (row.originalStartError) throw row.originalStartError;
    assert.ok(knownClosed(row) && row.facts.exit.code === 0 && row.facts.exit.signal === null, label + ': actual child exit zero and close/EOF required');
    assert.ok(row.outputBytes <= 8 * 1024 * 1024 && !row.logErrors.length, label + ': bounded complete output required');
    return Buffer.concat(row.stdout).toString('utf8');
  }
  async function until(read, label, budget = BUDGET.startup) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(40); }
    throw Error(label + ': caller deadline');
  }
  try {
    const required = ['app/server.js', 'app/public/js/steward-decisions.js', 'Ruyi.exe', 'RuyiDesktop.exe', 'WebView2Loader.dll', 'runtime/node/node.exe'];
    for (const name of required) assert.ok(fs.statSync(path.join(stage, name)).isFile(), 'package entry required: ' + name);
    for (const name of ['Ruyi.exe', 'RuyiDesktop.exe', 'WebView2Loader.dll', 'runtime/node/node.exe']) {
      const fd = fs.openSync(path.join(stage, name), 'r'), bytes = Buffer.alloc(2);
      try { assert.equal(fs.readSync(fd, bytes, 0, 2, 0), 2); assert.equal(bytes.toString('ascii'), 'MZ'); } finally { fs.closeSync(fd); }
    }
    assert.ok(fs.statSync(path.join(stage, 'Ruyi.exe')).size > 10 * 1024 * 1024, 'real compiled application EXE required');
    assert.equal(await fileHash(path.join(stage, 'app/server.js')), expectedServerSha);
    const original = await census(stage);
    report.stageCensus = { files: original.files.length, directories: original.directories.length, sha256: original.sha256 };
    report.binarySha256 = Object.fromEntries(await Promise.all(required.map(async name => [name, await fileHash(path.join(stage, name))])));
    report.zipSha256 = await fileHash(zip);
    const censusFile = path.join(output, 'stage-census.json'), zipReport = path.join(output, 'zip-readback.json');
    fs.writeFileSync(censusFile, JSON.stringify(original, null, 2) + '\n', { flag: 'wx' });
    check(true, 'real application EXE, Desktop, loader and bundled Node exist; stage server matches the explicit pin');
    phase = 'ZIP full readback';
    await command(options.python, [...options.pythonArgs, path.join(__dirname, 'offline-package-zip.py'), stage, zip, censusFile, zipReport],
      childEnv(path.join(output, 'archive-home'), path.join(output, 'archive-data'), nonce), 'zip-readback', BUDGET.archive);
    const zipResult = JSON.parse(fs.readFileSync(zipReport, 'utf8')); validateZipReport(zipResult, original);
    report.archive = { files: zipResult.files, entries: zipResult.entries, bytes: zipResult.bytes, python: zipResult.python,
      reportSha256: await fileHash(zipReport), hostToolOnly: true, crcReadToEof: true };
    check(true, 'every ZIP entry reaches CRC-checked EOF and all stage files match byte-for-byte without unsafe/duplicate paths');
    const bundledNode = path.join(stage, 'runtime/node/node.exe');
    report.bundledNode = (await command(bundledNode, ['--version'], childEnv(path.join(output, 'version-home'), path.join(output, 'version-data'), nonce), 'bundled-node-version', BUDGET.productionChild)).trim();
    assert.match(report.bundledNode, /^v\d+\.\d+\.\d+$/);
    providerOwner = retainProviderStartup(startFakeProvider({ handler: req => {
      fs.appendFileSync(path.join(output, 'provider-received.ndjson'), JSON.stringify({ receivedAt: new Date().toISOString(), raw: req.raw, body: req.body }) + '\n');
      assert.ok(scenario, 'provider request outside its original scenario');
      const messages = req.messages, lastUser = messages.findLastIndex(row => row.role === 'user');
      const text = typeof messages[lastUser]?.content === 'string' ? messages[lastUser].content
        : (messages[lastUser]?.content || []).filter(row => row.type === 'text').map(row => row.text).join('\n');
      if (text.includes(scenario.mediaMarker || '\x00impossible')) {
        const raw = JSON.stringify(req.body), images = [...raw.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(match => Buffer.from(match[1], 'base64'));
        assert.equal(images.length, 1); assert.deepEqual(images[0], scenario.preview);
        for (const forbidden of [...scenario.originalNames, scenario.originalImage.toString('base64'), scenario.reference]) assert.ok(!raw.includes(forbidden));
        scenario.mediaReceived = sha(images[0]); return textFrames('M6_PROTECTED_IMAGE_RECEIVED');
      }
      if (text.includes(scenario.followup)) {
        const previous = messages.find(row => row.role === 'tool' && row.tool_call_id === scenario.callId);
        assert.ok(previous && JSON.parse(previous.content).ok === true, 'later actual request retains the original tool result');
        assert.ok(messages.some(row => row.role === 'assistant' && String(row.content).includes(scenario.answer)), 'later actual request retains the prior assistant answer');
        scenario.followupReceived = true; return textFrames(scenario.followupAnswer);
      }
      assert.ok(text.includes(scenario.message), 'only the chosen local synthetic turn is admitted');
      const tool = messages.slice(lastUser + 1).find(row => row.role === 'tool' && row.tool_call_id === scenario.callId);
      if (!tool) { scenario.writeCalls++; return toolCallFrames('file_write', { path: scenario.target, content: scenario.payload }, scenario.callId); }
      const result = JSON.parse(tool.content); assert.equal(result.ok, true, 'real native file_write result reaches the subsequent model request');
      scenario.toolResultReceived = true; return textFrames(scenario.answer);
    } }), value => { fake = value; }, record, Date.now() + 40 * 60 * 1000);
    fake = await within(providerOwner.started, BUDGET.startup, 'original local fake provider startup');

    // Each mode has a completely new data root and profile. Only the encrypted
    // case invokes the stage Node production seed before the genuine EXE boots.
    for (const mode of ['plain', 'encrypted']) {
      phase = mode;
      const dir = path.join(output, mode), data = path.join(dir, 'data'), work = path.join(dir, 'workspace'), home = path.join(dir, 'profile');
      fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(work);
      const env = childEnv(home, data, nonce), port = await getFreePort();
      if (mode === 'encrypted' && options.fullMedia) env.RUYI_MEDIA_OCR_LANGUAGE = 'en-US';
      const config = { configSchema: 14, engineMode: 'interactive', privacyModeV1: 'off', credentialEncryptionV1: false, workDataEncryptionV1: mode === 'encrypted',
        activeProvider: 'qualification', providers: [{ id: 'qualification', type: 'openai-compat', baseUrl: fake.url, model: 'fixture', vision: true }],
        permissionMode: 'bypass', defaultWorkspace: work, workspaces: [{ path: work, read: true, write: true, execute: false }], toolLoadingMode: 'full',
        includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, autoImportKimiCodeMcp: false, enableMcpDropIn: false,
        schedulerEnabledV1: false, stewardEnabledV1: false, stewardThreadBriefV1: false, importAgentInstructions: false,
        contextAutoCompactEnabled: false, runtimeOptimizationShadowV1: false, desktopMcp: { enabled: false, autodetect: false } };
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
      let selected = { mode: 'plaintext', root: data };
      const production = async (op, extra = {}) => {
        const jobFile = path.join(dir, op + '-job.json');
        fs.writeFileSync(jobFile, JSON.stringify({ op, output, stage, data, expectedServerSha, ...extra }), { flag: 'wx' });
        return JSON.parse(await command(bundledNode, [path.join(__dirname, 'offline-package-production.cjs'), jobFile], env, mode + '-' + op, BUDGET.productionChild));
      };
      if (mode === 'encrypted') selected = await production('seed');
      const row = held(path.join(stage, 'Ruyi.exe'), ['serve', '--port', String(port)], env, mode + '-exe', false);
      let token;
      const request = async (route, { body, method = body === undefined ? 'GET' : 'POST', budget = BUDGET.request } = {}) => {
        const response = await fetch('http://127.0.0.1:' + port + route, { method, headers: {
          ...(token ? { 'x-wcw-token': token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(budget) });
        const bytes = Buffer.from(await response.arrayBuffer()); let json; try { json = JSON.parse(bytes); } catch {}
        return { status: response.status, bytes, json, headers: response.headers };
      };
      const runtime = await until(async () => {
        if (row.originalStartError) throw row.originalStartError;
        if (row.facts.exit) throw Error(mode + ': actual EXE exited before readiness');
        let value;
        try { value = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        if (value.pid !== row.child.pid || value.port !== port || typeof value.token !== 'string' || !value.token || !value.overlayId) return false;
        try { const health = await request('/health', { budget: 1500 }); return health.status === 200 && health.json?.overlayId === value.overlayId && value; }
        catch (error) { if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause?.code === 'ECONNREFUSED') return false; throw error; }
      }, mode + ' exact owned EXE/runtime/health');
      token = runtime.token;
      const bootstrap = await request('/api/bootstrap', { body: {} }); assert.equal(bootstrap.status, 200); assert.equal(bootstrap.json?.token, token);
      const status = await request('/api/status'); assert.equal(status.status, 200);
      assertSameDirectory(status.json.dataRoot, selected.root); assert.equal(status.json.config?.workDataEncryptionV1, mode === 'encrypted');
      assert.equal(fs.realpathSync.native(status.json.exePath).toLowerCase(), fs.realpathSync.native(path.join(stage, 'Ruyi.exe')).toLowerCase());
      const metrics = await request('/api/metrics'); assert.equal(metrics.status, 200); assert.equal(metrics.json.pid, row.child.pid); assert.match(metrics.json.node, /^v\d+\.\d+\.\d+$/);
      const script = await request('/js/steward-decisions.js'); assert.equal(script.status, 200);
      assert.deepEqual(script.bytes, fs.readFileSync(path.join(stage, 'app/public/js/steward-decisions.js')));
      check(true, mode + ': genuine EXE owns exact runtime/health/token and serves the actual packaged public JS');
      scenario = { target: path.join(work, 'native-result.txt'), payload: 'M6_PRIVATE_' + mode + '_' + nonce + '\n中文结果\n',
        message: 'M6_WRITE_' + mode + '_' + nonce, answer: 'M6_WRITE_CONFIRMED_' + mode,
        followup: 'M6_FOLLOWUP_' + mode + '_' + nonce, followupAnswer: 'M6_HISTORY_CONFIRMED_' + mode,
        callId: 'm6_write_' + mode, writeCalls: 0 };
      const created = await request('/api/sessions', { body: { title: 'Package ' + mode, cwd: work,
        engineRoute: { engine: 'openai', providerId: 'qualification', model: 'fixture' } } });
      assert.equal(created.status, 200); const sid = created.json?.session?.id; assert.ok(sid);
      const beforeRequests = fake.requests.length;
      const first = await request('/api/chat/stream', { body: { sessionId: sid, cwd: work, message: scenario.message } });
      fs.writeFileSync(path.join(dir, 'first-turn.ndjson'), first.bytes); assert.equal(first.status, 200); successfulTurn(first.bytes);
      assert.equal(fs.readFileSync(scenario.target, 'utf8'), scenario.payload); assert.equal(scenario.writeCalls, 1); assert.equal(scenario.toolResultReceived, true);
      const followup = await request('/api/chat/stream', { body: { sessionId: sid, cwd: work, message: scenario.followup } });
      fs.writeFileSync(path.join(dir, 'followup-turn.ndjson'), followup.bytes); assert.equal(followup.status, 200); successfulTurn(followup.bytes);
      assert.equal(scenario.followupReceived, true); assert.equal(scenario.writeCalls, 1); assert.equal(fake.requests.length - beforeRequests, 3);
      const history = await request('/api/sessions/' + sid); assert.equal(history.status, 200);
      const session = history.json.session, joined = JSON.stringify(session);
      for (const value of [scenario.message, scenario.followup, scenario.answer, scenario.followupAnswer]) assert.ok(joined.includes(value), 'API history preserves both actual turns');
      assert.ok(session.providerHistory.some(message => message.role === 'tool' && message.tool_call_id === scenario.callId));
      fs.writeFileSync(path.join(dir, 'session-http.json'), JSON.stringify(plainSession(session), null, 2));
      check(true, mode + ': real local model calls file_write once, receives the actual tool result and continues with preserved history');
      const outcome = { mode, selected, embeddedNode: metrics.json.node, bundledNode: report.bundledNode, pid: runtime.pid, port, overlayId: runtime.overlayId,
        sessionId: sid, fileSha256: sha(Buffer.from(scenario.payload)), providerPosts: 3, writeCalls: scenario.writeCalls };

      if (mode === 'encrypted' && options.fullMedia) {
        phase = 'Full actual EXE protected image';
        await protectedImage(request, scenario, sid, work, selected.root, check, dir);
        outcome.fullMedia = { status: 'PASS', apiStyle: 'chat', payloadSha256: scenario.mediaReceived, originalUnchanged: true,
          runtimeAndSources: 'actual stage defaults; no path/profile override', explicitLanguage: 'en-US',
          prepareCallerMs: BUDGET.mediaPrepare, productTtlAndJobBudgetsUnchanged: true };
      }
      await stop(row);
      if (mode === 'encrypted') {
        phase = 'encrypted cold production reader';
        const physicalBefore = new Map();
        const headFile = path.join(selected.root, 'sessions', sid + '.json'), headBytes = fs.readFileSync(headFile);
        physicalBefore.set(headFile, headBytes);
        const head = JSON.parse(headBytes);
        const keyHeader = JSON.parse(fs.readFileSync(path.join(selected.root, 'work-data-key-v1.json'), 'utf8'));
        assert.equal(head.workData, 2); assert.equal(head.purpose, 'session'); assert.equal(head.instanceId, keyHeader.instanceId);
        assert.equal(head.schema, 2); assert.equal(head.scopeId, 'sessions'); assert.equal(head.recordId, sid);
        for (const kind of ['messages', 'provider']) {
          const journalFile = path.join(selected.root, 'sessions', sid + '.' + kind + '.ndjson'), bytes = fs.readFileSync(journalFile);
          physicalBefore.set(journalFile, bytes);
          assert.ok(!bytes.includes(scenario.message) && !bytes.includes(scenario.payload));
          const lines = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)); assert.ok(lines.length > 0);
          for (let ordinal = 0; ordinal < lines.length; ordinal++) {
            const line = lines[ordinal]; assert.equal(line.w, 2); assert.equal(line.e.version, 2); assert.equal(line.e.purpose, 'session');
            assert.equal(line.e.instanceId, keyHeader.instanceId); assert.equal(line.e.scopeId, sid); assert.equal(line.e.recordId, kind + ':' + ordinal); assert.equal(line.e.seq, ordinal);
          }
          assert.ok(!fs.existsSync(path.join(data, 'sessions', sid + '.' + kind + '.ndjson')), 'no stable-base session fallback');
        }
        assert.ok(!fs.existsSync(path.join(data, 'sessions', sid + '.json')));
        const cold = await production('inspect', { selected, sessionId: sid });
        // The optional image adds a third turn. Take the last actual HTTP view
        // while the server is alive inside protectedImage instead of inventing it.
        assert.deepEqual(cold.session, scenario.finalHttpSession || plainSession(session));
        for (const [file, bytes] of physicalBefore) assert.deepEqual(fs.readFileSync(file), bytes, 'cold production history read must not repair/rewrite original sealed bytes');
        outcome.coldReader = { status: 'PASS', node: cold.node, generation: cold.generation, manifestSha256: cold.manifestSha256,
          physicalSessionSha256: Object.fromEntries([...physicalBefore].map(([file, bytes]) => [path.basename(file), sha(bytes)])),
          originalHeadAndBodyBytesUnchanged: true, historyScope: 'id/title/turnSeq and complete messages/providerHistory arrays' };
        check(true, 'encrypted: stage Node production cold reader matches real EXE history; physical session files are bound sealed records without base fallback');
      }
      report.scenarios.push(outcome); save(); scenario = null;
    }
    assert.equal(fake.errors.length, 0);
    fs.writeFileSync(path.join(output, 'provider-requests.json'), JSON.stringify(fake.requests, null, 2));
    assert.equal((await census(stage)).sha256, original.sha256, 'running actual packaged processes must not mutate stage input');
    assert.equal(await fileHash(zip), report.zipSha256, 'ZIP input stays unchanged');
    check(true, 'stage and ZIP remain byte-identical after both normal EXE scenarios');
  } catch (error) {
    primary = error; report.failure = { phase, name: error.name, code: error.code || '', message: error.message, stack: error.stack };
    try { fs.writeFileSync(path.join(output, 'FIRST-FAILURE.json'), JSON.stringify(report.failure, null, 2), { flag: 'wx' }); } catch (failure) { cleanupErrors.push(failure); }
  } finally {
    const cleanupDeadline = Date.now() + BUDGET.cleanup;
    report.retentionDeadline = cleanupDeadline + BUDGET.cleanup;
    for (const row of actors) { try { await stop(row, cleanupDeadline); } catch (error) { cleanupErrors.push(error); } }
    if (providerOwner) { try { await within(providerOwner.requestClose(), Math.max(1, cleanupDeadline - Date.now()), 'original fake provider close'); } catch (error) { cleanupErrors.push(error); } }
    if (fake) { try { fs.writeFileSync(path.join(output, 'provider-requests.json'), JSON.stringify(fake.requests, null, 2)); } catch (error) { cleanupErrors.push(error); } }
    report.actors = actors.map(row => ({ ...row.facts, killReceipt: row.killReceipt, knownCleanup: Boolean(knownCleanup(row)), logErrors: row.logErrors }));
    report.provider = providerOwner?.snapshot() || { phase: 'not-started' };
    report.cleanup = { status: cleanupErrors.length ? 'UNKNOWN_OR_FAILED' : 'KNOWN_ORIGINAL_ACTORS_CLOSED', allDescendantKernelExitCertified: false,
      errors: cleanupErrors.map(error => ({ name: error.name, message: error.message })) };
    report.finishedAt = new Date().toISOString(); report.status = primary || cleanupErrors.length ? 'RED' : 'PASS_SCOPED_PACKAGE_QUALIFICATION';
    if (!ownersClosed(actors, providerOwner)) report.retentionEvidence = 'LATE-RETENTION.ndjson';
    try { save(); } catch (error) { cleanupErrors.push(error); }
  }
  let failure = primary;
  if (cleanupErrors.length) failure = new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], 'package qualification failed or cleanup unknown', { cause: primary || cleanupErrors[0] });
  if (failure) {
    if (!ownersClosed(actors, providerOwner)) failure.packageQualificationRetention = retainUnknownOwners({ actors, provider: providerOwner,
      deadline: report.retentionDeadline, stop, note: value => fs.appendFileSync(path.join(output, 'LATE-RETENTION.ndjson'), JSON.stringify({ ...value,
        originalFailure: primary?.message || failure.message }) + '\n') });
    throw failure;
  }
  return report;
}

async function protectedImage(request, scenario, sid, work, activeRoot, check, dir) {
  const settings = await request('/api/privacy/settings', { body: { encryption: true, mode: 'enhanced', rules: [], technical: false } });
  fs.writeFileSync(path.join(dir, 'privacy-settings-apply-response.json'), JSON.stringify({ status: settings.status,
    body: settings.json, rawText: settings.bytes.toString('utf8') }, null, 2), { flag: 'wx' });
  assert.equal(settings.status, 200); assert.equal(settings.json?.ok, true);
  const applied = await request('/api/privacy/settings');
  fs.writeFileSync(path.join(dir, 'privacy-settings-readback-response.json'), JSON.stringify({ status: applied.status,
    body: applied.json, rawText: applied.bytes.toString('utf8') }, null, 2), { flag: 'wx' });
  assert.equal(applied.status, 200); assert.equal(applied.json?.ok, true);
  assert.equal(applied.json.encryption, true); assert.equal(applied.json.mode, 'enhanced');
  assert.equal(applied.json.technical, false); assert.deepEqual(applied.json.rules, []);
  assert.equal(applied.json.recoveryRequired, false); assert.equal(applied.json.ruleVersion, settings.json.ruleVersion);
  const original = bitmap(), name = 'qualification-original-' + crypto.randomBytes(8).toString('hex') + '.bmp';
  const upload = await request('/api/upload', { body: { name, data: original.toString('base64') } }); assert.equal(upload.status, 200);
  const file = upload.json.file; assert.ok(file?.id);
  const download = () => request('/api/upload/content?id=' + encodeURIComponent(file.id) + '&name=' + encodeURIComponent(file.name));
  assert.deepEqual((await download()).bytes, original);
  const uploads = await census(path.join(activeRoot, 'uploads'));
  const prepared = await request('/api/media/images/prepare', { body: { sessionId: sid, id: file.id, name: file.name }, budget: BUDGET.mediaPrepare });
  fs.writeFileSync(path.join(dir, 'media-prepare-response.json'), JSON.stringify({ status: prepared.status, body: prepared.json }, null, 2));
  if (prepared.status !== 200) throw Object.assign(Error('Full compiled EXE protected prepare refused: ' + (prepared.json?.error?.code || prepared.status)), { code: prepared.json?.error?.code });
  const issued = prepared.json, preview = await request('/api/media/images/' + issued.id + '/preview?sessionId=' + encodeURIComponent(sid));
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(sha(preview.bytes), issued.manifest.payloadHash); assert.equal(preview.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  scenario.preview = preview.bytes; scenario.originalNames = [name, file.name]; scenario.originalImage = original; scenario.reference = issued.reference;
  scenario.mediaMarker = 'M6_MEDIA_' + crypto.randomBytes(8).toString('hex');
  const sent = await request('/api/chat/stream', { body: { sessionId: sid, cwd: work, message: scenario.mediaMarker,
    attachments: [{ ...file, protectedImage: { reference: issued.reference } }] } });
  assert.equal(sent.status, 200); successfulTurn(sent.bytes); assert.equal(scenario.mediaReceived, sha(preview.bytes));
  assert.deepEqual((await download()).bytes, original); assert.equal((await census(path.join(activeRoot, 'uploads'))).sha256, uploads.sha256);
  const discarded = await request('/api/media/images/' + issued.id, { method: 'DELETE' }); assert.equal(discarded.status, 200);
  const history = await request('/api/sessions/' + sid); assert.equal(history.status, 200); scenario.finalHttpSession = plainSession(history.json.session);
  check(true, 'Full compiled EXE prepares an authenticated PNG and sends those exact bytes once without original BMP/name/reference; original remains intact');
}

if (require.main === module) {
  const runner = createRunner('OFFLINE PACKAGE QUALIFICATION');
  Promise.resolve().then(() => qualify(parseArgs(process.argv.slice(2)), runner)).catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
}
module.exports = { BUDGET, parseArgs, safeRelative, census, validateZipReport, childEnv, plainSession, successfulTurn, qualify };
