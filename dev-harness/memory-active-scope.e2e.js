'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const cp = require('child_process');
const { spawnMcpInApp } = require('./lib/internal-mcp-fixture');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('MEMORY ACTIVE SCOPE'), { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-active-'));
const home = path.join(root, 'home'), work = path.join(root, 'work'); fs.mkdirSync(home); fs.mkdirSync(work);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const s = loadServerInternals(['saveMemory', 'createSession', 'saveSession', 'listWorkbenchMemories', 'readWorkbenchMemory',
  'readMemoryItem', 'loadMemoryRegistry', 'projectKeyForCwd', 'proposeMemoryRelation', 'confirmMemoryRelation', 'deleteMemoryRelation', 'activeChildren', 'runSessionTurn', 'loadSession', 'startServer', 'RUNTIME', 'recordSessionExecutionOwner', 'registerSessionExecutionChild', 'turnSettlers', 'InternalMcpRelay'], { withEval: true });
const config = { defaultWorkspace: work, permissionMode: 'bypass', includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], stewardEnabledV1: false, toolLoadingMode: 'full', subagentMaxPerTurn: 0 };
let fake, mcp;
const ctx = session => ({ session, sessionId: session.id, turnSeq: session.turnSeq, workingDir: work, config });
(async () => {
  try {
    for (const [id, scope, extra] of [['old', 'project', {}], ['replacement', 'project', {}], ['shared', 'global', {}], ['expired', 'project', { expiresAt: '2020-01-01' }]]) {
      await s.saveMemory({ id, scope, type: 'lesson', name: id, description: '统计口径 ' + id, body: 'BODY_' + id, ...extra }, work);
    }
    const session = await s.createSession({ title: 'scope', cwd: work }); session.turnSeq = 1;
    s.activeChildren.set(session.id, { state: 'running', session });
    session.memoriesExplicit = true; session.memories = [];
    ok((await s.listWorkbenchMemories({}, ctx(session))).count === 0, 'explicit off lists nothing');
    ok(!(await s.readWorkbenchMemory({ id: 'old' }, ctx(session))).ok, 'explicit off rejects guessed IDs');
    session.memories = [{ id: 'old', scope: 'project', projectKey: s.projectKeyForCwd(work) }];
    const fixed = await s.listWorkbenchMemories({}, ctx(session));
    ok(fixed.count === 1 && fixed.memories[0].id === 'old', 'fixed set never expands');
    ok(!(await s.readWorkbenchMemory({ id: 'shared', scope: 'global' }, ctx(session))).ok, 'fixed set cannot read an unselected global item');
    session.memories[0].projectKey = 'foreign-project';
    ok((await s.listWorkbenchMemories({}, ctx(session))).count === 0, 'project lock rejects a same-ID substitute');
    session.memoriesExplicit = false; session.memoryExclusions = [{ id: 'old', scope: 'project' }];
    const excluded = await s.listWorkbenchMemories({}, ctx(session));
    ok(!excluded.memories.some(e => ['old', 'expired'].includes(e.id)), 'default list respects exclusion and expiry');
    ok(!(await s.readWorkbenchMemory({ id: 'old' }, ctx(session))).ok && !(await s.readWorkbenchMemory({ id: 'expired' }, ctx(session))).ok, 'direct reads respect exclusion and expiry');
    ok(!(await s.listWorkbenchMemories({}, { ...ctx(session), sessionId: '../bad' })).ok, 'invalid session binding cannot broaden access');
    ok((await s.readMemoryItem('expired', 'project', work)).ok, 'management read still allows editing expired entries');
    session.memoryExclusions = [];
    const relation = await s.proposeMemoryRelation({ type: 'supersedes', from: 'replacement', to: 'old', scope: 'project' }, work);
    await s.confirmMemoryRelation(relation.relation.id, work);
    const old = await s.readWorkbenchMemory({ id: 'old' }, ctx(session));
    ok(old.ok && old.memory.superseded && old.memory.supersededBy.includes('replacement'), 'confirmed replacement is visible as historical applicability warning');
    session.memoriesExplicit = true; session.memories = [{ id: 'old', scope: 'project' }];
    const onlyOld = await s.readWorkbenchMemory({ id: 'old' }, ctx(session));
    ok(onlyOld.ok && onlyOld.memory.superseded && !onlyOld.memory.supersededBy.length && !onlyOld.memory.body.includes('BODY_replacement'), 'fixed old selection warns without leaking excluded replacement identity');

    // Pause real disk-backed read at an await; selection, stop, replacement turn and library changes must discard it.
    const latch = s.__eval('(() => { const original = readMemoryItem; let release; readMemoryItem = async (...args) => { const r = await original(...args); await new Promise(resolve => { release = resolve; }); return r; }; return { waiting: () => !!release, release: () => { release(); release = null; }, restore: () => { readMemoryItem = original; } }; })()');
    for (const mutation of ['selection', 'stop', 'turn', 'library', 'relation', 'disk-copy']) {
      session.memoriesExplicit = false; session.memories = []; session.turnSeq = 1;
      const reg = { state: 'running', session }; s.activeChildren.set(session.id, reg);
      if (mutation === 'disk-copy') { s.activeChildren.delete(session.id); await s.saveSession(session); }
      const pending = s.readWorkbenchMemory({ id: 'old' }, mutation === 'disk-copy' ? { sessionId: session.id, turnSeq: 1, workingDir: work, config } : ctx(session));
      for (let i = 0; i < 100 && !latch.waiting(); i++) await new Promise(r => setTimeout(r, 10));
      if (!latch.waiting()) throw new Error('read did not reach disk boundary');
      if (mutation === 'selection') { session.memoriesExplicit = true; session.memories = []; }
      if (mutation === 'stop') reg.state = 'stopped';
      if (mutation === 'turn') s.activeChildren.set(session.id, { state: 'running', session: { ...session, turnSeq: 2 } });
      if (mutation === 'library') await s.saveMemory({ id: 'old', scope: 'project', name: 'old changed', description: 'changed', body: 'CHANGED' }, work);
      if (mutation === 'relation') await s.deleteMemoryRelation(relation.relation.id, work);
      if (mutation === 'disk-copy') { const fresh = await s.loadSession(session.id); fresh.memoriesExplicit = true; fresh.memories = []; await s.saveSession(fresh); }
      latch.release();
      ok(!(await pending).ok, 'late read discarded after ' + mutation);
      s.activeChildren.delete(session.id);
    }
    latch.restore();

    session.memoriesExplicit = false; session.memories = []; s.activeChildren.set(session.id, { state: 'running', session });
    const usageLatch = s.__eval('(() => { const original = touchMemoryUsage; let release; touchMemoryUsage = async () => { await new Promise(resolve => { release = resolve; }); }; return { waiting: () => !!release, release: () => { release(); release = null; }, restore: () => { touchMemoryUsage = original; } }; })()');
    for (const tool of ['read', 'list']) {
      await s.saveMemory({ id: 'expiry', scope: 'project', name: 'expiry marker', description: 'expiry marker', body: 'SECRET_EXPIRY', expiresAt: new Date(Date.now() + 30000).toISOString() }, work);
      const pending = tool === 'read' ? s.readWorkbenchMemory({ id: 'expiry' }, ctx(session)) : s.listWorkbenchMemories({ query: 'expiry marker' }, ctx(session));
      for (let i = 0; i < 100 && !usageLatch.waiting(); i++) await new Promise(r => setTimeout(r, 10));
      if (!usageLatch.waiting()) throw new Error('usage did not reach boundary');
      await s.saveMemory({ id: 'expiry', scope: 'project', name: 'expiry', body: 'EXPIRED', expiresAt: '2020-01-01' }, work);
      usageLatch.release(); ok(!(await pending).ok, tool + ' rechecks library after usage await');
    }
    usageLatch.restore(); s.activeChildren.delete(session.id);

    // Real provider loop: disable while a file read completes, inspect the next actual request.
    const marker = 'MEMORY_SCOPE_MARKER_94831';
    await s.saveMemory({ id: 'core', scope: 'project', name: 'core', type: 'preference', core: true, description: marker, body: marker }, work);
    fs.writeFileSync(path.join(work, 'source.txt'), 'source');
    let liveId;
    fake = await startFakeProvider({ handler(req) {
      if (!req.stream) return textFrames('done');
      if (!req.messages.some(m => m.role === 'tool')) return toolCallFrames('file_read', { path: path.join(work, 'source.txt') }, 'source');
      return textFrames('已按当前要求处理。');
    } });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, activeProvider: 'fake', providers: [{ id: 'fake', apiKey: 'k', model: 'fake', baseUrl: fake.url }] }));
    const hooks = s.__eval('AgentLoopHooks');
    for (const mutation of ['disable', 'library', 'reenable', 'hook']) {
      await s.saveMemory({ id: 'core', scope: 'project', name: 'core', type: 'preference', core: true, description: marker, body: marker }, work);
      const live = await s.createSession({ title: 'live scope', cwd: work }); liveId = live.id;
      if (mutation === 'reenable') { live.memoriesExplicit = true; live.memories = []; await s.saveSession(live); }
      const offset = fake.requests.length; let changed = false;
      if (mutation === 'hook') hooks.registerAgentLoopHook({ id: 'memory-scope-final-send', beforeModelCall(context) {
        if (context.sessionId === liveId && changed) { const reg = s.activeChildren.get(liveId); reg.session.memoriesExplicit = true; reg.session.memories = []; }
      } });
      const result = await s.runSessionTurn({ sessionId: liveId, message: '读取 source.txt', cwd: work, source: 'http', onEvent(event) {
        if (event.type === 'tool_result' && !changed) { changed = true; const reg = s.activeChildren.get(liveId); if (reg) {
          if (mutation === 'disable') { reg.session.memoriesExplicit = true; reg.session.memories = []; }
          if (mutation === 'reenable') { reg.session.memoriesExplicit = false; reg.session.memories = []; }
          if (mutation === 'library') { const entry = fs.readdirSync(path.join(home, 'memory', 'project', s.projectKeyForCwd(work))).find(n => n === 'core.md');
            const file = path.join(home, 'memory', 'project', s.projectKeyForCwd(work), entry); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(marker, 'CHANGED_CORE')); }
        } }
      } });
      if (mutation === 'hook') hooks.unregisterAgentLoopHook('memory-scope-final-send');
      const requests = fake.requests.slice(offset).filter(r => r.stream);
      ok(result.ok && requests.length === 2, mutation + ' production loop completes tool call and reply');
      ok(!JSON.stringify(requests[1].body).includes(marker), mutation + ' next real request drops stale core snapshot');
      const body = JSON.stringify(requests[1].body);
      ok(body.includes(['disable', 'hook'].includes(mutation) ? 'enabled=\\"false\\"' : 'enabled=\\"true\\"') && body.includes('checked=\\"false\\"'), mutation + ' receipt reflects current switch without claiming a new search');
      ok(requests[1].messages.some(m => m.role === 'tool' && m.tool_call_id === 'source'), mutation + ' preserves call/result pairing');
    }

    // Actual HTTP and separate MCP process: parent live selection wins over a stale disk copy.
    const port = await getFreePort(); await s.startServer({ port, open: false });
    const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
    const bridge = await s.createSession({ title: 'bridge scope', cwd: work }); bridge.turnSeq = 7; bridge.memoriesExplicit = true; bridge.memories = []; await s.saveSession(bridge);
    bridge.memories = [{ id: 'old', scope: 'project' }]; const bridgeReg = { kind: 'claude', state: 'running', session: bridge }; s.activeChildren.set(bridge.id, bridgeReg);
    const httpRead = () => fetch(`http://127.0.0.1:${runtime.port}/api/tools/workbench_memory_read`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wcw-token': runtime.token }, body: JSON.stringify({ sessionId: bridge.id, turnSeq: 7, id: 'old' }) }).then(r=>r.json());
    ok((await httpRead()).result?.ok === true, 'HTTP read uses live selection over a disabled disk copy');
    mcp = spawnMcpInApp(s, { session: bridge, env: process.env });
    mcp.stdin.on('error', () => {}); let buffer = ''; const pending = new Map();
    mcp.stdout.on('data', bytes => { buffer += bytes.toString(); let end;
      while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let value; try { value = JSON.parse(line); } catch { continue; }
        const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve(value); } }
    });
    let seq = 0;
    const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(()=>reject(new Error('MCP timeout')),15000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })+'\n'); });
    await request('initialize', {});
    const mcpRead = async () => { const response = await request('tools/call', { name: 'workbench_memory_read', arguments: { id: 'old', sessionId: 'forged', turnSeq: 999 } }); return JSON.parse(response.result.content.find(c=>c.type==='text').text); };
    const firstMcp = await mcpRead();
    ok(firstMcp.ok === true, 'MCP child reads through live parent; model args cannot replace session/turn binding');
    if (!firstMcp.ok) console.log('MCP_DIAGNOSTIC ' + JSON.stringify(firstMcp));
    bridge.memories = [];
    ok(!(await mcpRead()).ok, 'MCP parent enforces a newly disabled live selection');
    bridge.memories = [{ id: 'old', scope: 'project' }]; s.activeChildren.delete(bridge.id);
    const stoppedRead = await request('tools/call', { name: 'workbench_memory_read', arguments: { id: 'old' } });
    ok(stoppedRead.error && /setup_required/.test(stoppedRead.error.message), 'MCP late call is refused by real host authentication after parent turn stops');
    console.log('ARTIFACTS ' + root);
  } catch (error) { t.fail(error.stack); }
  finally { if (mcp) killOwnTree(mcp); if (fake) await fake.close(); t.done({ exit: true }); }
})();
