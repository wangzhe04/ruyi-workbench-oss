require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(回合引擎审计 t3 / t4 / t5 / t12):模型服务商引擎(09 runOpenAiTurn)的停止与「过期回合」收口。
// 真服务进程 + 进程内脚本化假 provider,按第一条用户消息里的场景标记分支。
//   [A] 不可中断的工具(http_request 打一个永不回包的端点)里按停止:回合当场结束(修前要等工具自己超时,
//       实测晚 14 s);结果事件 aborted;那个 tool_call 有配对回复(历史完好);没有更新回合时收尾照常落盘。
//   [B] 过期回合的收尾存不许盖掉更新的回合:回合 1 卡在慢工具里,同会话发回合 2 并跑完,回合 1 稍后收尾 ——
//       修前回合 1 拿着旧对象整份写回,回合 2 的 user/assistant 与 providerHistory 全没了。
//   [C] L2 摘要压缩期间按停止:摘要调用当场取消、回合当场结束(修前要等摘要调用返回);被停止取消的摘要不算
//       摘要服务失败 —— 下一回合照常再压(不武装滞回水位、不进冷却)。
//   [D] 空回复(正常结束、没有文字也没有工具调用):给用户一句看得见的提示(修前静悄悄结束,只剩空气泡);
//       providerHistory 里不塞空 assistant。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-turn-stop-supersede-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('TURN STOP SUPERSEDE');
const { ok } = t;

const SUMMARY = '【目标】x\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成:a;正在进行:b;阻塞:无;下一步:c\n【关键文件与上下文】无';
const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
function scenarioOf(messages) {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
}
const afterLastUser = messages => {
  const i = messages.map(m => m && m.role).lastIndexOf('user');
  return messages.slice(i + 1);
};

// 慢端点:/never 永不回包;/slow 4 s 后回。
const pending = new Set();
const hang = http.createServer((req, res) => {
  pending.add(res);
  if (req.url.startsWith('/slow')) setTimeout(() => { try { res.end('late'); } catch { /* gone */ } }, 4000);
});
await new Promise(r => hang.listen(0, '127.0.0.1', r));
const HANG = 'http://127.0.0.1:' + hang.address().port;

let summaryHits = 0;
let summaryDelayMs = 0;
const fake = await startFakeProvider({
  async handler(req) {
    const all = JSON.stringify(req.messages);
    if (all.includes('请把以上对话压缩为结构化摘要')) {
      summaryHits += 1;
      if (summaryDelayMs) await sleep(summaryDelayMs);
      return [...textFrames(SUMMARY), usageFrame(10, 10)];
    }
    if (!req.stream || /起名字/.test(all)) return textFrames('{"title":"t","gist":"g"}');
    const scn = scenarioOf(req.messages);
    const toolsAnswered = afterLastUser(req.messages).some(m => m.role === 'tool');
    switch (scn) {
      case 'A':
        if (toolsAnswered) return textFrames('A done');
        return toolCallFrames('http_request', { url: HANG + '/never', timeoutMs: 30000 }, 'a1');
      case 'B1':
        if (toolsAnswered) return textFrames('first done');
        return toolCallFrames('http_request', { url: HANG + '/slow', timeoutMs: 30000 }, 'b1');
      case 'B2':
        return [...textFrames('second reply'), usageFrame(8, 4)];
      case 'D':
        return [{ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usageFrame(8, 0)];
      default:
        return [...textFrames('normal reply'), usageFrame(8, 4)];
    }
  },
});

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); if (raw) r.write(raw); r.end();
  });
}
function stream(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => {
        buf += c; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let e = null; try { e = JSON.parse(line); } catch { /* partial */ }
          if (e) { events.push(e); try { if (onEvent) onEvent(e); } catch { /* ignore */ } }
        }
      });
      res.on('end', () => resolve(events));
    });
    r.on('error', reject); r.write(raw); r.end();
  });
}
async function waitFor(pred, ms, step = 50) { for (let i = 0; i < ms / step; i++) { if (pred()) return true; await sleep(step); } return pred(); }
const sessionIdOf = evs => { const s = evs.find(e => e.type === 'session'); return s && s.session && s.session.id; };
function pairingOk(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const got = new Set();
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) got.add(String(messages[j].tool_call_id));
    for (const tc of m.tool_calls) if (!got.has(String(tc.id))) return false;
  }
  return true;
}
const providerHistoryOf = (home, sid) => {
  try { return fs.readFileSync(path.join(home, 'sessions', sid + '.provider.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

async function startWorkbench(name, providerExtra) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: home,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }], ...providerExtra }],
    activeProvider: 'fake',
  }));
  const port = await getFreePort();
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, WCW_TOOL_HEARTBEAT_MS: '250' },
  });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await request(port, 'GET', '/health')).status === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  const page = up ? await request(port, 'GET', '/') : { text: '' };
  const token = (page.text.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  return { home, port, child, up, H: { 'x-wcw-token': token } };
}

const servers = [];
try {
  const main = await startWorkbench('main', {});
  servers.push(main);
  ok(main.up, 'workbench starts');
  const getSession = async sid => { const s = await request(main.port, 'GET', '/api/sessions/' + sid, null, main.H); return (s.json && (s.json.session || s.json)) || {}; };

  // ── [A] 不可中断工具里按停止 ──
  {
    const evs = [];
    let toolUseAt = 0, resultAt = 0;
    const p = stream(main.port, { message: 'SCN-A 抓一下这个地址' }, e => {
      evs.push(e);
      if (e.type === 'tool_use' && !toolUseAt) toolUseAt = Date.now();
      if (e.type === 'result') resultAt = Date.now();
    });
    await waitFor(() => toolUseAt > 0, 15000);
    await sleep(800);
    const sid = sessionIdOf(evs);
    const stopAt = Date.now();
    const st = await request(main.port, 'POST', '/api/stop', { sessionId: sid }, main.H);
    ok(st.json && st.json.ok === true, 'A1 /api/stop 被接受');
    await Promise.race([p, sleep(20000)]);
    const latency = resultAt ? resultAt - stopAt : Infinity;
    // 墙钟上界豁免：判的是「停止不再等不可中断的工具」；修后实得约 20 ms，界 3000 ms（150 倍）；失败形态是等满工具超时（30 s，本件等 20 s 即判红）。
    ok(latency < 3000, `A2 停止在不可中断工具里当场生效(${latency} ms < 3000;修前要等工具自己超时)`);
    const res = evs.find(e => e.type === 'result');
    ok(res && res.aborted === true, 'A3 结果事件 aborted:true');
    const tr = evs.find(e => e.type === 'tool_result' && e.id === 'a1');
    ok(tr && tr.isError === true && tr.content && tr.content.aborted === true, 'A4 被放弃的工具有一条「已停止」的配对结果');
    const ph = providerHistoryOf(main.home, sid);
    ok(ph.some(m => m.role === 'tool' && m.tool_call_id === 'a1') && pairingOk(ph), 'A5 providerHistory 配对完好(a1 有回复)');
    const s = await getSession(sid);
    const last = (s.messages || []).slice(-1)[0] || {};
    ok(last.role === 'assistant' && last.source === 'aborted', 'A6 没有更新回合时,停止后的收尾照常落盘(末条 assistant source:aborted)');
  }

  // ── [B] 过期回合的收尾存不盖掉更新的回合 ──
  {
    const ev1 = [];
    let toolUse = false;
    const p1 = stream(main.port, { message: 'SCN-B1 抓一下慢地址' }, e => { ev1.push(e); if (e.type === 'tool_use') toolUse = true; });
    await waitFor(() => toolUse && sessionIdOf(ev1), 15000);
    await sleep(500);
    const sid = sessionIdOf(ev1);
    const ev2 = await stream(main.port, { message: 'SCN-B2 换个问题', sessionId: sid });
    const r2 = ev2.find(e => e.type === 'result');
    ok(r2 && r2.ok === true, 'B1 回合 2 正常跑完');
    await Promise.race([p1, sleep(20000)]);
    await sleep(4500);   // 慢端点 4 s 后才回包:回合 1 的工具(若还在跑)这时也回来了
    const s = await getSession(sid);
    const texts = (s.messages || []).map(m => m.role + ':' + contentText(m.content));
    ok(texts.includes('user:SCN-B2 换个问题') && texts.includes('assistant:second reply'),
      `B2 回合 1 收尾之后,回合 2 的消息还在(实得 ${JSON.stringify(texts)})`);
    const ph = providerHistoryOf(main.home, sid);
    ok(ph.some(m => m.role === 'assistant' && contentText(m.content) === 'second reply'), 'B3 回合 2 的 providerHistory 还在');
    ok(pairingOk(ph), 'B4 providerHistory 配对完好');
    const r1 = ev1.find(e => e.type === 'result');
    ok(r1 && r1.superseded === true, 'B5 过期回合的结果事件标 superseded:true(收尾存已丢弃)');
  }

  // ── [D] 空回复给提示 ──
  {
    const evs = await stream(main.port, { message: 'SCN-D 说点什么' });
    const sid = sessionIdOf(evs);
    const deltas = evs.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(/空回复/.test(deltas), `D1 空回复时流里有一句看得见的提示(实得 ${JSON.stringify(deltas)})`);
    const res = evs.find(e => e.type === 'result');
    ok(res && res.ok === true, 'D2 回合仍是正常结束(不是错误)');
    const s = await getSession(sid);
    const last = (s.messages || []).slice(-1)[0] || {};
    ok(last.role === 'assistant' && /空回复/.test(contentText(last.content)), 'D3 落盘的助手消息带这句提示(刷新后也看得见)');
    const ph = providerHistoryOf(main.home, sid);
    ok(!ph.some(m => m.role === 'assistant' && !contentText(m.content).trim() && !(m.tool_calls && m.tool_calls.length)), 'D4 providerHistory 里没有塞空 assistant');
    ok(!ph.some(m => /空回复/.test(contentText(m.content))), 'D5 提示只进显示正文,不进 providerHistory');
  }

  // ── [C] L2 摘要压缩期间按停止(小窗口:每回合都要压) ──
  {
    const small = await startWorkbench('compact', { contextWindow: 4000 });
    servers.push(small);
    ok(small.up, 'C0 小窗口 workbench starts');
    summaryDelayMs = 8000;
    const evs = [];
    let compactAt = 0, resultAt = 0;
    const p = stream(small.port, { message: 'SCN-C hello there' }, e => {
      evs.push(e);
      if (e.type === 'compact' && e.mode === 'summary' && e.phase === 'started' && !compactAt) compactAt = Date.now();
      if (e.type === 'result') resultAt = Date.now();
    });
    await waitFor(() => compactAt > 0, 15000);
    ok(compactAt > 0, 'C1 L2 摘要压缩开始了');
    await sleep(400);
    const sid = sessionIdOf(evs);
    const stopAt = Date.now();
    await request(small.port, 'POST', '/api/stop', { sessionId: sid }, small.H);
    await Promise.race([p, sleep(20000)]);
    const latency = resultAt ? resultAt - stopAt : Infinity;
    // 墙钟上界豁免：判的是「停止当场取消在飞的摘要调用」；修后实得约 80 ms，界 3000 ms；失败形态是等满摘要慢回的 8 s。
    ok(latency < 3000, `C2 摘要压缩期间停止当场生效(${latency} ms < 3000;修前要等摘要调用返回)`);
    const failed = evs.find(e => e.type === 'compact' && e.mode === 'summary' && e.phase === 'failed');
    ok(failed && failed.aborted === true, 'C3 「压缩中」状态条被收掉(failed + aborted)');
    ok(!evs.some(e => e.type === 'compact' && e.mode === 'summary' && e.phase === 'completed'), 'C4 被取消的摘要没有被重播种进历史');
    const hitsBefore = summaryHits;
    summaryDelayMs = 0;
    const ev2 = await stream(small.port, { message: 'SCN-C2 再来一句', sessionId: sid });
    ok(summaryHits > hitsBefore && ev2.some(e => e.type === 'compact' && e.mode === 'summary' && e.phase === 'completed'),
      `C5 被停止取消的摘要不算失败:下一回合照常再压并成功(摘要请求 ${hitsBefore} → ${summaryHits})`);
    const r2 = ev2.find(e => e.type === 'result');
    ok(r2 && r2.ok === true, 'C6 下一回合正常结束');
    ok(pairingOk(providerHistoryOf(small.home, sid)), 'C7 providerHistory 配对完好');
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  for (const s of servers) { try { killOwnTree(s.child); } catch { /* ignore */ } }
  for (const res of pending) { try { res.destroy(); } catch { /* ignore */ } }
  try { hang.closeAllConnections && hang.closeAllConnections(); hang.close(); } catch { /* ignore */ }
  await fake.close();
  await sleep(300);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}
t.done({ exit: true });
})();
