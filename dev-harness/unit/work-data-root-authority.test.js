'use strict';
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const repoSource = path.join(process.cwd(), 'ruyi-workbench/app/src');
const draft = process.env.RUYI_ROOT_CANDIDATE_DIR || (fs.existsSync(path.join(__dirname, '01z-work-data-root-authority.js')) ? __dirname : repoSource);
const { functionBlock, constBlock } = require(path.join(process.cwd(), 'dev-harness/lib/source-slice'));
function source(name) {
  let text = fs.readFileSync(fs.existsSync(path.join(draft, name)) ? path.join(draft, name) : path.join(repoSource, name), 'utf8');
  if (process.env.RUYI_ROOT_NEGATIVE === 'missing-bind' && name === '13-http-router.js') text = text.replace('    await WorkDataRootHooks.bind(ownership);', '');
  if (process.env.RUYI_ROOT_NEGATIVE === 'missing-fallback' && name === '02-session-store.js') text = text.replace(".catch(() => typeof WorkDataRootHooks !== 'undefined' && WorkDataRootHooks.mode ? WorkDataRootHooks.mode(false) : false)", '.catch(() => false)');
  if (process.env.RUYI_ROOT_NEGATIVE === 'missing-generation-guards' && name === '03-bridge-guard.js') text = text.replace('WorkDataRootHooks.guardRoots(p)', '[]');
  return text;
}
const directories = [];
after(async () => { for (const root of directories) { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ruyi-root-authority-unit-')); await fsp.rm(root, { recursive: true, force: true }); } });
function machine(base) {
  const paths = Object.fromEntries([['data', base], ...['config', 'sessions', 'uploads', 'logs', 'generated', 'checkpoints', 'playbooks', 'skills', 'webcache', 'agentRuns', 'agentWorkflows', 'agentWorktrees', 'usage', 'memory'].map(name => [name, path.join(base, name === 'config' ? 'config.json' : name)])]);
  const context = { Buffer, process, require, paths, WorkDataRootHooks: {}, dataRoot: () => base, dataRootAliases: () => [], _workDataStableBase: null, _workDataStableAliases: null };
  vm.createContext(context);
  context.ServerOwnership = vm.runInContext(source('01g-server-ownership.js') + '\nServerOwnership;', context);
  context.WorkDataManifest = vm.runInContext(source('01v-work-data-manifest.js') + '\nWorkDataManifest;', context);
  const factory = vm.runInContext(source('01z-work-data-root-authority.js') + '\nWorkDataRootAuthority;', context);
  return { paths, context, factory };
}
async function fixture(mode = 'encrypted', baseAlias = false) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-root-authority-unit-')); directories.push(root);
  const real = path.join(root, 'real'), alias = path.join(root, 'old-custom-link'); await fsp.mkdir(real);
  if (baseAlias) await fsp.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base = baseAlias ? alias : real, activeId = 'a'.repeat(48), retainedId = 'b'.repeat(48);
  const active = path.join(real, '.work-data', 'generations', activeId), retained = path.join(real, '.work-data', 'generations', retainedId);
  await fsp.mkdir(active, { recursive: true }); await fsp.mkdir(retained);
  const pointer = path.join(real, '.work-data', 'active-v1.json');
  const manifest = { schema: 1, generation: 3, id: activeId, mode, activeRoot: 'generations/' + activeId };
  await fsp.writeFile(pointer, JSON.stringify(manifest) + '\n');
  const m = machine(base), canonical = await m.context.ServerOwnership.canonicalRoot(base);
  return { root, real, base, active, retained, pointer, manifest, ...m, owner: { roots: [canonical] } };
}
function guards(f, hooks = f.context.WorkDataRootHooks) {
  const text = source('03-bridge-guard.js'), kimi = source('05c-kimi-search-policy.js');
  const context = { path, fsp, process, dataRoot: () => f.base, dataRootAliases: () => [], _dataRootReal: f.real, paths: f.paths, WorkDataRootHooks: hooks };
  if (hooks === null) delete context.WorkDataRootHooks;
  const chunks = [functionBlock(text, 'pathWithinRoot'), functionBlock(text, 'isSensitiveDataPath'),
    constBlock(text, 'WRITE_PROTECTED_DATA_DIRS'), constBlock(text, 'WRITE_PROTECTED_DATA_FILES'), functionBlock(text, 'isWriteProtectedDataPath'),
    constBlock(text, 'SENSITIVE_HARDLINK_FILES'), functionBlock(text, 'sensitiveFileIdentities'), functionBlock(text, 'isSensitiveHardlinkStat'), functionBlock(text, 'isSensitiveHardlinkAlias'),
    functionBlock(source('11-native-tools.js'), 'sensitiveGlobsForRg'), functionBlock(kimi, 'kimiAcpSearchWithin'), functionBlock(kimi, 'kimiAcpSearchIsControlPlaneRoot')];
  return vm.runInNewContext(chunks.join('\n') + '\n({isSensitiveDataPath,isWriteProtectedDataPath,sensitiveFileIdentities,isSensitiveHardlinkAlias,sensitiveGlobsForRg,kimiAcpSearchIsControlPlaneRoot});', context);
}

test('no manifest, including a missing base, keeps legacy root strings, mode and exact paths without creating anything', async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-root-authority-unit-')); directories.push(parent);
  const base = path.join(parent, 'not-created'), m = machine(base), old = JSON.stringify(m.paths);
  const selected = await m.factory.bind({ roots: [await m.context.ServerOwnership.canonicalRoot(base)] });
  assert.equal(selected.present, false); assert.equal(m.factory.mode(false), false); assert.equal(m.factory.mode(true), true);
  assert.equal(JSON.stringify(m.paths), old); assert.equal(fs.existsSync(base), false); assert.equal(m.context._workDataStableBase, null);
});
test('a legacy custom junction remains the same visible paths and has no active mode authority', async () => {
  const f = await fixture('encrypted', true); await fsp.unlink(f.pointer); const before = JSON.stringify(f.paths);
  await f.factory.bind(f.owner); assert.equal(JSON.stringify(f.paths), before); assert.equal(f.factory.mode(false), false);
  assert.equal(f.context._workDataStableBase, null); assert.equal(fs.existsSync(path.join(f.real, 'work-data-key-v1.json')), false);
});
test('ownership is required before manifest selection and a failed binding cannot become OFF', async () => {
  const f = await fixture(), before = JSON.stringify(f.paths);
  await assert.rejects(f.factory.bind({ roots: [path.join(f.root, 'foreign')] }), { code: 'work_data_root.ownership_required' });
  assert.equal(JSON.stringify(f.paths), before); assert.throws(() => f.factory.mode(false), { code: 'work_data_root.unavailable' });
  await assert.rejects(f.factory.bind(f.owner), { code: 'work_data_root.already_bound' });
});
test('a real manifest through the legacy custom junction binds every path once and keeps the stable base for discovery', async () => {
  const f = await fixture('encrypted', true), selected = await f.factory.bind(f.owner);
  assert.equal(selected.present, true); assert.equal(selected.generation, 3); assert.equal(f.factory.mode(false), true);
  for (const value of Object.values(f.paths)) assert.ok(value === selected.root || value.startsWith(selected.root + path.sep));
  assert.equal(f.context._workDataStableBase, f.base); assert.equal(f.paths.config, path.join(selected.root, 'config.json'));
  const raw = fs.readFileSync(f.pointer, 'utf8'); await fsp.writeFile(f.pointer, JSON.stringify({ ...f.manifest, mode: 'plain' }));
  assert.equal(f.factory.mode(false), true); assert.equal(f.factory.selected().proof.raw, raw);
  await assert.rejects(f.factory.bind(f.owner), { code: 'work_data_root.already_bound' });
});
test('plain manifest overrides a stale manually enabled config; it never becomes an encryption toggle', async () => {
  const f = await fixture('plain'); await f.factory.bind(f.owner);
  assert.equal(f.factory.mode(true), false); assert.equal(f.factory.mode(false), false); assert.equal(f.factory.selected().mode, 'plain');
});
test('invalid, unsupported, traversal, invalid UTF8 and missing active roots refuse before rebasing or any writer', async () => {
  const variants = [Buffer.from('{'), Buffer.from([255]), JSON.stringify({ schema: 2 }), 'null',
    JSON.stringify({ schema: 1, generation: 1, id: 'c'.repeat(48), mode: 'encrypted', activeRoot: '../outside' }),
    JSON.stringify({ schema: 1, generation: 1, id: 'c'.repeat(48), mode: 'plain', activeRoot: 'generations/' + 'c'.repeat(48) })];
  for (const raw of variants) {
    const f = await fixture(), before = JSON.stringify(f.paths); await fsp.writeFile(f.pointer, raw);
    await assert.rejects(f.factory.bind(f.owner), error => error.code.startsWith('work_data_manifest.'));
    assert.equal(JSON.stringify(f.paths), before); assert.deepEqual(fs.readFileSync(f.pointer), Buffer.from(raw));
    assert.equal(fs.existsSync(path.join(f.active, 'sessions')), false); assert.throws(() => f.factory.mode(false), { code: 'work_data_root.unavailable' });
  }
});
test('hard-linked manifest authority refuses even when both names contain fully valid authenticated metadata', async () => {
  const f = await fixture(), before = JSON.stringify(f.paths); await fsp.link(f.pointer, path.join(f.root, 'pointer-alias'));
  await assert.rejects(f.factory.bind(f.owner), { code: 'work_data_root.manifest_alias' }); assert.equal(JSON.stringify(f.paths), before);
});
test('all asynchronous alias validation completes before namespace publication', async () => {
  const f = await fixture(), before = JSON.stringify(f.paths);
  const api = f.factory.create({ paths: f.paths, base: () => f.base, canonical: f.context.ServerOwnership.canonicalRoot,
    manifest: base => f.context.WorkDataManifest.create({ base }), aliases: async () => { throw Object.assign(new Error('alias unavailable'), { code: 'SYNTHETIC' }); } });
  await assert.rejects(api.bind(f.owner), { code: 'SYNTHETIC' }); assert.equal(JSON.stringify(f.paths), before);
});
test('active and retained generation sensitive subpaths remain protected while ordinary uploads/skills can be read', async () => {
  const f = await fixture(); await f.factory.bind(f.owner); const g = guards(f);
  for (const root of [f.real, f.active, f.retained]) for (const name of ['config.json', 'config.json.prev', 'runtime.json', 'sessions/a.json', 'memory/global/a.md', 'logs/a.ndjson', 'privacy-scopes/a.json', 'work-data-key-v1.json', 'work-data-key-v1.json.prev']) {
    assert.equal(g.isSensitiveDataPath(path.join(root, name)), true, name);
  }
  assert.equal(g.isSensitiveDataPath(path.join(f.real, '.work-data', 'active-v1.json')), true);
  assert.equal(g.isSensitiveDataPath(path.join(f.real, '.work-data', '.active-v1.stage-a.json')), true);
  assert.equal(g.isSensitiveDataPath(path.join(f.real, '.work-data')), false);
  for (const root of [f.active, f.retained]) for (const name of ['uploads/example.txt', 'skills/Tool_One/SKILL.md', 'checkpoints/readable.gz']) assert.equal(g.isSensitiveDataPath(path.join(root, name)), false);
  assert.equal(g.isWriteProtectedDataPath(path.join(f.active, 'uploads/example.txt')), false);
  assert.equal(g.isWriteProtectedDataPath(path.join(f.retained, 'uploads/example.txt')), true);
  assert.equal(g.isWriteProtectedDataPath(path.join(f.active, 'checkpoints/readable.gz')), true);
  assert.equal(g.isWriteProtectedDataPath(path.join(f.real, '.work-data')), true);
});
test('generation guards normalize Windows ADS/trailing aliases and remain self-contained without installed hooks', async () => {
  const f = await fixture('encrypted', true); await f.factory.bind(f.owner); const g = guards(f);
  const aliasGeneration = path.join(f.base, '.work-data', 'generations', f.manifest.id);
  assert.equal(g.isSensitiveDataPath(path.join(aliasGeneration, 'config.json.::$DATA')), true);
  assert.equal(g.isSensitiveDataPath(path.join(aliasGeneration, 'sessions.::$INDEX_ALLOCATION', 's.json')), true);
  const old = guards(f, null); assert.equal(old.isSensitiveDataPath(path.join(f.base, 'config.json')), true);
  assert.equal(old.isSensitiveDataPath(path.join(f.active, 'config.json')), false);
});
test('hardlink identities cover base, retained/active private trees, key envelopes and manifest/control stages', async () => {
  const f = await fixture(); await f.factory.bind(f.owner); const g = guards(f);
  const files = [path.join(f.real, 'config.json.prev'), path.join(f.active, 'work-data-key-v1.json'), path.join(f.retained, 'sessions', 'private.json'), path.join(f.real, '.work-data', '.active-v1.stage-test.json')];
  for (let i = 0; i < files.length; i++) {
    await fsp.mkdir(path.dirname(files[i]), { recursive: true }); await fsp.writeFile(files[i], 'PRIVATE_SYNTHETIC');
    await fsp.link(files[i], path.join(f.root, 'alias-' + i));
  }
  const identities = await g.sensitiveFileIdentities();
  for (let i = 0; i < files.length; i++) assert.equal(await g.isSensitiveHardlinkAlias(path.join(f.root, 'alias-' + i), identities), true);
  const ordinary = path.join(f.active, 'uploads', 'ordinary.txt'); await fsp.mkdir(path.dirname(ordinary)); await fsp.writeFile(ordinary, 'ordinary');
  await fsp.link(ordinary, path.join(f.root, 'ordinary-alias')); assert.equal(await g.isSensitiveHardlinkAlias(path.join(f.root, 'ordinary-alias')), false);
});
test('unknown identity census under a selected authority refuses aliases rather than permitting a private hardlink', async () => {
  const f = await fixture(); await f.factory.bind(f.owner); const broken = { ...f.context.WorkDataRootHooks, hardlinkIdentities: async () => { throw Error('unknown'); } }, g = guards(f, broken);
  const file = path.join(f.root, 'file'); await fsp.writeFile(file, 'x'); await fsp.link(file, path.join(f.root, 'link'));
  assert.equal(await g.isSensitiveHardlinkAlias(file), true);
});
test('native ripgrep rejects control/generation roots but allows active ordinary content directories', async () => {
  const f = await fixture(); await f.factory.bind(f.owner); const g = guards(f), info = { lexical: f.base, canonical: f.real };
  for (const candidate of [f.real, path.join(f.real, '.work-data'), path.join(f.real, '.work-data', 'generations'), f.active, f.retained]) assert.equal(g.kimiAcpSearchIsControlPlaneRoot(candidate, info), true);
  assert.equal(g.kimiAcpSearchIsControlPlaneRoot(path.join(f.active, 'uploads'), info), false);
  const globs = g.sensitiveGlobsForRg(f.real); assert.ok(globs.some(value => value.includes('/generations/*/sessions'))); assert.equal(globs.includes('!/.work-data'), false);
});
test('each legacy OFF fallback in a managed writer is forced by an active manifest or rejects an unknown authority', async () => {
  const names = ['02-session-store.js', '05-claude-engine.js', '06-provider-engine.js', '06d-memory-domain.js', '13i-steward-inbox.js', '13j-steward-tool-base.js']; let count = 0;
  for (const name of names) {
    const matches = source(name).match(/readConfig\(\)\.then\(config => config\.workDataEncryptionV1 === true\)\.catch\([^\n;]+/g) || [];
    for (let expression of matches) {
      expression = expression.slice(0, expression.indexOf('),') >= 0 ? expression.lastIndexOf(')') + 1 : expression.length);
      if (expression.endsWith(',')) expression = expression.slice(0, -1);
      for (const enabled of [false, true]) {
        const answer = await vm.runInNewContext(expression, { readConfig: async () => { throw Error('unreadable'); }, WorkDataRootHooks: { mode: () => enabled } });
        assert.equal(answer, enabled, name);
      }
      await assert.rejects(vm.runInNewContext(expression, { readConfig: async () => { throw Error('unreadable'); }, WorkDataRootHooks: { mode: () => { throw Object.assign(Error('unknown'), { code: 'work_data_root.unavailable' }); } } }), { code: 'work_data_root.unavailable' });
      count++;
    }
  }
  assert.equal(count, 9);
});
test('session body catch-null never writes plaintext for a selected encrypted manifest and preserves legacy OFF behavior', async () => {
  const text = functionBlock(source('02-session-store.js'), 'sessionBodyWriteText');
  const context = { readConfig: async () => { throw Error('unreadable'); }, WorkDataRootHooks: { mode: () => true }, sessionBodyCodec: () => ({ sessionId: 's', kind: 'messages' }),
    WorkDataStore: { acquireSnapshot: async () => ({ key: Buffer.alloc(32), instanceId: 'i', release: async () => {} }) }, workDataKeys: {},
    WorkDataRecords: { encodeLine: () => 'SEALED_SYNTHETIC' } };
  const write = vm.runInNewContext(text + '\nsessionBodyWriteText;', context);
  assert.equal(await write('s.messages.ndjson', ['SECRET']), 'SEALED_SYNTHETIC\n');
  delete context.WorkDataRootHooks; assert.equal(await write('s.messages.ndjson', ['SECRET']), 'SECRET\n');
});
test('the synchronous exit-index raw fast path cannot persist plaintext under an encrypted manifest', () => {
  let writes = 0;
  const context = { pendingSessionIndex: new Map([['s', {}]]), inflightSessionIndex: new Map(), WorkDataRootHooks: { mode: () => true }, fs: new Proxy({}, { get: () => () => { writes++; throw Error('unexpected'); } }) };
  const flush = vm.runInNewContext(functionBlock(source('02-session-store.js'), 'flushSessionIndexSync') + '\nflushSessionIndexSync;', context);
  flush(); assert.equal(writes, 0);
});
test('direct config persistence projects only the manifest-derived mirror without changing unrelated explicit fields', () => {
  const code = functionBlock(source('01-config.js'), 'persistableConfig');
  const context = { WorkDataRootHooks: { guarded: () => true, mode: () => false }, CONFIG_BOOKKEEPING_KEYS: [], CONFIG_SCHEMA: 1, VERSION: '3.0.1', configComparableValue: (config, key) => config[key] };
  const persist = vm.runInNewContext(code + '\npersistableConfig;', context);
  const saved = persist({ workDataEncryptionV1: true, useful: 7, configExplicitKeysV1: ['useful'] }, { workDataEncryptionV1: false });
  assert.equal(saved.workDataEncryptionV1, false); assert.equal(saved.useful, 7);
  delete context.WorkDataRootHooks; const old = persist({ workDataEncryptionV1: false, configExplicitKeysV1: [] }, { workDataEncryptionV1: false }); assert.equal(Object.hasOwn(old, 'workDataEncryptionV1'), false);
});
test('generation-specific MCP drop-in discovery follows active paths rather than the stable relay base', async () => {
  const f = await fixture(); await f.factory.bind(f.owner);
  const fn = vm.runInNewContext(functionBlock(source('04-permission-runtime.js'), 'mcpDropInDirs') + '\nmcpDropInDirs;', { path, paths: f.paths, dataRoot: () => f.base, externalRoot: () => '/synthetic-install' });
  assert.equal(fn()[1].root, path.join(f.paths.data, 'mcp'));
});
test('runtime discovery continues reading the stable base after every managed data path is rebound', async () => {
  const f = await fixture(); await f.factory.bind(f.owner); await fsp.writeFile(path.join(f.base, 'runtime.json'), '{"port":1234}');
  const read = vm.runInNewContext(functionBlock(source('13-http-router.js'), 'readOwnRuntimeRecord') + '\nreadOwnRuntimeRecord;', { path, fsp, paths: f.paths, dataRoot: () => f.base, safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } } });
  assert.equal((await read()).port, 1234);
});
test('serve selects under the existing OS owner before inner startup; an invalid manifest never reaches its error writer', async () => {
  for (const bad of [false, true]) {
    const f = await fixture(); if (bad) await fsp.writeFile(f.pointer, '{'); const events = [];
    const context = { path, fs, process, paths: f.paths, dataRoot: () => f.base, resolveBindHost: () => '127.0.0.1', defaultDataRoots: () => ({ next: f.base, legacy: f.base }), lstatOrNull: () => null,
      isDirectServeInvocation: () => false, ServerOwnership: { acquire: async () => { events.push('owner'); return f.owner; } }, WorkDataRootHooks: f.factory,
      startServerInner: async () => { assert.equal(f.factory.ready(), true); assert.equal(f.paths.data, f.factory.selected().root); events.push('inner'); return 'served'; },
      finishBootCliPathProbes: () => events.push('finish'), writeStartError: async () => events.push('error-write'), START_ERROR_KINDS: [], PrivacyCore: { configHooks: {} } };
    const start = vm.runInNewContext(functionBlock(source('13-http-router.js'), 'startServer') + '\nstartServer;', context);
    if (bad) { await assert.rejects(start({})); assert.deepEqual(events, ['owner', 'finish']); }
    else { assert.equal(await start({}), 'served'); assert.deepEqual(events, ['owner', 'inner', 'finish']); }
  }
});
test('one-shot config-reading CLI commands acquire/select first and keep ownership through config/audit flushes', async () => {
  for (const command of ['install', 'doctor', 'mcp-config', 'mcp']) {
    const events = [], text = source('14-main.js');
    const context = { parseArgs: () => ({ _: [command] }), process: { argv: ['node', 'server.js', command] }, dataRoot: () => '/synthetic-base',
      ServerOwnership: { acquire: async () => { events.push('owner'); return { release: async () => events.push('release') }; } },
      WorkDataRootHooks: { bind: async () => events.push('bind'), ready: () => true }, configMutateChain: Promise.resolve(), configWriteChain: Promise.resolve(), flushWorkbenchLogs: async () => events.push('flush'),
      installIntegration: async () => events.push('install'), doctor: async () => events.push('doctor'), generateMcpConfig: async () => { events.push('mcp-config'); return ''; }, startMcp: async () => events.push('relay'), console: { log() {} } };
    const main = vm.runInNewContext(functionBlock(text, 'withSelectedWorkDataRoot') + '\n' + functionBlock(text, 'main') + '\nmain;', context);
    await main(); assert.deepEqual(events, command === 'mcp' ? ['relay'] : ['owner', 'bind', command, 'flush', 'release']);
  }
});

test('independent challenge: case-equivalent physical generation names retain private hardlink identity protection', async () => {
  const f = await fixture();
  const upper = path.join(path.dirname(f.active), path.basename(f.active).toUpperCase());
  await fsp.rename(f.active, upper);
  await f.factory.bind(f.owner);
  const privateFile = path.join(f.paths.data, 'sessions', 'private.json');
  await fsp.mkdir(path.dirname(privateFile), { recursive: true });
  await fsp.writeFile(privateFile, 'SYNTHETIC_ONLY_PRIVATE');
  const alias = path.join(f.root, 'public-alias'); await fsp.link(privateFile, alias);
  assert.equal(await guards(f).isSensitiveHardlinkAlias(alias), true);
});

test('independent challenge: case-equivalent GENERATIONS container does not classify ordinary uploads hardlinks as private', async () => {
  const f = await fixture();
  const parent = path.dirname(f.active), upper = path.join(path.dirname(parent), 'GENERATIONS');
  await fsp.rename(parent, upper);
  await f.factory.bind(f.owner);
  const ordinary = path.join(f.paths.data, 'uploads', 'ordinary.txt');
  await fsp.mkdir(path.dirname(ordinary), { recursive: true }); await fsp.writeFile(ordinary, 'SYNTHETIC_ONLY_ORDINARY');
  const alias = path.join(f.root, 'ordinary-alias'); await fsp.link(ordinary, alias);
  assert.equal(await guards(f).isSensitiveHardlinkAlias(alias), false);
});

test('independent challenge: unknown reserved names under generations retain control hardlink protection', async () => {
  const f = await fixture(); await f.factory.bind(f.owner);
  const privateFile = path.join(path.dirname(f.active), 'unknown-reserved', 'private.bin');
  await fsp.mkdir(path.dirname(privateFile), { recursive: true }); await fsp.writeFile(privateFile, 'SYNTHETIC_ONLY_RESERVED');
  const alias = path.join(f.root, 'reserved-alias'); await fsp.link(privateFile, alias);
  const g = guards(f); assert.equal(g.isSensitiveDataPath(privateFile), true);
  assert.equal(await g.isSensitiveHardlinkAlias(alias), true);
});

test('independent challenge: a 48hex ordinary file is reserved control rather than a readable generation container', async () => {
  const f = await fixture(), invalidRoot = path.join(path.dirname(f.active), 'c'.repeat(48));
  await fsp.writeFile(invalidRoot, 'SYNTHETIC_ONLY_RESERVED_FILE');
  try { await f.factory.bind(f.owner); }
  catch (error) { assert.ok(String(error.code).startsWith('work_data_root.')); return; }
  assert.equal(guards(f).isSensitiveDataPath(invalidRoot), true);
});

test('independent challenge: no-manifest reserved control and candidate private hardlinks remain private', async () => {
  const f = await fixture(); await fsp.unlink(f.pointer); await f.factory.bind(f.owner);
  const targets = [path.join(f.real, '.work-data', 'pending-control.bin'), path.join(f.active, 'sessions', 'private.json')];
  for (let index = 0; index < targets.length; index++) {
    const file = targets[index]; await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, 'SYNTHETIC_ONLY_PENDING');
    const alias = path.join(f.root, 'pending-alias-' + index); await fsp.link(file, alias);
    const g = guards(f); assert.equal(g.isSensitiveDataPath(file), true);
    assert.equal(await g.isSensitiveHardlinkAlias(alias), true);
  }
});

test('independent challenge: no-manifest unselected candidate private hardlink is not the legacy base fast path', async () => {
  const f = await fixture(); await fsp.unlink(f.pointer); await f.factory.bind(f.owner);
  const file = path.join(f.active, 'sessions', 'private.json'); await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, 'SYNTHETIC_ONLY_CANDIDATE');
  const alias = path.join(f.root, 'candidate-alias'); await fsp.link(file, alias);
  const g = guards(f); assert.equal(g.isSensitiveDataPath(file), true); assert.equal(await g.isSensitiveHardlinkAlias(alias), true);
});

test('reserved control without a manifest protects aliases while preserving legacy config mirror and strict audit validation', async () => {
  const f = await fixture(); await fsp.unlink(f.pointer); await f.factory.bind(f.owner);
  assert.equal(f.factory.hasReserved(), true); assert.equal(f.factory.hardlinkGuarded(), true); assert.equal(f.factory.guarded(), false);
  assert.equal(f.factory.mode(true), true); assert.equal(f.factory.mode(false), false);
  const persist = vm.runInNewContext(functionBlock(source('01-config.js'), 'persistableConfig') + '\npersistableConfig;', {
    WorkDataRootHooks: f.factory, CONFIG_BOOKKEEPING_KEYS: [], CONFIG_SCHEMA: 1, VERSION: '3.0.1', configComparableValue: (config, key) => config[key],
  });
  assert.equal(persist({ workDataEncryptionV1: true, configExplicitKeysV1: ['workDataEncryptionV1'] }, { workDataEncryptionV1: false }).workDataEncryptionV1, true);
  assert.equal(Object.hasOwn(persist({ workDataEncryptionV1: false, configExplicitKeysV1: [] }, { workDataEncryptionV1: false }), 'workDataEncryptionV1'), false);
  await fsp.writeFile(f.paths.config, '{"workDataEncryptionV1":"invalid"}');
  const audit = vm.runInNewContext(functionBlock(source('04-permission-runtime.js'), 'auditLogEnabled') + '\nauditLogEnabled;', {
    fsp, path, paths: f.paths, WorkDataRootHooks: f.factory, PrivacyCore: { configHooks: {} }, configMutateChain: Promise.resolve(), configWriteChain: Promise.resolve(),
    configReadGeneration: 0, configDegraded: false, safeJsonParse: text => JSON.parse(text), normalizeConfig: raw => ({ config: raw }),
    auditLogError: error => Object.assign(new Error(error.code), { code: error.code }),
  });
  await assert.rejects(audit(), { code: 'work_data_audit.switch_unavailable' });
});
test('a 48hex regular file stays reserved private and cannot borrow a real generation directory read exemption', async () => {
  const f = await fixture(), file = path.join(path.dirname(f.active), 'd'.repeat(48)), alias = path.join(f.root, 'hex-file-alias');
  await fsp.writeFile(file, 'SYNTHETIC_RESERVED'); await fsp.link(file, alias); await f.factory.bind(f.owner);
  assert.equal(f.factory.ready(), true); const g = guards(f);
  assert.equal(g.isSensitiveDataPath(file), true); assert.equal(await g.isSensitiveHardlinkAlias(alias), true);
  assert.equal(g.isSensitiveDataPath(path.join(f.active, 'uploads', 'ordinary.txt')), false);
});
test('no-control legacy retains the original hardlink fast path without invoking the reserved namespace census', async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-root-authority-unit-')); directories.push(parent);
  const base = path.join(parent, 'legacy'); await fsp.mkdir(base); const m = machine(base), owner = { roots: [await m.context.ServerOwnership.canonicalRoot(base)] };
  await m.factory.bind(owner); assert.equal(m.factory.hasReserved(), false); assert.equal(m.factory.hardlinkGuarded(), false);
  const config = path.join(base, 'config.json'), alias = path.join(parent, 'old-config-alias'); await fsp.writeFile(config, '{}'); await fsp.link(config, alias);
  const hooks = { ...m.context.WorkDataRootHooks, hardlinkIdentities: async () => { assert.fail('legacy must keep the old census'); } };
  assert.equal(await guards({ ...m, base, real: base }, hooks).isSensitiveHardlinkAlias(alias), true);
});
test('late reserved paths require an explicit owner-checked refresh and never rebind namespace or mode', async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-root-authority-unit-')); directories.push(parent);
  const base = path.join(parent, 'legacy'); await fsp.mkdir(base); const m = machine(base), owner = { roots: [await m.context.ServerOwnership.canonicalRoot(base)] };
  await m.factory.bind(owner); const before = JSON.stringify(m.paths), selected = m.factory.selected();
  const candidate = path.join(base, '.work-data', 'generations', 'e'.repeat(48));
  const pending = path.join(base, '.work-data', 'pending.bin'), privateFile = path.join(candidate, 'sessions', 'private.json');
  await fsp.mkdir(path.dirname(privateFile), { recursive: true }); await fsp.writeFile(privateFile, 'SYNTHETIC_CANDIDATE'); await fsp.writeFile(pending, 'SYNTHETIC_PENDING');
  await fsp.link(pending, path.join(parent, 'pending-alias')); await fsp.link(privateFile, path.join(parent, 'candidate-alias'));
  assert.equal(m.factory.hardlinkGuarded(), false); // Bind-time facts deliberately do not promise dynamic discovery.
  await assert.rejects(m.factory.refreshReserved({ roots: [parent] }), { code: 'work_data_root.ownership_required' });
  assert.equal(m.factory.hardlinkGuarded(), false);
  await m.factory.refreshReserved(owner);
  assert.equal(m.factory.hardlinkGuarded(), true); assert.equal(m.factory.guarded(), false); assert.equal(m.factory.mode(true), true); assert.equal(m.factory.mode(false), false);
  assert.equal(m.factory.selected(), selected); assert.equal(JSON.stringify(m.paths), before);
  const g = guards({ ...m, base, real: base });
  assert.equal(await g.isSensitiveHardlinkAlias(path.join(parent, 'pending-alias')), true);
  assert.equal(await g.isSensitiveHardlinkAlias(path.join(parent, 'candidate-alias')), true);
  assert.equal(g.isSensitiveDataPath(path.join(candidate, 'uploads', 'ordinary.txt')), false);
});
