'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:工作台记忆的【注入布局】(走查 记忆 B #6 / #9 / #10)。真工作台 + 脚本化假 provider / 假 Claude CLI,断网可跑。
//
//   [P] provider 引擎(默认布局):
//     P1 核心胶囊在首条 user 里,三回合逐字节相同;
//     P2 第二、第三回合的首条 user 逐字节相同、且不含随消息变化的检索回执/相关索引 —— 修前相关列表一变,首条 user 就变,
//        provider 的前缀缓存从 messages[1] 起整段作废(实测 matches="1"→"2");
//     P3 回执 + 相关索引改投末条 user 尾部,系统提示三回合也逐字节相同;
//     P4 #6 索引行不带记忆文件路径,是 [id](scope),指示用 workbench_memory_read(provider 的 file_read 封了记忆目录);
//     P5 check 行如实:零命中只有默认规则补位时 matches="0" rule-fill="1"(修前报「额外匹配 1 条」)。
//   [C] Claude 引擎(WCW_FAKE_CLAUDE,resume 开):
//     C1 稳定索引(<workbench-context>)只发一次 —— 召回换了也不重发(修前 indexInjected 依次 true/true/false/true);
//     C2 首轮的 <workbench-context> 里只有核心胶囊,没有相关记忆索引;
//     C3 相关索引改拼进每回合信封(与检索回执同处),且仍带绝对路径(Claude 用自己的 Read)。
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-injection-'));
const t = createRunner('MEMORY RECALL INJECTION');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
function stream(port, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* partial */ } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}
async function startWorkbench(home, extraEnv) {
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, ...(extraEnv || {}) } });
  let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
  const stop = () => { try { killOwnTree(wb); } catch { /* gone */ } };
  const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null), 100, 150);
  if (!up) { stop(); throw new Error('workbench did not start: ' + log.slice(-800)); }
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  return { port, stop, headers: { 'x-wcw-token': token } };
}
// 同一批记忆夹具(经 API 落盘):1 条核心偏好 + 2 条教训 + 1 条惯例(惯例用来造「零命中规则补位」)。
async function seedMemories(wb, cwd) {
  const save = (memory) => request(wb.port, 'POST', '/api/memory', { memory, cwd }, wb.headers);
  const rs = [
    await save({ id: 'core-zh', scope: 'project', type: 'preference', name: '默认中文回复', description: '默认使用简体中文回答用户', body: 'x', core: true }),
    await save({ id: 'deploy-notes', scope: 'project', type: 'lesson', name: 'deploy pipeline notes', description: 'deploy pipeline must run the release workflow first', body: 'x' }),
    await save({ id: 'vite-hmr', scope: 'project', type: 'lesson', name: 'vite 热更新失效', description: 'vite 热更新失效时检查 watch 配置和文件监听数量', body: 'x' }),
    await save({ id: 'conv-commit', scope: 'project', type: 'convention', name: '提交规范', description: '提交信息写清楚改了什么', body: 'x' }),
  ];
  return rs.every(r => r && r.ok);
}
const userTextOf = m => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.type === 'text') ? String(p.text || '') : '').join('\n') : ''));

(async () => {
  let fake = null, wbP = null, wbC = null;
  try {
    const WORK = path.join(ROOT, 'work'); fs.mkdirSync(WORK, { recursive: true });
    // ════════ [P] provider 引擎 ════════
    fake = await startFakeProvider({ handler: () => textFrames('ok') });
    const homeP = path.join(ROOT, 'home-p'); fs.mkdirSync(homeP, { recursive: true });
    fs.writeFileSync(path.join(homeP, 'config.json'), JSON.stringify({
      configSchema: 12, permissionMode: 'bypass', defaultWorkspace: WORK, stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake',
    }));
    wbP = await startWorkbench(homeP);
    ok(await seedMemories(wbP, WORK), 'P0 记忆夹具落盘(1 核心偏好 + 2 教训 + 1 惯例)');
    const Q1 = 'how do I run the deploy pipeline';
    const Q2 = 'vite 热更新不生效怎么办';
    const Q3 = '今天天气怎么样';
    const e1 = await stream(wbP.port, { message: Q1, cwd: WORK });
    const sid = (e1.find(e => e.type === 'session') || {}).session?.id;
    const e2 = await stream(wbP.port, { message: Q2, sessionId: sid, cwd: WORK });
    const e3 = await stream(wbP.port, { message: Q3, sessionId: sid, cwd: WORK });
    ok(!!sid && [e1, e2, e3].every(ev => (ev.find(e => e.type === 'result') || {}).ok), 'P0b 三回合都正常完成');
    const mains = fake.requests.filter(b => b && b.stream !== false && Array.isArray(b.messages));
    const reqOf = q => mains.find(b => { const us = b.messages.filter(m => m.role === 'user'); return us.length && userTextOf(us[us.length - 1]).includes(q); }); // 首回合那条 user 前面还有易变前缀,所以用 includes
    const [r1, r2, r3] = [reqOf(Q1), reqOf(Q2), reqOf(Q3)];
    ok(r1 && r2 && r3, 'P0c 三个回合的请求都抓到了');
    if (r1 && r2 && r3) {
      const users = r => r.messages.filter(m => m.role === 'user').map(userTextOf);
      const sys = r => userTextOf(r.messages.find(m => m.role === 'system') || {});
      const [u1, u2, u3] = [users(r1), users(r2), users(r3)];
      const coreOf = text => (text.match(/<workbench-memory-core>[\s\S]*?<\/workbench-memory-core>/) || [''])[0];
      ok(coreOf(u1[0]).includes('[core-zh]') && coreOf(u1[0]) === coreOf(u2[0]) && coreOf(u2[0]) === coreOf(u3[0]), 'P1 核心胶囊在首条 user 里,三回合逐字节相同');
      ok(u2[0] === u3[0] && u2.length === 2 && u3.length === 3, `P2 第二、第三回合的首条 user 逐字节相同(前缀缓存不再从 messages[1] 断裂)(${u2[0] === u3[0]})`);
      ok(!/<workbench-memory-check mode=/.test(u2[0]) && !/<workbench-memory>/.test(u2[0]) && !u2[0].includes('vite-hmr'), 'P2b 首条 user 里没有检索回执 / 相关索引');
      ok(sys(r1) === sys(r2) && sys(r2) === sys(r3), 'P3 系统提示三回合逐字节相同');
      const tail2 = u2[u2.length - 1];
      ok(tail2.startsWith(Q2) && /<workbench-memory-check mode="default"[^>]*matches="1"/.test(tail2) && /<workbench-memory>[\s\S]*vite-hmr/.test(tail2), 'P3b 第二回合的回执(matches=1)与相关索引在末条 user 尾部');
      ok(tail2.includes('- vite 热更新失效 [vite-hmr](project):') && !tail2.includes(WORK) && !/memory[\\/]project[\\/][0-9a-f]{16}/.test(tail2), 'P4 索引行是 [id](scope),不带记忆文件路径');
      ok(/用 workbench_memory_read 工具按方括号里的 id 读取/.test(tail2) && !/用 file_read 工具/.test(tail2), 'P4b 表头指示 workbench_memory_read 按 id 读(不再让模型 file_read 被封的记忆目录)');
      const tail3 = u3[u3.length - 1];
      ok(tail3.startsWith(Q3) && /matches="0"[^>]*>/.test(tail3) && /rule-fill="1"/.test(tail3) && tail3.includes('[conv-commit](project)'), 'P5 零命中只有规则补位:matches="0" rule-fill="1",补位的惯例仍列出');
      ok(!/额外匹配 [1-9]/.test(tail3) && /额外匹配 0 条/.test(tail3), 'P5b 回执文字如实说额外匹配 0 条(修前把规则补位算成匹配)');
      const meta3 = e3.find(e => e.type === 'meta');
      ok(meta3 && meta3.memoryCheck && meta3.memoryCheck.matchCount === 0 && meta3.memoryCheck.ruleFillCount === 1, 'P5c 流式 meta 的 memoryCheck:matchCount 0、ruleFillCount 1');
    }
    wbP.stop(); wbP = null;

    // ════════ [C] Claude 引擎 ════════
    const homeC = path.join(ROOT, 'home-c'); fs.mkdirSync(homeC, { recursive: true });
    fs.writeFileSync(path.join(homeC, 'config.json'), JSON.stringify({
      configSchema: 7, activeProvider: '', permissionMode: 'bypass', engineMode: 'interactive', includePartialMessages: false, autoImportClaudeCodeMcp: false,
      autoResumeClaudeSessions: true, defaultWorkspace: WORK,
    }));
    const stdinCap = path.join(homeC, 'stdin.txt');
    // WCW_FAKE_SID 固定假 CLI 回报的 session id —— 模拟真 CLI 的 --resume 保真(默认每次 spawn 随机 = 每轮都是新对话,稳定索引每轮都得重发)。
    wbC = await startWorkbench(homeC, { WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_STDIN_CAPTURE: stdinCap, WCW_FAKE_SID: 'fake-claude-resume-sid-0001' });
    ok(await seedMemories(wbC, WORK), 'C0 记忆夹具落盘');
    const turns = [];
    let csid = '';
    for (const q of [Q1, Q2, Q3, Q1]) {
      try { fs.rmSync(stdinCap, { force: true }); } catch { /* ignore */ }
      const ev = await stream(wbC.port, { message: q, cwd: WORK, ...(csid ? { sessionId: csid } : {}) });
      csid = csid || ((ev.find(e => e.type === 'session') || {}).session || {}).id || '';
      await waitFor(() => fs.existsSync(stdinCap), 50, 100);
      let text = '';
      try { text = JSON.parse(fs.readFileSync(stdinCap, 'utf8')).message.content[0].text; } catch { text = ''; }
      turns.push({ meta: ev.find(e => e.type === 'meta') || {}, text, q });
      try { fs.writeFileSync(path.join(ROOT, 'claude-turn-' + turns.length + '.txt'), text, 'utf8'); } catch { /* inspection aid only */ }
    }
    ok(turns.every(x => x.text), 'C0b 四回合都抓到了 stdin');
    const injected = turns.map(x => x.meta.indexInjected);
    ok(JSON.stringify(injected) === JSON.stringify([true, false, false, false]), `C1 稳定索引只在首轮发一次,换召回不重发(indexInjected=${JSON.stringify(injected)};修前每次召回一变整块就重发)`);
    const ctxBlock = (turns[0].text.match(/<workbench-context>[\s\S]*?<\/workbench-context>/) || [''])[0];
    ok(ctxBlock.includes('<workbench-memory-core>') && !ctxBlock.includes('<workbench-memory>') && !ctxBlock.includes('deploy-notes'), 'C2 首轮 <workbench-context> 里有核心胶囊、没有相关记忆索引');
    ok(turns.slice(1).every(x => !x.text.includes('<workbench-context>')), 'C2b 后续回合的信封里没有 <workbench-context>(去重生效)');
    const memFile = /\[vite-hmr\]\([^)]*vite-hmr\.md\)/;
    ok(memFile.test(turns[1].text) && turns[1].text.indexOf('<workbench-memory>') < turns[1].text.indexOf('<current_user_message>') && /matches="1"/.test(turns[1].text), 'C3 第二回合的相关索引(带绝对路径)与回执拼进回合信封,排在 current_user_message 之前');
    ok(!turns[2].text.includes('<workbench-memory>') || /conv-commit/.test(turns[2].text) && !/vite-hmr/.test(turns[2].text), 'C3b 第三回合(无关问句)信封里没有上一回合的相关列表');
    ok(/deploy-notes/.test(turns[3].text) && !/vite-hmr/.test(turns[3].text), 'C3c 第四回合(回到部署话题)信封里是部署那条,不是第二回合的');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    for (const w of [wbP, wbC]) if (w) w.stop();
    if (fake) await fake.close();
    if (!t.failures) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log('[kept for inspection] ' + ROOT);
  }
  t.done({ exit: true });
})();
