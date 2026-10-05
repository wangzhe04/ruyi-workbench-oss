'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:服务商会话的手动压缩(POST /api/provider/compact)先 L1 后 L2,以及 L2 之后被摘要掉的工具原文仍够得着。
// 2026-10 用户报「手动触发似乎直接触发 L2」+ 本机 agent 的评估(「既没写进摘要、又够不着」那段洞)。离线,lib/fake-openai-provider。
//
//  M1 缺省(mode 省略):旧工具结果先被 L1 折成带 rawRef 的缩减视图,估算已在低水位以下 → level:1,不发摘要请求;
//     原文不在模型视图里(NEEDLE 被省略),会话写了快照(recoverable:true)。
//  M2 mode:'summary':走 L2 —— 历史塌成 [摘要, 收到](手动压缩的既有语义),摘要后附「已执行的工具调用」机器索引,
//     两次 file_read 都在索引里且带 rawRef。
//  M3 下一回合:最新 user 消息旁的恢复索引(105a)不再为空(含摘要索引里的 rawRef);模型凭它调 observation_recall,
//     取回的原文里有 NEEDLE —— 摘要没写的确切值仍能捞回来。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-provider-compact-recall');
const WS = path.join(HOME, 'ws');
const NEEDLE = 'NEEDLE-4711-紫藤';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('PROVIDER COMPACT RECALL');
const { ok } = t;
const FRAME_ID = { id: 'chatcmpl-compact-recall' };
const textOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
const RAWREF = /history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/;

function bigText(tag) {
  const filler = n => Array.from({ length: n }, (_, i) => `${tag} 第 ${i} 行:普通的填充内容,用来把工具结果撑大到会被缩减的程度。`).join('\n');
  return filler(60) + '\n' + (tag === 'BIG1' ? `关键值是 ${NEEDLE}\n` : '') + filler(60);
}

let summaryRequests = 0;
let recallRef = '';
function handleChat(req) {
  const messages = req.messages || [];
  if (req.body && req.body.stream === false) {
    summaryRequests += 1;
    return textFrames('【目标】读两个文件\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成:读了 big1 与 big2;正在进行:无;阻塞:无;下一步:无\n【关键文件与上下文】big1.txt、big2.txt', FRAME_ID);
  }
  const last = messages[messages.length - 1] || {};
  const lastUser = [...messages].reverse().find(m => m.role === 'user') || {};
  const userText = textOf(lastUser);
  if (last.role === 'tool') {
    if (last.tool_call_id === 'call_recall') return textFrames('RECALLED', FRAME_ID);
    return textFrames('读完了。', FRAME_ID);
  }
  if (userText.includes('CMD_READ1')) return toolCallFrames('file_read', { path: path.join(WS, 'big1.txt') }, 'call_read1', FRAME_ID);
  if (userText.includes('CMD_READ2')) return toolCallFrames('file_read', { path: path.join(WS, 'big2.txt') }, 'call_read2', FRAME_ID);
  if (userText.includes('CMD_RECALL')) {
    const idx = userText.indexOf('[Ruyi recovery index');
    const refs = idx >= 0 ? (userText.slice(idx).match(new RegExp(RAWREF.source, 'g')) || []) : [];
    recallRef = refs[0] || '';
    if (recallRef) return toolCallFrames('observation_recall', { rawRef: recallRef, maxChars: 60000 }, 'call_recall', FRAME_ID);
    return textFrames('NO_INDEX', FRAME_ID);
  }
  return textFrames('好的。', FRAME_ID);
}

let WP = 0;
function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 30000, headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (raw) req.write(raw); req.end();
  });
}
function streamChat(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'big1.txt'), bigText('BIG1'), 'utf8');
  fs.writeFileSync(path.join(WS, 'big2.txt'), bigText('BIG2'), 'utf8');
  const fake = await startFakeProvider({ handler: handleChat });
  WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: WS,
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME } });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
  try {
    let healthy = false; for (let i = 0; i < 300 && !healthy; i++) { await sleep(120); healthy = !!(await request('GET', '/health').catch(() => null)); }
    ok(healthy, 'workbench starts');
    const html = await request('GET', '/');
    const token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const auth = { 'x-wcw-token': token };
    const created = await request('POST', '/api/sessions', { title: 'compact recall', cwd: WS }, auth);
    const sid = created && created.session && created.session.id;
    ok(!!sid, 'session created');
    for (const msg of ['CMD_READ1 读第一个文件', 'CMD_READ2 读第二个文件', 'CMD_CHAT 随便聊一句']) {
      const ev = await streamChat({ sessionId: sid, message: msg, cwd: WS });
      ok(ev.some(e => e.type === 'result' && e.ok === true), `turn ok: ${msg.split(' ')[0]}`);
    }
    const loadHistory = async () => { const r = await request('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth); return (r && r.session && r.session.providerHistory) || []; };
    const before = await loadHistory();
    ok(before.some(m => m.role === 'tool' && textOf(m).includes(NEEDLE)), 'precondition: the raw file_read result (with the needle) is in providerHistory');

    // ── M1 缺省:L1 够了就停 ──
    const r1 = await request('POST', '/api/provider/compact', { sessionId: sid });
    ok(r1 && r1.ok === true && r1.level === 1, `M1 manual compact stops at L1 when it is enough (got level=${r1 && r1.level}, err=${r1 && JSON.stringify(r1.error)})`);
    ok(r1 && r1.evaporated >= 1 && r1.afterTokens < r1.beforeTokens, 'M1 L1 really shrank the estimate');
    ok(r1 && r1.recoverable === true, 'M1 a snapshot was written, the folded outputs are recoverable');
    ok(summaryRequests === 0, 'M1 no summary request was sent to the provider');
    const h1 = await loadHistory();
    // 缩减视图两种形状:文本工具结果是 `[Ruyi observation reduced …]` 头,JSON 工具结果是带 `_ruyiObservation` 键的对象。
    const reduced = h1.filter(m => m.role === 'tool' && (textOf(m).includes('[Ruyi observation reduced') || textOf(m).includes('"_ruyiObservation"')));
    ok(reduced.length >= 1 && reduced.every(m => RAWREF.test(textOf(m))), 'M1 old tool results became reduced views carrying a rawRef');
    ok(!h1.some(m => m.role === 'tool' && textOf(m).includes(NEEDLE)), 'M1 the needle is no longer in the model-visible history');

    // ── M2 mode:'summary':L2 + 工具索引 ──
    const r2 = await request('POST', '/api/provider/compact', { sessionId: sid, mode: 'summary' });
    ok(r2 && r2.ok === true && r2.level === 2, `M2 mode:summary runs the L2 summary (got level=${r2 && r2.level})`);
    ok(summaryRequests >= 1, 'M2 the summary model was called');
    const h2 = await loadHistory();
    ok(h2.length === 2 && h2[0].role === 'user' && h2[1].role === 'assistant', 'M2 manual L2 still collapses to [summary, ack]');
    const head = textOf(h2[0] || {});
    const indexAt = head.indexOf('【已执行的工具调用');
    ok(indexAt >= 0, 'M2 the summary carries the machine-built tool-call index');
    const indexLines = indexAt >= 0 ? head.slice(indexAt).split('\n').filter(l => l.startsWith('- ')) : [];
    ok(indexLines.filter(l => l.includes('file_read') && RAWREF.test(l)).length === 2, 'M2 both file_read calls are indexed with a rawRef');
    ok(indexLines.some(l => l.includes('big1.txt')), 'M2 index lines name the call arguments (path)');
    ok(/observation_recall/.test(head.slice(indexAt)) && /scratchpad_write/.test(head.slice(indexAt)), 'M2 index footer tells the model how to recall and to pin facts in the scratchpad');

    // ── M3 下一回合:恢复索引不空,模型捞回原文 ──
    const ev3 = await streamChat({ sessionId: sid, message: 'CMD_RECALL 刚才第一个文件里的关键值是多少?', cwd: WS });
    ok(ev3.some(e => e.type === 'result' && e.ok === true), 'M3 recall turn ok');
    ok(RAWREF.test(recallRef), 'M3 the recovery index next to the newest user message lists a rawRef after L2');
    const recallResult = fake.requests.map(r => (r.messages || []).find(m => m.role === 'tool' && m.tool_call_id === 'call_recall')).filter(Boolean).pop();
    ok(!!recallResult && textOf(recallResult).includes(NEEDLE), 'M3 observation_recall returned the original output with the needle');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch {}
    await fake.close();
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });
