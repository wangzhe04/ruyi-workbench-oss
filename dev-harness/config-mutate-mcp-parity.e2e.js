'use strict';
/*
 * E2E (117n-M2): 配置写口收敛(mutateConfig)+ MCP 连接器判据合一(mutateMcpConnector)。
 *
 * 修的是两个真缺口,本件的每条断言在修前都会红:
 *  T 段 工具面 mcp_configure(configureMcpFromTool)漏掉的三项副作用 —— 与 HTTP 面
 *      (POST /api/mcp/connectors/toggle、DELETE /api/mcp/connectors)必须走同一条路径:
 *   T1 upsert 后 .mcp.json 被重生成且含新条目(修前:压根不调 generateMcpConfig,文件不存在)
 *   T2 set-enabled false 后 .mcp.json 里该条目消失(CLI 侧清单不再落后于 config.json)
 *   T3 remove 后 dismissedMcpIds 记住该 id(修前:不记 -> 下次启动被 autoImportClaudeCodeMcp 悄悄加回来)
 *   T4 remove 后 .mcp.json 里该条目消失
 *   T5 drop-in 来源的连接器在工具面 set-enabled 被护栏挡下,且给的是「drop-in/目录」人话
 *      (修前:只回「未找到外部 MCP」—— 与 HTTP 面 409 的判据分岔)
 *   T6 drop-in 来源的连接器在工具面 remove 被同一条护栏挡下
 *   T7 drop-in 同 id 的 upsert 被挡,且没有把条目偷偷写进 config(修前:成功遮蔽 drop-in)
 *   T8 remove 走工具面也留审计事件(与 HTTP 面 DELETE 同一条 kind:mcp_connector_delete)
 *   T9 内置 ai-computer-control 仍被挡(零回归)
 *   T10 未知 id 的 remove / set-enabled 仍是「未找到」(零回归)
 *   T11 upsert 显式再导入 -> 把该 id 从 dismissedMcpIds 移除(与 import-folder/import-config 同语义)
 *  C 段 配置「读-改-写」临界区(修前红:9 处绕过 applyConfigPatch 各自裸 readConfig->writeConfig,
 *      configWriteChain 只串行化物理写,后写者静默吞掉先写者的字段):
 *   C1 5 个并发 toggle(5 个不同 id)全部落盘
 *   C2 storage/policy + agent-roles(global)+ connectors/toggle 三路并发,三个字段都活
 *  S 段 静态锁:mutateConfig / mutateMcpConnector 在;裸 writeConfig 的调用点收敛到 1 个
 *      (即 mutateConfig 自己),护栏 mcpConnectorMutateError 仍在。
 *
 * Run: node dev-harness/config-mutate-mcp-parity.e2e.js
 */
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const FAKE_MCP = path.join(__dirname, 'fake-mcp.js');
const HOME = path.join(os.tmpdir(), 'ruyi-117n-m2-tool');
const HOME2 = path.join(os.tmpdir(), 'ruyi-117n-m2-conc');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const readCfg = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; } };
const readGenerated = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'generated', 'workbench.mcp.json'), 'utf8')); } catch { return null; } };
const errText = r => { const e = r && (r.error || (r.json && r.json.error)); return typeof e === 'string' ? e : (e && e.message) || ''; };

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 12000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
async function up(port) { // 117q:预算 60×120ms=7.2s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
function getHtml(port) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve('')); r.on('timeout', () => { r.destroy(); resolve(''); });
  });
}
// 审计事件是 fs.createWriteStream 异步刷的 —— 轮询等它落盘,不用固定 sleep。
async function waitForAudit(home, kind, id, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const dir = path.join(home, 'logs');
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.ndjson')) continue;
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let rec = null; try { rec = JSON.parse(line); } catch { continue; }
          if (rec && rec.kind === kind && (id == null || rec.id === id)) return rec;
        }
      }
    } catch { /* 目录还没建 */ }
    await sleep(50);
  }
  return null;
}

const baseConfig = extra => ({
  configSchema: 7, version: '2.0.1', permissionMode: 'bypass',
  // 管家/线程摘要与本件无关,显式关掉避免背景写盘干扰配置比对。
  stewardEnabledV1: false, stewardThreadBriefV1: false,
  // autoImportClaudeCodeMcp 会读【真实】~/.claude.json 污染 temp-HOME,必须关。
  autoImportClaudeCodeMcp: false,
  enableMcpDropIn: true, desktopMcp: { enabled: false },
  ...extra,
});

(async () => {
  // ────────────────────────────── T 段: 工具面 mcp_configure(in-process 直测)──────────────────────
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'mcp', 'drop-tool'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'mcp', 'drop-tool', 'ruyi-mcp.json'),
    JSON.stringify({ id: 'drop-tool', label: 'dropin', command: process.execPath, args: [FAKE_MCP] }));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(baseConfig({
    externalMcpServers: [
      { id: 'tool-a', label: 'A', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: true },
      { id: 'tool-b', label: 'B', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: true },
    ],
    dismissedMcpIds: ['tool-c'],
  }), null, 2));
  process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const srv = require(SERVER);
  const cfgTool = () => srv.configureMcpFromTool;

  console.log('── T 段: 工具面 mcp_configure 的副作用与护栏 ──');
  // T1/T11: upsert 一个新 id(它此前在 dismissedMcpIds 里 —— 显式再导入应把它移出)
  const rUp = await cfgTool()({ operation: 'upsert', id: 'tool-c', server: { id: 'tool-c', label: 'C', command: process.execPath, args: [FAKE_MCP] } });
  ok(rUp && rUp.ok === true, 'T0 upsert 成功(前置)');
  const gen1 = readGenerated(HOME);
  ok(gen1 && gen1.mcpServers && gen1.mcpServers['tool-c'], 'T1 upsert 后 .mcp.json 被重生成且含 tool-c');
  ok((readCfg(HOME).dismissedMcpIds || []).indexOf('tool-c') < 0, 'T11 upsert(显式再导入)把该 id 从 dismissedMcpIds 移除');

  // T2: set-enabled false -> 生成清单里该条目消失
  const rDis = await cfgTool()({ operation: 'set-enabled', id: 'tool-c', enabled: false });
  ok(rDis && rDis.ok === true, 'T2a set-enabled 成功(前置)');
  const gen2 = readGenerated(HOME);
  ok(gen2 && gen2.mcpServers && !gen2.mcpServers['tool-c'], 'T2 set-enabled false 后 .mcp.json 里 tool-c 消失');

  // T3/T4/T8: remove -> dismissedMcpIds + 重生成 + 审计
  const rRm = await cfgTool()({ operation: 'remove', id: 'tool-a' });
  ok(rRm && rRm.ok === true && rRm.removed === true, 'T3a remove 成功(前置)');
  ok((readCfg(HOME).dismissedMcpIds || []).includes('tool-a'), 'T3 remove 后 dismissedMcpIds 记住 tool-a(否则重启被自动加回)');
  const gen3 = readGenerated(HOME);
  ok(gen3 && gen3.mcpServers && !gen3.mcpServers['tool-a'], 'T4 remove 后 .mcp.json 里 tool-a 消失');
  ok(await waitForAudit(HOME, 'mcp_connector_delete', 'tool-a'), 'T8 remove 走工具面也留审计事件 mcp_connector_delete');

  // T5/T6/T7: drop-in 来源的连接器 —— 三个操作都必须被同一条护栏挡下
  const rDropEn = await cfgTool()({ operation: 'set-enabled', id: 'drop-tool', enabled: false });
  ok(rDropEn && rDropEn.ok === false && /drop-in|目录/.test(errText(rDropEn)), 'T5 drop-in set-enabled 被护栏挡下并给目录管理人话');
  const rDropRm = await cfgTool()({ operation: 'remove', id: 'drop-tool' });
  ok(rDropRm && rDropRm.ok === false && /drop-in|目录/.test(errText(rDropRm)), 'T6 drop-in remove 被同一条护栏挡下');
  const rDropUp = await cfgTool()({ operation: 'upsert', id: 'drop-tool', server: { id: 'drop-tool', label: '偷换', command: process.execPath, args: [FAKE_MCP] } });
  ok(rDropUp && rDropUp.ok === false && /drop-in|目录/.test(errText(rDropUp)), 'T7a drop-in upsert 被挡');
  ok(!(readCfg(HOME).externalMcpServers || []).some(s => s && s.id === 'drop-tool'), 'T7 drop-in upsert 没有把条目偷偷写进 config');

  // T9/T10: 零回归
  const rBuiltin = await cfgTool()({ operation: 'remove', id: 'ai-computer-control' });
  ok(rBuiltin && rBuiltin.ok === false, 'T9 内置 ai-computer-control 仍被挡');
  const rUnk1 = await cfgTool()({ operation: 'remove', id: 'no-such-mcp' });
  const rUnk2 = await cfgTool()({ operation: 'set-enabled', id: 'no-such-mcp', enabled: true });
  ok(rUnk1 && rUnk1.ok === false && /未找到/.test(errText(rUnk1)), 'T10a 未知 id remove -> 未找到');
  ok(rUnk2 && rUnk2.ok === false && /未找到/.test(errText(rUnk2)), 'T10b 未知 id set-enabled -> 未找到');
  // tool-b 全程没被碰过(无关连接器不受影响)
  ok((readCfg(HOME).externalMcpServers || []).some(s => s && s.id === 'tool-b' && s.enabled !== false), 'T10c 无关连接器 tool-b 不受影响');

  // ────────────────────────────── C 段: 并发丢失更新(HTTP 真身)────────────────────────────────
  console.log('── C 段: 配置读-改-写临界区(并发丢失更新)──');
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(HOME2, { recursive: true });
  const conc = ['c1', 'c2', 'c3', 'c4', 'c5'].map(id => ({ id, label: id, command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: true }));
  fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify(baseConfig({
    enableMcpDropIn: false, externalMcpServers: conc,
  }), null, 2));
  let WP = await getFreePort();
  const spawnWb = () => cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2 }, windowsHide: true });
  let wb = null, started = false;
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    wb = spawnWb();
    if (await up(WP)) { started = true; break; }
    try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(200); WP = await getFreePort();
  }
  try {
    ok(started, 'C0 workbench up');
    const token = (((await getHtml(WP)).match(/name="wcw-token"\s+content="([a-f0-9]+)"/)) || [])[1] || '';
    const hdr = { 'x-wcw-token': token };

    // C1: 5 路并发 toggle,各改一个不同 id 的 enabled。没有临界区时它们读到同一份旧 list,
    // 后写者整份覆盖前写者 -> 只有最后一个的 enabled:false 活下来。
    const t = await Promise.all(conc.map(s => post(WP, '/api/mcp/connectors/toggle', { id: s.id, enabled: false }, hdr)));
    ok(t.every(r => r && r.status === 200 && r.json && r.json.ok === true), 'C1a 5 路并发 toggle 都回 200');
    const after = readCfg(HOME2);
    const survived = conc.filter(s => (after.externalMcpServers || []).some(x => x && x.id === s.id && x.enabled === false)).map(s => s.id);
    ok(survived.length === 5, 'C1 5 个并发 toggle 全部落盘(存活 ' + survived.length + '/5: ' + survived.join(',') + ')');

    // C2: 三条不同路由并发改三个不同字段(storage/policy、agent-roles global、connectors/toggle)。
    const r2 = await Promise.all([
      post(WP, '/api/storage/policy', { logsKeepDays: 111 }, hdr),
      post(WP, '/api/agent-roles', { scope: 'global', roles: [{ id: 'concurrency-probe', label: '并发探针' }] }, hdr),
      post(WP, '/api/mcp/connectors/toggle', { id: 'c1', enabled: true }, hdr),
    ]);
    ok(r2.every(r => r && r.status === 200 && r.json && r.json.ok === true), 'C2a 三路并发都回 200');
    const after2 = readCfg(HOME2);
    const hasPolicy = after2 && after2.storagePolicy && after2.storagePolicy.logsKeepDays === 111;
    const hasRole = after2 && (after2.agentRoleOverrides || []).some(r => r && r.id === 'concurrency-probe');
    const hasToggle = after2 && (after2.externalMcpServers || []).some(x => x && x.id === 'c1' && x.enabled === true);
    ok(hasPolicy && hasRole && hasToggle, 'C2 三路并发的三个字段都活(policy=' + !!hasPolicy + ' role=' + !!hasRole + ' toggle=' + !!hasToggle + ')');
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  }

  // ────────────────────────────── S 段: 静态锁 ─────────────────────────────────────────────────
  console.log('── S 段: 静态锁 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  // mutateConfig 不是 async 函数:它必须【同步】把自己接到 configMutateChain 上再返回,
  // 否则两个并发调用会在各自的第一个 await 之后才排队,临界区就漏了。两条一起钉。
  ok(/function mutateConfig\(mutator\)/.test(src) && /configMutateChain/.test(src), 'S1 mutateConfig(全程持锁的读-改-写)+ 独立队列 configMutateChain 在');
  ok(/async function mutateMcpConnector\(/.test(src), 'S2 mutateMcpConnector(连接器变更唯一内核)在');
  ok(/function mcpConnectorMutateError\(/.test(src), 'S3 护栏 mcpConnectorMutateError 仍在');
  const bare = (src.match(/await writeConfig\(/g) || []).length;
  ok(bare === 1, 'S4 裸 writeConfig 调用点收敛到 1 个(mutateConfig 自己),实测 ' + bare);
  ok(/applyConfigPatch/.test(src) && /mutateConfig\(/.test(src), 'S5 applyConfigPatch 与 mutateConfig 都在产物里');

  console.log(fail ? `\nFAILED (${fail})` : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR ' + (e && e.stack || e)); process.exit(1); });
