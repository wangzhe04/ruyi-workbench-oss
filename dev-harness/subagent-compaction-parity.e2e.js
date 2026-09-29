'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:子代理的上下文压缩与主回合走同一个内核(10 runAutoCompaction / runForcedOverflowCompaction)。
//
// 修前子代理那份是照主回合另写的,主回合后来加的几件没跟过去。本件在真工作台 + 脚本化假服务商上把子代理跑到压缩点,
// 断言它现在拿到的是主回合那一套:
//   A1 迭代边界的自动压缩在子代理里真的触发(L1 蒸发),日志里有带 subagentId 的 auto_compact / observation_reduced;
//   A2 被蒸发的工具结果换成【观察缩减视图】(带 rawRef=history:…),不再是修前的「[已省略:前 120 字]」;
//   A3 L1 之前的历史快照写进父会话的 checkpoints,且只写带内容哈希的文件名 —— 不覆盖父回合同一回合号的安全网快照;
//   A4 子代理用 observation_recall 按 rawRef 取回原件,拿到缩减视图里没有的那段事实(修前子代理有这个工具却拿不到 rawRef);
//   A5 压缩之后回到预算以内,整个子回合只压这一次(滞回水位本身由 context-governance.e2e 的沙箱件钉)。
//   F1 强压重试(服务端判定超窗的 400):子代理摘要重播种后重试成功,日志里有带 subagentId 的 forced_400 与 L2 摘要调用;
//   F2 窗口学习只在强压重试【成功】之后落账(45f P1-1,主回合早就这样):重试成功 → data/context-calibration.json 里出现
//      这个模型的学习上限(context-calibration.json);重试也失败(其实不是超窗)→ 一条都不写。修前子代理在重试之前就落账,误判会永久压窗。
// 做法:阶段 0 用一个超大窗口把同一段剧本跑一遍,量出子代理每一发请求的真实估算;阶段 1 按量出来的数设窗口,
// 让「读完两份中等文件之后」恰好越过预算、而蒸发掉那份大文件之后回到预算以内(只走 L1,不需要 L2)。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-subcompact-'));
const WORK = path.join(ROOT, 'work');
const t = createRunner('SUBAGENT COMPACTION PARITY');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FACT = 'MIDDLE-FACT-Q7X2';
// 摘要内核会校验结构(五节至少四节,状态节四项齐全),假摘要照这个形状给。
const SUMMARY = ['【目标】读文件', '【已确认的决定】无', '【未完成事项】无', '【当前执行状态】', '- 已完成:无', '- 进行中:回答', '- 阻塞:无', '- 下一步:收尾', '【关键文件与上下文】big.txt'].join('\n');

// 文件内容避开 reducer 的保护词(error / checkpoint / journal …),事实放在大文件约 3.6K 字符处:
// 缩减视图只留头尾(约 1.2K + 0.6K),召回的缺省 8K 视图(头 65%)拿得到它。
const filler = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} line ${String(i).padStart(5, '0')} lorem ipsum dolor sit amet consectetur`).join('\n');
fs.mkdirSync(WORK, { recursive: true });
{
  const lines = filler('big', 640).split('\n');
  lines.splice(60, 0, `the answer is ${FACT}`);
  fs.writeFileSync(path.join(WORK, 'big.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(WORK, 's1.txt'), filler('one', 240), 'utf8');
  fs.writeFileSync(path.join(WORK, 's2.txt'), filler('two', 240), 'utf8');
}

const subBodies = [];
let forcedServed = 0;
const isSub = req => String(((req.messages || []).find(m => m && m.role === 'system') || {}).content || '').includes('子任务执行体');
const toolResults = req => (req.messages || []).filter(m => m && m.role === 'tool');
function handler(req) {
  if (req.body && req.body.stream === false) return { status: 200, json: { id: 'sum', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: SUMMARY } }] } };
  if (!isSub(req)) return textFrames('parent ok');
  const all = JSON.stringify(req.messages);
  if (all.includes('ALWAYS_400_TASK')) { forcedServed += 1; return { status: 400, json: { error: { message: "This model's maximum context length is 8192 tokens" } } }; }
  if (all.includes('FORCED_TASK')) {
    // 第一发回超窗 400;摘要重播种之后的重试正常收尾
    if (!all.includes('【目标】')) { forcedServed += 1; return { status: 400, json: { error: { message: "This model's maximum context length is 8192 tokens" } } }; }
    return textFrames('forced retry ok');
  }
  subBodies.push(req.body);
  const n = toolResults(req).length;
  const file = name => ({ path: path.join(WORK, name) });
  if (n === 0) return toolCallFrames('file_read', file('big.txt'), 'call_big');
  if (n === 1) return toolCallFrames('file_read', file('s1.txt'), 'call_s1');
  if (n === 2) return toolCallFrames('file_read', file('s2.txt'), 'call_s2');
  if (n === 3) {
    // rawRef 在文本视图里写成 rawRef=…,在 JSON 视图里是 _ruyiObservation.rawRef 字段;两种都认
    const ref = (all.match(/(history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16})/) || [])[1];
    if (ref) return toolCallFrames('observation_recall', { rawRef: ref }, 'call_recall');
    return textFrames('no compaction happened');
  }
  const last = toolResults(req).slice(-1)[0];
  return textFrames(last && String(last.content).includes(FACT) ? 'recalled ' + FACT : 'recall missed');
}

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

// 起一个工作台(独立 HOME),跑一个子代理节点,返回 { home, sessionId, run, stop }
async function phase(name, fakeUrl, contextWindow, task) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 12, permissionMode: 'bypass', defaultWorkspace: WORK, stewardThreadBriefV1: false,
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true, runtimeOptimizationShadowV1: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fakeUrl, apiKey: 'k', model: 'sub-model', contextWindow }],
    activeProvider: 'fake',
  }));
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home } });
  let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
  const stop = () => { try { killOwnTree(wb); } catch { /* gone */ } };
  const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null), 80, 150);
  if (!up) { stop(); throw new Error('workbench did not start: ' + log.slice(-800)); }
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  const headers = { 'x-wcw-token': token };
  const created = await request(port, 'POST', '/api/sessions', { title: name, cwd: WORK }, headers);
  const sessionId = created.session.id;
  const launch = await request(port, 'POST', '/api/agent-workflow/launch', { token, sessionId, async: true, nodes: [{ id: 'reader', task, toolTier: 'read' }] }, headers);
  const run = await waitFor(async () => {
    const list = await request(port, 'GET', `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, null, headers);
    const r = list && Array.isArray(list.runs) && list.runs.find(x => x.id === launch.runId);
    return r && !r.live && ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(r.status) ? r : null;
  }, 600, 100);
  return { home, port, headers, sessionId, run, stop };
}
function logRecords(home) {
  const dir = path.join(home, 'logs');
  const out = [];
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { try { if (line.trim()) out.push(JSON.parse(line)); } catch { /* partial */ } }
  }
  return out;
}

(async () => {
  let fake = null, p0 = null, p1 = null, p2 = null, p3 = null;
  try {
    const srv = require(path.join(WB, 'app', 'server.js'));
    fake = await startFakeProvider({ handler });
    const TASK = '子任务:依次读 big.txt、s1.txt、s2.txt,然后回答 big.txt 里 the answer is 后面的标记。';

    // ── 阶段 0:超大窗口,量出子代理每一发请求的估算 ─────────────────────────────────────────────────
    p0 = await phase('p0', fake.url, 1000000, TASK);
    p0.stop();
    ok(p0.run && p0.run.status === 'succeeded', `阶段 0 子代理跑完(${p0.run && p0.run.status})`);
    const est = subBodies.map(b => srv.estimateHistoryTokens(b.messages, '', b.tools));
    ok(est.length >= 4 && est[1] > est[0] && est[3] > est[2], `阶段 0 量到 4 发请求的估算 ${JSON.stringify(est)}`);
    // 预算落在「读完 s1」与「读完 s2」之间:第 4 发之前越线、之前三发都不越;窗口 = 预算 / 0.8(autoCompactThreshold 缺省)
    const budget = Math.round((est[2] + est[3]) / 2);
    const bigTokens = est[1] - est[0];
    ok(est[3] - bigTokens + 800 < budget, `阶段 0 蒸发大文件之后能回到预算以内(${est[3]} - ${bigTokens} < ${budget})`);
    const windowTokens = Math.ceil(budget / 0.8);
    subBodies.length = 0;

    // ── 阶段 1:按量出来的数设窗口,子代理在第 4 发之前做 L1 自动压缩 ─────────────────────────────────
    p1 = await phase('p1', fake.url, windowTokens, TASK);
    const logs = logRecords(p1.home);
    p1.stop();
    ok(p1.run && p1.run.status === 'succeeded', `阶段 1 子代理跑完(${p1.run && p1.run.status}, window=${windowTokens})`);
    const autoLogs = logs.filter(r => r.kind === 'auto_compact' && r.subagentId);
    ok(autoLogs.some(r => r.mode === 'evaporate' && r.sessionId === p1.sessionId), `A1 子代理的自动压缩走了 L1 蒸发,日志带 subagentId 与父会话 id(${JSON.stringify(autoLogs.map(r => r.mode))})`);
    ok(logs.some(r => r.kind === 'observation_reduced' && r.subagentId && r.toolName === 'file_read'), 'A1 observation_reduced 日志带 subagentId');
    ok(!autoLogs.some(r => r.mode === 'summary'), 'A1 L1 已够,没有走 L2 摘要');
    const afterCompact = subBodies[3] ? JSON.stringify(subBodies[3].messages) : '';
    const bigView = String((((subBodies[3] && subBodies[3].messages) || []).find(m => m.role === 'tool' && m.tool_call_id === 'call_big') || {}).content || '');
    let bigMeta = null; try { bigMeta = JSON.parse(bigView)._ruyiObservation; } catch { /* not JSON */ }
    ok(bigMeta && bigMeta.reduced === true && /^history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}$/.test(bigMeta.rawRef) && !afterCompact.includes('[已省略:'),
      `A2 被蒸发的大文件换成带 rawRef 的观察缩减视图(不再是「[已省略:」占位)(${JSON.stringify(bigMeta && { policy: bigMeta.policy, rawRef: bigMeta.rawRef })})`);
    ok(!afterCompact.includes(FACT), 'A2 缩减视图里看不到中段事实(确实省掉了)');
    const journal = path.join(p1.home, 'checkpoints', p1.sessionId);
    const snaps = fs.existsSync(journal) ? fs.readdirSync(journal).filter(f => /^history-/.test(f)) : [];
    ok(snaps.length >= 1 && snaps.every(f => /^history-\d+-[a-f0-9]{16}\.json\.gz$/.test(f)),
      `A3 快照写进父会话 checkpoints,只有带内容哈希的文件名(${JSON.stringify(snaps)})`);
    const snapHas = snaps.some(f => zlib.gunzipSync(fs.readFileSync(path.join(journal, f))).toString('utf8').includes(FACT));
    ok(snapHas, 'A3 快照里是压缩前的原文');
    const recallBody = subBodies[4] ? JSON.stringify(subBodies[4].messages) : '';
    ok(recallBody.includes(FACT), 'A4 子代理用 observation_recall 取回了原文中段的事实');
    ok(/recalled MIDDLE-FACT-Q7X2/.test(String(p1.run && p1.run.nodes && p1.run.nodes[0] && (p1.run.nodes[0].result || p1.run.nodes[0].summary) || '')), 'A4 节点结论里带着取回的事实');
    ok(autoLogs.length === 1, `A5 整个子回合只压一次(实 ${autoLogs.length} 次)`);

    // ── 阶段 2:强压重试(服务端判定超窗)─────────────────────────────────────────────────────────
    p2 = await phase('p2', fake.url, 1000000, 'FORCED_TASK 子任务:说一句话。');
    const logs2 = logRecords(p2.home);
    await sleep(400); // 窗口学习是异步写穿
    p2.stop();
    ok(p2.run && p2.run.status === 'succeeded' && forcedServed === 1, `F1 超窗 400 之后摘要重播种、重试成功(${p2.run && p2.run.status}, 400 发了 ${forcedServed} 次)`);
    ok(logs2.some(r => r.kind === 'auto_compact' && r.mode === 'forced_400' && r.subagentId && r.sessionId === p2.sessionId), 'F1 forced_400 日志带 subagentId 与父会话 id');
    const caps = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'context-calibration.json'), 'utf8')).windowCaps || {}; } catch { return {}; } };
    ok(Object.keys(caps(p2.home)).some(k => k.includes('sub-model')), `F2 重试成功 → 落了这个模型的窗口学习(${JSON.stringify(caps(p2.home))})`);
    // 阶段 3:重试也是 400(其实不是超窗)→ 窗口学习一条都不写
    forcedServed = 0;
    p3 = await phase('p3', fake.url, 1000000, 'ALWAYS_400_TASK 子任务:说一句话。');
    await sleep(400);
    p3.stop();
    ok(p3.run && p3.run.status !== 'succeeded' && forcedServed === 2, `F2 重试仍是 400 → 子代理失败收场(${p3.run && p3.run.status}, 400 发了 ${forcedServed} 次)`);
    ok(Object.keys(caps(p3.home)).length === 0, `F2 重试没成功 → 不落窗口学习(${JSON.stringify(caps(p3.home))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    for (const p of [p0, p1, p2, p3]) if (p) p.stop();
    if (fake) await fake.close();
    if (!t.failures) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log('[kept for inspection] ' + ROOT);
  }
  t.done({ exit: true });
})();
