#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// claude-binary-live.e2e.js — 第42b波:真实 claude 二进制冒烟(LIVE,手工跑,不进全量套件)
//
//   node dev-harness/claude-binary-live.e2e.js
//
// 全套件 130+ 件全建立在 fake-claude 上 —— 真身 CLI 的协议漂移(stream-json 事件形状、
// 权限桥握手、--resume 语义)只有本件能兜住,是 43(模块化)/44(压缩 v2)的回归底座。
// 前置:本机装有 claude CLI 且已登录(或有 API key)。未装/未登录 → SKIP 退出 0(不红)。
// 成本:约 2-3 个最小真实回合(强制 haiku),一次运行 < $0.05。
//
// 覆盖:
//   ① resolveClaudeLauncher 真机解析(npm shim → 真身 claude.exe;cmd8191 根治路径)
//   ② exe 直启 --version(Bun 单文件二进制可独立启动,不依赖 cmd shim)
//   ③ stream-json 协议握手:-p 最小回合,init 事件 + result(success) + usage 字段(电量表数据源)
//   ④ 权限桥端到端:workbench(permissionMode=default)+ 真 CLI → Bash 触发 permission_request
//     → /api/permission/decision 批准 → 回合完成且 echo 结果可见
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
let skipped = false;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
const skip = l => { skipped = true; console.log('SKIP ' + l); };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }

function spawnCollect(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = cp.spawn(cmd, args, { windowsHide: true, cwd: opts.cwd || os.tmpdir(), env: opts.env || process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { kill(child); resolve({ status: null, out, err, timeout: true }); }, opts.timeoutMs || 120000);
    child.on('error', e => { clearTimeout(timer); resolve({ status: -1, out, err: err + String(e), spawnError: true }); });
    child.on('close', code => { clearTimeout(timer); resolve({ status: code, out, err }); });
    if (opts.stdinClose !== false && child.stdin) child.stdin.end();
  });
}

function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise(resolve => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.write(raw); r.end(); }); }
async function up(port) { for (let i = 0; i < 60; i++) { if (await get(port, '/health')) return true; await sleep(150); } return false; }
async function tokenFor(port) {
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
}

// 流式回合:边收事件边回调(权限请求要【回合进行中】就批准,不能等流结束)
function streamTurn(port, body, hdr, onEvent) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const events = [];
    const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 300000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...hdr } }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line); events.push(ev); if (onEvent) onEvent(ev); } catch { /* 半行忽略 */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    r.on('error', () => resolve(events));
    r.on('timeout', () => { r.destroy(); resolve(events); });
    r.write(raw); r.end();
  });
}

(async () => {
  console.log('CLAUDE-BINARY LIVE SMOKE (真实二进制,手工触发;未装/未登录自动 SKIP)');

  // ── ① resolveClaudeLauncher 真机解析 ─────────────────────────────────────
  // 注意:resolver 只对批处理 shim(.cmd/.bat)动手(裸名 'claude' 原样返回 —— isBatchLauncher 门),
  // 真实启动路径 = detectClaudePath 先 PATH 探 'claude.cmd' 再交给 resolver。本用例镜像该语义。
  const resolved = srv.resolveClaudeLauncher('claude.cmd');
  ok(/claude\.exe$/i.test(resolved) && fs.existsSync(resolved), `① npm shim 'claude.cmd' 解析为真身 exe: ${resolved}`);
  if (!fs.existsSync(resolved)) { console.log('未安装 claude CLI —— 后续用例整体 SKIP'); console.log('\nCLAUDE-BINARY LIVE: SKIP'); return; }

  // ── ② exe 直启 ────────────────────────────────────────────────────────────
  const ver = await spawnCollect(resolved, ['--version'], { timeoutMs: 60000 });
  ok(ver.status === 0 && /\d+\.\d+\.\d+/.test(ver.out), `② 直启 --version 退出 0: ${String(ver.out).trim()}`);

  // ── ③ stream-json 协议握手(1 个最小真实回合) ────────────────────────────
  const probe = await spawnCollect(resolved, [
    '-p', 'Reply with exactly: OK', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  ], { timeoutMs: 180000 });
  const lines = probe.out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = lines.find(e => e.type === 'system' && e.subtype === 'init');
  const result = lines.find(e => e.type === 'result');
  const authFailed = !result || /not logged in|unauthorized|401|invalid api key|authentication/i.test(String(result && result.result || '') + probe.err);
  if (authFailed) {
    skip('③ CLI 未登录/无凭据 —— live 协议与权限桥用例跳过(本机登录 claude 后可跑全)');
  } else {
    ok(!!init, '③ stream-json init 事件(type=system, subtype=init)');
    ok(result && result.subtype === 'success', `③ result 事件 subtype=success(is_error=${result && result.is_error})`);
    ok(result && result.usage && Number(result.usage.input_tokens) > 0, '③ usage.input_tokens 存在(电量表真实数据源)');
    ok(result && typeof result.session_id === 'string' && result.session_id.length > 8, '③ session_id 下发(--resume 锚点)');
  }

  // ── ④ 权限桥端到端(workbench + 真 CLI,1 回合 + 1 次 Bash 批准) ──────────
  if (!skipped) {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-live-smoke');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'project'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'default', defaultWorkspace: path.join(HOME, 'project'),
      providers: [], activeProvider: '', model: 'haiku',
    }, null, 2));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME },
    });
    try {
      ok(await up(PORT), '④ workbench 起服(真 CLI 引擎,无 provider)');
      const token = await tokenFor(PORT);
      const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'live-bridge', cwd: path.join(HOME, 'project') }, hdr);
      ok(created && created.session && created.session.id, '④ 会话创建');

      let sawPerm = null;
      // 批准【每一个】权限请求 —— 模型可能先探测再正式跑,单批准一次会让第二次请求悬挂到超时。
      const events = await streamTurn(PORT, {
        sessionId: created.session.id,
        message: '请用 Bash 工具执行命令: node -e "console.log(\'PID=\'+process.pid)",然后原样告诉我输出里的数字。不要其他操作。',
        cwd: path.join(HOME, 'project'),
      }, hdr, async ev => {
        if (ev.type === 'permission_request') {
          sawPerm = sawPerm || ev;
          await post(PORT, '/api/permission/decision', { requestId: ev.requestId, behavior: 'allow' }, hdr);
        }
      });
      ok(!!sawPerm, `④ 收到 permission_request(tool=${sawPerm && sawPerm.toolName}) —— 桥握手成功`);
      // 防伪:只认 tool_result 事件里的 PID=<digits>(模型最终文本可以编造,tool_result 是真实子进程输出)
      const toolResults = events.filter(e => e.type === 'tool_result').map(e => JSON.stringify(e)).join('');
      ok(/PID=\d+/.test(toolResults), '④ tool_result 含真实 PID 输出(不可伪造 → 证明真跑了工具)');
      if (!/PID=\d+/.test(toolResults)) console.log('   [diag] tool_result 实容: ' + (toolResults.slice(0, 600) || '(无 tool_result 事件)'));
    } finally {
      kill(wb); await sleep(300);
      fs.rmSync(HOME, { recursive: true, force: true });
    }
  }

  if (failures) { console.log(`\nCLAUDE-BINARY LIVE: FAIL (${failures})`); process.exitCode = 1; }
  else console.log('\nCLAUDE-BINARY LIVE: ' + (skipped ? 'PASS(部分 SKIP)' : 'ALL PASS'));
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
