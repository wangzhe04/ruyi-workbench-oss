'use strict';
// Test-only memory FS/net boundaries. Module bodies always come from current app/src.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { constBlock, functionBlock } = require('./source-slice');
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

function memoryFs() {
  const nodes = new Map(), calls = [];
  let nextInode = 1n, clock = 1n, nextTemp = 0;
  const key = file => path.resolve(file).toLowerCase();
  const fail = code => Object.assign(Error('memory FS ' + code), { code });
  function get(file) { calls.push(['lookup', key(file)]); const row = nodes.get(key(file)); if (!row) throw fail('ENOENT'); return row; }
  function stat(row) {
    return { dev: 1n, ino: row.ino, mode: row.directory ? 0o40755n : 0o100600n, nlink: 1n,
      size: BigInt(row.bytes.length), mtimeNs: row.time, ctimeNs: row.time,
      isFile: () => !row.directory, isDirectory: () => row.directory, isSymbolicLink: () => false,
      reparsePoint: false, reparseTag: 0 };
  }
  function mkdir(file) {
    file = path.resolve(file); const parent = path.dirname(file);
    if (key(parent) !== key(file) && !nodes.has(key(parent))) mkdir(parent);
    if (nodes.has(key(file))) return;
    nodes.set(key(file), { file, directory: true, bytes: Buffer.alloc(0), ino: nextInode++, time: clock++ });
  }
  function entries(file) {
    get(file); return [...nodes.values()].filter(row => key(row.file) !== key(file) && key(path.dirname(row.file)) === key(file)).map(row => path.basename(row.file)).sort();
  }
  function put(file, bytes) {
    if (!nodes.has(key(path.dirname(file)))) throw fail('ENOENT');
    const row = nodes.get(key(file)) || { file: path.resolve(file), directory: false, ino: nextInode++ };
    row.bytes = Buffer.from(bytes); row.time = clock++; nodes.set(key(file), row);
  }
  const io = {
    async lstat(file) { return stat(get(file)); },
    async realpath(file) { get(file); return path.resolve(file); },
    async readdir(file) { return entries(file); },
    async readFile(file, encoding) { const bytes = Buffer.from(get(file).bytes); return encoding ? bytes.toString(encoding) : bytes; },
    async mkdir(file) { mkdir(file); },
    async mkdtemp(prefix) { const file = prefix + String(++nextTemp).padStart(6, '0'); mkdir(file); return file; },
    async open(file, flags) {
      if (flags.includes('x')) { if (nodes.has(key(file))) throw fail('EEXIST'); put(file, Buffer.alloc(0)); }
      const row = get(file); let position = 0, closed = false;
      const live = () => { if (closed) throw fail('EBADF'); };
      return {
        async stat() { live(); return stat(row); },
        async writeFile(bytes) { live(); row.bytes = Buffer.from(bytes); row.time = clock++; },
        async sync() { live(); },
        async read(buffer, offset, length, at) {
          live(); const start = at === null ? position : at, used = Math.min(length, row.bytes.length - start);
          row.bytes.copy(buffer, offset, start, start + Math.max(0, used)); if (at === null) position += Math.max(0, used);
          return { bytesRead: Math.max(0, used), buffer };
        },
        async close() { live(); closed = true; }
      };
    }
  };
  return { io, calls, mkdir, put, entries, stat: file => stat(get(file)), exists: file => nodes.has(key(file)),
    replaceDirectory(file) { const row = get(file); assert.equal(row.directory, true); row.ino = nextInode++; } };
}

function createFixture({ manualClose = false, withoutRecoveryBudget = false } = {}) {
  const root = path.resolve(path.parse(process.cwd()).root, 'ruyi-production-host-model');
  const paths = Object.fromEntries(['base', 'upload', 'backup', 'temp'].map(name => [name, path.join(root, name)]));
  const memory = memoryFs(); memory.mkdir(root); Object.values(paths).forEach(memory.mkdir);
  const events = [], servers = [], holds = [], timeouts = [], state = { unknown: false, resultReads: 0, configured: null, bootOwner: null,
    // 00-boot reports where the serving root came from ('default' or 'preference');
    // startServer only consults it to close the migration gate.
    dataRootSource: 'default',
    exitCalls: [], maintenance: { phase: 'open', epoch: 1, admitted: 0, writers: 0, dirty: 0, busy: { turns: 0 }, processExitRequired: true } };
  const timers = { setInterval(fn, ms) { const row = { fn, ms, refs: 0, ref() { this.refs++; }, unref() {} }; holds.push(row); return row; },
    setTimeout(fn, ms) { const row = { fn, ms, fired: false, cleared: false, ref() {}, unref() {} }; timeouts.push(row); return row; },
    clearTimeout(row) { if (row) row.cleared = true; }, clearInterval() {} };
  const net = { createServer() {
    const server = new EventEmitter(); server.listening = false; server.closeCalls = 0;
    server.listen = (endpoint, callback) => { server.endpoint = endpoint; server.listening = true; events.push('bind'); queueMicrotask(callback); return server; };
    server.finishClose = (error = null) => { if (!error) { server.listening = false; server.emit('close'); } server.closeCallback?.(error); };
    server.close = callback => { server.closeCalls++; server.closeCallback = callback; events.push('close'); if (!manualClose) queueMicrotask(() => server.finishClose()); return server; };
    servers.push(server); return server;
  } };
  const proc = { platform: 'win32', versions: { node: '24.14.0' }, pid: 777, ppid: 888, env: {},
    execPath: process.execPath, argv: [process.execPath, 'pure-model'],
    kill() { throw Object.assign(Error('modeled exited process'), { code: 'ESRCH' }); }, once() {},
    exit(code) { state.exitCalls.push(code); throw Object.assign(Error('modeled process termination'), { code: 'MODELED_PROCESS_EXIT' }); } };
  const imports = new Map([
    ['net', net], ['node:net', net], ['fs', { promises: memory.io }], ['node:fs', { promises: memory.io }],
    ['node:fs/promises', memory.io], ['path', path], ['node:path', path], ['crypto', crypto], ['node:crypto', crypto],
    ['os', { tmpdir: () => paths.temp }], ['node:os', { tmpdir: () => paths.temp }],
    ['node:timers', timers], ['node:util', require('node:util')], ['node:buffer', require('node:buffer')]
  ]);
  const context = vm.createContext({ Buffer, process: proc, URL, AbortController, queueMicrotask,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    require(name) { if (!imports.has(name)) throw Error('Unexpected production-pure fixture import: ' + name); return imports.get(name); } });
  const modules = [
    ['01g-server-ownership.js', 'ServerOwnership'], ['13aq-work-data-native-adapters.js', 'WorkDataNativeAdapters'],
    ['01t-work-data-recovery.js', 'WorkDataRecovery'], ['13at-work-data-restore-uploads.js', 'WorkDataRestoreUploads'],
    ['01ae-work-data-maintenance-result.js', 'WorkDataMaintenanceResult'], ['13am-work-data-maintenance-runtime.js', 'WorkDataMaintenanceRuntime'],
    ['13au-work-data-runtime-host.js', 'WorkDataRuntimeHost'], ['13au-work-data-runtime-host.js', 'WorkDataServeUploadBootstrap'],
    ['13ah-work-data-setup.js', 'WorkDataSetup']
  ];
  for (const [file, symbol] of modules) {
    let source = constBlock(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), symbol);
    assert.ok(source, 'current production declaration exists: ' + symbol);
    if (file === '01t-work-data-recovery.js' && withoutRecoveryBudget) source = source.replace('LIMITS, seal, open', 'LIMITS: null, seal, open');
    vm.runInContext(source, context, { filename: file });
  }
  const api = vm.runInContext('({ ownership:ServerOwnership,native:WorkDataNativeAdapters,uploads:WorkDataRestoreUploads,result:WorkDataMaintenanceResult,runtime:WorkDataMaintenanceRuntime,host:WorkDataRuntimeHost,bootstrap:WorkDataServeUploadBootstrap,setup:WorkDataSetup,recovery:WorkDataRecovery })', context);
  const authority = { generation: 1, id: 'a'.repeat(48), mode: 'encrypted', proof: { sha256: 'b'.repeat(64) } };
  const fullAuthority = { generation: authority.generation, id: authority.id, mode: authority.mode, sha256: authority.proof.sha256 };
  const nativeBindings = { ownership: api.ownership, manifest: { create: () => ({ readActive: async () => authority }) },
    fullSnapshot: { create: () => ({ seal: async () => ({ sourceProof: { sha256: 'd'.repeat(64) }, files: 1, directories: 1 }), restore: async () => ({ ok: true }) }) },
    nativePublish: { createFlush: () => async directories => { events.push('flush'); return { ok: true, flushDirectories: directories, directoryFlush: directories.map(() => 0) }; } },
    disposableTree: { create: () => async () => true }, migrationHost: { create: () => ({}) },
    worker: { create: () => ({}), spawnCold() { throw Error('No real child in pure fixture'); }, processChannel() { throw Error('No real IPC in pure fixture'); } },
    protector: { supported: () => true, run: async () => ({}) }, capturePreserved: async () => ({}), externalOwner: () => ({}), skillOwner: () => ({}),
    writeJson: async () => {}, helperMayStillRun: () => state.unknown, resultOwner: {}, appVersion: '3.0.1' };
  const native = api.native.create({ bindings: nativeBindings, proc, clock: timers });
  // The production host is built from WorkDataVerifierEntry.createVerifier, i.e. a
  // native adapter with the verifier entry command already bound.
  const hostNative = api.native.create({ bindings: nativeBindings, proc, clock: timers,
    verifierCommand: { command: proc.execPath, args: [proc.execPath, 'work-data-verify'] } });
  const workerHooks = vm.runInContext('({})', context), runtimeHooks = {};
  const resultApi = { create(options) { const actual = api.result.create(options); return { ...actual, async read() { state.resultReads++; return actual.read(); } }; } };
  const maintenance = { status: () => state.maintenance };
  const claim = Object.freeze({ inspect: async () => null, write: async () => { throw Error('pure fixture claim is read-only'); },
    remove: async () => true, classify: () => 'inert' });
  const bindings = { ownership: api.ownership, native: hostNative, uploads: api.uploads, workerHooks, runtimeHooks, resultApi, maintenance, claim: null,
    workerApi: { create() { throw Error('Missing worker must not be created'); }, spawnCold() { throw Error('No child'); }, processChannel() { throw Error('No IPC'); }, waitForProcessExit: async () => {} },
    httpApi: { create() { throw Error('No HTTP listener'); } }, controlApi: { create: () => ({ inspect: async () => ({ pending: false }) }) },
    coldOperations: { create: () => ({}) }, command: mode => ({ command: proc.execPath, args: [mode] }) };
  runtimeHooks.configure = host => { state.configured = api.runtime.create(host); return state.configured; };
  const factory = api.host.create({ proc, bindings });
  const bootstrap = api.bootstrap.create({ ownership: api.ownership, hostApi: { create: () => factory }, proc, temp: paths.temp, inspectNative: () => state.unknown });
  const fixture = { root, paths, memory, events, servers, holds, timeouts, state, context, api, native, hostNative, nativeBindings, bindings, claim, maintenance, factory, bootstrap, workerHooks, runtimeHooks, fullAuthority, proc,
    lease: (roots = [paths.base, paths.upload]) => api.ownership.acquire(roots),
    async warm() { const ownership = await fixture.lease(), session = await factory.openWarm({ base: paths.base, uploadRoot: paths.upload, ownership }); return { ownership, session }; },
    async open(factory) { const ownership = await fixture.lease(); return { ownership, session: await factory.openWarm({ base: paths.base, uploadRoot: paths.upload, ownership }) }; },
    async finishWarm({ ownership, session }) { await session.close(); await ownership.release(); },
    captureContext(session, ownership) { return { base: session.base, ownership, server: { listening: true, address: () => ({ address: '127.0.0.1', port: 34567 }) }, listener: { host: '127.0.0.1', port: 34567 } }; },
    async startRouter({ pending = false, inspect = () => {}, innerFailure = false } = {}) {
      const hooks = { acquireServe: async options => { const owner = await bootstrap.acquireServe(options); state.bootOwner = owner; return owner; },
        configureServe: options => bootstrap.configureServe(options), abortUnconfiguredServe: options => bootstrap.abortUnconfigured(options), helperMayStillRun: bootstrap.helperMayStillRun,
        inspectBoot: async () => { events.push('inspect'); await inspect(); if (pending) throw Object.assign(Error('modeled pending intent'), { code: 'work_data_setup.intent_pending' }); } };
      Object.assign(context, { WorkDataMaintenanceRuntimeHooks: hooks, resolveBindHost: () => '127.0.0.1', dataRoot: () => paths.base,
        dataRootSource: () => state.dataRootSource,
        defaultDataRoots: () => ({ legacy: path.join(root, 'legacy'), next: paths.base }), lstatOrNull: () => null, isDirectServeInvocation: () => false,
        WorkDataRootHooks: { bind: async () => events.push('root-bind'), ready: () => true }, START_ERROR_KINDS: [],
        writeStartError: async () => events.push('error-writer'), finishBootCliPathProbes: () => events.push('finish-probes'),
        startServerInner: async () => { events.push('inner'); if (innerFailure) throw Error('modeled inner failure'); return { modeledListener: true }; } });
      const source = functionBlock(fs.readFileSync(path.join(sourceRoot, '13-http-router.js'), 'utf8'), 'startServer');
      assert.ok(source); vm.runInContext(source, context, { filename: '13-http-router.js:startServer' });
      return context.startServer({});
    }
  };
  return fixture;
}

// Real 13av claim + real 13am boot gate, assembled exactly like production: the
// 13au module tail installs the single claim on WorkDataMaintenanceRuntimeHooks,
// and the readonly inspectBoot path classifies/cleans the same TEMP record. Only
// the verifier entry is doubled (13au needs its .flush seam); 13av's durability and
// CAS have their own suite.
async function createClaimWiring({ claimModule = true, presetActivation = null, rootPreferenceModule = true,
  presetRootPreference = null, rootPreferenceDeferred = false } = {}) {
  const { constBlock } = require('./source-slice');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-host-wiring-')));
  const base = path.join(root, 'base'), temp = path.join(root, 'temp'), backup = path.join(root, 'backup');
  for (const dir of [base, temp, backup]) fs.mkdirSync(dir);
  const livePids = new Set([424242]);
  const proc = { platform: process.platform === 'win32' ? 'win32' : process.platform, versions: { node: process.versions.node },
    pid: 9001, ppid: 9000, env: { RUYI_HOME: base }, execPath: process.execPath, argv: [process.execPath, path.join(root, 'server.js')],
    connected: true, send() { return Promise.resolve(); }, disconnect() { this.connected = false; },
    exit() { throw Object.assign(Error('modeled termination'), { code: 'MODELED_PROCESS_EXIT' }); },
    kill(pid) { if (livePids.has(pid)) return true; throw Object.assign(Error('no such process'), { code: 'ESRCH' }); } };
  const sandboxOs = { ...os, tmpdir: () => temp, homedir: () => root };
  const context = vm.createContext({ Buffer, process: proc, URL, AbortController, queueMicrotask,
    http: require('node:http'), crypto: require('node:crypto'),
    setTimeout: () => ({ ref() {}, unref() {} }), clearTimeout() {}, setInterval: () => ({ ref() {}, unref() {} }), clearInterval() {},
    require(name) { return name === 'os' || name === 'node:os' ? sandboxOs : require(name); } });
  const load = (file, symbol) => {
    const source = constBlock(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), symbol);
    assert.ok(source, 'wiring source: ' + file + ' ' + symbol);
    return vm.runInContext(source, context, { filename: file });
  };
  load('01g-server-ownership.js', 'ServerOwnership');
  load('01v-work-data-manifest.js', 'WorkDataManifest');
  load('01ae-work-data-maintenance-result.js', 'WorkDataMaintenanceResult');
  load('13aj-work-data-control.js', 'WorkDataMaintenanceControl');
  load('13al-work-data-maintenance-http.js', 'WorkDataMaintenanceHttp');
  load('13ai-work-data-worker.js', 'WorkDataMaintenanceWorker');
  load('13ak-work-data-cold-operations.js', 'WorkDataColdOperations');
  load('13at-work-data-restore-uploads.js', 'WorkDataRestoreUploads');
  if (claimModule) load('13av-work-data-handoff-claim.js', 'WorkDataHandoffClaim');
  context.WorkDataMaintenanceRuntimeHooks = vm.runInContext('({})', context);
  if (presetActivation !== null) context.WorkDataMaintenanceRuntimeHooks.activation = presetActivation;
  if (presetRootPreference !== null) context.WorkDataMaintenanceRuntimeHooks.rootPreference = presetRootPreference;
  // The wiring doubles 13aw's current shape exactly: the owner carries inspect/write/
  // remove while the eight-key codec stays at module level, so the tail's bridge (which
  // publishes that codec as owner.validate) is exercised by every wiring test.
  const rootPreferenceCalls = [];
  const rootPreferenceValidated = [];
  const rootPreferenceFactory = Object.freeze({
    validate(value) { rootPreferenceValidated.push(value); return !!value && typeof value === 'object' && !Array.isArray(value); },
    create(options) {
      rootPreferenceCalls.push({ keys: Object.keys(options).sort(), ...options });
      return Object.freeze({ inspect: async () => ({ present: false }), write: async () => null, remove: async () => true });
    } });
  // `rootPreferenceDeferred` models a future bundle reordering that concatenates 13aw
  // after 13au; today 13aw precedes it, so the tail installs at module load.
  if (rootPreferenceModule && !rootPreferenceDeferred) context.WorkDataRootPreference = rootPreferenceFactory;
  context.WorkDataMaintenanceWorkerHooks = vm.runInContext('({})', context);
  context.WorkDataVerifierEntry = Object.freeze({
    command: ({ proc: target }) => Object.freeze({ command: target.execPath, args: Object.freeze([target.execPath, 'work-data-verify']) }),
    createVerifier: () => Object.freeze({ sourceKeeper() {}, readAuthority() {}, coldOperationHost() {}, helperMayStillRun: () => false, flush: async () => {},
      capabilities: Object.freeze({ implemented: Object.freeze(['native-flush-adapter', 'full-snapshot-adapter', 'cold-verifier-protocol', 'genuine-source-keeper']), verifierCommandBound: true }) }) });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, '13am-work-data-maintenance-runtime.js'), 'utf8'), context, { filename: '13am-work-data-maintenance-runtime.js' });
  const installedBy13am = context.WorkDataMaintenanceRuntimeHooks.claim;
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, '13au-work-data-runtime-host.js'), 'utf8'), context, { filename: '13au-work-data-runtime-host.js' });
  if (rootPreferenceModule && rootPreferenceDeferred) context.WorkDataRootPreference = rootPreferenceFactory;
  const api = vm.runInContext('({host:WorkDataRuntimeHost,ownership:ServerOwnership,hooks:WorkDataMaintenanceRuntimeHooks})', context);
  const hooks = api.hooks;
  const canonicalBase = await api.ownership.canonicalRoot(base);
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const digest = value => crypto.createHash('sha256').update(Buffer.from(fold(value), 'utf8')).digest('hex');
  const claimDir = path.join(temp, 'ruyi-work-data-handoff-' + digest(canonicalBase));
  const stat = fs.lstatSync(canonicalBase, { bigint: true });
  const baseIdentity = Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
  const fixture = {
    root, base, canonicalBase, temp, backup, proc, context, api, hooks, installedBy13am, claimDir,
    claimFile: path.join(claimDir, 'claim-v1.json'),
    async lease() { return api.ownership.acquire([base]); },
    claimRecord(phase, overrides = {}) {
      return { schema: 1, base: canonicalBase, baseIdentity: { ...baseIdentity }, id: 'a'.repeat(48), nonce: 'b'.repeat(64),
        parentPid: proc.ppid, childPid: 424242, operation: 'export', serve: { host: '127.0.0.1', port: 32123 }, phase,
        createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', ...overrides };
    },
    resultRecord(id) {
      const authority = { generation: 0, id: null, mode: 'plain', sha256: null };
      return { schema: 1, id, operation: 'export', state: 'verified', sourceAuthority: { ...authority }, authority: { ...authority },
        finishedAt: '2026-10-27T00:00:00.000Z',
        backup: { path: path.join(backup, 'ruyi-work-data-' + id + '.ruyi-backup'), sha256: 'e'.repeat(64), bytes: 1, identity: { dev: '1', ino: '1' } } };
    },
    writeResult(record) {
      const control = path.join(base, '.work-data');
      fs.mkdirSync(control, { recursive: true });
      fs.writeFileSync(path.join(control, 'maintenance-result-v1.json'), JSON.stringify(record));
    },
    rootPreferenceCalls,
    rootPreferenceValidated,
    claimBytes() { return fs.readFileSync(fixture.claimFile); },
    claimEntries() { try { return fs.readdirSync(claimDir); } catch { return []; } },
    dispose() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* already removed */ } }
  };
  return fixture;
}

module.exports = { createFixture, createClaimWiring, tick };
