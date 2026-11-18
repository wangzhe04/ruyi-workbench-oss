'use strict';
// Real memory preflight and files; synthetic encoder tests authority/ranking only.
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { createRunner } = require('./lib/harness');
const t = createRunner('MEMORY SEMANTIC'), { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-semantic-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home; process.env.RUYI_DISABLE_SEMANTIC = '1';
const config = { configSchema: 9, permissionMode: 'bypass', semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: true,
  memoryRelevanceMaxV1: 8, autoImportClaudeCodeMcp: false };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
const app = path.resolve(__dirname, '../ruyi-workbench/app');
const manifest = JSON.parse(fs.readFileSync(path.join(app, 'src/manifest.json'), 'utf8'));
const source = manifest.modules.map(m => fs.readFileSync(path.join(app, 'src', typeof m === 'string' ? m : m.file), 'utf8')).join('\n');
const mod = new Module(path.join(app, 'server.js'), module); mod.filename = path.join(app, 'server.js'); mod.paths = Module._nodeModulePaths(app);
mod._compile(source + '\nmodule.exports.__test={resolveMemoryPreflight,buildMemoryPromptSection,memorySemanticBudgetSafe,proposeMemoryRelation,confirmMemoryRelation,setMemoryReader:fn=>{const old=MemoryCliHooks.readerTool;MemoryCliHooks.readerTool=fn;return old;},setRuntime:hooks=>Object.assign(SemanticRuntimeHooks,hooks),clearSemantic:()=>MemorySemanticHooks.clear()};', mod.filename);
const srv = mod.exports;
const ids = entries => entries.map(entry => entry.id).sort().join(',');
(async () => {
  try {
    const cwd = path.join(home, 'project-a'), other = path.join(home, 'project-b'); fs.mkdirSync(cwd); fs.mkdirSync(other);
    const session = await srv.createSession({ title: 'memory semantic test', cwd }); session.turnSeq = 1;
    const save = async (id, name, extra = {}, target = cwd) => {
      const result = await srv.saveMemory({ id, scope: 'project', type: 'reference', name, description: name, body: 'body not encoded ' + id, ...extra }, target);
      if (!result.ok) throw Error('fixture save failed'); return result;
    };
    await save('alpha-one', 'alpha first'); await save('alpha-two', 'alpha beta second');
    await save('rule-fill', '稳定规则', { type: 'convention' });
    await save('core-rule', 'alpha core-secret', { type: 'preference', core: true });
    await save('expired', 'alpha expired-secret', { expiresAt: '2000-01-01T00:00:00.000Z' });
    await save('other-project', 'alpha other-project-secret', {}, other);
    const seen = []; let onEncode = null, encodeCalls = 0;
    const ready = () => ({ available: true, modelFingerprint: 'synthetic-memory-model', retrievalThresholds: { search: .22, automatic: null } });
    const encode = async (texts, { role }) => {
      encodeCalls++; seen.push(...texts); if (onEncode) { const action = onEncode; onEncode = null; await action(); }
      return { ok: true, modelFingerprint: 'synthetic-memory-model', vectors: texts.map(text => role === 'query' || text.includes('beta') ? [1, 0] : [0, 1]), truncated: texts.map(() => false) };
    };
    srv.__test.setRuntime({ prepare: async () => ready(), encode });
    const baseline = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, { ...config, semanticRetrievalV1: false });
    const result = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, config);
    ok(result.status.semantic?.status === 'reranked' && result.status.semantic.automaticCandidates === false, 'real preflight reports rerank-only with no automatic candidates');
    ok(ids(result.entries) === ids(baseline.entries) && result.entries[0]?.id === 'alpha-two', 'semantic reranking changes order while preserving the previous candidate membership');
    ok(result.entries.findIndex(entry => entry.id === 'rule-fill') === baseline.entries.findIndex(entry => entry.id === 'rule-fill') && result.status.ruleFillCount === baseline.status.ruleFillCount, 'rule fill positions and counts remain intact');
    ok(result.coreEntries.some(entry => entry.id === 'core-rule') && !seen.some(text => /core-secret|expired-secret|other-project-secret|body not encoded/.test(text)), 'encoder sees only eligible non-core memory headers');
    const budgetConfig = { ...config, memoryIndexCharCapV1: 500 }, beforeBudget = encodeCalls;
    const budget = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, budgetConfig);
    const render = entries => srv.__test.buildMemoryPromptSection(entries, 'openai', budgetConfig, null, { part: 'related' });
    ok(budget.status.semantic?.status === 'budget' && encodeCalls === beforeBudget && render(budget.entries) === render(baseline.entries), 'character budget boundaries preserve the exact baseline prompt and avoid encoding');
    const reader = srv.__test.setMemoryReader(() => 'mcp__' + 'x'.repeat(100000) + '__workbench_memory_read');
    try { ok(!srv.__test.memorySemanticBudgetSafe(baseline.entries, { ...config, workDataEncryptionV1: true }), 'encrypted CLI reader names are included in the character budget safety check'); }
    finally { srv.__test.setMemoryReader(reader); }
    const beforeFixed = encodeCalls;
    const fixed = await srv.__test.resolveMemoryPreflight({ ...session, memoriesExplicit: true, memories: [{ id: 'alpha-one', scope: 'project' }] }, cwd, 'alpha', null, config);
    ok(ids(fixed.entries) === 'alpha-one' && encodeCalls === beforeFixed && fixed.status.mode === 'fixed', 'fixed selections bypass semantic preparation and encoding');
    srv.__test.clearSemantic(); const beforePrepareRevocation = encodeCalls;
    srv.__test.setRuntime({ prepare: async () => {
      await Promise.resolve(); session.memoryExclusions = [{ id: 'alpha-one', scope: 'project' }]; return ready();
    }, encode });
    const prepareRevoked = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha preparation-revocation', null, config);
    ok(prepareRevoked.status.mode === 'stale' && !prepareRevoked.entries.length && !prepareRevoked.coreEntries.length && encodeCalls === beforePrepareRevocation,
      'revocation during scorer preparation prevents any header or query from reaching encode');
    session.memoryExclusions = [];
    srv.__test.setRuntime({ prepare: async () => ({ available: false, reason: 'unavailable', state: 'loading' }) });
    const loading = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, config);
    ok(ids(loading.entries) === ids(baseline.entries) && loading.status.semantic.status === 'loading', 'cold model loading preserves the entire previous ranking');
    srv.__test.setRuntime({ prepare: async () => ready(), encode });
    const race = async (query, action) => { srv.__test.clearSemantic(); onEncode = action; return srv.__test.resolveMemoryPreflight(session, cwd, query, null, config); };
    let raced = await race('alpha selection-race', () => { session.memoryExclusions = [{ id: 'alpha-one', scope: 'project' }]; });
    ok(raced.status.mode === 'stale' && !raced.entries.length && !raced.coreEntries.length, 'selection revocation during encoding prevents all disclosure'); session.memoryExclusions = [];
    raced = await race('alpha metadata-race', () => save('alpha-one', 'alpha changed header'));
    ok(raced.status.mode === 'stale' && !raced.entries.length, 'memory metadata revisions are revalidated after encoding');
    raced = await race('alpha turn-race', () => { session.turnSeq++; });
    ok(raced.status.mode === 'stale' && !raced.entries.length, 'a changed turn cannot receive the old ranking');
    raced = await race('alpha config-race', () => { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, semanticRetrievalV1: false })); });
    ok(raced.status.mode === 'stale' && !raced.entries.length, 'direct configuration changes during encoding are detected without relying only on generation');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    srv.__test.clearSemantic(); onEncode = () => { throw Object.assign(Error('work_data.key_unavailable'), { code: 'work_data.key_unavailable' }); };
    let keyFailed = false; try { await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha key-race', null, config); } catch (error) { keyFailed = error.code === 'work_data.key_unavailable'; }
    ok(keyFailed, 'key or authority failure propagates instead of falling back');
    let ownerAborted = false;
    try { await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha owner-cancel', null, { ...config, semanticRetrievalV1: false }, { executionOwner: { cancelRequested: true } }); }
    catch (error) { ownerAborted = error.name === 'AbortError' && error.memorySemanticGuardFailure === true; }
    ok(ownerAborted, 'a cancelled execution owner aborts before activeChildren registration even with semantic disabled');
    const frozen = Object.freeze(Error('custom-authority-failure')); let wrapped = false;
    try { await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha custom-owner', null, config, { executionOwnerCurrent: () => { throw frozen; } }); }
    catch (error) { wrapped = error.code === 'memory_semantic.guard_failed' && error.memorySemanticGuardFailure === true && error.cause === frozen; }
    ok(wrapped, 'non-extensible authority failures carry a fail-closed marker and original cause');
    srv.__test.clearSemantic(); let authorityRevoked = false, authorityChecks = 0, authorityRefused = false;
    onEncode = () => { authorityRevoked = true; };
    try { await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha dynamic-authority', null, config, { executionOwnerRevalidate: async () => {
      authorityChecks++; if (authorityRevoked) throw Object.assign(Error('custom permission changed'), { code: 'permission.changed' });
    } }); }
    catch (error) { authorityRefused = error.code === 'permission.changed' && error.memorySemanticGuardFailure === true; }
    ok(authorityRefused && authorityChecks > 1, 'dynamic execution authority is revalidated across asynchronous guard boundaries');
    for (const [from, to] of [['alpha-one', 'alpha-two'], ['alpha-two', 'alpha-one']]) {
      const relation = await srv.__test.proposeMemoryRelation({ type: 'supersedes', from, to, scope: 'project' }, cwd);
      if (!relation.ok) throw Error('relation fixture failed'); await srv.__test.confirmMemoryRelation(relation.relation.id, cwd);
    }
    const cycleBaseline = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, { ...config, semanticRetrievalV1: false });
    srv.__test.clearSemantic(); const cycle = await srv.__test.resolveMemoryPreflight(session, cwd, 'alpha', null, config);
    ok(ids(cycle.entries) === ids(cycleBaseline.entries), 'supersedes cycle survivors are selected by original baseline order');
  } finally {
    srv.__test.clearSemantic();
    if (path.dirname(home) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('ruyi-memory-semantic-')) throw Error('fixture cleanup outside owned temp');
    fs.rmSync(home, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { t.fail(error.stack || error.message); t.done(); });
