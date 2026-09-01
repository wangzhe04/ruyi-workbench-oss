#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// session-notes-inject.e2e.js — 第 105 波切片 d-A · session notes 回注(23 号方案 §4.1)
//
// 覆盖:
//   [U] 白盒(require server.js,临时数据根):
//       开关三态(默认开/显式 false/字符串 "true" 洗回 false) / null·空(三节全「无」)·
//       坏 notes 不注入 / 开关开时注入块头+使用提示 / 2000 字符截断与省略计数 /
//       去重守门(首条 user 含【压缩摘要】或 (以下是此前对话的压缩摘要),含数组 content 形态) /
//       appendPromptToLastUserMessage 贴最后一条 user 的 string/数组两形态
//   [E] 集成(fake-openai 真实 HTTP 回合 + FAKE_CAPTURE_DIR 请求体捕获):
//       开关开 + 预置 notes 文件 → 请求体最后一条 user 含注入块(首条 user 不含) /
//       注入不写入 providerHistory(非持久) / 无 notes 文件零注入 /
//       首条 user 含摘要标记 → 跳过注入 / 显式关闭 → 零注入
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离纪律:require server.js 之前把数据根指向临时目录。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105d-inject-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function postStream(port, payload) { return new Promise(resolve => { const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let buf = ''; const events = []; res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } }); res.on('end', () => resolve(events)); }); req.on('error', () => resolve(events)); req.on('timeout', () => { req.destroy(); resolve(events); }); req.write(data); req.end(); }); }

const NOTES_MD = srv.renderSessionNotesMarkdown(
  { decisions: '- 用方案 B:路由懒加载', open: '- 补 e2e 回归', files: '- app/src/01-config.js 开关定义' },
  { sessionId: 'inject-u1', updatedAt: '2026-09-01T00:00:00.000Z', turnSeq: 3 });

// 请求体里最后一条 user 的纯文本(content 兼容 string/parts 数组)。
function lastUserText(body) {
  const users = ((body && body.messages) || []).filter(m => m && m.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) return last.content.map(p => p && typeof p.text === 'string' ? p.text : '').join('\n');
  return '';
}
function firstUserText(body) {
  const first = ((body && body.messages) || []).find(m => m && m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  if (Array.isArray(first.content)) return first.content.map(p => p && typeof p.text === 'string' ? p.text : '').join('\n');
  return '';
}

// 起一套 fake-openai + workbench;flags 写进 config.json;返回捕获目录等句柄。
async function launchStack(tag, flags) {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105d-e-' + tag + '-'));
  const CAP = path.join(EHOME, 'caps'); fs.mkdirSync(CAP, { recursive: true });
  fs.writeFileSync(path.join(EHOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 40000 }],
    activeProvider: 'fake',
    autoCompactThreshold: 0.8,
    ...(flags || {}),
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_NO_USAGE: '1', FAKE_CAPTURE_DIR: CAP },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: EHOME, RUYI_HOME: EHOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!' + tag + '] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await get(WB_PORT, '/health'); }
  const readCap = n => { try { return JSON.parse(fs.readFileSync(path.join(CAP, 'req-' + String(n).padStart(3, '0') + '.json'), 'utf8')); } catch { return null; } };
  const cleanup = async () => { kill(wb); kill(fake); await sleep(300); fs.rmSync(EHOME, { recursive: true, force: true }); };
  return { EHOME, WB_PORT, CAP, readCap, cleanup, healthy: !!h };
}
function presetNotes(EHOME, sid, markdown) {
  const dir = path.join(EHOME, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.session-notes.md'), markdown);
}

(async () => {
  // ═══ [U] 白盒:开关 / 注入块 / 守门 / 注入形态 ═══
  console.log('── [U] session-notes 回注白盒契约 ──');

  const cfgDefault = srv.normalizeConfig({}).config;
  ok(srv.sessionNotesInjectEnabled(cfgDefault) === true, 'U1 默认配置 sessionNotesInjectEnabled=true(真实历史门后默认开)');
  const cfgOff = srv.normalizeConfig({ runtimeSessionNotesInjectV1: false }).config;
  const cfgOn = srv.normalizeConfig({ runtimeSessionNotesInjectV1: true }).config;
  ok(srv.sessionNotesInjectEnabled(cfgOff) === false, 'U2 显式 false 时关闭(可回退旧行为)');
  const cfgStr = srv.normalizeConfig({ runtimeSessionNotesInjectV1: 'true' }).config;
  ok(srv.sessionNotesInjectEnabled(cfgStr) === false, 'U3 sanitize 只认 JSON 布尔(字符串 "true" 洗回 false)');

  ok(srv.buildSessionNotesInjectPrompt(NOTES_MD, cfgOff) === '', 'U4 显式关闭时即便有 notes 也不注入(零行为变化)');
  ok(srv.buildSessionNotesInjectPrompt(null, cfgOn) === '', 'U5 null notes → 不注入');
  ok(srv.buildSessionNotesInjectPrompt('', cfgOn) === '', 'U6 空串 notes → 不注入');
  const emptyMd = srv.renderSessionNotesMarkdown({ decisions: '无', open: '无', files: '无' }, {});
  ok(srv.buildSessionNotesInjectPrompt(emptyMd, cfgOn) === '', 'U7 三节全「无」→ 不注入');
  ok(srv.buildSessionNotesInjectPrompt('随手写的没有节标题的文本', cfgOn) === '', 'U8 坏 notes(无三节标题)→ 不注入');

  const prompt = srv.buildSessionNotesInjectPrompt(NOTES_MD, cfgOn);
  ok(prompt.startsWith('[Ruyi session notes — runtime context, not user-authored]'), 'U9 注入块以非用户 authored 标记开头');
  ok(prompt.includes('newest summary wins') && prompt.includes('用方案 B') && prompt.includes('补 e2e 回归'), 'U10 注入块含使用提示与 notes 正文');

  const bigMd = srv.renderSessionNotesMarkdown({ decisions: 'x'.repeat(3000), open: '无', files: '无' }, {});
  const bigPrompt = srv.buildSessionNotesInjectPrompt(bigMd, cfgOn);
  ok(bigPrompt.includes('chars omitted') && bigPrompt.length <= 2000, 'U11 整个注入块 ≤2000 字符且带省略计数标记');

  ok(srv.historyStartsWithCompactionSummary([{ role: 'user', content: '【压缩摘要】\nxxxx' }]) === true, 'U12 守门:首条 user 含【压缩摘要】→ 跳过');
  ok(srv.historyStartsWithCompactionSummary([{ role: 'user', content: '(以下是此前对话的压缩摘要)\nxxxx' }]) === true, 'U13 守门:首条 user 含 (以下是此前对话的压缩摘要) → 跳过');
  ok(srv.historyStartsWithCompactionSummary([{ role: 'user', content: [{ type: 'text', text: '(以下是此前对话的压缩摘要)\nxxxx' }] }]) === true, 'U14 守门:数组 content 形态同样识别');
  ok(srv.historyStartsWithCompactionSummary([{ role: 'user', content: '普通问题' }, { role: 'user', content: '(以下是此前对话的压缩摘要)\nxxxx' }]) === false, 'U15 守门只看首条 user(次条含标记不跳过)');
  ok(srv.historyStartsWithCompactionSummary([]) === false && srv.historyStartsWithCompactionSummary(null) === false, 'U16 空/坏历史安全放行');

  const msgs1 = [{ role: 'system', content: 'sys' }, { role: 'user', content: '第一问' }, { role: 'assistant', content: '答一' }, { role: 'user', content: '第二问' }];
  ok(srv.appendPromptToLastUserMessage(msgs1, 'INJECT') === true
    && msgs1[3].content === '第二问\n\nINJECT' && msgs1[1].content === '第一问', 'U17 string content:贴最后一条 user,首条不动');
  const msgs2 = [{ role: 'user', content: [{ type: 'text', text: '带图问题' }, { type: 'image_url', image_url: { url: 'data:...' } }] }];
  ok(srv.appendPromptToLastUserMessage(msgs2, 'INJECT') === true
    && Array.isArray(msgs2[0].content) && msgs2[0].content.length === 3
    && msgs2[0].content[2].type === 'text' && msgs2[0].content[2].text === 'INJECT', 'U18 数组 content:追加 text part 不改原有 part');
  const msgs3 = [{ role: 'system', content: 'sys' }, { role: 'assistant', content: 'a' }];
  ok(srv.appendPromptToLastUserMessage(msgs3, 'INJECT') === false && msgs3.length === 2, 'U19 无 user 消息 → false 且不改消息');
  ok(srv.appendPromptToLastUserMessage(msgs1, '') === false, 'U20 空提示 → false(不再动消息)');

  // ═══ [H] 项目真实 checkpoint:历史 L2 摘要 → notes 注入块/去重守门 ═══
  console.log('── [H] 真实历史 notes 回注 ──');
  const histPath = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-25.json.gz');
  if (!fs.existsSync(histPath)) {
    console.log('SKIP H1-H3 realhist fixture 不在当前环境');
  } else {
    try {
      const zlib = require('zlib');
      const hist = JSON.parse(zlib.gunzipSync(fs.readFileSync(histPath)).toString('utf8'));
      const historicalSummary = String(hist[0] && hist[0].content || '').replace(/^\(以下是此前对话的压缩摘要\)\s*/, '');
      const historicalNotes = srv.extractSessionNotes(historicalSummary);
      const historicalMd = srv.renderSessionNotesMarkdown(historicalNotes, { sessionId: 'inject-h1', turnSeq: 25 });
      const historicalPrompt = srv.buildSessionNotesInjectPrompt(historicalMd, cfgOn);
      ok(historicalSummary.includes('【已确认的决定】') && historicalSummary.includes('【未完成事项】') && historicalSummary.includes('【关键文件与上下文】'), 'H1 真实 history-25 首条为五节 L2 摘要');
      ok(historicalPrompt.length <= 2000 && historicalPrompt.includes('chars omitted') && historicalPrompt.includes('newest summary wins'), 'H2 真实 notes 注入块整体 ≤2000 且保留提示/省略标记');
      ok(srv.historyStartsWithCompactionSummary(hist) === true, 'H3 真实压缩历史命中去重守门(不重复注入上游摘要)');
    } catch (e) { ok(false, 'H* 真实历史解析异常: ' + e.message); }
  }

  // ═══ [E] 集成:fake-openai 真实 HTTP 回合 ═══
  // E-A: 开关开。turn1 无 notes(零注入);写入 notes 后 turn2 最后一条 user 应含注入块;
  //      首条 user 不含;providerHistory 不落注入块(非持久)。
  console.log('── [E] fake-openai 集成(开关开) ──');
  {
    const A = await launchStack('a', { runtimeSessionNotesInjectV1: true });
    ok(A.healthy, 'E0 workbench A listening on :' + A.WB_PORT);
    try {
      const ev1 = await postStream(A.WB_PORT, { message: '第一轮问题' });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      ok(!!sid && !!(ev1.find(e => e.type === 'result') || {}).ok, 'E1 turn1 回合 ok 且拿到 session id');
      const cap1 = A.readCap(1);
      ok(cap1 && !lastUserText(cap1).includes('[Ruyi session notes'), 'E2 无 notes 文件时请求体零注入(no_notes 跳过)');

      presetNotes(A.EHOME, sid, NOTES_MD);
      const ev2 = await postStream(A.WB_PORT, { sessionId: sid, message: '第二轮问题' });
      ok(!!(ev2.find(e => e.type === 'result') || {}).ok, 'E3 turn2 回合 ok');
      const cap2 = A.readCap(2);
      const lastText = lastUserText(cap2);
      ok(!!cap2 && lastText.includes('[Ruyi session notes — runtime context, not user-authored]'), 'E4 开关开+预置 notes → 最后一条 user 含注入块头');
      ok(lastText.includes('用方案 B') && lastText.includes('第二轮问题'), 'E5 注入块含 notes 正文且贴在最新问题旁');
      ok(!firstUserText(cap2).includes('[Ruyi session notes'), 'E6 首条 user 不含注入块(只贴最后一条)');
      const s1 = sid ? await get(A.WB_PORT, '/api/sessions/' + encodeURIComponent(sid)) : null;
      const ph = (s1 && s1.session && s1.session.providerHistory) || [];
      const phText = ph.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
      ok(ph.length >= 2 && !phText.includes('[Ruyi session notes'), 'E7 注入不写入 providerHistory(非持久)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await A.cleanup(); }
  }

  // E-B: 开关开,但首条 user 即摘要标记(用户首条消息粘贴了压缩摘要)→ 守门跳过注入。
  console.log('── [E] fake-openai 集成(去重守门) ──');
  {
    const B = await launchStack('b', { runtimeSessionNotesInjectV1: true });
    ok(B.healthy, 'E8 workbench B listening on :' + B.WB_PORT);
    try {
      const ev1 = await postStream(B.WB_PORT, { message: '(以下是此前对话的压缩摘要)\n【已确认的决定】\n- 旧决定' });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      ok(!!sid && !!(ev1.find(e => e.type === 'result') || {}).ok, 'E9 turn1 回合 ok(首条 user 带摘要标记)');
      presetNotes(B.EHOME, sid, NOTES_MD);
      const ev2 = await postStream(B.WB_PORT, { sessionId: sid, message: '继续' });
      ok(!!(ev2.find(e => e.type === 'result') || {}).ok, 'E10 turn2 回合 ok');
      const cap2 = B.readCap(2);
      ok(!!cap2 && !lastUserText(cap2).includes('[Ruyi session notes'), 'E11 首条 user 含摘要标记 → 跳过注入(summary_in_history)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await B.cleanup(); }
  }

  // E-C: 显式关闭:预置 notes 也零注入。
  console.log('── [E] fake-openai 集成(显式关闭) ──');
  {
    const C = await launchStack('c', { runtimeSessionNotesInjectV1: false });
    ok(C.healthy, 'E12 workbench C listening on :' + C.WB_PORT);
    try {
      const ev1 = await postStream(C.WB_PORT, { message: '第一轮问题' });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      ok(!!sid && !!(ev1.find(e => e.type === 'result') || {}).ok, 'E13 turn1 回合 ok');
      presetNotes(C.EHOME, sid, NOTES_MD);
      const ev2 = await postStream(C.WB_PORT, { sessionId: sid, message: '第二轮问题' });
      ok(!!(ev2.find(e => e.type === 'result') || {}).ok, 'E14 turn2 回合 ok');
      const cap2 = C.readCap(2);
      ok(!!cap2 && !lastUserText(cap2).includes('[Ruyi session notes') && !lastUserText(cap2).includes('用方案 B'),
        'E15 显式关闭 → 零注入(完整回退到 105b 只写不回注)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await C.cleanup(); }
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nSESSION-NOTES-INJECT E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  // 显式退出:残留的 workbench/fake 子进程句柄可能让事件循环挂住(同 observation-recall 纪律)
  setImmediate(() => process.exit(failures ? 1 : 0));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
