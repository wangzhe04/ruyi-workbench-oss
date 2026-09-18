require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(127 波 2-bis · 45 号文 §2-bis):永久豁免把 shell_send 误判成「对外发送」—— 真夹具。
//
// 用户真机:「A 股盘中巡检」线程(全自动、原生引擎)每一步 shell_send 都卡在放行上 —— 工具名判据
// STEWARD_EXEMPT_TOOL_PATTERNS 是裸子串正则,shell_send 只因为名字里有 send 就进了永久豁免;而同族的
// powershell_run/run_command 不命中名字,走的是命令文本扫描。方向是反的。
//
// 本件先证【前提】(派单稿第 2 处):命令文本扫描确实拿得到 shell_send 的 input —— 两条真实路径各验一遍:
//   (H) 原生引擎回合路径(09 gateWithLiveMode → 07 nativeToolGate):真服务 + 进程内 fake provider,
//       线程切全自动,模型真的发 shell_start / shell_send,PowerShell 会话真的起、命令真的跑;
//   (P) 管家代答路径(13l stewardImplDecide,exec 档把 current.input 交给判据):用 (H) 里【真回合】
//       留下的那条 pending 权限待决(不是手搓的行),停服后进程内直调 steward_decide。
// 然后是 2-bis 的四条判据:
//   ① shell_send / keyboard_send_keys 输入无害时,全自动档不再恒「要人按」(真回合里不弹权限且命令真跑了);
//   ② 同一个 shell_send,input 里带 rm -rf 时仍然拦下(原生:弹权限;管家:propose_required + exemptBy:'command_text');
//   ③ 真正对外发送的工具名(send_email/slack_send/send_message/mcp__x__send_message/post_message…)在
//      五个权限档 × 三个 tier 下恒 propose_required(exemptBy:'tool_name');精确名出口不被前缀/大小写变体借走;
//   ④ 命中内容判据时 message 带类别人话(删数据/改系统/装卸载/对外发送/推送远端),details 带 exemptCategory 机器键。
//
// keyboard_send_keys【不跑真回合】:放行的那一支会把按键真的敲进本机前台窗口(跑回归的人正在用的那个)。
// 它只在进程内走 steward_decide 与判据本身 —— 这两处不执行工具。
//
// 端口全部 getFreePort()。判定行:`STEWARD EXEMPT SHELL_SEND E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-exempt-shell-send-'));
const sessionsDir = path.join(HOME, 'sessions');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const SHELL_ID = 'bis2probe';

// ── 进程内 fake provider:nextTool 置上时,这一回合先发它(名字与参数由测试端给),拿到 tool 结果后回一句话 ──
let nextTool = null;
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  // 只看最后一条:历史里留着上一回合的 tool 结果,用 some() 判会让后面的回合再也不发工具调用。
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const wantTool = nextTool && !(last && last.role === 'tool') && Array.isArray(body && body.tools) && body.tools.length;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  if (wantTool) {
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: nextTool.name, arguments: '' } }] } }] });
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(nextTool.args) } }] } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    frame({ choices: [{ index: 0, delta: { content: '好的。' } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

// 权限超时给足 120 s:本件从不靠超时走完一个回合 —— 要拒就当场经 /api/permission/decision 拒(用户点「拒绝」
// 的那条真路径),要留 pending 就停服。于是没有任何一条断言挂在计时器上。
function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false, shellSessionMax: 3,
    // 与 steward-guardrails 同一道守卫:任何读 homedir 的缺省值都落不到真机上。
    stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  }, null, 2), 'utf8');
}
fs.mkdirSync(HOME, { recursive: true });
writeConfig({});

function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function reqJson(method, p, payload) {
  return new Promise(resolve => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers, timeout: 15000 }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (data) r.write(data);
    r.end();
  });
}
// 一个完整回合:/api/chat/stream 的 NDJSON 事件边到边交给 onEvent(要当场拒权限就在这里拒)。
// 连接被停服打断时不抛,带着已收到的事件 resolve —— (H4) 就是故意在 pending 时停服。
function runTurn(payload, onEvent) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 90000 }, res => {
      let buf = '';
      const take = line => { if (!line.trim()) return; let e = null; try { e = JSON.parse(line); } catch { return; } events.push(e); if (onEvent) { try { onEvent(e); } catch { /* 观察者绝不打断回合 */ } } };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); take(line); } });
      res.on('end', () => { take(buf); resolve(events); });
      res.on('error', () => resolve(events));
    });
    r.on('error', () => resolve(events));
    r.on('timeout', () => { r.destroy(); resolve(events); });
    r.write(data); r.end();
  });
}
const permissionAsks = events => events.filter(e => e && e.type === 'permission_request');
const toolResults = events => events.filter(e => e && e.type === 'tool_result');
// 用户点「拒绝」:当场经兼容适配器 /api/permission/decision 决定(token-browser 档:本机非浏览器同源放行)。
const denyOnAsk = e => { if (e.type === 'permission_request') reqJson('POST', '/api/permission/decision', { requestId: e.requestId, behavior: 'deny', message: '2-bis 夹具:拒绝' }); };
const ivRows = sid => { try { return fs.readFileSync(path.join(sessionsDir, sid + '.interventions.ndjson'), 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const psQuote = p => "'" + String(p).replace(/'/g, "''") + "'";
async function waitFor(pred, ms) { const end = Date.now() + ms; for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } }

let wb = null;
let A = '';
let capturedRequestId = '';
const markerA = path.join(HOME, 'harmless-ran.txt');
const markerB = path.join(HOME, 'risky-ran.txt');
const markerD = path.join(HOME, 'captured-ran.txt');
try {
  /* ══════════════════════ (H) 原生引擎真回合 ══════════════════════ */
  console.log('── (H) 原生引擎回合路径(真服务) ──');
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {});
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let up = null; for (let i = 0; i < 200 && !up; i++) { await sleep(150); up = await health(WB_PORT); }
  ok(!!up, 'H00 workbench 起来了');

  A = (await reqJson('POST', '/api/sessions', { title: '2-bis 全自动线程', cwd: HOME })).json.session.id;
  const set = await reqJson('PATCH', '/api/sessions/' + A, { permissionMode: 'auto', confirm: true });
  ok(set.status === 200 && set.json && set.json.sessionMeta && set.json.sessionMeta.permissionMode === 'auto', 'H01 线程切到全自动(与用户真机那条同档)');

  // H0 起一个真 PowerShell 会话(shell_start 名字不命中任何判据,全自动档本来就不问)。
  {
    nextTool = { name: 'shell_start', args: { shellId: SHELL_ID, cwd: HOME } };
    const ev = await runTurn({ sessionId: A, message: '起一个 shell', cwd: HOME }, denyOnAsk);
    const r = toolResults(ev)[0];
    ok(permissionAsks(ev).length === 0 && r && r.content && r.content.ok === true && r.content.shellId === SHELL_ID,
      `H0 shell_start 真起了会话(asks=${permissionAsks(ev).length}, result=${JSON.stringify(r && r.content).slice(0, 160)})`);
  }

  // H1 判据 ①:无害的 shell_send 在全自动档不再「要人按」,而且命令真的跑了。
  {
    nextTool = { name: 'shell_send', args: { shellId: SHELL_ID, input: `Get-ChildItem -Name; Set-Content -LiteralPath ${psQuote(markerA)} -Value ran; Write-Output HARMLESS_DONE`, timeoutMs: 20000 } };
    const ev = await runTurn({ sessionId: A, message: '列一下目录', cwd: HOME }, denyOnAsk);
    const asks = permissionAsks(ev);
    ok(asks.length === 0, `H1 ① 全自动 + shell_send 无害输入 → 不弹权限(实得 ${asks.length} 次` + (asks.length ? `,toolName=${asks[0].toolName}` : '') + ')');
    const ran = await waitFor(() => fs.existsSync(markerA), 15000);
    const r = toolResults(ev)[0];
    ok(!!ran && r && r.content && r.content.ok === true && String(r.content.output || '').includes('HARMLESS_DONE'),
      `H1 ① 而且命令真的在那个 PowerShell 会话里跑了(标记文件=${!!ran},输出含 HARMLESS_DONE=${String(r && r.content && r.content.output || '').includes('HARMLESS_DONE')})`);
  }

  // H2 判据 ②:同一个 shell_send,input 里带 rm -rf(PowerShell 注释里,真跑也不删东西)→ 仍然弹权限。
  //   放行了就会写出 markerB —— 所以「没被拦住」在磁盘上看得见,不只看事件。
  {
    const input = `Set-Content -LiteralPath ${psQuote(markerB)} -Value ran # rm -rf C:\\somewhere`;
    nextTool = { name: 'shell_send', args: { shellId: SHELL_ID, input, timeoutMs: 20000 } };
    const ev = await runTurn({ sessionId: A, message: '清一下', cwd: HOME }, denyOnAsk);
    const asks = permissionAsks(ev);
    ok(asks.length === 1 && asks[0].toolName === 'shell_send' && asks[0].input && String(asks[0].input.input || '').includes('rm -rf'),
      `H2 ② 全自动 + shell_send 带 rm -rf → 仍然弹权限,事件里的 input 就是那行命令(实得 ${asks.length} 次,input=${JSON.stringify(asks[0] && asks[0].input && asks[0].input.input)})`);
    const row = ivRows(A).filter(x => x.toolName === 'shell_send' && x.input && String(x.input.input || '').includes('rm -rf')).pop();
    ok(row && row.tier === 'exec' && row.input.shellId === SHELL_ID,
      `H2 ② 权限待决落盘形状 = 用户真机那几条(toolName=shell_send, tier=exec, input={shellId,input,timeoutMs};实得 ${JSON.stringify(row && { toolName: row.toolName, tier: row.tier, keys: Object.keys(row.input || {}) })})`);
  }
  // H3 冲刷:再递一行无害的,确认 H2 那行没有被写进 shell 的 stdin(真写进去了,它会先于 FLUSH_DONE 跑完)。
  {
    nextTool = { name: 'shell_send', args: { shellId: SHELL_ID, input: 'Write-Output FLUSH_DONE', timeoutMs: 20000 } };
    const ev = await runTurn({ sessionId: A, message: '再看一眼', cwd: HOME }, denyOnAsk);
    const r = toolResults(ev)[0];
    ok(permissionAsks(ev).length === 0 && r && r.content && String(r.content.output || '').includes('FLUSH_DONE'),
      `H3 冲刷回合不弹权限且拿到 FLUSH_DONE(asks=${permissionAsks(ev).length})`);
    ok(!fs.existsSync(markerB), `H3 ② 被拦下的那行确实没执行(标记文件 risky-ran.txt 存在=${fs.existsSync(markerB)})`);
  }

  // H4 给 (P) 留一条【真回合产生的】pending 权限待决:同样的 rm -rf 输入,不拒,看见待决落盘就停服。
  {
    const input = `Set-Content -LiteralPath ${psQuote(markerD)} -Value ran # rm -rf C:\\somewhere`;
    nextTool = { name: 'shell_send', args: { shellId: SHELL_ID, input, timeoutMs: 20000 } };
    let seen = null;
    const turn = runTurn({ sessionId: A, message: '再清一下', cwd: HOME }, e => { if (e.type === 'permission_request' && !seen) seen = e; });
    const asked = await waitFor(() => seen, 30000);
    const row = asked && await waitFor(() => ivRows(A).find(x => x.id === asked.requestId && x.status === 'pending'), 10000);
    capturedRequestId = row ? row.id : '';
    ok(!!row && row.toolName === 'shell_send', `H4 真回合留下一条 pending 的 shell_send 权限待决(id=${capturedRequestId || '无'})`);
    killp(wb); wb = null;
    await turn;
    await sleep(600);
    ok(!fs.existsSync(markerD), 'H4 停服前后那行命令都没执行(标记文件不存在)');
  }
} catch (e) {
  fail++; console.log('FAIL (H) 段异常 ' + (e && e.stack || e));
} finally {
  killp(wb); wb = null;
  nextTool = null;
}

/* ══════════════════════ (P) 管家代答路径(进程内) ══════════════════════ */
console.log('── (P) 管家代答路径(进程内直调 steward_decide) ──');
writeConfig({ stewardEnabledV1: true, stewardPollMs: 120000, stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 500 });
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
try {
  const srv = require(SERVER);
  const stewardCtx = { session: { id: 'steward', kind: 'steward', providerHistory: [] } };
  const decide = (sid, id) => srv.toolCall('steward_decide', { missionId: sid, interventionId: id, action: 'allow' }, stewardCtx);
  const brief = r => JSON.stringify(r && { error: r.error, reason: r.reason, exemptBy: r.exemptBy, exemptCategory: r.exemptCategory, message: r.message });
  function craftThread(id, permissionMode) {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(sessionsDir, id + '.json'), JSON.stringify({
      id, schemaVersion: 3, storageVersion: 2, turnSeq: 2, title: '线程 ' + id, summary: '在等你',
      pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
      messageCount: 0, providerHistoryCount: 0, mission: null, missionId: id, kind: 'mission', permissionMode,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(sessionsDir, id + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, id + '.provider.ndjson'), '', 'utf8');
  }
  function putIv(sessionId, id, extra) {
    fs.appendFileSync(path.join(sessionsDir, sessionId + '.interventions.ndjson'), JSON.stringify({
      id, type: 'permission', sessionId, status: 'pending', requestedAt: new Date().toISOString(),
      interventionVersion: 1, ...extra,
    }) + '\n', 'utf8');
  }

  // P1 判据 ②(管家侧):真回合留下的那条 pending 待决。exec 档 → current.input 交给判据 → 命令文本命中。
  {
    const current = ivRows(A).filter(x => x.id === capturedRequestId).pop();
    ok(current && current.status === 'pending' && current.tier === 'exec' && String(current.input && current.input.input || '').includes('rm -rf'),
      `P1 前提:待决仍是 pending、tier=exec、input 里就是那行命令(实得 status=${current && current.status}, tier=${current && current.tier})`);
    const r = capturedRequestId ? await decide(A, capturedRequestId) : null;
    ok(r && r.ok === false && r.error === 'propose_required' && r.reason === 'permanently_exempt' && r.exemptBy === 'command_text',
      `P1 ② steward_decide → propose_required 且 exemptBy:'command_text'(内容判据真的收到了 shell_send 的 input;实得 ${brief(r)})`);
    ok(r && r.exemptCategory === 'delete_data' && String(r.message || '').includes('删数据'),
      `P1 ④ message 带类别人话「删数据」,details 带 exemptCategory:'delete_data'(实得 ${brief(r)})`);
  }

  // P2 判据 ①(管家侧):同一条真行的形状,只把命令换成无害的 —— 不再以永久豁免拒。
  {
    const base = ivRows(A).filter(x => x.id === capturedRequestId).pop() || { toolName: 'shell_send', tier: 'exec', input: { shellId: SHELL_ID, timeoutMs: 20000 } };
    putIv(A, 'iv_bis_harmless', { toolName: base.toolName, tier: base.tier, revertible: false, input: { ...base.input, input: 'Get-ChildItem -Name' } });
    const r = await decide(A, 'iv_bis_harmless');
    ok(!(r && r.reason === 'permanently_exempt'), `P2 ① 全自动线程 + shell_send 无害输入 → 管家不再以永久豁免拒(实得 ${brief(r)})`);
  }

  // P3 用户 2026-09-17 拍板:keyboard_send_keys 也放出来。无害按键不再恒豁免;按键里敲的是命中内容判据的命令照样拦。
  //   {ENTER} 这类 SendKeys 记号贴在词尾时,\b 仍然成立(`}`/`{` 不是单词字符)—— 下面两条就是实测。
  {
    const cases = [
      ['iv_kb_plain', 'Hello{ENTER}', null],
      ['iv_kb_push', 'git push origin main{ENTER}', 'push_remote'],
      ['iv_kb_push_tight', 'git push{ENTER}', 'push_remote'],
      ['iv_kb_rm', 'rm -rf C:\\x{ENTER}', 'delete_data'],
    ];
    for (const [id, keys] of cases) putIv(A, id, { toolName: 'keyboard_send_keys', tier: 'exec', revertible: false, input: { keys } });
    for (const [id, keys, category] of cases) {
      const r = await decide(A, id);
      if (category === null) {
        ok(!(r && r.reason === 'permanently_exempt'), `P3 ① keyboard_send_keys{keys:${JSON.stringify(keys)}} → 不再以永久豁免拒(实得 ${brief(r)})`);
      } else {
        ok(r && r.error === 'propose_required' && r.reason === 'permanently_exempt' && r.exemptBy === 'command_text' && r.exemptCategory === category,
          `P3 ② keyboard_send_keys{keys:${JSON.stringify(keys)}} → 仍拦,exemptBy:'command_text'、类别 ${category}(实得 ${brief(r)})`);
      }
    }
  }

  // P4 判据 ③:真正对外发送的工具名在【五个权限档 × 三个 tier】下恒 propose_required(tool_name)。
  //   同时钉住精确名出口不被借走:前缀形态、大小写变体、「名字里含 shell_send」的外部工具一律仍按名字拦。
  {
    const MODES = ['default', 'acceptEdits', 'auto', 'bypass', 'plan'];
    const TIERS = ['read', 'edit', 'exec'];
    const NAMES = [
      'send_email', 'slack_send', 'send_message', 'mcp__x__send_message', 'post_message', 'sms_send', 'pay_invoice', 'mcp_configure',
      'mcp__win-claude-workbench__shell_send', 'mcp__x__shell_send', 'x__shell_send', 'Shell_Send', 'shell_send_email',
      'mcp__win-claude-workbench__keyboard_send_keys', 'Keyboard_Send_Keys',
    ];
    const missed = [];
    let n = 0;
    for (const mode of MODES) {
      const sid = 'sess_bis_' + mode.toLowerCase();
      craftThread(sid, mode);
      for (const tier of TIERS) {
        for (const name of NAMES) {
          const id = `iv_${tier}_${n++}`;
          putIv(sid, id, { toolName: name, tier, revertible: false, input: {} });
          const r = await decide(sid, id);
          if (!(r && r.error === 'propose_required' && r.reason === 'permanently_exempt' && r.exemptBy === 'tool_name')) missed.push(`${mode}/${tier}/${name} -> ${brief(r)}`);
        }
      }
    }
    ok(missed.length === 0, `P4 ③ ${NAMES.length} 个工具名 × ${MODES.length} 档 × ${TIERS.length} tier = ${n} 条全部 propose_required(tool_name)`
      + (missed.length ? ' → 漏: ' + missed.slice(0, 6).join(' | ') : ''));
  }

  // P5 判据 ④:五类内容判据 + 结构化对外写,各自的类别人话进 message、机器键进 exemptCategory。
  {
    const CASES = [
      ['del', 'shell_send', { shellId: SHELL_ID, input: 'Remove-Item C:\\data -Recurse -Force' }, 'command_text', 'delete_data', '删数据'],
      ['sys', 'shell_send', { shellId: SHELL_ID, input: 'reg add HKLM\\SOFTWARE\\Foo /v Bar /d 1' }, 'command_text', 'system_change', '改系统'],
      ['inst', 'shell_send', { shellId: SHELL_ID, input: 'winget install Git.Git' }, 'command_text', 'install', '装卸载'],
      ['out', 'shell_send', { shellId: SHELL_ID, input: 'curl -X POST https://x.example -d a=1' }, 'command_text', 'outbound_send', '对外发送'],
      ['push', 'shell_send', { shellId: SHELL_ID, input: 'git push origin main' }, 'command_text', 'push_remote', '推送远端'],
      ['http', 'http_request', { method: 'POST', url: 'https://x.example/api' }, 'structured_write', 'outbound_send', '对外发送'],
    ];
    const wrong = [];
    for (const [id, toolName, input, by, category, label] of CASES) {
      putIv(A, 'iv_cat_' + id, { toolName, tier: 'exec', revertible: false, input });
      const r = await decide(A, 'iv_cat_' + id);
      if (!(r && r.reason === 'permanently_exempt' && r.exemptBy === by && r.exemptCategory === category && String(r.message || '').includes('「' + label + '」'))) wrong.push(`${id} -> ${brief(r)}`);
    }
    ok(wrong.length === 0, `P5 ④ ${CASES.length} 条内容/结构化命中:exemptBy、exemptCategory 与 message 里的「类别」逐条对得上`
      + (wrong.length ? ' → 不符: ' + wrong.join(' | ') : ''));
  }
} catch (e) {
  fail++; console.log('FAIL (P) 段异常 ' + (e && e.stack || e));
} finally {
  try { providerServer.close(); } catch { /* ignore */ }
}

console.log(fail ? `\nSTEWARD EXEMPT SHELL_SEND E2E: FAIL (${fail})` : '\nSTEWARD EXEMPT SHELL_SEND E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
