(async () => {
'use strict';
// E2E(第 116 波 116-2a · 27 号文 §3.3「线程权限即管家边界」/ §8.6「权限的界面表达」):
// 线程级权限字段与就地快切。真服务 + 自带 fake-openai(会在每个回合发一次 file_write 工具调用,
// 于是「这一档到底放不放行」是可以用【文件有没有被写出来】直接观测的,不靠读内部状态)。
//
// 全局默认档统一设成 acceptEdits(edit 层自动放行 → 文件被写);于是:
//   · 会话级/请求级设成 plan → nativeToolGate 对 edit 层 block → 文件【不】出现;
//   · 没设 → 跟随全局 acceptEdits → 文件出现。
//
// 覆盖:
//  ① 存量会话:sessionMeta.permissionMode === null(缺省不写,零迁移),effectivePermissionMode === 全局档;
//     会话头文件里根本没有 permissionMode 这个键。
//  ② PATCH 设 plan → 该会话回合里的写工具被 block(文件不写),另一条会话不受影响(文件照写)。
//  ③ PATCH 设 auto 不带 confirm → 409 permission.confirm_required;带 confirm:true → 200;
//     非白名单值 → 400 session.invalid_permission_mode(且不落盘)。
//  ④ 请求级覆盖仍优先于会话级(会话级 auto + 请求级 plan → 仍然 block)。
//  ⑤ 清除(permissionMode:null)→ 回落全局,会话头文件里该键被删掉。
//  ⑥ 竞态防护【延后落盘】策略:活回合期间 PATCH 立刻返回(不被回合阻塞)、对读者立即生效,
//     回合结束后档位落到磁盘,且【回合刚写的消息一条不少】(这正是 116c 登记的既有根因)。
//  ⑦ 管家工具 steward_thread_permission:收紧成功 + 决策日志一行;放宽 → steward.widen_forbidden;
//     普通会话 ctx → steward.forbidden。
//  ⑧ steward_thread_status 的 effectivePermissionMode / sessionPermissionMode 与 PATCH 后一致。
// 117m-A1 追加(用户第六轮走查②「我已经默认线程全自动了,还是会有很多要求权限」):
//  ⑨ auto + exec + 普通工具(script_run 写个文件)→ 不弹权限,且工具真的执行;
//  ⑩ auto + exec + 高风险(命令文本含 rm -rf)→ 仍然弹权限,且超时 deny 后没有执行;
//  ⑪ nativeToolGate 真值矩阵(进程内纯函数):没传 toolName 回落 ask;九种高风险形状全 ask;
//     bypass/read/plan/dontAsk/acceptEdits/default 六条既有分支逐条钉住「一行没动」;
//  ⑫ 活回合中途 PATCH 改档:default → auto 放宽后同一回合的下一个工具不再弹窗、auto → default
//     收紧后重新弹窗(收紧比放宽更重要),并各记恰好一条 permission_mode_live 观测事件。
//
// ①–⑥ 走真服务 HTTP;⑦⑧ 在服务停掉之后【进程内】直调 TOOL_HANDLERS(合成管家 ctx),读的是同一个
// 数据根 —— 于是「HTTP 改的档,管家看得见」也是被验证的。
// 端口全部 getFreePort() 动态取。判定行:`SESSION PERMISSION MODE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-perm-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();

// ── fake-openai:每个回合先发一次 file_write(目标路径由测试端控制),拿到 tool 结果后回一句话 ──
// 117m-A1:多一个 nextTool 旋钮 —— 置上之后这一回合改发它(名字与参数都由测试端给),用来观测
// 【exec 档】工具在各档下到底放不放行。不置 = 逐字节走原来的 file_write 剧本。
let toolTargetPath = path.join(HOME, 'unused.txt');
let nextTool = null;
let providerDelayMs = 0;
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (providerDelayMs) await sleep(providerDelayMs);
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  // 【只看最后一条】:整段历史里往往留着上一回合的 tool 结果,用 some() 判会让第二个回合起再也不发工具调用。
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const hasToolResult = !!(last && last.role === 'tool');
  const wantTool = !hasToolResult && Array.isArray(body && body.tools) && body.tools.length;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  if (wantTool) {
    const callName = nextTool ? nextTool.name : 'file_write';
    const callArgs = nextTool ? nextTool.args : { path: toolTargetPath, content: 'written' };
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: callName, arguments: '' } }] } }] });
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(callArgs) } }] } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    frame({ choices: [{ index: 0, delta: { content: '好的，做完了。' } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

// ── config:全局默认档 acceptEdits(edit 层自动放行),权限超时短(万一走到 ask 也不会挂住) ──
function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'acceptEdits', permissionTimeoutMs: 4000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  }, null, 2), 'utf8');
}
writeConfig({});

// ── HTTP 小工具 ────────────────────────────────────────────────────────────────────────
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function reqJson(method, p, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers, timeout: 15000 }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); });
    if (data) r.write(data);
    r.end();
  });
}
// 一个完整回合:发 /api/chat/stream,收 NDJSON 事件数组。
function runTurn(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 60000 }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('turn timeout')); });
    r.write(data); r.end();
  });
}
const headPath = id => path.join(HOME, 'sessions', id + '.json');
const readHead = id => { try { return JSON.parse(fs.readFileSync(headPath(id), 'utf8')); } catch { return null; } };
const messageLines = id => { try { return fs.readFileSync(path.join(HOME, 'sessions', id + '.messages.ndjson'), 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch { return -1; } };
// 「这一档放不放行 edit 层工具」的可观测判据:回合跑完后目标文件在不在。
async function turnWritesFile(sessionId, extra) {
  const target = path.join(HOME, 'probe-' + Math.random().toString(36).slice(2, 8) + '.txt');
  toolTargetPath = target;
  nextTool = null;
  try { fs.unlinkSync(target); } catch { /* not there */ }
  await runTurn({ sessionId, message: '写个文件', cwd: HOME, ...(extra || {}) });
  return fs.existsSync(target);
}
// 117m-A1:同一个判据搬到 exec 档 —— 让这一回合发一次 script_run(node),脚本自己写一个标记文件。
// 于是「这一档放不放行 exec 层工具」有两条互相独立的可观测量:标记文件在不在(真跑了没),以及
// 事件流里有没有 permission_request(弹没弹窗)。riskyText 非空时把它塞进 code —— 命令文本里带
// `rm -rf` 之类的高风险动作,判据(stewardToolPermanentlyExempt)应当把它拦回「要人按」。
async function runExecTurn(sessionId, opts) {
  const o = opts || {};
  const marker = path.join(HOME, 'exec-probe-' + Math.random().toString(36).slice(2, 8) + '.txt');
  try { fs.unlinkSync(marker); } catch { /* not there */ }
  const risky = o.riskyText ? `// ${o.riskyText}\n` : '';
  nextTool = {
    name: o.toolName || 'script_run',
    args: { language: 'node', code: risky + `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` },
  };
  const events = await runTurn({ sessionId, message: '跑一句', cwd: HOME, ...(o.extra || {}) });
  nextTool = null;
  return {
    ran: fs.existsSync(marker),
    asked: events.some(e => e && e.type === 'permission_request'),
    events,
  };
}
// 观测日志:permission_mode_live 是「中途换档真的改变了这一步的判定」的唯一记账口。
function liveModeLogRows() {
  const day = new Date().toISOString().slice(0, 10);
  try {
    return fs.readFileSync(path.join(HOME, 'logs', `workbench-${day}.ndjson`), 'utf8')
      .split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.kind === 'permission_mode_live');
  } catch { return []; }
}

let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let up = null; for (let i = 0; i < 60 && !up; i++) { await sleep(150); up = await health(WB_PORT); }
  ok(!!up, '00 workbench 起来了');

  const mk = async title => (await reqJson('POST', '/api/sessions', { title, cwd: HOME })).json.session.id;
  const A = await mk('线程A'), B = await mk('线程B');

  /* ═══════════════ ① 存量会话:会话级为 null,生效档 = 全局 ═══════════════ */
  {
    const headA = readHead(A);
    ok(headA && !Object.prototype.hasOwnProperty.call(headA, 'permissionMode'),
      '① 新建/存量会话的会话头【没有】 permissionMode 这个键(缺省不写 = 跟随全局,零迁移)');
    const patched = await reqJson('PATCH', '/api/sessions/' + A, {}); // 空 patch:只为拿一份 sessionMeta
    const meta = patched.json && patched.json.sessionMeta;
    ok(patched.status === 200 && meta, '① 空 PATCH 200 并返回 sessionMeta');
    ok(meta && meta.permissionMode === null, '① sessionMeta.permissionMode === null(不是全局值 —— chip 要能分清「自己定了档」与「跟着走」)');
    ok(meta && meta.effectivePermissionMode === 'acceptEdits', '① sessionMeta.effectivePermissionMode === 全局档 acceptEdits(实 ' + (meta && meta.effectivePermissionMode) + ')');
    const list = (await reqJson('GET', '/api/sessions')).json;
    const rowA = list && list.sessions && list.sessions.find(s => s.id === A);
    ok(rowA && rowA.permissionMode === null, '① /api/sessions 列表行也带 permissionMode(null)');
  }

  /* ═══════════════ ② 会话级 plan 阻断写工具;别的会话不受影响 ═══════════════ */
  {
    ok(await turnWritesFile(B, null), '② 基线:未设会话级档的线程按全局 acceptEdits 跑 → 文件被写出');
    const r = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'plan' });
    ok(r.status === 200 && r.json.sessionMeta && r.json.sessionMeta.permissionMode === 'plan'
      && r.json.sessionMeta.effectivePermissionMode === 'plan', '② PATCH 设 plan → 200 且 sessionMeta 两个字段都是 plan');
    ok(readHead(A) && readHead(A).permissionMode === 'plan', '② 会话头文件里落了 permissionMode:"plan"');
    ok(!(await turnWritesFile(A, null)), '② 会话级 plan → 该线程的 edit 层写工具被 block(文件没出现)');
    ok(await turnWritesFile(B, null), '② 同一进程里的另一条线程完全不受影响(文件照写)');
  }

  /* ═══════════════ ③ 白名单 400 / 全自动二次确认 409 ═══════════════ */
  {
    const bad = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'superuser' });
    ok(bad.status === 400 && bad.json && bad.json.error && bad.json.error.code === 'session.invalid_permission_mode',
      '③ 非白名单值 → 400 session.invalid_permission_mode(实 ' + bad.status + '/' + JSON.stringify(bad.json && bad.json.error) + ')');
    ok(readHead(A) && readHead(A).permissionMode === 'plan', '③ 400 之后会话头一个字节都没改(仍是 plan)');
    const noConfirm = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'auto' });
    ok(noConfirm.status === 409 && noConfirm.json && noConfirm.json.error && noConfirm.json.error.code === 'permission.confirm_required',
      '③ 切全自动不带 confirm → 409 permission.confirm_required(实 ' + noConfirm.status + '/' + JSON.stringify(noConfirm.json && noConfirm.json.error) + ')');
    ok(readHead(A) && readHead(A).permissionMode === 'plan', '③ 409 之后会话头仍是 plan(没有被悄悄放宽)');
    const confirmed = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'auto', confirm: true });
    ok(confirmed.status === 200 && confirmed.json.sessionMeta.permissionMode === 'auto', '③ 带 confirm:true → 200 且落到 auto');
    ok(readHead(A) && readHead(A).permissionMode === 'auto', '③ 会话头落了 auto');
    // 收紧方向不需要二次确认。
    const tighten = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'default' });
    ok(tighten.status === 200 && tighten.json.sessionMeta.permissionMode === 'default', '③ 收紧到 default 不需要 confirm');
    await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'auto', confirm: true }); // 恢复到 auto 供 ④ 用
  }

  /* ═══════════════ ④ 请求级 > 会话级 ═══════════════ */
  {
    ok(await turnWritesFile(A, null), '④ 会话级 auto → 写工具放行(文件出现)');
    ok(!(await turnWritesFile(A, { permissionMode: 'plan' })), '④ 同一会话带请求级 plan → 仍被 block:请求级【优先于】会话级');
    ok(readHead(A) && readHead(A).permissionMode === 'auto', '④ 请求级临时覆盖绝不回写会话级(会话头仍是 auto)');
    ok(await turnWritesFile(A, { permissionMode: 'garbage' }), '④ 请求级非法值静默回落会话级 auto(文件出现,不报错)');
  }

  /* ═══════════════ ⑤ 清除 → 回落全局 ═══════════════ */
  {
    const cleared = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: null });
    ok(cleared.status === 200 && cleared.json.sessionMeta.permissionMode === null
      && cleared.json.sessionMeta.effectivePermissionMode === 'acceptEdits', '⑤ permissionMode:null → 清除会话级,生效档回落全局 acceptEdits');
    const headA = readHead(A);
    ok(headA && !Object.prototype.hasOwnProperty.call(headA, 'permissionMode'), '⑤ 会话头里的 permissionMode 键被删掉(不是写成空串)');
    ok(await turnWritesFile(A, null), '⑤ 清除后按全局 acceptEdits 跑(文件出现)');
    // 空串与 null 等价。
    await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'plan' });
    const cleared2 = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: '' });
    ok(cleared2.status === 200 && cleared2.json.sessionMeta.permissionMode === null, "⑤ 空串与 null 等价(都是「清除,回落全局」)");
  }

  /* ═══════════════ ⑥ 竞态防护:活回合期间 PATCH = 延后落盘,消息一条不丢 ═══════════════ */
  {
    const C = await mk('线程C');
    const before = messageLines(C);
    providerDelayMs = 2500;
    toolTargetPath = path.join(HOME, 'race-probe.txt');
    const turn = runTurn({ sessionId: C, message: '慢慢来', cwd: HOME }); // 不 await:回合在飞
    await sleep(900); // 落在「回合已登记 turnSettlers、provider 还没回」的窗口里
    const t0 = Date.now();
    const patched = await reqJson('PATCH', '/api/sessions/' + C, { permissionMode: 'plan' });
    const elapsed = Date.now() - t0;
    ok(patched.status === 200 && patched.json.sessionMeta.permissionMode === 'plan', '⑥ 活回合期间 PATCH 照样 200(不拒绝、不返回 session.busy)');
    ok(elapsed < 1500, '⑥ PATCH 没有被在飞回合阻塞(耗时 ' + elapsed + 'ms < 1500ms)');
    const live = await reqJson('GET', '/api/sessions/' + C);
    ok(live.status === 200 && live.json.session && live.json.session.permissionMode === 'plan',
      '⑥ 对读者【立即生效】(内存覆盖表)—— 还没落盘就已经读得到 plan');
    await turn;
    providerDelayMs = 0;
    // 延后落盘发生在回合 settle 之后,给它一点时间。
    let head = null;
    for (let i = 0; i < 40; i++) { head = readHead(C); if (head && head.permissionMode === 'plan') break; await sleep(150); }
    ok(head && head.permissionMode === 'plan', '⑥ 回合结束后档位【落到了磁盘】(延后落盘的读改写完成)');
    const after = messageLines(C);
    ok(after >= before + 2, '⑥ 回合刚写的消息一条不丢(正文行数 ' + before + ' → ' + after + ',至少 +2:user+assistant)');
    ok(head && Number(head.messageCount) === after, '⑥ 会话头计数与正文行数一致(没有被陈旧副本盖出错位)');
  }

  /* ═══════ ⑨ 117m-A1:「全自动」对 exec 层真的不问(用户第六轮走查②)═══════ */
  // 修前 nativeToolGate 的 auto 档只放行 edit,exec 落到末尾的 return 'ask' —— 三处界面都叫它
  // 「全自动」,而线程每一步 script_run/http_request 照样弹窗、进收件箱、管家再起一个回合去代批。
  {
    const D = await mk('线程D-全自动');
    const set = await reqJson('PATCH', '/api/sessions/' + D, { permissionMode: 'auto', confirm: true });
    ok(set.status === 200 && set.json.sessionMeta.permissionMode === 'auto', '⑨ 线程 D 切到 auto(全自动)');
    const plain = await runExecTurn(D, {});
    ok(plain.asked === false, '⑨ auto + exec + 普通工具(script_run 写个文件)→ 【不弹权限】(事件流里没有 permission_request)');
    ok(plain.ran === true, '⑨ 而且工具是真的执行了(脚本写出的标记文件在)');
  }

  /* ═══════ ⑩ 高风险仍然要人按(判据复用 06i stewardToolPermanentlyExempt)═══════ */
  {
    const D2 = await mk('线程D2-全自动高风险');
    await reqJson('PATCH', '/api/sessions/' + D2, { permissionMode: 'auto', confirm: true });
    const risky = await runExecTurn(D2, { riskyText: 'rm -rf C:/nope' });
    ok(risky.asked === true, '⑩ auto + exec + 命令文本含 rm -rf → 【仍然弹权限】(高风险不因「全自动」而免检)');
    ok(risky.ran === false, '⑩ 且超时回落 deny → 脚本没有执行(标记文件不在)');
  }

  /* ═══════ ⑫ 活回合中途改档:同一个回合的下一个工具立刻按新档判 ═══════ */
  // 修前 09 的闸门只读回合开始时那个快照,02 的 sessionPermissionModeOverrides 从来没人读 ——
  // 于是用户在最该收紧/放宽的那几分钟里改档等于没改(放宽只是费 token,收紧失效是安全问题)。
  {
    const E = await mk('线程E-回合中放宽');
    const t0 = await reqJson('PATCH', '/api/sessions/' + E, { permissionMode: 'default' });
    ok(t0.status === 200 && t0.json.sessionMeta.permissionMode === 'default', '⑫ 线程 E 起手是 default(exec 要问)');
    const before = liveModeLogRows().length;
    const marker = path.join(HOME, 'live-widen.txt');
    try { fs.unlinkSync(marker); } catch { /* not there */ }
    nextTool = { name: 'script_run', args: { language: 'node', code: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` } };
    providerDelayMs = 2500;
    const turn = runTurn({ sessionId: E, message: '跑一句', cwd: HOME }); // 不 await:回合在飞
    await sleep(900);
    const widen = await reqJson('PATCH', '/api/sessions/' + E, { permissionMode: 'auto', confirm: true });
    ok(widen.status === 200, '⑫ 回合在飞时把 E 切成 auto(PATCH 照常 200)');
    const events = await turn;
    providerDelayMs = 0; nextTool = null;
    ok(!events.some(e => e && e.type === 'permission_request'), '⑫ 放宽:同一个回合的下一个工具【不再弹窗】(default → auto 当场生效)');
    ok(fs.existsSync(marker), '⑫ 放宽:该工具真的执行了');
    const rows = liveModeLogRows();
    ok(rows.length === before + 1 && rows[rows.length - 1].sessionId === E
      && rows[rows.length - 1].from === 'default' && rows[rows.length - 1].to === 'auto',
      '⑫ 恰好记一条 permission_mode_live{sessionId,from:"default",to:"auto"}(每回合最多一条)');
  }
  {
    const F = await mk('线程F-回合中收紧');
    await reqJson('PATCH', '/api/sessions/' + F, { permissionMode: 'auto', confirm: true });
    const before = liveModeLogRows().length;
    const marker = path.join(HOME, 'live-tighten.txt');
    try { fs.unlinkSync(marker); } catch { /* not there */ }
    nextTool = { name: 'script_run', args: { language: 'node', code: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` } };
    providerDelayMs = 2500;
    const turn = runTurn({ sessionId: F, message: '跑一句', cwd: HOME });
    await sleep(900);
    const tighten = await reqJson('PATCH', '/api/sessions/' + F, { permissionMode: 'default' });
    ok(tighten.status === 200, '⑫ 回合在飞时把 F 从 auto 收紧成 default(PATCH 照常 200)');
    const events = await turn;
    providerDelayMs = 0; nextTool = null;
    ok(events.some(e => e && e.type === 'permission_request'), '⑫ 收紧:同一个回合的下一个工具【重新弹窗】(auto → default 当场生效 —— 这条比放宽更重要)');
    ok(!fs.existsSync(marker), '⑫ 收紧:该工具没有执行(超时回落 deny)');
    const rows = liveModeLogRows();
    ok(rows.length === before + 1 && rows[rows.length - 1].from === 'auto' && rows[rows.length - 1].to === 'default',
      '⑫ 恰好再记一条 permission_mode_live{from:"auto",to:"default"}');
  }

  /* ═══════ ╭ 请求级档不得被会话级中途改动顶掉（117m-A6）═══════ */
  // ⑦ 的契约是「请求级 > 会话级 > 全局」，但 ⑩ 只测了「回合未带请求级档」那一半。
  // 带了请求级 plan 的回合，如果中途有人（另一个标签页、管家的档位菜单）把会话级 PATCH 成 auto，
  // 修前会静默把本回合专门要的收紧推翻掉 —— 本该 block 的 exec 变成 allow，且不弹窗、用户无感。
  {
    const G = await mk('线程G-请求级锁定');
    const before = liveModeLogRows().length;
    const marker = path.join(HOME, 'live-request-lock.txt');
    try { fs.unlinkSync(marker); } catch { /* not there */ }
    nextTool = { name: 'script_run', args: { language: 'node', code: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` } };
    providerDelayMs = 2500;
    const turn = runTurn({ sessionId: G, message: '跑一句', cwd: HOME, permissionMode: 'plan' });
    await sleep(900);
    const widen = await reqJson('PATCH', '/api/sessions/' + G, { permissionMode: 'auto', confirm: true });
    ok(widen.status === 200, '╭ 回合在飞时把 G 的会话级档改成 auto(PATCH 照常 200)');
    const events = await turn;
    providerDelayMs = 0; nextTool = null;
    ok(!fs.existsSync(marker),
      '╭ 请求级 plan 全程有效：中途把会话级改成 auto 也不能把它顶掉(工具没执行)');
    ok(!events.some(e => e && e.type === 'permission_request'),
      '╭ 而且是【直接拦】不是弹窗等人(plan 档的语义就是 block)');
    ok(liveModeLogRows().length === before,
      '╭ 带请求级档的回合压根不走活档那条路(零新增 permission_mode_live)');
    const head = readHead(G);
    ok(head && head.permissionMode === 'auto',
      '╭ companion：会话级那一改本身照常落盘(只是不管这一单，下一回合就是它)');
  }

  /* ═══════════════ ⑦⑧ 管家侧:先把服务停掉,再进程内直调工具 ═══════════════ */
  killp(wb); wb = null; await sleep(600);
  writeConfig({ stewardEnabledV1: true, stewardPollMs: 120000 });
  process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  process.env.RUYI_HOME = HOME;
  const srv = require(SERVER);
  const stewardCtx = { session: { id: 'steward', kind: 'steward', providerHistory: [] } };
  const plainCtx = { session: { id: 'plain', kind: 'quick_ask', providerHistory: [] } };
  const call = (name, args, ctx) => srv.TOOL_HANDLERS[name].handler(args, ctx || stewardCtx);
  const decisionsFile = path.join(HOME, 'steward', 'decisions-v1.ndjson');
  const decisionRows = () => { try { return fs.readFileSync(decisionsFile, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)); } catch { return []; } };

  {
    // B 从未设过会话级档 → 生效 acceptEdits。收紧到 default 应当成功。
    const before = decisionRows().length;
    const tightened = await call('steward_thread_permission', { sessionId: B, permissionMode: 'default' });
    ok(tightened && tightened.ok === true && tightened.permissionMode === 'default' && tightened.previousEffective === 'acceptEdits',
      '⑦ 收紧成功(acceptEdits → default)并回报 previousEffective');
    ok(tightened && tightened.undoRef && tightened.undoRef.kind === 'permission' && tightened.undoRef.previous === null,
      '⑦ undoRef = {kind:"permission", sessionId, previous:null}(此前跟随全局)');
    ok(readHead(B) && readHead(B).permissionMode === 'default', '⑦ 会话头落盘为 default');
    // 决策日志是 fire-and-forget 的 append 链(记账失败绝不回滚已做完的动作),轮询等它落盘。
    let rows = decisionRows();
    for (let i = 0; i < 40 && rows.length <= before; i++) { await sleep(100); rows = decisionRows(); }
    const row = rows[rows.length - 1];
    ok(rows.length === before + 1 && row && row.tool === 'steward_thread_permission' && row.targetSessionId === B
      && row.permissionMode === 'default' && row.undoRef && typeof row.basis === 'object',
      '⑦ 决策日志恰好多一行,字段齐整(tool/targetSessionId/permissionMode/undoRef/basis)');

    // 放宽:B 现在是 default,想改成 acceptEdits / auto 都必须被拒。
    const widen1 = await call('steward_thread_permission', { sessionId: B, permissionMode: 'acceptEdits' });
    ok(widen1 && widen1.ok === false && widen1.error === 'steward.widen_forbidden', '⑦ 放宽 default → acceptEdits 被拒(steward.widen_forbidden)');
    const widen2 = await call('steward_thread_permission', { sessionId: B, permissionMode: 'auto' });
    ok(widen2 && widen2.ok === false && widen2.error === 'steward.widen_forbidden', '⑦ 放宽 default → auto 被拒(永久豁免第 2 条:管家不得自我扩权)');
    const same = await call('steward_thread_permission', { sessionId: B, permissionMode: 'default' });
    ok(same && same.ok === false && same.error === 'steward.widen_forbidden', '⑦ 平移到同一档也被拒(不是收紧)');
    ok(readHead(B) && readHead(B).permissionMode === 'default', '⑦ 三次被拒之后会话头一个字节都没变');
    await sleep(300);
    ok(decisionRows().length === before + 1, '⑦ 被拒的三次都【不落】决策日志(没做决定就没有决定可记)');

    // 收紧到最紧的 plan 仍然可以。
    const toPlan = await call('steward_thread_permission', { sessionId: B, permissionMode: 'plan' });
    await sleep(200);
    ok(toPlan && toPlan.ok === true && toPlan.undoRef.previous === 'default', '⑦ 继续收紧 default → plan 成功,undoRef 带旧的会话级值');

    // 身份门与参数门。
    const forbidden = await call('steward_thread_permission', { sessionId: B, permissionMode: 'default' }, plainCtx);
    ok(forbidden && forbidden.ok === false && forbidden.error === 'steward.forbidden', '⑦ 普通会话 ctx → steward.forbidden(fail-closed 二次校验)');
    const badMode = await call('steward_thread_permission', { sessionId: B, permissionMode: 'superuser' });
    ok(badMode && badMode.ok === false && badMode.error === 'invalid_request', '⑦ 非白名单档 → invalid_request');
    const noSession = await call('steward_thread_permission', { sessionId: 'sess_nope', permissionMode: 'plan' });
    ok(noSession && noSession.ok === false && noSession.error === 'not_found', '⑦ 目标线程不存在 → not_found');
    const stewardTarget = await call('steward_thread_permission', { sessionId: 'steward', permissionMode: 'plan' });
    ok(stewardTarget && stewardTarget.ok === false, '⑦ 管家自己的会话不能被当成目标线程');
  }

  /* ═══════ ⑪ 117m-A1:nativeToolGate 真值矩阵(纯函数,穷举比走 HTTP 便宜且更全)═══════ */
  {
    const g = srv.nativeToolGate;
    ok(typeof g === 'function' && typeof srv.liveSessionPermissionMode === 'function',
      '⑪ nativeToolGate / liveSessionPermissionMode 已从产物导出(e2e 可直测)');
    // 保守回落:调用方没给工具名 → 仍然 ask。新调用面忘了传参【不会】静默放权(13d 的桥消耗点
    // 眼下就还没补传,它必须继续走 ask —— 这条断言就是那一处的安全网)。
    ok(g('auto', 'exec') === 'ask', '⑪ auto + exec + 没传 toolName → ask(保守回落)');
    ok(g('auto', 'exec', '') === 'ask', '⑪ auto + exec + 空工具名 → ask');
    ok(g('auto', 'exec', 'script_run', { language: 'node', code: "console.log('hi')" }) === 'allow',
      '⑪ auto + exec + 普通命令 → allow');
    for (const [name, input, why] of [
      ['script_run', { code: 'rm -rf /var/x' }, '删除数据(rm -rf)'],
      ['powershell_run', { command: 'Remove-Item C:/x -Recurse -Force' }, '删除数据(Remove-Item -Recurse)'],
      ['powershell_run', { command: 'git push origin main' }, '推到远端(git push)'],
      ['script_run', { code: 'winget install Foo' }, '安装软件(winget install)'],
      ['powershell_run', { command: 'reg add HKLM\\Software\\X /v Y' }, '改注册表(reg add)'],
      ['powershell_run', { command: 'shutdown /s /t 0' }, '关机'],
      ['script_run', { code: "curl -X POST https://x/y -d 'z'" }, '对外发送(curl -X POST)'],
      ['acc__install_package', {}, '工具名命中 install'],
      ['keyboard_send_keys', { keys: 'hi' }, '工具名命中 send'],
    ]) {
      ok(g('auto', 'exec', name, input) === 'ask', `⑪ auto + exec + 高风险(${why})→ 仍然 ask`);
    }
    // 其余五条分支一行不动:改动只准落在 auto 的 exec 一支上。
    ok(g('bypass', 'exec', 'script_run', { code: 'rm -rf /' }) === 'allow', '⑪ bypass 不变(exec 一律 allow,高风险也不问)');
    ok(g('bypassPermissions', 'exec', 'script_run', {}) === 'allow', '⑪ bypassPermissions 不变');
    ok(g('default', 'read', 'file_read', {}) === 'allow', '⑪ read 层不变(任何档都 allow)');
    ok(g('plan', 'exec', 'script_run', {}) === 'block' && g('plan', 'edit', 'file_write', {}) === 'block', '⑪ plan 不变(edit/exec 都 block)');
    ok(g('dontAsk', 'exec', 'script_run', {}) === 'block', '⑪ dontAsk 不变');
    ok(g('acceptEdits', 'edit', 'file_write', {}) === 'allow' && g('acceptEdits', 'exec', 'script_run', { code: "console.log('hi')" }) === 'ask',
      '⑪ acceptEdits 不变(edit allow / exec ask —— 它【不】跟着 auto 一起放宽)');
    ok(g('default', 'exec', 'script_run', { code: "console.log('hi')" }) === 'ask', '⑪ default 不变(exec 一律 ask)');
    ok(g('auto', 'edit', 'file_write', { path: 'C:/x' }) === 'allow', '⑪ auto + edit 不变(可撤销的落盘一直是 allow)');
    ok(g('auto', 'edit', 'file_delete', { path: 'C:/x' }) === 'allow', '⑪ auto + edit 不看高风险判据(edit 层由检查点兜底,口径与修前逐字节一致)');
  }

  {
    const st = await call('steward_thread_status', { sessionId: B });
    ok(st && st.ok === true && st.effectivePermissionMode === 'plan' && st.sessionPermissionMode === 'plan',
      '⑧ steward_thread_status 的 effectivePermissionMode / sessionPermissionMode 与刚设的档一致');
    ok(st && st.permissionMode === 'plan', '⑧ 既有字段 permissionMode 语义不变(生效档),断言只加不改');
    const stA = await call('steward_thread_status', { sessionId: A });
    ok(stA && stA.ok === true && stA.sessionPermissionMode === null && stA.effectivePermissionMode === 'acceptEdits',
      '⑧ 没设过会话级档的线程:sessionPermissionMode === null 且生效档回落全局');
  }
} catch (e) {
  fail++;
  console.log('FAIL 未捕获异常: ' + (e && e.stack || e));
} finally {
  killp(wb);
  try { providerServer.close(); } catch { /* ignore */ }
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log('');
if (fail) { console.log(`SESSION PERMISSION MODE E2E: FAIL (${fail})`); process.exit(1); }
console.log('SESSION PERMISSION MODE E2E: ALL PASS');
process.exit(0);
})();
