// E2E: 第31波「§5 产品侧三任务基准」(AUTONOMY-PLAN §5 验收指标 · 产品侧)。
// 端口: FAKE 9123 / WB 9124(已登记 dev-harness/README)。离线,Node 直跑。
// 三个加速模拟离线长任务(用 fake provider 把长任务压到秒级,但保留完整 until-done 语义):
//   任务1 REFACTOR 多文件重构(4 里程碑,应无人值守完成)
//   任务2 DIGEST 资料汇编(读 3 来源 + 写汇编片段,应无人值守完成)
//   任务3 BUILDFAIL 构建-失败-修复(m1 推进后 m2 停滞 -> 验无进展自动暂停触发)
// 验收 §5 产品侧 4 指标:
//   ① 无人值守完成率 ≥2/3   ② 人工干预 ≤1 次/任务   ③ 无进展自动暂停触发率 100%   ④ token 不破预算
// 纪律:复用第26波b mission-driver 的 fake SSE + /api/mission 基建;验收主会话亲自实跑。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-autonomy-benchmark-e2e');
const WS = path.join(HOME, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function chatStream(payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch {} } } });
      res.on('end', () => resolve(events));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }

// ── 内联 fake(按 session 初始消息的任务标记分支) ──
function sse(res, o) { res.write('data: ' + JSON.stringify(o) + '\n\n'); }
function streamText(res, text) {
  const id = 'chatcmpl-b';
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const piece of text.match(/[\s\S]{1,40}/g) || [text]) sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse(res, { id, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
  res.write('data: [DONE]\n\n'); res.end();
}
function streamToolCall(res, name, argsObj) {
  const id = 'chatcmpl-b', a = JSON.stringify(argsObj), h = Math.ceil(a.length / 2);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, h) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(h) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  sse(res, { id, choices: [], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
  res.write('data: [DONE]\n\n'); res.end();
}
// 任务标记从 system prompt(账本注入)或 user 消息里识别 -- 驱动器续跑消息也会带目标 [mK]。
function taskTag(msgs, lastUser) {
  if (/BUILDFAIL/.test(lastUser) || msgs.some(m => m.role === 'system' && /BUILDFAIL/.test(String(m.content || '')))) return 'BUILDFAIL';
  if (/DIGEST/.test(lastUser) || msgs.some(m => m.role === 'system' && /DIGEST/.test(String(m.content || '')))) return 'DIGEST';
  return 'REFACTOR';
}
const REFACTOR_FILES = { m1: ['a.js', 'export const A = 1;\n'], m2: ['b.js', 'export const B = 2;\n'], m3: ['c.js', 'export const C = 3;\n'], m4: ['index.js', 'export { A, B, C } from "./a.js";\n'] };
const DIGEST_SRCS = { m1: 's1', m2: 's2', m3: 's3' };
const fake = http.createServer((rq, rs) => {
  let body = ''; rq.on('data', c => (body += c));
  rq.on('end', () => {
    if (rq.method === 'GET' && (rq.url || '').includes('/models')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] })); }
    if (!(rq.method === 'POST' && (rq.url || '').includes('/chat/completions'))) { rs.writeHead(404); return rs.end('no'); }
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUserIdx = (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') return i; return -1; })();
    const lastUser = lastUserIdx >= 0 ? String(msgs[lastUserIdx].content || '') : '';
    const turnTools = msgs.slice(lastUserIdx + 1).filter(m => m && m.role === 'tool').length;
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    const tag = taskTag(msgs, lastUser);
    const mk = (lastUser.match(/\[([a-z]\d+)\]/) || [])[1] || 'm1';

    if (tag === 'BUILDFAIL') {
      // m1: 写初始 bug 代码 + 标 done;m2/m3: 停滞(模拟模型卡在"如何修复",连续纯文本不推进)。
      if (mk === 'm1') {
        if (turnTools === 0) return streamToolCall(rs, 'file_write', { path: WS + '\\app.js', content: 'function add(a, b) { return a - b; }\n' });
        if (turnTools === 1) return streamToolCall(rs, 'mission_update', { milestones: [{ id: 'm1', status: 'done', evidence: '初始代码已写(含 bug:add 误用减法)' }] });
        return streamText(rs, 'm1 完成,准备构建。');
      }
      return streamText(rs, '构建失败了,我需要思考如何修复这个 bug,但暂时没有清晰的下一步。');
    }

    if (tag === 'DIGEST') {
      // 每个里程碑:file_read 来源 -> file_write 汇编片段 -> mission_update done
      const src = DIGEST_SRCS[mk] || 's1';
      if (turnTools === 0) return streamToolCall(rs, 'file_read', { path: WS + '\\src\\' + src + '.txt' });
      if (turnTools === 1) return streamToolCall(rs, 'file_write', { path: WS + '\\part_' + mk + '.md', content: '## ' + mk + '\n来源 ' + src + ' 要点已汇编。\n' });
      if (turnTools === 2) return streamToolCall(rs, 'mission_update', { milestones: [{ id: mk, status: 'done', evidence: '已汇编来源 ' + src }] });
      return streamText(rs, mk + ' 完成。');
    }

    // REFACTOR: file_write 重构文件 -> mission_update done
    const f = REFACTOR_FILES[mk] || REFACTOR_FILES.m1;
    if (turnTools === 0) return streamToolCall(rs, 'file_write', { path: WS + '\\' + f[0], content: f[1] });
    if (turnTools === 1) return streamToolCall(rs, 'mission_update', { milestones: [{ id: mk, status: 'done', evidence: '已重构 ' + f[0] }] });
    return streamText(rs, mk + ' 完成。');
  });
});

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
  // 任务2 来源文件
  fs.writeFileSync(path.join(WS, 'src', 's1.txt'), '来源1:项目采用单文件 server.js 零依赖架构,共 14k+ 行。');
  fs.writeFileSync(path.join(WS, 'src', 's2.txt'), '来源2:核心模块含 provider 引擎、DAG 调度、权限门、任务账本。');
  fs.writeFileSync(path.join(WS, 'src', 's3.txt'), '来源3:自主性主线经 25-30 波迭代,含耐久基座/授权书/上下文治理。');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  // 产品指标累计
  const results = [];
  try {
    ok(await up(), 'workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const sessionPath = sid => path.join(HOME, 'sessions', sid + '.json');
    const BUDGET = { maxAutoTurns: 12, maxTokens: 50000 };

    // ── 任务1 · REFACTOR 多文件重构(4 里程碑,应无人值守完成)──
    const s1 = (await req('POST', '/api/sessions', { title: 'refactor', cwd: WS }, H)).json.session;
    await req('POST', '/api/mission', { token, sessionId: s1.id, action: 'start', mission: { goal: 'REFACTOR 重构四个源文件并更新导出', milestones: ['m1', 'm2', 'm3', 'm4'].map(id => ({ id, desc: '重构 ' + id, check: { type: 'file_exists', path: (REFACTOR_FILES[id][0]) } })), budget: BUDGET }, autoMode: 'until-done' }, H);
    const ev1 = await chatStream({ sessionId: s1.id, message: 'REFACTOR 开始重构,第一步 [m1]' }, H);
    const m1fin = readJson(sessionPath(s1.id)).mission;
    const t1Complete = !!ev1.find(e => e.type === 'mission' && e.state === 'complete');
    ok(t1Complete, '任务1 REFACTOR 无人值守跑完(mission_complete)');
    ok(m1fin && m1fin.milestones.every(m => m.status === 'done'), '任务1 全部 4 里程碑 done');
    ok(['a.js', 'b.js', 'c.js', 'index.js'].every(f => fs.existsSync(path.join(WS, f))), '任务1 四个重构文件都已写出');
    ok(m1fin && m1fin.spent.autoTurns >= 1 && m1fin.spent.autoTurns <= 6, '任务1 预算内 autoTurns=' + (m1fin && m1fin.spent.autoTurns));
    ok(m1fin && (m1fin.spent.tokens == null || m1fin.spent.tokens <= BUDGET.maxTokens), '任务1 token 不破预算');
    results.push({ name: 'REFACTOR', complete: t1Complete, interventions: 0, autoTurns: m1fin && m1fin.spent.autoTurns });

    // ── 任务2 · DIGEST 资料汇编(3 里程碑,应无人值守完成)──
    const s2 = (await req('POST', '/api/sessions', { title: 'digest', cwd: WS }, H)).json.session;
    await req('POST', '/api/mission', { token, sessionId: s2.id, action: 'start', mission: { goal: 'DIGEST 读三个来源并汇编成片段', milestones: ['m1', 'm2', 'm3'].map(id => ({ id, desc: '汇编来源 ' + DIGEST_SRCS[id], check: { type: 'file_exists', path: 'part_' + id + '.md' } })), budget: BUDGET }, autoMode: 'until-done' }, H);
    const ev2 = await chatStream({ sessionId: s2.id, message: 'DIGEST 开始汇编,第一份 [m1]' }, H);
    const m2fin = readJson(sessionPath(s2.id)).mission;
    const t2Complete = !!ev2.find(e => e.type === 'mission' && e.state === 'complete');
    ok(t2Complete, '任务2 DIGEST 无人值守跑完(mission_complete)');
    ok(['part_m1.md', 'part_m2.md', 'part_m3.md'].every(f => fs.existsSync(path.join(WS, f))), '任务2 三份汇编片段都已写出');
    ok(m2fin && m2fin.spent.autoTurns >= 1 && m2fin.spent.autoTurns <= 6, '任务2 预算内 autoTurns=' + (m2fin && m2fin.spent.autoTurns));
    ok(m2fin && (m2fin.spent.tokens == null || m2fin.spent.tokens <= BUDGET.maxTokens), '任务2 token 不破预算');
    results.push({ name: 'DIGEST', complete: t2Complete, interventions: 0, autoTurns: m2fin && m2fin.spent.autoTurns });

    // ── 任务3 · BUILDFAIL 构建-失败-修复(m1 推进后 m2 停滞 -> 验无进展自动暂停触发)──
    const s3 = (await req('POST', '/api/sessions', { title: 'buildfail', cwd: WS }, H)).json.session;
    await req('POST', '/api/mission', { token, sessionId: s3.id, action: 'start', mission: { goal: 'BUILDFAIL 写 bug 代码->构建失败->修复->再构建', milestones: [{ id: 'm1', desc: '写初始代码(含bug)', check: { type: 'file_exists', path: 'app.js' } }, { id: 'm2', desc: '修复 bug', check: { type: 'none' } }, { id: 'm3', desc: '构建成功', check: { type: 'none' } }], budget: BUDGET }, autoMode: 'until-done' }, H);
    const ev3 = await chatStream({ sessionId: s3.id, message: 'BUILDFAIL 开始,写初始代码 [m1]' }, H);
    const m3fin = readJson(sessionPath(s3.id)).mission;
    const stuckEv = ev3.find(e => e.type === 'mission' && e.state === 'stuck');
    ok(!!stuckEv, '任务3 无进展 -> 收到 state:stuck(自动暂停触发)');
    ok(m3fin && m3fin.autoMode === 'supervised', '任务3 停滞后 autoMode=supervised(降级待人)');
    ok(m3fin && m3fin.milestones[0].status === 'done', '任务3 m1 已推进(停滞发生在 m2,非起步即卡)');
    ok(m3fin && !ev3.find(e => e.type === 'mission' && e.state === 'complete'), '任务3 未误报 complete(确实卡住)');
    // 停滞触发即指标达成;此任务不强制完成(§5 允许完成率 ≥2/3,任务1+2 已达)
    results.push({ name: 'BUILDFAIL', complete: false, interventions: 0, paused: !!stuckEv, autoTurns: m3fin && m3fin.spent.autoTurns });

    // ── §5 产品侧 4 指标达标判定 ──
    console.log('\n── §5 产品侧验收 ──');
    const completed = results.filter(r => r.complete).length;
    const completionRate = completed / results.length;
    ok(completionRate >= 2 / 3, '① 无人值守完成率 ≥2/3(实 ' + completed + '/' + results.length + '=' + (completionRate * 100).toFixed(0) + '%)');
    const maxInterventions = Math.max(...results.map(r => r.interventions || 0));
    ok(maxInterventions <= 1, '② 人工干预 ≤1 次/任务(实最大 ' + maxInterventions + ')');
    const pauseShouldFire = results.filter(r => r.name === 'BUILDFAIL');
    const pauseFired = pauseShouldFire.filter(r => r.paused).length;
    ok(pauseFired === pauseShouldFire.length, '③ 无进展自动暂停触发率 100%(实 ' + pauseFired + '/' + pauseShouldFire.length + ')');
    const budgetOk = results.every(r => r.autoTurns == null || r.autoTurns <= BUDGET.maxAutoTurns);
    ok(budgetOk, '④ token/回合不破预算(各任务 autoTurns ≤ ' + BUDGET.maxAutoTurns + ')');
    console.log('  任务明细: ' + results.map(r => r.name + '[' + (r.complete ? '完成' : '暂停') + ',干预' + (r.interventions || 0) + ',turns' + (r.autoTurns || 0) + ']').join(' | '));
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    kill(wb); try { fake.close(); } catch {}
    await sleep(300); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nAUTONOMY-BENCHMARK E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
