'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:3.0 统一命名 —— 数据目录 ~/.win-claude-workbench → ~/.ruyi-workbench 的一次性迁移,以及 MCP server id 改名为 ruyi。
// 每个场景一个独立的临时家目录(HOME / USERPROFILE 指过去),子进程里【去掉】RUYI_HOME 与旧变量 WIN_CLAUDE_WORKBENCH_HOME ——
// 迁移只在「没有任何数据根环境变量」时发生。
//   M1 只有旧目录 → 直接运行 serve 时搬成新目录,原处留一个指回新目录的链接(Windows 是目录联接);配置原样在新目录里;
//      /api/status 的 dataRoot 是新目录、dataRootAliases 列出旧路径;启动行与日志各记一笔;
//   M2 经旧路径(别名)读 config.json 的文件工具访问照样被拒(敏感子树判定认别名),经新路径同样拒;
//   M3 第二次启动:不再迁移、不再打迁移行;
//   M4 旧目录里有活实例(runtime.json 的 pid 活着)→ 不动它,本次继续用旧目录,启动行说明原因;
//   M5 设了 RUYI_HOME → 不迁移(旧目录原样);
//   M6 mcp-config 子命令不迁移;生成的 MCP 配置里如意自己的 server id 是 ruyi,子进程环境只写 RUYI_HOME。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-dataroot-'));
const t = createRunner('DATA ROOT MIGRATION');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (!('RUYI_HOME' in extra)) delete env.RUYI_HOME;
  delete env.WIN_CLAUDE_WORKBENCH_HOME;
  return env;
}
function makeHome(name) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}
function seedLegacy(home, marker) {
  const legacy = path.join(home, '.win-claude-workbench');
  fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ configSchema: 12, permissionMode: 'bypass', stewardThreadBriefV1: false, marker }));
  fs.writeFileSync(path.join(legacy, 'sessions', 'keep.txt'), 'session data ' + marker);
  return legacy;
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
async function waitFor(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}
// 起一个工作台,等到 /health 通,取页面 token;返回 { port, headers, log(), stop() }
async function serve(home, extraEnv) {
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: childEnv(home, extraEnv) });
  let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
  const stop = async () => { try { killOwnTree(wb); } catch { /* gone */ } await sleep(300); };
  const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null));
  if (!up) { await stop(); throw new Error('workbench did not start: ' + log.slice(-800)); }
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  return { port, headers: { 'x-wcw-token': token }, log: () => log, stop };
}
const lexists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };

(async () => {
  const running = [];
  try {
    // ── M1–M3:只有旧目录 → 迁移 ────────────────────────────────────────────────────────────────
    const h1 = makeHome('m1');
    const legacy1 = seedLegacy(h1, 'MARK-M1');
    const next1 = path.join(h1, '.ruyi-workbench');
    const s1 = await serve(h1); running.push(s1);
    ok(fs.existsSync(path.join(next1, 'config.json')) && JSON.parse(fs.readFileSync(path.join(next1, 'config.json'), 'utf8')).marker === 'MARK-M1'
      && fs.readFileSync(path.join(next1, 'sessions', 'keep.txt'), 'utf8') === 'session data MARK-M1', 'M1 旧目录的内容原样搬进 ~/.ruyi-workbench');
    ok(isLink(legacy1) && same(legacy1, next1), 'M1 旧路径留一个指回新目录的链接(Windows 上是目录联接)');
    const st1 = await request(s1.port, 'GET', '/api/status', null, s1.headers);
    ok(st1 && same(st1.dataRoot, next1) && Array.isArray(st1.dataRootAliases) && st1.dataRootAliases.some(a => a === legacy1),
      `M1 /api/status:dataRoot 是新目录,dataRootAliases 列出旧路径(${JSON.stringify({ dataRoot: st1 && st1.dataRoot, aliases: st1 && st1.dataRootAliases })})`);
    ok(/data dir migrated .*\.win-claude-workbench -> .*\.ruyi-workbench/.test(s1.log()), 'M1 启动行记了迁移');
    const logs = fs.readdirSync(path.join(next1, 'logs')).map(f => fs.readFileSync(path.join(next1, 'logs', f), 'utf8')).join('\n');
    ok(/"kind":"data_root_migration".*"moved":true/.test(logs), 'M1 日志记了 data_root_migration');
    // M2:经旧路径(别名)与新路径读 config.json 都被拒
    const viaAlias = await request(s1.port, 'POST', '/api/tools/file_read', { path: path.join(legacy1, 'config.json') }, s1.headers);
    const viaNext = await request(s1.port, 'POST', '/api/tools/file_read', { path: path.join(next1, 'config.json') }, s1.headers);
    const denied = r => r && r.result && r.result.ok === false && !JSON.stringify(r.result).includes('MARK-M1');
    ok(denied(viaAlias), `M2 经旧路径(别名)读 config.json 被拒(${JSON.stringify(viaAlias && viaAlias.result).slice(0, 160)})`);
    ok(denied(viaNext), 'M2 经新路径读 config.json 被拒');
    await s1.stop(); running.pop();
    const s1b = await serve(h1); running.push(s1b);
    ok(!/data dir (migrated|migration skipped)/.test(s1b.log()) && fs.existsSync(path.join(next1, 'config.json')), 'M3 第二次启动不再迁移');
    await s1b.stop(); running.pop();

    // ── M4:旧目录里有活实例 → 不动 ──────────────────────────────────────────────────────────────
    const h4 = makeHome('m4');
    const legacy4 = seedLegacy(h4, 'MARK-M4');
    fs.writeFileSync(path.join(legacy4, 'runtime.json'), JSON.stringify({ pid: process.pid, port: 1 }));
    const s4 = await serve(h4); running.push(s4);
    const st4 = await request(s4.port, 'GET', '/api/status', null, s4.headers);
    ok(!isLink(legacy4) && !lexists(path.join(h4, '.ruyi-workbench')) && st4 && same(st4.dataRoot, legacy4),
      `M4 旧目录有活实例:不搬、本次用旧目录(dataRoot=${st4 && st4.dataRoot})`);
    ok(/migration skipped \(legacy-in-use\)/.test(s4.log()), 'M4 启动行说明为什么没迁');
    await s4.stop(); running.pop();

    // ── M5:显式 RUYI_HOME → 不迁移 ──────────────────────────────────────────────────────────────
    const h5 = makeHome('m5');
    const legacy5 = seedLegacy(h5, 'MARK-M5');
    const s5 = await serve(h5, { RUYI_HOME: path.join(h5, 'explicit') }); running.push(s5);
    ok(!isLink(legacy5) && !lexists(path.join(h5, '.ruyi-workbench')) && fs.existsSync(path.join(h5, 'explicit')), 'M5 设了 RUYI_HOME:旧目录原样、不建新目录');
    await s5.stop(); running.pop();

    // ── M6:mcp-config 子命令不迁移;生成的配置用新 id 与 RUYI_HOME ─────────────────────────────────
    const h6 = makeHome('m6');
    const legacy6 = seedLegacy(h6, 'MARK-M6');
    const out = cp.execFileSync(process.execPath, ['app/server.js', 'mcp-config'], { cwd: WB, env: childEnv(h6), encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).pop();
    const generated = JSON.parse(fs.readFileSync(out, 'utf8'));
    ok(!isLink(legacy6) && !lexists(path.join(h6, '.ruyi-workbench')), 'M6 mcp-config 子命令不迁移');
    const own = generated.mcpServers && generated.mcpServers.ruyi;
    ok(own && !generated.mcpServers['win-claude-workbench'] && own.env && own.env.RUYI_HOME && !('WIN_CLAUDE_WORKBENCH_HOME' in own.env),
      `M6 生成的 MCP 配置:server id 是 ruyi,子进程环境只写 RUYI_HOME(${JSON.stringify(Object.keys(generated.mcpServers || {}))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    for (const s of running) await s.stop();
    if (t.failures === 0) fs.rmSync(ROOT, { recursive: true, force: true });
    else console.log('[keep] ' + ROOT);
  }
  t.done({ exit: true });
})();
