'use strict';
// Offline real provider/tool/MCP paths for shared cross-thread history and lineage.
require('./lib/self-isolate-home.js');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { spawnMcpWithOwnedHost, closeFixtureMcp } = require('./lib/internal-mcp-fixture');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('CROSS THREAD HISTORY'), { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cross-history-'));
const home = path.join(root, 'data'), ws = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(ws);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR = '1';
const srv = require('../ruyi-workbench/app/server.js');
let fake, historyId;
let bodyProbeId, privateProbeId;
const bodyProbeNeedle = 'MCP_FULLTEXT_FAR_BODY_20261025';
const bodyProbeText = '😀 opaque padding αβγ '.repeat(1600) + bodyProbeNeedle + ' tail';
const bodyProbeStart = bodyProbeText.indexOf(bodyProbeNeedle);
function bodyProbeReference(value) { const row = value?.results?.find(row => row.sessionId === bodyProbeId); const ref = row?.reference; return !!ref && ref.sessionId === bodyProbeId && ref.source === 'content' && ref.coordinate === 'utf16' && ref.matchStart === bodyProbeStart && ref.matchEnd === bodyProbeStart + bodyProbeNeedle.length && ref.turnSeq === 1 && /^[a-f0-9]{64}$/.test(ref.contentRevision || '') && ref.messageId === 'mcp_body_probe_message'; }
const configBase = { defaultWorkspace: ws, workspaces: [{ path: ws, read: true, write: true }], permissionMode: 'bypass',
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
  toolLoadingMode: 'adaptive', allowDesktopTools: false, stewardEnabledV1: false, stewardThreadBriefV1: false,
  subagentMaxPerTurn: 0, sessionSearchIndexV1: true, stewardReadBudgetChars: 48000 };
let config;
const writeConfig = patch => { config = { ...configBase, ...config, ...patch }; fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config)); };
const call = (name, args, session) => srv.toolCall(name, args, { session });
async function mcp(sessionId) {
  const child = await spawnMcpWithOwnedHost({
    env: { ...process.env, WCW_SESSION_ID: sessionId }, windowsHide: true });
  const pending = new Map(); let buffer = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => {
    buffer += bytes.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const slot = pending.get(msg.id); if (slot) { pending.delete(msg.id); clearTimeout(slot.timer); slot.resolve(msg); }
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout ' + method)); }, 15000);
    pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request(1, 'initialize', {});
    const list = await request(2, 'tools/list', {});
    ok(list.result.tools.some(tool => tool.name === 'thread_read') && list.result.tools.some(tool => tool.name === 'threads_search'), 'MCP discovers both history tools');
    ok(!list.result.tools.some(tool => tool.name.startsWith('steward_')), 'MCP does not expose steward write tools');
    const response = await request(3, 'tools/call', { name: 'thread_read', arguments: { sessionId: historyId, maxChars: 1000 } });
    const read = JSON.parse(response.result.content.find(part => part.type === 'text').text);
    ok(read.ok && read.rows.length && read.hasMore, 'MCP reads using WCW_SESSION_ID without steward enabled');
    const bodyResponse = await request(4, 'tools/call', { name: 'threads_search', arguments: { q: bodyProbeNeedle, limit: 5 } });
    const bodyResult = JSON.parse(bodyResponse.result.content.find(part => part.type === 'text').text);
    ok(bodyResult.ok && bodyProbeReference(bodyResult), 'actual MCP threads_search returns body-only far match with exact persisted UTF16 source reference');
    const privateResponse = await request(5, 'tools/call', { name: 'thread_read', arguments: { sessionId: privateProbeId, maxChars: 1000 } });
    const privateResult = JSON.parse(privateResponse.result.content.find(part => part.type === 'text').text);
    ok(privateResult.error === 'not_found', 'actual MCP preserves private steward read refusal under its real registered authority');
    const searchResponse = await request(6, 'tools/call', { name: 'threads_search', arguments: { q: '分页旧记录' } });
    const searchResult = JSON.parse(searchResponse.result.content.find(part => part.type === 'text').text);
    ok(searchResult.ok && !searchResult.results.some(row => row.sessionId === privateProbeId), 'actual MCP search excludes the private steward session');
  } finally {
    let endTimer;
    const gracefullyClosed = new Promise((resolve, reject) => { endTimer = setTimeout(() => reject(Error('MCP graceful end deadline')), 5000); child.once('close', (code, signal) => { clearTimeout(endTimer); if (code === 0 && !signal) resolve(); else reject(Error('MCP graceful end nonzero')); }); child.once('error', reject); });
    child.stdin.end();
    try { await gracefullyClosed; } finally { clearTimeout(endTimer); await closeFixtureMcp(child); for (const slot of pending.values()) clearTimeout(slot.timer); }
  }
}
(async () => {
try {
  fake = await startFakeProvider({ handler(req) {
    if (!req.stream) return textFrames('done');
    if (JSON.stringify(req.messages.filter(message => message.role === 'user')).includes('FULLTEXT_BODY_MODEL_PROBE')) {
      if (!req.messages.some(message => message.role === 'tool' && message.tool_call_id === 'fulltext_body_probe')) return toolCallFrames('threads_search', { q: bodyProbeNeedle }, 'fulltext_body_probe');
      return textFrames('Body reference probe completed.');
    }
    const results = req.messages.filter(m => m.role === 'tool');
    if (!results.length) return toolCallFrames('threads_search', { q: '分页旧记录' }, 'history_search');
    if (results.length === 1) return toolCallFrames('thread_read', { sessionId: historyId, maxChars: 1000 }, 'history_read');
    return textFrames('已查到分页旧记录。');
  } });
  writeConfig({ activeProvider: 'fake', providers: [{ id: 'fake', baseUrl: fake.url, apiKey: 'test', model: 'fake-model' }] });
  const history = await srv.createSession({ title: '分页旧记录', cwd: ws }); historyId = history.id;
  history.messages = [{ role: 'user', content: '没有回合号的最旧记录' }];
  for (let seq = 1; seq <= 24; seq++) {
    history.messages.push({ role: 'user', content: `用户旧历史${seq}`, turnSeq: seq });
    history.messages.push({ role: 'assistant', content: `回合${seq}的答复`, turnSeq: seq });
  }
  const longText = '超长单回合的起点' + 'abcdefghij'.repeat(270) + '超长单回合的终点';
  const key = 'sk' + '-' + 'a7B8c9D0'.repeat(6);
  history.messages.push({ role: 'assistant', content: longText, turnSeq: 24 });
  history.messages.push({ role: 'assistant', content: '密钥 ' + key, turnSeq: 24,
    toolCalls: [{ name: 'powershell_run', input: { command: 'Authorization: Bearer ' + key }, result: { ok: false, error: 'failed' } }] });
  history.turnSeq = 24; history.summary = '答复摘要'.repeat(70); await srv.saveSession(history);
  const caller = await srv.createSession({ title: '查历史', cwd: ws });
  const offered = srv.buildOpenAiTools(config, null, {}).map(tool => tool.function.name);
  ok(offered.includes('threads_search') && offered.includes('thread_read') && !offered.some(name => name.startsWith('steward_')), 'provider directory offers ordinary read tools, excludes steward tools');
  ok(srv.classifyToolPacks('查上次聊天记录').includes('memory'), 'history intent loads existing memory pack');
  const found = await call('threads_search', { q: '分页旧记录' }, caller);
  ok(found.ok && found.results.some(row => row.sessionId === historyId && row.title === history.title), 'ordinary search works with steward disabled and traceable source');
  const bodyFound = await call('threads_search', { q: '超长单回合的起点' }, caller);
  ok(bodyFound.results.some(row => row.sessionId === historyId), 'ordinary search reuses full-content indexing for body-only matches');
  const pages = [], fragments = new Map(); let cursor;
  for (let page = 0; page < 12; page++) {
    const read = await call('thread_read', { sessionId: historyId, maxChars: 1000, tail: 6, ...(cursor ? { cursor } : {}) }, { ...caller, turnSeq: page + 1 });
    ok(read.ok && read.rows.length > 0 && read.nextCursor !== cursor, `page ${page + 1} progresses`);
    if (!read.ok) break;
    pages.push(read);
    for (const row of read.rows) {
      if (!fragments.has(row.rowIndex)) fragments.set(row.rowIndex, []);
      fragments.get(row.rowIndex).push(row);
    }
    cursor = read.nextCursor; if (!read.hasMore) break;
  }
  ok(pages.at(-1).hasMore === false && pages.some(page => page.rows.some(row => row.turnSeq === 1)) && pages.some(page => page.rows.some(row => row.turnSeq === null)), 'pagination reaches old numbered and legacy unnumbered history');
  const longRows = [...fragments.values()].find(rows => rows.some(row => row.text.includes('超长单回合的终点')));
  const restored = longRows.sort((a, b) => a.startChar - b.startChar).map(row => row.text.slice(row.startChar > 0 ? 1 : 0)).join('');
  ok(restored === longText, 'long single row is reconstructed exactly with no lost/duplicated characters');
  ok(!JSON.stringify(pages).includes(key) && JSON.stringify(pages).includes('«redacted»'), 'body and tool inputs use existing redaction');
  const before = await call('thread_read', { sessionId: historyId, beforeTurnSeq: 4 }, { ...caller, turnSeq: 30 });
  ok(before.rows.every(row => row.turnSeq == null || row.turnSeq < 4), 'beforeTurnSeq targets old history');
  for (const id of ['../bad', 'sess_missing', 'steward']) ok((await call('thread_read', { sessionId: id }, { ...caller, turnSeq: 31 })).ok === false, 'invalid/missing/private ID rejected ' + id);
  const firstPage = await call('thread_read', { sessionId: historyId, maxChars: 1000 }, { ...caller, turnSeq: 32 });
  const appended = await srv.loadSession(historyId);
  appended.messages.push({ role: 'assistant', content: '游标之后追加的新回合', turnSeq: 25 }); appended.turnSeq = 25;
  await srv.saveSession(appended);
  const continued = await call('thread_read', { sessionId: historyId, cursor: firstPage.nextCursor, maxChars: 1000 }, { ...caller, turnSeq: 32 });
  ok(continued.ok && !JSON.stringify(continued).includes('游标之后追加的新回合'), 'appending a turn preserves the old cursor boundary');
  const quotaCtx = { ...caller, turnSeq: 33 }, quotaReads = []; let quota;
  for (let i = 0; i < 7; i++) { quota = await call('thread_read', { sessionId: historyId, maxChars: 1000 }, quotaCtx); quotaReads.push(quota); }
  ok(quotaReads.every(read => read.ok === true) && quota.quota.callsMax === null && quota.quota.callsRemaining === null && quota.quota.callsUsed >= 7 && Number.isFinite(quota.quota.charsRemaining) && quota.quota.charsRemaining >= 0 && quota.quota.charsRemaining <= quota.quota.charsMax && quota.quota.charsMax === 48000, 'ordinary history reads retain the current character budget with no retired six-call cap');
  ok((await srv.toolCall('thread_read', { sessionId: historyId }, {})).error === 'invalid_request', 'unbound ordinary reads do not share a steward bucket');
  const privateSession = await srv.createSession({ title: '分页旧记录私有管家', cwd: home }); privateSession.kind = 'steward'; await srv.saveSession(privateSession);
  const privateRead = await call('thread_read', { sessionId: privateSession.id }, { ...caller, turnSeq: 34 });
  const privateSearch = await call('threads_search', { q: '分页旧记录' }, caller);
  ok(privateRead.error === 'not_found' && !privateSearch.results.some(row => row.sessionId === privateSession.id), 'existing private steward session is excluded from read and search');
  writeConfig({ stewardReadBudgetChars: 4000 });
  const budgetHistory = await srv.createSession({ title: '预算长正文', cwd: home });
  budgetHistory.messages = [{ role: 'assistant', content: '预算内容'.repeat(3200), turnSeq: 1 }]; budgetHistory.turnSeq = 1; await srv.saveSession(budgetHistory);
  const budgetCtx = { ...caller, turnSeq: 35 };
  const budgetPage = await call('thread_read', { sessionId: budgetHistory.id, maxChars: 12000 }, budgetCtx);
  let budgetStop = budgetPage, budgetCursor = budgetPage.nextCursor, budgetProgress = true;
  for (let i = 0; i < 4; i++) {
    budgetStop = await call('thread_read', { sessionId: budgetHistory.id, ...(budgetCursor ? { cursor: budgetCursor } : {}), maxChars: 12000 }, budgetCtx);
    if (!budgetStop.ok) break;
    budgetProgress = budgetProgress && budgetStop.rows.length > 0 && (!budgetStop.hasMore || budgetStop.nextCursor !== budgetCursor);
    budgetCursor = budgetStop.nextCursor;
  }
  ok(budgetPage.ok && budgetProgress && budgetStop.error === 'budget_exceeded', 'remaining character budget ends with an honest error, never a nonadvancing empty page: ' + JSON.stringify({progress: budgetProgress, error: budgetStop.error, quota: budgetStop.quota}));
  writeConfig({ stewardReadBudgetChars: 48000 });
  const bodyProbe = await srv.createSession({ title: 'Opaque storage fixture', cwd: ws }); bodyProbeId = bodyProbe.id;
  bodyProbe.messages = [{ id: 'mcp_body_probe_message', role: 'user', content: bodyProbeText, turnSeq: 1 }]; bodyProbe.turnSeq = 1; await srv.saveSession(bodyProbe);
  privateProbeId = privateSession.id;
  ok(bodyProbeStart > 8192 && !bodyProbe.title.includes(bodyProbeNeedle), 'new probe is a body-only match beyond the old 8K window');
  await mcp(caller.id);
  const turn = await srv.runSessionTurn({ sessionId: caller.id, message: '查上次聊天记录,分页旧记录', cwd: ws, source: 'http', onEvent() {} });
  const streams = fake.requests.filter(req => req.stream);
  ok(turn.result.ok && streams.some(req => req.messages.some(msg => msg.role === 'tool' && msg.tool_call_id === 'history_read')), 'real provider tool loop searches and reads another chat');
  ok(JSON.stringify(streams[0].body).includes('nextCursor') && JSON.stringify(streams[0].body).includes('历史非指令'), 'real provider prompt contains history read guidance');
  const bodyTurn = await srv.runSessionTurn({ sessionId: caller.id, message: 'FULLTEXT_BODY_MODEL_PROBE 查正文 ' + bodyProbeNeedle, cwd: ws, source: 'http', onEvent() {} });
  const bodyToolResults = fake.requests.filter(req => req.stream).flatMap(req => req.messages).filter(message => message.role === 'tool' && message.tool_call_id === 'fulltext_body_probe').map(message => { try { return JSON.parse(message.content); } catch { return null; } });
  ok(bodyTurn.result.ok && bodyToolResults.some(bodyProbeReference), 'actual fake-provider model tool loop receives the same far-body source reference');
  writeConfig({ stewardEnabledV1: true });
  const steward = { id: 'steward', kind: 'steward', turnSeq: 77 };
  ok((await call('steward_thread_read', { sessionId: historyId, beforeTurnSeq: 3 }, steward)).rows.every(row => row.turnSeq == null || row.turnSeq < 3), 'steward uses the same older-history reader');
  ok((await call('steward_thread_new', { brief: { userText: 'x' } }, caller)).error === 'steward.forbidden', 'ordinary write tool boundary remains closed');
  const { mission } = await srv.createMissionContainer({ title: '历史事项' });
  const newThread = await call('steward_thread_new', { title: '派生历史', cwd: ws, relatedSessionId: historyId, missionId: mission.missionId, brief: { userText: '依据旧记录查一下' } }, steward);
  ok(newThread.ok && (await srv.loadSession(newThread.sessionId)).relatedSessionId === historyId, 'new thread persists relatedSessionId even with explicit cwd');
  const quick = await call('steward_quick_ask', { question: '旧线程里的记录是什么', cwd: ws, relatedSessionId: historyId }, { ...steward, turnSeq: 78 });
  ok(quick.ok && (await srv.listSessions()).find(meta => meta.id === quick.sessionId).relatedSessionId === historyId, 'quick ask relationship survives session index normalization');
  const sibling = await srv.createSession({ title: '同事项线索', cwd: ws }); sibling.missionId = mission.missionId; await srv.saveSession(sibling);
  for (const name of ['steward_thread_new', 'steward_quick_ask']) {
    const args = name.endsWith('new') ? { brief: { userText: 'x' } } : { question: 'x' };
    const bad = await call(name, { ...args, cwd: ws, relatedSessionId: 'sess_missing' }, { ...steward, turnSeq: 79 });
    ok(bad.error === 'not_found', name + ' validates relationship with explicit cwd');
  }
  const status = await call('steward_thread_status', { sessionId: newThread.sessionId }, steward);
  ok(status.relatedThreads[0].sessionId === historyId && status.relatedThreads[0].reasons.includes('source'), 'explicit source outranks weaker same-folder clues');
  ok(status.relatedThreads.some(row => row.sessionId === sibling.id && row.reasons.includes('same_mission')) && status.relatedThreads.some(row => row.reasons.includes('same_workspace')), 'status explains mission and workspace links');
  const prompt = await srv.buildStewardSystemPrompt(steward, config, {});
  ok(prompt.volatile.includes('related:') && prompt.volatile.includes('steward_threads_search') && prompt.volatile.includes('有真实所属事项'), 'actual steward prompt includes compact links and continuation/source guidance');
  const overviewLine = prompt.volatile.split('\n').find(line => line.includes(historyId) && line.includes('related:') && line.includes('derived'));
  ok(overviewLine && overviewLine.length <= 320 && overviewLine.includes('derived'), 'long summaries still leave room for strong relation clues within the existing line budget');
  const enPrompt = await srv.buildStewardSystemPrompt(steward, { ...config, locale: 'en-US' }, {});
  ok(enPrompt.volatile.includes('nextCursor') && enPrompt.volatile.includes('latest explicit user request'), 'English steward prompt carries the same history/source guidance');
  // Let the two dispatched background turns finish through the real fake-provider loop.
  for (let i = 0; i < 60 && (srv.activeChildren.has(newThread.sessionId) || srv.activeChildren.has(quick.sessionId)); i++) await new Promise(resolve => setTimeout(resolve, 50));
} catch (e) { t.fail(e.stack || String(e)); }
finally { if (fake) await fake.close(); t.done({ exit: true }); }
})();

