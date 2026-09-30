require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(审计 A2):审计中心的桌面源吃 ACC audit_tail 的【真实形状】。ACC 的 tools/audit.py 返回
// {ok, count, records:[{ts, tool, ok, args:'<json 字符串>'}], log_dir};修前工作台只认 entries/items/audit/裸数组,
// 桌面源被标 available:true 却一行都没有 —— 每一次桌面写操作都不在时间线上。
// 一个假 ACC(只有 audit_tail,按 ACC 的形状回)当 desktopMcp,GET /api/audit?source=desktop。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');

const t = createRunner('AUDIT DESKTOP RECORDS');
const { ok } = t;
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-audit-desktop-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fakeAcc = path.join(HOME, 'fake-acc.js');
fs.writeFileSync(fakeAcc, `
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id == null) return;
  const send = r => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');
  if (m.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-acc', version: '1' } });
  else if (m.method === 'tools/list') send({ tools: [{ name: 'audit_tail', description: 'x', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }] });
  else if (m.method === 'tools/call') {
    const res = { ok: true, count: 2, records: [
      { ts: '2026-09-30T16:17:50', tool: 'write_file', ok: true, args: '{"path": "C:\\\\\\\\a.txt"}' },
      { ts: '2026-09-30T16:18:10', tool: 'run_command', ok: false, args: '{"command": "dir"}' } ], log_dir: 'x' };
    send({ content: [{ type: 'text', text: JSON.stringify(res) }], isError: false });
  } else send({});
});`);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'bypass', providers: [],
  desktopMcp: { enabled: true, command: process.execPath, args: [fakeAcc], cwd: '', autodetect: false },
}));
const WP = await getFreePort();
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, HOME, USERPROFILE: HOME } });
const get = (p, headers) => new Promise(resolve => {
  http.get({ host: '127.0.0.1', port: WP, path: p, headers: headers || {}, timeout: 20000 }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', () => resolve({ status: 0, body: '' }));
});
try {
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { up = (await get('/health')).status === 200; if (!up) await sleep(120); }
  ok(up, 'server up');
  const idx = await get('/');
  const token = (idx.body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  ok(!!token, 'token scraped');
  const r = await get('/api/audit?limit=50&source=desktop', { 'x-wcw-token': token });
  let j = null; try { j = JSON.parse(r.body); } catch { /* fall through */ }
  ok(r.status === 200 && j && j.ok === true && j.sources && j.sources.desktop === true, `desktop 源可用(got ${r.body.slice(0, 200)})`);
  const rows = (j && j.entries) || [];
  ok(rows.length === 2 && rows.every(e => e.source === 'desktop'), `ACC records 变成 2 行 desktop 时间线(got ${rows.length})`);
  ok(rows.some(e => e.type === 'write_file') && rows.some(e => e.type === 'run_command' && /失败/.test(e.summary)), '类型取自 tool,失败的 summary 带「失败」');
  ok(rows.length === 2 && typeof rows[0].detail.args === 'object', 'args 字符串被摊成对象(不再双重编码)');
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { killOwnTree(wb.pid); } catch { /* gone */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
