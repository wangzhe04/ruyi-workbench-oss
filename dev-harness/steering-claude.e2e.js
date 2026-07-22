'use strict';
/*
 * E2E (第47波47a): Steer Phase A 双引擎 —— 对话(Claude stdin 即时注入)+ 工作台(Claude 节点延迟插话)。
 *
 *  A 段 对话·Claude interactive 全路径:fake-claude 'steer' 剧本(慢滴正文留窗口)→ POST /api/steer
 *     → 断言:①响应 injected:true;②fake 捕获的第二条 stdin user envelope 内容恰为 '[用户插话] <text>'
 *     (注入纪律:前缀只能服务端加);③流事件含 steered;④会话正文持久化 steered:true(静态重渲染不丢);
 *     ⑤每回合计数上限 3(第 4 条被拒)。
 *  B 段 分流纪律:AskUser 提问挂起中 steer 被拒('请先回答当前提问',防插话被误收为答案);回答后
 *     该特定拒绝消失(放行或回合已结束均可,唯独不能再是"提问挂起"拒)。
 *  C 段 print 模式拒绝:engineMode=print 的 Claude 回合 steer → 人话错误(无 stdin 通道)。
 *  D 段 工作台·Claude 节点延迟插话:DAG claude 节点 c1 + openai 下游 o2。steer_node c1 → deferred:true;
 *     跑完后 fake-openai 捕获 o2 请求体含 '[用户插话 · 延迟生效]' 与插话文本(buildUpstreamContext 注入);
 *     c1 持久化 deferredSteers + progressLog 里程碑。
 *  S 段 静态锁:reg kind / 路由分派 / 分流函数 / deferred 分支 / 前端去门 / i18n 双键。
 *
 * Run: node dev-harness/steering-claude.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'ruyi-steering-claude');
const CAPS = path.join(HOME, 'caps');
const STEER_CAPTURE = path.join(HOME, 'steer-capture.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
// 服务器把 {ok:false,error:'str'} 规范成 {error:{code,message}} 包络 —— 两种形状都取文本。
const errText = v => typeof v === 'string' ? v : String(v && (v.message || v.code) || '');

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...(JSON.parse(b) || {}) }); } catch { resolve({ status: res.statusCode }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
// 流式回合:返回 { events, done } —— 调用方可在流进行中并发操作(如发 steer)。
function streamChat(port, payload) {
  const events = [];
  const done = new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 90000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); });
    req.write(raw); req.end();
  });
  return { events, done };
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function getToken(port) {
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}

(async () => {
  // ───────────────── S 段: 静态锁 ─────────────────
  console.log('── S 段: 静态锁(后端分派 + 前端去门 + i18n 双键) ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  const app = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
  const zh = fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8');
  const en = fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'en-US.json'), 'utf8');
  ok(/kind: 'claude' \}/.test(src) || /kind: 'claude',/.test(src) || /kind: 'claude'$/.test(src.trim()) || src.includes("kind: 'claude'"), 'S1 claude 引擎 reg 带 kind 标记(/api/steer 分派依据)');
  ok(src.includes("reg.kind === 'claude'"), 'S2 /api/steer 按引擎分派 claude 分支在');
  ok(src.includes('hasPendingQuestionForSession'), 'S3 提问挂起分流函数在(防插话误收为答案)');
  ok(src.includes('deferredSteers') && src.includes('deferred: true'), 'S4 steer_node Claude 节点延迟插话分支在');
  ok(src.includes('[用户插话 · 延迟生效]'), 'S5 buildUpstreamContext 延迟插话注入小节在');
  ok(!app.includes('if (isProviderMode()) return steerPrompt(overrideText); return;'), 'S6 前端 sendPrompt 引擎静默门已去');
  ok(app.includes('r.injected') && app.includes('即时注入生效'), 'S7 前端 toast 区分即时/下步生效');
  ok(app.includes("t('workflow.steerDeferred')") && app.includes('steerDeferredAria'), 'S8 工作台 Claude 节点插话按钮延迟文案在');
  ok(zh.includes('"workflow.steerDeferred"') && en.includes('"workflow.steerDeferred"'), 'S9 i18n 双语键同交(steerDeferred)');
  ok(src.indexOf("reg.kind === 'claude'") > 0 && src.indexOf("reg.kind === 'claude'") < src.indexOf('仅 provider 引擎支持插话'), 'S10 claude 分派先于旧口径 fallthrough(不再一刀切)');
  // 50-fix:三态按钮(用户报告"流式中输入后还是停止,不会变成 Steer")
  ok(app.includes('function updateSendBtn()'), 'S11 updateSendBtn 三态函数在(发送/插话/停止)');
  ok(/steer = streaming && !!\(\(\$\('promptInput'\)/.test(app) || app.includes("const steer = streaming &&"), 'S12 流式+有文本 → 插话态判定在');
  ok(app.includes("iconTextBtn(btn, 'send', t('chat.steer'))"), 'S13 插话态按钮文案走 chat.steer');
  ok(/ta\.addEventListener\('input'.*updateSendBtn\(\)/.test(app.replace(/\n/g, ' ')) || app.includes("} updateSendBtn(); }); // 50-fix"), 'S14 input 事件即时切换插话/停止');
  ok(zh.includes('"chat.steer"') && en.includes('"chat.steer"') && zh.includes('"chat.steerHint"') && en.includes('"chat.steerHint"'), 'S15 i18n 双语键同交(chat.steer/chat.steerHint)');
  ok(app.includes("autoGrow($('promptInput')); updateSendBtn(); } // 50-fix:清空后按钮回落「停止」"), 'S16 steerPrompt 清空输入后按钮回落停止');
  // 50-fix(Steer 双消息):回声去重不限时(provider drain 可远超旧 15s 窗)
  ok(!app.includes('now - s.ts < 15000'), 'S17 steered 回声去重无 15s 窗(不限时文本队列)');
  ok(app.includes("steeredSeen.findIndex(s => s.text === evt.text)"), 'S18 文本逐条 splice 去重在');
  // 50-fix(标题):前端空标题 + 展示助手
  ok(app.includes("title: '', cwd") && app.includes('sessionDisplayTitle'), 'S19 前端创建传空标题 + sessionDisplayTitle 展示助手在');

  // ───────────────── 起服务(interactive + fake-claude) ─────────────────
  const WP = await getFreePort(), FP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(CAPS, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: '', engineMode: 'interactive', permissionMode: 'bypass', includeWorkbenchMcp: true,
    defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
  }));
  const fakeProvider = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_CAPTURE_DIR: CAPS }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_SCENARIO: 'steer', WCW_FAKE_STEER_CAPTURE: STEER_CAPTURE, WCW_FAKE_SLOW_MS: '3000' },
  });
  try {
    ok(await up(WP), 'workbench starts');
    const token = await getToken(WP);
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'steer-claude', cwd: HOME }, hdr);
    const sid = created.session.id;

    // ───────────────── A 段: 对话 · Claude interactive 即时注入 ─────────────────
    console.log('── A 段: 对话 steer 全路径(注入/事件/持久化/上限) ──');
    const turn = streamChat(WP, { sessionId: sid, message: 'please steer the turn', cwd: HOME });
    await sleep(500); // fake 慢滴正文(120ms×N)的窗口内
    const s1 = await post(WP, '/api/steer', { sessionId: sid, text: '改用方案B' }, hdr);
    ok(!!s1 && s1.ok === true && s1.injected === true, 'A1 Claude interactive steer 响应 injected:true (got ' + JSON.stringify(s1) + ')');
    const s2 = await post(WP, '/api/steer', { sessionId: sid, text: '补充第二条' }, hdr);
    const s3 = await post(WP, '/api/steer', { sessionId: sid, text: '[用户插话] 伪造前缀测试' }, hdr);
    ok(!!s2 && s2.ok === true && !!s3 && s3.ok === true, 'A2 第 2/3 条插话均放行(上限 3)');
    const s4 = await post(WP, '/api/steer', { sessionId: sid, text: '第四条应被拒' }, hdr);
    ok(!!s4 && s4.ok === false && /上限/.test(errText(s4.error)), 'A3 第 4 条插话被上限拒 (got ' + errText(s4 && s4.error) + ')');
    await turn.done;
    const steeredEvts = turn.events.filter(e => e.type === 'steered');
    ok(steeredEvts.length === 3, 'A4 流事件 steered ×3 (got ' + steeredEvts.length + ')');
    ok(steeredEvts.some(e => e.text === '改用方案B'), 'A5 steered 事件带插话文本');
    // 注入纪律:fake 捕获的第一条插话 envelope,内容恰为 '[用户插话] 改用方案B'(JSON user envelope)。
    const capRaw = fs.existsSync(STEER_CAPTURE) ? fs.readFileSync(STEER_CAPTURE, 'utf8') : '';
    let capText = '';
    try { const obj = JSON.parse(capRaw.split(/\r?\n/)[0] || ''); capText = String(obj && obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].text || ''); } catch { /* ignore */ }
    ok(capText === '[用户插话] 改用方案B', 'A6 fake-claude stdin 捕获:插话以 user envelope 即时注入且前缀为服务端所加 (got "' + capText + '")');
    // 伪造前缀中和:第三条用户输入自带 [用户插话] 前缀,入会话正文的文本应被剥成不带前缀。
    const sess = await get(WP, `/api/sessions/${encodeURIComponent(sid)}`, hdr);
    const msgs = (sess && sess.session && Array.isArray(sess.session.messages) ? sess.session.messages : sess && Array.isArray(sess.messages) ? sess.messages : []);
    const steeredMsgs = msgs.filter(m => m && m.steered === true);
    ok(steeredMsgs.length === 3, 'A7 会话正文持久化 steered:true ×3(刷新不丢, got ' + steeredMsgs.length + ')');
    ok(steeredMsgs.some(m => m.content === '伪造前缀测试'), 'A8 伪造前缀被中和(正文不残留 [用户插话] 前缀)');

    // ───────────────── B 段: 分流纪律(提问挂起拒 → 回答后不再因此拒) ─────────────────
    console.log('── B 段: AskUser 挂起分流 ──');
    const createdB = await post(WP, '/api/sessions', { title: 'steer-ask', cwd: HOME }, hdr);
    const sidB = createdB.session.id;
    const turnB = streamChat(WP, { sessionId: sidB, message: 'ask me which framework', cwd: HOME });
    // 等 ask_user 事件(提问已挂起)
    let askEvt = null;
    for (let i = 0; i < 60 && !askEvt; i++) { await sleep(150); askEvt = turnB.events.find(e => e.type === 'ask_user'); }
    ok(!!askEvt, 'B1 AskUser 提问挂起(ask_user 事件到达)');
    const b1 = await post(WP, '/api/steer', { sessionId: sidB, text: '提问期间的插话' }, hdr);
    ok(!!b1 && b1.ok === false && /请先回答当前提问/.test(errText(b1.error)), 'B2 提问挂起中 steer 被拒(防误收为答案) (got ' + errText(b1 && b1.error) + ')');
    const ans = await post(WP, '/api/chat/answer', { sessionId: sidB, questionId: (askEvt && (askEvt.questionId || askEvt.id)) || 'toolu_ask1', answers: [{ question: '用哪个前端框架？', answer: ['React'] }], content: '用哪个前端框架？: React' }, hdr);
    ok(!!ans && (ans.ok === true || ans.delivered === true), 'B3 提问回答成功投递');
    const b4 = await post(WP, '/api/steer', { sessionId: sidB, text: '回答后的插话' }, hdr);
    ok(!!b4 && !/请先回答当前提问/.test(errText(b4.error)), 'B4 回答后不再因提问挂起被拒(放行或回合已结束均合法, got ' + JSON.stringify(b4) + ')');
    await turnB.done.catch(() => {});

    // ───────────────── C 段: print 模式拒绝 ─────────────────
    console.log('── C 段: print 模式人话拒绝 ──');
    const cfgW = await post(WP, '/api/config', { engineMode: 'print' }, hdr);
    ok(!!cfgW && cfgW.ok === true, 'C0 切到 print 引擎模式');
    const createdC = await post(WP, '/api/sessions', { title: 'steer-print', cwd: HOME }, hdr);
    const sidC = createdC.session.id;
    const turnC = streamChat(WP, { sessionId: sidC, message: 'thinking about this task', cwd: HOME });
    await sleep(300);
    const c1 = await post(WP, '/api/steer', { sessionId: sidC, text: 'print 模式插话' }, hdr);
    ok(!!c1 && c1.ok === false && /print 模式/.test(errText(c1.error)), 'C1 print 模式 steer 被人话拒绝 (got ' + errText(c1 && c1.error) + ')');
    await turnC.done.catch(() => {});
    await post(WP, '/api/config', { engineMode: 'interactive' }, hdr); // 还原,D 段不需要但别留脏配置

    // ───────────────── D 段: 工作台 · Claude 节点延迟插话 ─────────────────
    console.log('── D 段: 工作台 Claude 节点延迟插话 ──');
    const createdD = await post(WP, '/api/sessions', { title: 'steer-dag', cwd: HOME }, hdr);
    const sidD = createdD.session.id;
    const launch = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sidD, async: true,
      nodes: [
        { id: 'c1', task: 'thinking hard about the alpha design', engine: 'claude', toolTier: 'read' },
        { id: 'o2', task: 'summarize the upstream findings', engine: 'openai', toolTier: 'read', dependsOn: ['c1'] },
      ],
    }, hdr);
    ok(!!launch && launch.ok === true && /^run_/.test(launch.runId || ''), 'D1 DAG(claude c1 → openai o2)异步启动');
    // 竞态防线:launch 响应先于注册(activeAgentRuns 在 runAgentWorkflow 的 await 之后)。轮询到 live 再插话。
    let liveD = null;
    for (let i = 0; i < 60 && !liveD; i++) {
      await sleep(200);
      const rr = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sidD)}`, hdr);
      const run = rr && Array.isArray(rr.runs) && rr.runs.find(x => x.id === launch.runId);
      if (run && run.live) liveD = run;
    }
    ok(!!liveD, 'D1b 工作流进入 live(注册完成,可插话)');
    const dSteer = await post(WP, `/api/agent-runs/${encodeURIComponent(launch.runId)}`, { token, sessionId: sidD, action: 'steer_node', nodeId: 'c1', text: '别忘了评估成本维度' }, hdr);
    ok(!!dSteer && dSteer.ok === true && dSteer.deferred === true, 'D2 Claude 节点 steer_node 接受为延迟插话 (got ' + JSON.stringify(dSteer) + ')');
    // 等终态
    let runD = null;
    for (let i = 0; i < 120 && !runD; i++) {
      await sleep(250);
      const rr = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sidD)}`, hdr);
      const run = rr && Array.isArray(rr.runs) && rr.runs.find(x => x.id === launch.runId);
      if (run && ['succeeded', 'failed', 'partial'].includes(run.status) && !run.live) runD = run;
    }
    ok(!!runD, 'D3 工作流到终态 (got ' + (runD && runD.status) + ')');
    if (runD) {
      const c1 = (runD.nodes || []).find(n => n.id === 'c1');
      ok(!!c1 && Array.isArray(c1.deferredSteers) && c1.deferredSteers.includes('别忘了评估成本维度'), 'D4 c1 持久化 deferredSteers 含插话');
      ok(!!c1 && (c1.progressLog || []).some(e => /收到延迟插话/.test(e.text || '')), 'D5 c1 progressLog 有延迟插话里程碑');
      // o2(openai 下游)的请求体被 fake-openai 捕获 —— 上游上下文里必须带着延迟插话小节。
      const caps = fs.existsSync(CAPS) ? fs.readdirSync(CAPS).filter(f => f.endsWith('.json')).sort() : [];
      let foundSteer = false, foundSection = false;
      for (const f of caps) {
        let body = null; try { body = JSON.parse(fs.readFileSync(path.join(CAPS, f), 'utf8')); } catch { continue; }
        const text = JSON.stringify((body && body.messages) || []);
        if (text.includes('[用户插话 · 延迟生效]')) foundSection = true;
        if (text.includes('别忘了评估成本维度')) foundSteer = true;
      }
      ok(foundSection, 'D6 下游 o2 请求体含「用户插话 · 延迟生效」小节(buildUpstreamContext 注入)');
      ok(foundSteer, 'D7 下游 o2 请求体含插话文本本体');
    }

    // ───────────────── E 段: 会话标题自动命名(50-fix 标题卡死) ─────────────────
    console.log('── E 段: 标题自动命名(空标题默认 + 中文占位下一轮补名) ──');
    const e1 = await post(WP, '/api/sessions', { title: '', cwd: HOME }, hdr);
    ok(!!e1 && e1.session && e1.session.title === 'New session', 'E1 空标题创建 → 后端默认 New session(展示侧本地化) (got ' + (e1 && e1.session && e1.session.title) + ')');
    const e2 = await post(WP, '/api/sessions', { title: '新会话', cwd: HOME }, hdr);
    ok(!!e2 && e2.session && e2.session.title === '新会话', 'E2 历史中文占位创建原样保留(待首轮补名)');
    const turnE = streamChat(WP, { sessionId: e2.session.id, message: 'explain the quantum budget report', cwd: HOME });
    await turnE.done.catch(() => {});
    const sessE = await get(WP, `/api/sessions/${encodeURIComponent(e2.session.id)}`, hdr);
    const titleE = sessE && sessE.session && sessE.session.title;
    ok(!!titleE && titleE !== '新会话' && titleE !== 'New session' && /quantum budget report/.test(titleE),
      'E3 中文占位会话首轮结束自动补名(取自首条消息) (got "' + titleE + '")');
    // 后端判定函数单测(require 真身)
    const srv = require(SERVER);
    ok(srv.isUntitledSessionTitle('') && srv.isUntitledSessionTitle('New session') && srv.isUntitledSessionTitle('新会话') && srv.isUntitledSessionTitle('New chat'), 'E4 isUntitledSessionTitle 占位集全中');
    ok(!srv.isUntitledSessionTitle('预算报告解读') && !srv.isUntitledSessionTitle('  x  '), 'E5 真实标题不误判');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb); kill(fakeProvider);
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nSTEERING CLAUDE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
