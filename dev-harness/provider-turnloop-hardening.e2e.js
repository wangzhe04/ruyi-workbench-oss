require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(hunt2-turnloop):模型服务商引擎工具循环(09 runOpenAiTurn)的几处收口,一个服务进程 + 一个脚本化假 provider,
// 按第一条用户消息里的场景标记分支。流式解码层(04i / 07 openAiStreamOnce)的同批修复由 unit/provider-wire-stream 钉。
//   [A] 最终回答流式期间的插话:/api/steer 回了 ok,回合不许在「没有工具调用」处直接结束把它丢掉 —— 模型要再被调一次、
//       请求里带着 [用户插话];会话正文里有 steered 那条。
//   [B] 参数被截断的工具调用(finish_reason:length、参数是半截 JSON)不执行:修前按 {} 执行,todo_write({}) 清空任务清单。
//   [C] 计划审批挂着时 idle 看门狗豁免(WCW_TURN_IDLE_MS=1000):晚于看门狗阈值批准,回合照样继续执行、正常结束。
//   [D] 一批工具中途按停止:末尾那批没执行的调用在收尾时补上配对回复(「回合已被停止」),
//       下一回合不再出现「上次回会在执行该工具时中断」那条误导的 🛠 修复消息。
//   [E] 服务商跨迭代复用 tool_call id(每轮都叫 call_1)+ 批内插话中断:本批还没应答的 call_1 也要补配对,
//       不能因为上一轮答过 call_1 就当成已答。
//   [F] 429 在首字节前自动退避重试(一次限流不再整回合失败);一直 429 则归 errorClass rate_limited(不是 tool_error)。
//   [H] 子代理回合(08)同 [B]:半截参数的工具调用回「截断、未执行」的配对结果,不按 {} 执行。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-turnloop-hardening-'));
const WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('PROVIDER TURNLOOP HARDENING');
const { ok } = t;

const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
// 场景标记取「最后一条带标记的用户消息」:同一会话跨回合时两条标记都在历史里;插话、计划批准、产物自检
// 这些后插的用户消息不带标记,跳过。
function scenarioOf(messages) {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
}
const afterLastUser = messages => {
  const i = messages.map(m => m && m.role).lastIndexOf('user');
  return messages.slice(i + 1);
};
const hits = {};
const fake = await startFakeProvider({
  async handler(req) {
    const msgs = req.messages;
    // 非流式的是辅助调用(线程起名等),不计入场景
    if (!req.stream || msgs.some(m => m && m.role === 'system' && /起名字/.test(contentText(m.content)))) return textFrames('{"title":"t","gist":"g"}');
    const scn = scenarioOf(msgs);
    hits[scn] = (hits[scn] || 0) + 1;
    const n = hits[scn];
    const steered = msgs.some(m => m && m.role === 'user' && /^\[用户插话\]/.test(contentText(m.content)));
    const toolsAnswered = afterLastUser(msgs).some(m => m.role === 'tool');
    switch (scn) {
      case 'A':
        if (steered) return textFrames('已按插话补充');
        return { frames: textFrames(['最终', '回答', '在流']), delayMs: 400 };
      case 'B1':
        if (toolsAnswered) return textFrames('ok1');
        return toolCallFrames('todo_write', { items: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] }, 'c1');
      case 'B2':
        if (toolsAnswered) return textFrames('ok2');
        return toolCallFrames('todo_write', '{"items":[{"text":"a","status":"done"},{"text":"b","stat', 'c2', { finish: 'length' });
      case 'C':
        if (n === 1) return textFrames('PLAN: 1. 先做 a\n2. 再做 b');
        return textFrames('按计划执行完毕');
      case 'D':
        if (n === 1) return toolCallFrames([{ name: 'request_user_input', args: { questions: [{ question: '选哪个?', options: ['a', 'b'] }] }, id: 'd1' }, { name: 'list_directory', args: { path: '.' }, id: 'd2' }]);
        return textFrames('ok');
      case 'D2':
        return textFrames('next ok');
      case 'E':
        if (n === 1) return toolCallFrames('list_directory', { path: '.' }, 'call_1');
        if (n === 2) {
          req.open();
          req.sse({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '想一想' }, finish_reason: null }] });
          await sleep(700);
          for (const f of toolCallFrames([{ name: 'list_directory', args: { path: '.' }, id: 'call_9' }, { name: 'list_directory', args: { path: '..' }, id: 'call_1' }])) req.sse(f);
          req.end();
          return undefined;
        }
        return textFrames('ok');
      case 'F':
        if (n === 1) return { status: 429, json: { error: { message: 'rate limited', type: 'rate_limit_exceeded' } } };
        return textFrames('限流后成功');
      case 'G':
        return { status: 429, json: { error: { message: 'rate limited', type: 'rate_limit_exceeded' } } };
      case 'H': // 子代理(08 runSubAgentCore):半截参数的 file_write 同样不执行
        if (toolsAnswered) return textFrames('子任务完成');
        return toolCallFrames('file_write', '{"path":"' + path.join(HOME, 'h-out.txt').replace(/\\/g, '\\\\') + '","content":"半截', 'h1', { finish: 'length' });
      default:
        return textFrames('default');
    }
  },
});

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: WP, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); if (raw) r.write(raw); r.end();
  });
}
function stream(payload, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
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
const scnRequests = scn => fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);
// 配对连续性:每个 assistant.tool_calls 后面紧跟且恰好是它那几个 id 的 role:'tool'。
function pairingOk(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const want = new Set(m.tool_calls.map(tc => String(tc.id)));
    let j = i + 1;
    const got = new Set();
    while (j < messages.length && messages[j].role === 'tool') { got.add(String(messages[j].tool_call_id)); j++; }
    for (const id of want) if (!got.has(id)) return false;
  }
  return true;
}

fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: HOME,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
  activeProvider: 'fake',
}));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
  cwd: WB, windowsHide: true, stdio: 'ignore',
  // [C] 看门狗阈值压到 1 s(它每 5 s 巡检一次);工具心跳 250 ms 让其它场景的工具等待照常喂狗。
  env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_TURN_IDLE_MS: '1000', WCW_TOOL_HEARTBEAT_MS: '250' },
});
try {
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await request('GET', '/health')).status === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  ok(up, 'workbench starts');
  const page = await request('GET', '/');
  const token = (page.text.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  const H = { 'x-wcw-token': token };
  const getSession = async sid => { const s = await request('GET', '/api/sessions/' + sid, null, H); return (s.json && (s.json.session || s.json)) || {}; };

  // ── [A] 最终回答流式期间插话 ──
  {
    const evs = [];
    const p = stream({ message: 'SCN-A 回答我' }, e => evs.push(e));
    await waitFor(() => scnRequests('A').length >= 1, 10000);
    await sleep(300);
    const st = await request('POST', '/api/steer', { sessionId: sessionIdOf(evs), text: '再补一句结论' }, H);
    ok(st.json && st.json.ok === true, 'A1 最终回答流式期间 /api/steer 被接受');
    await p;
    const reqs = scnRequests('A');
    ok(reqs.length === 2 && reqs[1].messages.some(m => m.role === 'user' && /^\[用户插话\] 再补一句结论/.test(contentText(m.content))),
      `A2 插话没有被丢:模型被再调一次、请求里带着 [用户插话](实得 ${reqs.length} 次)`);
    const s = await getSession(sessionIdOf(evs));
    ok((s.messages || []).some(m => m.steered === true && m.content === '再补一句结论'), 'A3 会话正文里有 steered 那条');
    const res = evs.find(e => e.type === 'result');
    ok(res && res.ok === true, 'A4 回合正常结束');
  }

  // ── [B] 参数被截断的工具调用不执行 ──
  {
    const ev1 = [];
    await stream({ message: 'SCN-B1 建清单' }, e => ev1.push(e));
    const sid = sessionIdOf(ev1);
    const before = (await getSession(sid)).todos;
    ok(Array.isArray(before) && before.length === 2, 'B1 第一回合写入两条任务');
    const ev2 = await stream({ message: 'SCN-B2 更新清单', sessionId: sid });
    const tr = ev2.find(e => e.type === 'tool_result' && e.id === 'c2');
    ok(tr && tr.isError === true && tr.content && tr.content.argsInvalid === true && /截断/.test(tr.content.error || ''),
      'B2 半截参数的 todo_write 回失败结果(argsInvalid,说明是截断),没有执行');
    const after = (await getSession(sid)).todos;
    ok(JSON.stringify(after) === JSON.stringify(before), `B3 任务清单没被 {} 清空(实得 ${JSON.stringify(after)})`);
    const followUp = scnRequests('B2').pop();
    ok(followUp && pairingOk(followUp.messages) && followUp.messages.some(m => m.role === 'tool' && m.tool_call_id === 'c2'), 'B4 被拒的调用仍有配对回复,模型收到了');
  }

  // ── [C] 计划审批挂着时看门狗豁免 ──
  {
    const evs = [];
    let planEv = null;
    const p = stream({ message: 'SCN-C 做两件事', permissionMode: 'plan' }, e => { evs.push(e); if (e.type === 'plan') planEv = e; });
    ok(await waitFor(() => planEv, 15000), 'C1 计划模式弹出计划');
    await sleep(6500); // 看门狗每 5 s 巡检,阈值 1 s:修前此刻回合已被当作空闲杀掉
    ok(!evs.some(e => e.type === 'result'), 'C2 审批挂着的 6.5 s 里回合没有被看门狗杀掉');
    const d = await request('POST', '/api/plan/decision', { sessionId: sessionIdOf(evs), planId: planEv && planEv.planId, decision: 'approve' }, H);
    ok(d.json && d.json.ok === true, 'C3 批准被接受');
    await Promise.race([p, sleep(15000)]);
    const res = evs.find(e => e.type === 'result');
    ok(res && res.ok === true && !res.errorClass, `C4 批准后回合继续并正常结束(实得 ${JSON.stringify(res)})`);
    ok(scnRequests('C').length === 2 && !evs.some(e => e.type === 'stderr' && /watchdog/.test(e.text || '')), 'C5 批准后模型被再调一次,全程没有 watchdog 中止');
  }

  // ── [D] 一批工具中途停止 → 收尾补配对,下一回合没有误导的修复消息 ──
  {
    const evs = [];
    const p = stream({ message: 'SCN-D 问我' }, e => evs.push(e));
    ok(await waitFor(() => evs.some(e => /question|ask_user/.test(e.type || '')), 15000), 'D1 request_user_input 挂起提问');
    const sid = sessionIdOf(evs);
    const st = await request('POST', '/api/stop', { sessionId: sid }, H);
    ok(st.status === 200, 'D2 停止被接受');
    await p;
    await stream({ message: 'SCN-D2 下一条', sessionId: sid });
    const next = scnRequests('D2').pop();
    const d2reply = next && next.messages.find(m => m.role === 'tool' && m.tool_call_id === 'd2');
    ok(next && pairingOk(next.messages) && d2reply && /回合已被停止/.test(contentText(d2reply.content)),
      `D3 没执行的 d2 在收尾时就补了「回合已被停止」的配对回复(实得 ${JSON.stringify(d2reply && d2reply.content)})`);
    const s = await getSession(sid);
    ok(!(s.messages || []).some(m => m.source === 'repair'), 'D4 下一回合没有「上次回会在执行该工具时中断」的 🛠 修复消息');
  }

  // ── [E] 跨迭代复用 tool_call id + 批内插话中断 ──
  {
    const evs = [];
    const p = stream({ message: 'SCN-E 看目录' }, e => evs.push(e));
    await waitFor(() => scnRequests('E').length >= 2, 15000);
    await sleep(200);
    const st = await request('POST', '/api/steer', { sessionId: sessionIdOf(evs), text: '换个思路', mode: 'interrupt' }, H);
    ok(st.json && st.json.ok === true, 'E1 interrupt 插话被接受');
    await p;
    const reqs = scnRequests('E');
    const third = reqs[2];
    ok(third && pairingOk(third.messages), `E2 第三发请求里每个 tool_call 都有配对回复(含本批复用的 call_1;实得 ${third ? third.messages.map(m => m.role + (m.tool_calls ? '[' + m.tool_calls.map(x => x.id) + ']' : '') + (m.tool_call_id ? '<' + m.tool_call_id + '>' : '')).join(' | ') : 'none'})`);
  }

  // ── [F] 429 退避重试 / 一直 429 归 rate_limited ──
  {
    const evs = await stream({ message: 'SCN-F 你好' });
    const res = evs.find(e => e.type === 'result');
    ok(res && res.ok === true && scnRequests('F').length === 2, `F1 一次 429 后自动重试成功(实得 ${scnRequests('F').length} 发,${JSON.stringify(res)})`);
    ok(evs.some(e => e.type === 'stderr' && /限流/.test(e.text || '')), 'F2 重试时给出限流提示');
    const evs2 = await stream({ message: 'SCN-G 你好' });
    const res2 = evs2.find(e => e.type === 'result');
    ok(scnRequests('G').length === 4, `F3 一直 429:首发 + 3 次重试(实得 ${scnRequests('G').length})`);
    ok(res2 && res2.ok === false && res2.errorClass === 'rate_limited', `F4 重试用尽归 rate_limited(实得 ${res2 && res2.errorClass})`);
    const status = await request('GET', '/api/status', null, H);
    ok(status.json && status.json.errorClasses && status.json.errorClasses.rate_limited && status.json.errorClasses.rate_limited.zh, 'F5 ERROR_CLASSES 有 rate_limited 的人话');
  }

  // ── [H] 子代理回合同样不执行半截参数的工具调用 ──
  {
    const created = await request('POST', '/api/sessions', { title: 'sub', cwd: HOME }, H);
    const sid = created.json && created.json.session && created.json.session.id;
    const launched = await request('POST', '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [{ id: 'writer', task: 'SCN-H 写个文件' }] }, H);
    ok(launched.json && launched.json.ok === true, `H1 子代理工作流跑完(实得 ${launched.text.replace(/\s+/g, " ").slice(0, 200)})`);
    const follow = scnRequests('H').find(r => r.messages.some(m => m.role === 'tool' && m.tool_call_id === 'h1'));
    const reply = follow && follow.messages.find(m => m.role === 'tool' && m.tool_call_id === 'h1');
    ok(reply && /argsInvalid/.test(contentText(reply.content)) && /截断/.test(contentText(reply.content)), 'H2 子代理收到「参数被截断、未执行」的配对回复');
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { killOwnTree(wb); } catch { /* ignore */ }
  await fake.close();
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
t.done();
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
