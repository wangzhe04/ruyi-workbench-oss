'use strict';
// 3.0 收口走查(第四波,docs/RELEASE-3.0-AUDIT-2026-10-08.md)后端安全 / 数据修复的回归钉。真源码、临时 HOME、零外网。
//   [C] 0 字节 / 全空白的 config.json 从 .prev 恢复(修前当全新安装,两次保存后含密钥的 .prev 被覆盖);
//   [D] 管家代批:命令超出扫描窗口 / 嵌套过深(scan_incomplete)、http_request 打本机内网(internal_target)一律交回用户;
//   [G] 智能自动档:http_request 指向回环 / 内网 / 链路本地(含云元数据,各种 IPv4 写法)停下来问;公网照旧放行;
//   [H] http_request 工具不许调如意自己的本机接口;maxBodyChars 钳制(1e308 / NaN 不再让字节硬顶失效);
//   [F] steward_file_read 认工作区的「读：关」(read:false);
//   [S] 敏感闸 / 写保护闸先剥 NTFS 流后缀与尾随点(config.json::$DATA、sessions::$INDEX_ALLOCATION\…、config.json.);
//   [A] ~/.claude/agents 里 preview≤3 按老写法(项目角色也带 permissionMode)写下的文件认作自家旧文件、覆盖成不带免问档的新写法;
//   [B] body-token 路由:浏览器跨站请求在读体之前就拒(修前任意网页可让工作台每请求缓冲约 128MB);
//   [T] 管家回合读过外界内容后,直调「会让事情多发生」的写工具降级为提议;收紧类(停止 / 拒绝)不拦;
//   [U] office_open / browser_open 在任何 I/O 之前拒非本机 UNC(\\主机\共享、file://主机/共享)。
//   [I] 管家收件箱:已见过的线程在回合起止窗口(turnSettlers 已登记、activeChildren 还没 / 已经不在)不报「跑完了」、不推基线。
// 反向验证:RUYI_TEST_SERVER_JS=<修前 server.js> node --test 本文件 → 各节红(修前产物里没有这些判据)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cp = require('child_process');

test('离线打包在依赖、EXE 或桌面编译失败时拒绝旧产物', { skip: process.platform !== 'win32' }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-package-fail-'));
  try {
    for (const failure of ['dependencies', 'exe', 'desktop']) {
      const wb = path.join(scratch, failure);
      for (const d of ['tools', 'app', 'dist', 'desktop', 'bin', 'node_modules/.bin']) fs.mkdirSync(path.join(wb, d), { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, '../../ruyi-workbench/tools/package-offline.ps1'), path.join(wb, 'tools/package-offline.ps1'));
      fs.writeFileSync(path.join(wb, 'app/build.js'), 'process.exit(0)');
      fs.writeFileSync(path.join(wb, 'dist/Ruyi.exe'), 'OLD EXE MUST NOT SHIP');
      fs.writeFileSync(path.join(wb, 'RuyiDesktop.exe'), 'OLD DESKTOP MUST NOT SHIP');
      fs.writeFileSync(path.join(wb, 'desktop/build-desktop.ps1'), 'exit 19');
      if (failure !== 'dependencies') fs.writeFileSync(path.join(wb, 'node_modules/.bin/pkg.cmd'), '@exit /b 0\r\n');
      for (const name of ['npm', 'npx', 'powershell']) fs.writeFileSync(path.join(wb, 'bin', name + '.cmd'), '@exit /b 19\r\n');
      const env = { ...process.env };
      const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = path.join(wb, 'bin') + path.delimiter + env[pathKey];
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(wb, 'tools/package-offline.ps1'), '-Variant', 'failure-test'];
      if (failure === 'desktop') args.push('-SkipExeBuild');
      const result = cp.spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { cwd: wb, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, failure + ' must stop packaging');
      assert.match(result.stdout + result.stderr, failure === 'dependencies' ? /dependencies failed/ : failure === 'exe' ? /Ruyi.exe build failed/ : /Desktop shell build failed/);
      assert.equal(fs.existsSync(path.join(wb, 'dist/Ruyi-failure-test.zip')), false, failure + ' must not emit an archive');
      assert.equal(fs.existsSync(path.join(wb, 'dist/Ruyi-failure-test/RuyiDesktop.exe')), false, 'old desktop must not be copied');
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-audit-w4-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const ws = path.join(root, 'ws');
for (const d of [home, data, ws, path.join(data, 'sessions')]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RUYI_HOME = data;
process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'WCW_PORT']) delete process.env[k];

const { loadServerInternals } = require('../lib/server-internals');
const I = loadServerInternals([
  'readConfig', 'writeConfigAtomic', 'paths', 'toolCall', 'nativeToolGate', 'TOOL_HANDLERS', 'httpRequest',
  'isSensitiveDataPath', 'isWriteProtectedDataPath', 'dataRoot', 'WRITE_PROTECTED_DATA_DIRS',
  'syncAgentRolesToClaude', 'RUYI_AGENT_FILE_MARKER', 'authorizeRoute', 'RUNTIME',
  'stewardMarkTurnTainted', 'openToolUncDenied', 'stewardCollectSessionTurn', 'stewardRuntime', 'turnSettlers',
]);

const writeCfg = obj => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(obj, null, 2), 'utf8');
const baseCfg = extra => ({
  configSchema: 14, defaultWorkspace: ws, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killPortOnStart: false,
  permissionMode: 'default', providers: [], activeProvider: '', stewardEnabledV1: true, stewardPollMs: 120000,
  stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 500, ...extra,
});
const brief = r => JSON.stringify(r && { ok: r.ok, error: r.error, reason: r.reason, blockedBy: r.blockedBy, failClass: r.failClass, code: r.code });

// ── [C] 空 config.json 从 .prev 恢复 ─────────────────────────────────────────
test('[C] 0 字节 / 全空白 config.json 从 .prev 恢复服务商与密钥;没有 .prev 时照旧按空配置', async () => {
  const cfgFile = I.paths.config;
  const withKey = baseCfg({ providers: [{ id: 'p1', name: 'P1', base: 'https://api.example.com/v1', apiKey: 'sk-AUDIT-W4-0123456789', model: 'm1', apiStyle: 'chat' }], activeProvider: 'p1' });
  await I.writeConfigAtomic(JSON.stringify(withKey, null, 2));
  await I.writeConfigAtomic(JSON.stringify(withKey, null, 2));   // 第二次写:把第一份拷成 .prev
  assert.ok(fs.existsSync(cfgFile + '.prev'), '.prev 应已存在');
  for (const empty of ['', '  \r\n\t ', '﻿']) {
    fs.writeFileSync(cfgFile, empty, 'utf8');
    const cfg = await I.readConfig();
    const p1 = (cfg.providers || []).find(p => p && p.id === 'p1');
    assert.ok(p1 && p1.apiKey === 'sk-AUDIT-W4-0123456789', `空文件 ${JSON.stringify(empty)} 应从 .prev 恢复出 p1 与密钥,实得 ${JSON.stringify(cfg.providers)}`);
    assert.match(fs.readFileSync(cfgFile, 'utf8'), /sk-AUDIT-W4-0123456789/, '恢复后落盘,config.json 不再是空的');
  }
  fs.unlinkSync(cfgFile + '.prev');
  fs.writeFileSync(cfgFile, '', 'utf8');
  const fresh = await I.readConfig();
  assert.equal((fresh.providers || []).length, 0, '没有 .prev 时空文件仍按空配置处理');
});

// ── 管家与工具用的配置 / 线程夹具 ─────────────────────────────────────────────
const stewardCtx = (turnSeq = 3) => ({ session: { id: 'steward', kind: 'steward', providerHistory: [], turnSeq } });
function craftThread(id, permissionMode) {
  const now = new Date().toISOString();
  const dir = path.join(data, 'sessions');
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    id, schemaVersion: 3, storageVersion: 2, turnSeq: 2, title: '线程 ' + id, summary: '在等你', pinned: false, cwd: ws, createdAt: now, updatedAt: now,
    claudeSessionId: null, attachments: [], messageCount: 0, providerHistoryCount: 0, mission: null, missionId: id, kind: 'mission', permissionMode,
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, id + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(dir, id + '.provider.ndjson'), '', 'utf8');
}
function putIv(sessionId, id, extra) {
  fs.appendFileSync(path.join(data, 'sessions', sessionId + '.interventions.ndjson'), JSON.stringify({
    id, type: 'permission', sessionId, status: 'pending', requestedAt: new Date().toISOString(), interventionVersion: 1, ...extra,
  }) + '\n', 'utf8');
}

// ── [D] 管家代批 ─────────────────────────────────────────────────────────────
test('[D] 管家不代批:看不全的命令(垫 4000 空格 / 嵌套过深)与打本机内网的 http_request', async () => {
  writeCfg(baseCfg());
  craftThread('w4thread', 'auto');
  putIv('w4thread', 'iv_padded', { toolName: 'script_run', tier: 'exec', input: { language: 'powershell', code: ' '.repeat(4100) + 'git push --force origin main' } });
  let nested = { command: 'git push --force origin main' };
  for (let i = 0; i < 6; i++) nested = { wrap: nested };
  putIv('w4thread', 'iv_nested', { toolName: 'shell_send', tier: 'exec', input: nested });
  putIv('w4thread', 'iv_internal', { toolName: 'http_request', tier: 'exec', input: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' } });
  putIv('w4thread', 'iv_public', { toolName: 'http_request', tier: 'exec', input: { method: 'GET', url: 'https://api.example.com/v1/items' } });
  const decide = (id, action = 'allow') => I.toolCall('steward_decide', { missionId: 'w4thread', interventionId: id, action }, stewardCtx());
  const padded = await decide('iv_padded');
  assert.ok(padded && padded.error === 'propose_required' && padded.blockedBy === 'scan_incomplete', `垫空格:${brief(padded)}`);
  const nestedR = await decide('iv_nested');
  assert.ok(nestedR && nestedR.error === 'propose_required', `嵌套过深:${brief(nestedR)}`);
  const internal = await decide('iv_internal');
  assert.ok(internal && internal.error === 'propose_required' && internal.blockedBy === 'internal_target', `元数据地址:${brief(internal)}`);
  const pub = await decide('iv_public');
  assert.ok(!(pub && ['internal_target', 'scan_incomplete'].includes(pub.blockedBy)), `对照:公网 http_request 不被这两道新闸拦(实得 ${brief(pub)})`);
  const deny = await decide('iv_padded', 'deny');
  assert.ok(!(deny && deny.blockedBy === 'scan_incomplete'), `拒绝类不受 scan_incomplete 限制(实得 ${brief(deny)})`);
});

// ── [G] 智能自动档的 http_request 判据 ───────────────────────────────────────
test('[G] 智能自动:http_request 指向回环 / 内网 / 链路本地停下来问,公网照旧放行', () => {
  const gate = (url, mode = 'auto') => I.nativeToolGate(mode, 'exec', 'http_request', { method: 'GET', url });
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8765/api/sessions', 'http://2130706433:8765/', 'http://0x7f.1/',
    'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]:9000/', 'http://10.0.0.5/admin', 'http://192.168.1.2/', 'http://nas/api', 'http://printer.local/']) {
    assert.equal(gate(url), 'ask', url);
  }
  assert.equal(gate('https://api.example.com/v1/items'), 'allow', '公网 API 照旧免确认');
  assert.equal(gate('http://169.254.169.254/', 'bypass'), 'allow', '全自动档照旧');
  assert.equal(I.nativeToolGate('auto', 'exec', 'mcp__ruyi__http_request', { url: 'http://127.0.0.1/' }), 'ask', 'MCP 前缀名同样认');
});

// ── [H] http_request 工具:不调自己;maxBodyChars 钳制 ───────────────────────
test('[H1] http_request 工具拒绝如意自己的本机接口(各种主机写法),别的端口照常发', async () => {
  process.env.WCW_PORT = '18765';
  try {
    const handler = I.TOOL_HANDLERS.http_request.handler;
    for (const url of ['http://127.0.0.1:18765/api/sessions', 'http://localhost:18765/api/tools/file_list', 'http://[::1]:18765/', 'http://2130706433:18765/',
      'http://127.1:18765/', 'http://[::ffff:127.0.0.1]:18765/api/permission/decision']) {
      const r = await handler({ url, method: 'GET' }, null);
      assert.ok(r && r.ok === false && r.failClass === 'blocked', `${url}: ${brief(r)}`);
    }
    const other = await handler({ url: 'http://127.0.0.1:9/', method: 'GET', timeoutMs: 1500 }, null);
    assert.ok(other && other.failClass !== 'blocked', `别的端口不按「自己」拦(实得 ${brief(other)})`);
  } finally { delete process.env.WCW_PORT; }
});

test('[H2] httpRequest 的 maxBodyChars:1e308 封顶 5,000,000;NaN 回落默认 200000', async () => {
  const big = 'x'.repeat(6 * 1024 * 1024);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(big); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const huge = await I.httpRequest({ url, maxBodyChars: 1e308, timeoutMs: 20000 });
    assert.ok(huge && typeof huge.body === 'string' && huge.body.length <= 5000000, `1e308:body ${huge && huge.body && huge.body.length}`);
    const nan = await I.httpRequest({ url, maxBodyChars: 'abc', timeoutMs: 20000 });
    assert.ok(nan && typeof nan.body === 'string' && nan.body.length === 200000, `NaN:body ${nan && nan.body && nan.body.length}`);
  } finally { server.close(); }
});

// ── [F] steward_file_read 认 read:false ──────────────────────────────────────
test('[F] steward_file_read:工作区关掉「读」后管家不读;打开后照常读', async () => {
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello from the workspace\n', 'utf8');
  writeCfg(baseCfg({ workspaces: [{ path: ws, read: false, write: true, execute: true }] }));
  const off = await I.toolCall('steward_file_read', { path: path.join(ws, 'notes.txt') }, stewardCtx(11));
  assert.ok(off && off.ok === false && off.error === 'read_disabled', `read:false:${brief(off)}`);
  writeCfg(baseCfg({ workspaces: [{ path: ws, read: true, write: true, execute: true }] }));
  const on = await I.toolCall('steward_file_read', { path: path.join(ws, 'notes.txt') }, stewardCtx(12));
  assert.ok(on && on.ok !== false && /hello from the workspace/.test(JSON.stringify(on)), `read:true:${brief(on)}`);
});

// ── [S] 敏感闸剥 NTFS 流后缀 ─────────────────────────────────────────────────
test('[S] 敏感闸 / 写保护闸:NTFS 流后缀与尾随点不能绕过', () => {
  const dr = I.dataRoot();
  for (const p of [path.join(dr, 'config.json') + '::$DATA', path.join(dr, 'config.json') + ':stream', path.join(dr, 'config.json') + '.',
    path.join(dr, 'runtime.json') + '::$DATA', path.join(dr, 'sessions::$INDEX_ALLOCATION', 'a.json'), path.join(dr, 'sessions .', 'a.json')]) {
    assert.equal(I.isSensitiveDataPath(p), true, p);
  }
  const protectedDir = I.WRITE_PROTECTED_DATA_DIRS[0];
  assert.equal(I.isWriteProtectedDataPath(path.join(dr, protectedDir + '::$INDEX_ALLOCATION', 'x.json')), true);
  assert.equal(I.isSensitiveDataPath(path.join(ws, 'config.json::$DATA')), false, '工作区里的同名文件不受影响');
});

// ── [A] 旧版写进 ~/.claude/agents 的免问档 ───────────────────────────────────
test('[A] preview≤3 按老写法(项目角色带 permissionMode)写下的子代理文件被认作自家旧文件并修正;用户改过的不碰', async () => {
  writeCfg(baseCfg());
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.ruyi'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.ruyi', 'agents.json'), JSON.stringify({ roles: [
    { id: 'w4-auditor', label: '审计员', description: '只读审计', prompt: '你是审计员。', permissionMode: 'bypass' },
    { id: 'w4-keeper', label: '守门员', description: '守门', prompt: '你是守门员。', permissionMode: 'bypass' },
  ] }), 'utf8');
  const agentsDir = path.join(home, '.claude', 'agents');
  const cfg = await I.readConfig();
  await I.syncAgentRolesToClaude(proj, cfg);   // 先按现在的写法生成一份,作为「修正后应有的样子」
  const current = fs.readFileSync(path.join(agentsDir, 'w4-auditor.md'), 'utf8');
  assert.doesNotMatch(current, /permissionMode/, '现在的写法:项目角色不带免问档');
  // 老写法 = 去掉标记行、在 description 之后插 permissionMode(preview.3 的 fm 次序)。
  const legacy = current.replace('\n\n' + I.RUYI_AGENT_FILE_MARKER, '').replace(/^(---\ndescription: [^\n]*\n)/, '$1permissionMode: bypassPermissions\n');
  assert.match(legacy, /permissionMode: bypassPermissions/);
  fs.writeFileSync(path.join(agentsDir, 'w4-auditor.md'), legacy, 'utf8');
  const userEdited = legacy.replace('你是守门员。', '').replace('你是审计员。', '你是审计员。\n(用户自己加的一行)');
  fs.writeFileSync(path.join(agentsDir, 'w4-keeper.md'), userEdited, 'utf8');
  await I.syncAgentRolesToClaude(proj, cfg);
  assert.equal(fs.readFileSync(path.join(agentsDir, 'w4-auditor.md'), 'utf8'), current, '老写法的自家文件被覆盖成新写法');
  assert.equal(fs.readFileSync(path.join(agentsDir, 'w4-keeper.md'), 'utf8'), userEdited, '对不上老写法的(用户改过)不碰');
});

// ── [B] body-token 路由拒跨站浏览器请求 ─────────────────────────────────────
test('[B] body-token 路由:跨站浏览器请求在读体之前拒;无 Origin 的回环(MCP 子进程)与同源照常', () => {
  I.RUNTIME.port = 18799;
  const req = headers => ({ headers: { host: '127.0.0.1:18799', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  for (const p of ['/api/todo', '/api/permission/request', '/api/agent-workflow/launch', '/api/mission']) {
    assert.equal(I.authorizeRoute(req({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), 'POST', p), 'cross-origin request rejected', p);
    assert.equal(I.authorizeRoute(req({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }), 'POST', p), 'cross-origin request rejected', p + '(只有 Sec-Fetch)');
    assert.equal(I.authorizeRoute(req({}), 'POST', p), null, p + '(MCP 子进程:无 Origin)');
    assert.equal(I.authorizeRoute(req({ origin: 'http://127.0.0.1:18799', 'sec-fetch-site': 'same-origin' }), 'POST', p), null, p + '(同源页面)');
  }
});

// ── [T] 管家污点:直调写工具降级为提议 ───────────────────────────────────────
test('[T] 管家这一回合读过外界内容后,直调写工具降级为提议;收紧类与只读不拦', async () => {
  writeCfg(baseCfg());
  const ctx = stewardCtx(21);
  I.stewardMarkTurnTainted(ctx, 'steward_web_fetch');
  const sched = await I.toolCall('steward_schedule_create', { title: 'x', kind: 'prompt', prompt: 'do it', schedule: { type: 'interval', everyMinutes: 15 } }, ctx);
  assert.ok(sched && sched.error === 'propose_required' && sched.blockedBy === 'steward_turn_tainted', `schedule_create:${brief(sched)}`);
  const relay = await I.toolCall('steward_thread_continue', { sessionId: 'w4thread', message: 'hi' }, ctx);
  assert.ok(relay && relay.error === 'propose_required' && relay.blockedBy === 'steward_turn_tainted', `thread_continue:${brief(relay)}`);
  const mem = await I.toolCall('steward_memory_write', { kind: 'preference', body: 'x' }, ctx);
  assert.ok(mem && mem.error === 'propose_required' && mem.blockedBy === 'steward_turn_tainted', `memory_write:${brief(mem)}`);
  const stop = await I.toolCall('steward_thread_stop', { sessionId: 'w4thread' }, ctx);
  assert.ok(!(stop && stop.blockedBy === 'steward_turn_tainted'), `收紧类 thread_stop 不受污点拦(实得 ${brief(stop)})`);
  const deny = await I.toolCall('steward_decide', { missionId: 'w4thread', interventionId: 'iv_public', action: 'deny' }, ctx);
  assert.ok(!(deny && deny.blockedBy === 'steward_turn_tainted'), `拒绝类不受污点拦(实得 ${brief(deny)})`);
  const clean = await I.toolCall('steward_schedule_create', { title: 'x' }, stewardCtx(22));
  assert.ok(!(clean && clean.blockedBy === 'steward_turn_tainted'), `干净回合不受影响(实得 ${brief(clean)})`);
  const pressed = await I.toolCall('steward_schedule_create', { title: 'x' }, { ...ctx, userPressed: true });
  assert.ok(!(pressed && pressed.blockedBy === 'steward_turn_tainted'), `用户亲手按下的按钮不拦(实得 ${brief(pressed)})`);
});

// ── [U] 打开类工具拒非本机 UNC ───────────────────────────────────────────────
test('[U] office_open / browser_open:非本机 UNC 在任何 I/O 之前拒;本机主机名与网址不拦', async () => {
  writeCfg(baseCfg());
  const office = await I.TOOL_HANDLERS.office_open.handler({ path: '\\\\attacker.example\\share\\a.pdf' }, null);
  assert.ok(office && office.ok === false && office.code === 'not-allowed', `office_open UNC:${brief(office)}`);
  const browser = await I.TOOL_HANDLERS.browser_open.handler({ url: '\\\\attacker.example\\share\\x.html' }, null);
  assert.ok(browser && browser.ok === false && browser.code === 'not-allowed', `browser_open UNC:${brief(browser)}`);
  const fileUrl = await I.TOOL_HANDLERS.browser_open.handler({ url: 'file://attacker.example/share/x.html' }, null);
  assert.ok(fileUrl && fileUrl.ok === false && fileUrl.code === 'not-allowed', `browser_open file://主机:${brief(fileUrl)}`);
  assert.equal(await I.openToolUncDenied('https://example.com/a.pdf', null), '', '网址不在此列');
  assert.equal(await I.openToolUncDenied(path.join(ws, 'a.pdf'), null), '', '本地路径不拦');
  assert.equal(await I.openToolUncDenied('\\\\localhost\\C$\\x.pdf', null), '', '本机主机名不算外联');
});

// ── [I] 收件箱:回合窗口里不误报「跑完了」 ──────────────────────────────────
test('[I] 收件箱:回合已进 runSessionTurn(turnSettlers 已登记)时,已见过的线程不报完成、基线不前进;收尾后照常报一次', async () => {
  const sid = 'w4inbox';
  craftThread(sid, 'default');
  const headFile = path.join(data, 'sessions', sid + '.json');
  const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  fs.writeFileSync(headFile, JSON.stringify({ ...head, turnSeq: 2, stewardWatch: true, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  I.stewardRuntime.cursor.sessionTurns[sid] = { turnSeq: 1, stamp: '' };
  I.turnSettlers.set(sid, { probe: true });
  try {
    const during = await I.stewardCollectSessionTurn(sid, sid, { sourceStamp: 'stamp-a' }, Date.now());
    assert.equal(during, null, '回合还在起手 / 收尾窗口:不报');
    assert.equal(I.stewardRuntime.cursor.sessionTurns[sid].turnSeq, 1, '基线不前进(否则真结果再也报不出来)');
  } finally { I.turnSettlers.delete(sid); }
  const after = await I.stewardCollectSessionTurn(sid, sid, { sourceStamp: 'stamp-b' }, Date.now());
  assert.ok(after && typeof after === 'object', '回合收尾之后照常报这一回合');
  assert.equal(I.stewardRuntime.cursor.sessionTurns[sid].turnSeq, 2);
});
