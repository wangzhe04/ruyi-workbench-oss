'use strict';
// Offline continuation through the actual model budget, native wrappers, and CLI MCP.
require('./lib/self-isolate-home.js');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process'), crypto = require('crypto');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { spawnMcpWithOwnedHost, closeFixtureMcp } = require('./lib/internal-mcp-fixture');
const { killOwnTree } = require('./lib/kill-own-tree');
const { StringDecoder } = require('string_decoder');
const t = createRunner('READING CONTINUATION'), { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-reading-pages-')), home = path.join(root, 'data'), ws = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(ws);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1'; process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR = '1';
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[key];
const srv = require('../ruyi-workbench/app/server.js');
const paragraph = '中文网页长正文😀 "引号" \\路径\n第二行数据\n';
const html = '<html><body><main><pre>' + paragraph.repeat(20000) + '</pre><a href="/source">出处链接</a></main></body></html>';
const escapedBody = '\u0001'.repeat(30000);
const truncatedSource = '源下载截断部分\n' + 'x'.repeat(2 * 1024 * 1024 + 10000);
let server, fake, url, config, requestArgs, requestTool = 'web_fetch', readCallId = 'read_page', hits = 0;
const pageText = result => result.text;
const noBrokenSurrogate = text => !/[\uD800-\uDBFF]$/.test(text) && !/^[\uDC00-\uDFFF]/.test(text);
function pagesValid(pages, expected) {
  let offset = 0;
  for (const page of pages) {
    if (!page.ok || page.offset !== offset || !pageText(page) || !noBrokenSurrogate(pageText(page)) || JSON.stringify(page).length > 60000) { console.log('PAGE DIAGNOSTIC', { offset, pageOffset: page.offset, length: pageText(page)?.length, serialized: JSON.stringify(page).length, surrogate: noBrokenSurrogate(pageText(page)), keys: Object.keys(page), marker: page._truncated, tail: pageText(page).slice(-120) }); return false; }
    offset += pageText(page).length;
    if (page.nextOffset !== undefined && page.nextOffset !== offset) { console.log('CURSOR DIAGNOSTIC', { offset, nextOffset: page.nextOffset, keys: Object.keys(page), marker: page._truncated, tail: pageText(page).slice(-120) }); return false; }
  }
  const joined = pages.map(pageText).join('');
  if (joined !== expected || pages.at(-1).nextOffset !== undefined) console.log('JOIN DIAGNOSTIC', { actual: joined.length, expected: expected.length, nextOffset: pages.at(-1).nextOffset, prefix: joined.slice(0, 60), expectedPrefix: expected.slice(0, 60) });
  return joined === expected && pages.at(-1).nextOffset === undefined;
}
function unwrapExternal(content) { return content.split('\n').slice(2, -1).join('\n'); }
async function startMcp(sessionId) {
  const child = await spawnMcpWithOwnedHost({ env: { ...process.env, WCW_SESSION_ID: sessionId }, windowsHide: true });
  const waiting = new Map(), decoder = new StringDecoder('utf8'); let buffer = '', counter = 0;
  child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => {
    buffer += decoder.write(bytes); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const slot = waiting.get(msg.id); if (slot) { clearTimeout(slot.timer); waiting.delete(msg.id); slot.resolve(msg); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { waiting.delete(id); reject(new Error('MCP timeout ' + method)); }, 15000);
    waiting.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', {});
  return { async call(name, args) {
    const response = await request('tools/call', { name, arguments: args });
    return JSON.parse(response.result.content.find(part => part.type === 'text').text);
  }, async close() { await closeFixtureMcp(child); for (const slot of waiting.values()) clearTimeout(slot.timer); } };
}
(async () => {
let mcp;
try {
  server = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': req.url === '/oversize' || req.url === '/escaped' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' }); res.end(req.url === '/oversize' ? truncatedSource : req.url === '/escaped' ? escapedBody : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}/page`;
  const expected = srv.extractMainText(html, { baseUrl: url }).text;
  ok(expected.length > 400000, 'fixture exceeds the former 400K cache boundary');
  fake = await startFakeProvider({ handler(req) {
    if (!req.stream) return textFrames('done');
    if (!req.messages.slice(req.messages.map(msg => msg.role).lastIndexOf('user') + 1).some(msg => msg.role === 'tool')) return toolCallFrames(requestTool, requestArgs, readCallId);
    return textFrames('已读本页');
  } });
  config = { defaultWorkspace: ws, workspaces: [{ path: ws, read: true, write: true }], permissionMode: 'bypass', toolLoadingMode: 'full',
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
    allowDesktopTools: false, stewardEnabledV1: true, stewardReadBudgetChars: 48000, runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
    activeProvider: 'fake', providers: [{ id: 'fake', baseUrl: fake.url, apiKey: 'test', model: 'fake-model' }], subagentMaxPerTurn: 0 };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const pages = []; let offset = 0;
  for (let i = 0; i < 30; i++) {
    requestTool = i % 2 ? 'tool_invoke_read' : 'web_fetch'; const args = { url, offset, maxChars: 60000 }; requestArgs = requestTool === 'tool_invoke_read' ? { name: 'web_fetch', arguments: args } : args;
    const before = fake.requests.length, session = await srv.createSession({ title: '网页分页' + i, cwd: ws });
    const turn = await srv.runSessionTurn({ sessionId: session.id, message: '读取网页本页', cwd: ws, source: 'http', onEvent() {} });
    const toolMessage = fake.requests.slice(before).flatMap(req => req.messages || []).find(msg => msg.role === 'tool' && msg.tool_call_id === 'read_page');
    if (!turn.result.ok || !toolMessage) throw new Error('real provider page failed at ' + offset);
    const page = JSON.parse(typeof toolMessage.content === 'string' ? toolMessage.content : toolMessage.content.map(part => part.text || '').join(''));
    pages.push(page); if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  ok(pagesValid(pages, expected), 'real provider + tool_invoke_read pages reconstruct full Chinese/escaped text without holes');
  ok(pages.some(page => page.links && page.links.length) && pages.slice(1).every(page => page.fromCache), 'links and cached continuation metadata survive provider reduction');
  ok((await srv.readWebCache(url)).text === expected && hits === 1, 'cache stores all captured text beyond 400K and continuation does not refetch');
  requestTool = 'web_fetch'; requestArgs = { url, offset: 65000, maxChars: 60000 };
  const subBefore = fake.requests.length, parent = await srv.createSession({ title: '代理分页', cwd: ws });
  const sub = await srv.runSubAgentCore({ parentSession: parent, provider: config.providers[0], config, task: '读取网页中段', toolTier: 'read', maxIters: 4, onEvent() {}, subagentId: 'reading-continuation', depth: 1 });
  const subMessage = fake.requests.slice(subBefore).flatMap(req => req.messages || []).find(msg => msg.role === 'tool' && msg.tool_call_id === 'read_page');
  const subPage = subMessage && JSON.parse(subMessage.content);
  ok(sub.ok && subPage && subPage.text === expected.slice(subPage.offset, subPage.nextOffset), 'subagent model view preserves the requested continuous middle page');
  const mcpSession = await srv.createSession({ title: 'MCP分页', cwd: ws }); mcp = await startMcp(mcpSession.id);
  const mcpPages = []; offset = 0;
  for (let i = 0; i < 30; i++) {
    const page = await mcp.call('web_fetch', { url, offset, maxChars: 60000 }); mcpPages.push(page);
    if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  ok(pagesValid(mcpPages, expected), 'CLI MCP reconstructs the same complete long webpage');
  const steward = { id: 'steward', kind: 'steward', turnSeq: 100 };
  const s1 = await srv.toolCall('steward_web_fetch', { url, offset: 0, maxChars: 5000 }, { session: steward });
  const s2 = await srv.toolCall('steward_web_fetch', { url, offset: s1.nextOffset, maxChars: 5000 }, { session: steward });
  ok(s1.ok && s1.offset === 0 && s1.nextOffset === 5000 && s2.offset === 5000 && s2.fromCache && s2.totalChars === expected.length,
    'steward web wrapper accepts offset/maxChars and preserves source/cache/page metadata');
  ok(unwrapExternal(s1.content) + unwrapExternal(s2.content) === expected.slice(0, s2.nextOffset) && s1.content.includes('\n第二行数据\n'), 'steward fence preserves text formatting and every delivered character');
  await srv.ensureStewardSession(config);
  const escapedPages = []; offset = 0;
  for (let i = 0; i < 5; i++) {
    readCallId = 'escaped_' + i; requestTool = 'steward_web_fetch'; requestArgs = { url: url.replace('/page', '/escaped'), offset, maxChars: 12000 };
    const before = fake.requests.length;
    const turn = await srv.runSessionTurn({ sessionId: 'steward', message: '读取网站控制字符页', cwd: home, source: 'steward', onEvent() {} });
    const msg = fake.requests.slice(before).flatMap(req => req.messages || []).findLast(msg => msg.role === 'tool' && msg.tool_call_id === readCallId);
    if (!turn.result.ok || !msg) throw new Error('steward escaped-page model loop failed');
    const result = JSON.parse(msg.content); escapedPages.push(result);
    if (result.nextOffset === undefined) break; offset = result.nextOffset;
  }
  ok(escapedPages.map(page => unwrapExternal(page.content)).join('') === escapedBody
    && escapedPages.every(page => JSON.stringify(page).length <= 60000)
    && escapedPages[0].nextOffset === unwrapExternal(escapedPages[0].content).length, '12K control-character requests survive the real steward wrapper/model budget with source-only cursors');
  readCallId = 'read_page';
  const giant = await mcp.call('web_fetch', { url: url.replace('/page', '/oversize'), offset: 2 * 1024 * 1024 - 10000, maxChars: 60000 });
  ok(giant.ok && giant.sourceTruncated && giant.truncated && giant.nextOffset === undefined && /http_download.*file_read/.test(giant.hint) && giant.totalChars < truncatedSource.length,
    'source byte truncation at the tail remains explicit and provides recovery instead of a looping cursor');
  const recallSession = await srv.createSession({ title: '观察分页', cwd: ws }), original = ('观察原文😀 "值" \\路径\n').repeat(12000);
  const history = [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'http_request', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'old_call', content: original }];
  const prefix = await srv.writeHistorySnapshot(recallSession.id, 7, history, true), hash = crypto.createHash('sha256').update(original).digest('hex').slice(0, 16), rawRef = `${prefix}:2:${hash}`;
  await mcp.close(); mcp = await startMcp(recallSession.id);
  const recalled = []; offset = 0;
  for (let i = 0; i < 8; i++) {
    const page = await mcp.call('observation_recall', { rawRef, offset, maxChars: 60000 });
    recalled.push({ ...page, text: page.content }); if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  ok(pagesValid(recalled.map(({ content, ...page }) => page), original), 'observation recall recovers an original over 60K including its middle with serialized page budgets');
  const fileText = ('文件原文😀 "字段" \\路径\n').repeat(5000), file = path.join(ws, 'pages.txt'); fs.writeFileSync(file, fileText);
  let fileJoined = '', fileOffset = 0;
  for (let i = 0; i < 20; i++) {
    const result = await srv.toolCall('steward_file_read', { path: file, offset: fileOffset }, { session: { ...steward, turnSeq: 101 + i } });
    if (!result.ok) throw new Error('steward file page: ' + JSON.stringify(result));
    fileJoined += unwrapExternal(result.content); if (result.nextOffset === undefined) break; fileOffset = result.nextOffset;
  }
  ok(fileJoined === fileText, 'steward file offset selects the existing character reader and does not drop lines or middle text');
  requestTool = 'tool_invoke_read'; requestArgs = { name: 'file_read', arguments: { path: file, offset: 30000, limit: 40000 } };
  const proxyBefore = fake.requests.length, proxySession = await srv.createSession({ title: '文件代理页', cwd: ws });
  const proxyTurn = await srv.runSessionTurn({ sessionId: proxySession.id, message: '读取文件中段', cwd: ws, source: 'http', onEvent() {} });
  const proxyMsg = fake.requests.slice(proxyBefore).flatMap(req => req.messages || []).findLast(msg => msg.role === 'tool' && msg.tool_call_id === 'read_page');
  const proxyFile = proxyMsg && JSON.parse(proxyMsg.content);
  ok(proxyTurn.result.ok && proxyFile && proxyFile.content === fileText.slice(proxyFile.offset, proxyFile.nextOffset), 'proxy file read preserves the complete continuous source window');
  const delivered = await srv.createSession({ title: '交付文本分页', cwd: ws });
  delivered.mission = { result: { status: 'complete', artifacts: [{ path: file, kind: 'file', turnSeq: 1 }] } }; await srv.saveSession(delivered);
  const artifactPage = await srv.toolCall('steward_thread_artifact_read', { sessionId: delivered.id, path: file, offset: 12000 }, { session: { ...steward, turnSeq: 140 } });
  ok(artifactPage.ok && unwrapExternal(artifactPage.content) === fileText.slice(12000, artifactPage.nextOffset), 'delivered artifact uses the same continuous character reader');
  const response = await srv.toolCall('http_request', { url: url.replace('/page', '/oversize'), method: 'POST', maxBodyChars: 1000 }, { session: mcpSession });
  ok(response.truncated && /非幂等.*不要.*重发/.test(response.hint), 'non-idempotent HTTP truncation does not recommend replay as continuation');
} catch (error) { t.fail(error.stack || String(error)); }
finally { if (mcp) await mcp.close(); if (fake) await fake.close(); if (server) await new Promise(resolve => server.close(resolve)); t.done({ exit: true }); }
})();
