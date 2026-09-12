'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// 2026-09-06 对抗审查 P0-2 回归锁：readConfig 此前把「任何读失败」当「全新安装」并立刻把默认配置写回磁盘——
// 一次背景 GET /api/status 撞上文件被外部写坏/短暂锁住，用户的密钥/服务商/工作区就被静默冲成默认值。
// 现在：文件确实不存在且无 .prev → 才是全新安装；JSON 损坏 → 先从 config.json.prev 恢复，没有就【降级】
// （默认值只供本次请求、不落盘，writeConfig 拒绝），文件恢复可读后自动解除降级。writeConfigAtomic 每次覆盖前
// 把上一版留成 config.json.prev。判定行：`CONFIG READ SAFETY E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-config-read-safety-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

(async () => {
const WB_PORT = await getFreePort();
const CONFIG = path.join(HOME, 'config.json');
const PREV = CONFIG + '.prev';
const seeded = { configSchema: 7, activeProvider: 'fake-a', engineMode: 'interactive', locale: 'zh-CN', providers: [
  { id: 'fake-a', label: 'A', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real-key-A', model: 'm-a', models: [{ id: 'm-a', label: 'm-a' }] },
] };
fs.writeFileSync(CONFIG, JSON.stringify(seeded, null, 2));

let TOKEN = '';
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, resp => { // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
function reqJson(method, p, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers, timeout: 15000 }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve({ status: res.statusCode, json: j, text: body }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
async function waitForHttp(attempts = 300) { // 117q:预算 100×150ms=15s 低于 30 号文 P1-31 建议的 300×同款间隔量级,为同批口径统一一并抬高(30 号文 P1-31)
  for (let i = 0; i < attempts; i++) { try { const r = await reqJson('GET', '/api/status'); if (r.status === 200) return true; } catch { /* not up yet */ } await sleep(150); }
  return false;
}
const diskText = () => fs.readFileSync(CONFIG, 'utf8');
const diskJson = () => JSON.parse(diskText());
const logText = () => { const d = path.join(HOME, 'logs'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n') : ''; };

let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
  ok(await waitForHttp(), 'A0 workbench listening');
  TOKEN = await getToken();
  ok(!!TOKEN, 'A0b got UI token');

  // ① 一次正常写入 → 上一版被留成 .prev。
  let r = await reqJson('POST', '/api/config', { locale: 'en-US' });
  ok(r.status === 200, 'A1 normal write ok');
  ok(fs.existsSync(PREV) && JSON.parse(fs.readFileSync(PREV, 'utf8')).locale === 'zh-CN', 'A2 config.json.prev holds the previous version');
  ok(diskJson().providers.length === 1 && diskJson().providers[0].apiKey === 'sk-real-key-A', 'A3 providers intact after the write');

  // ② JSON 被外部写坏 + 有 .prev → 读时从 .prev 恢复，磁盘重新变成合法配置且服务商还在。
  fs.writeFileSync(CONFIG, '{ this is not json');
  r = await reqJson('GET', '/api/status');
  await sleep(300);
  let disk = null; try { disk = diskJson(); } catch { disk = null; }
  ok(r.status === 200 && disk && Array.isArray(disk.providers) && disk.providers.length === 1 && disk.providers[0].apiKey === 'sk-real-key-A',
    'B1 corrupt config recovers from .prev (providers + key survive) instead of being reset to defaults');
  ok(/config_recovered/.test(logText()), 'B2 recovery logged as config_recovered');

  // ③ JSON 坏了且 .prev 也不可用，但本进程刚才读成功过 → 用内存里上一次的好配置顶着：读不写坏文件；
  //    写入在好配置之上合并后落盘 = 自愈（不是丢失）。
  fs.writeFileSync(CONFIG, '{ still not json');
  fs.writeFileSync(PREV, 'also broken');
  r = await reqJson('GET', '/api/status');
  await sleep(300);
  ok(r.status === 200, 'C1 status still answers on the in-memory last-good copy');
  ok(diskText() === '{ still not json', 'C2 a read never overwrites the broken file');
  ok(/config_read_failed/.test(logText()), 'C3 the failed read is logged as config_read_failed');
  r = await reqJson('POST', '/api/config', { locale: 'zh-CN' });
  ok(r.status === 200 && diskJson().locale === 'zh-CN' && diskJson().providers.length === 1 && diskJson().providers[0].apiKey === 'sk-real-key-A',
    'C4 a write merges onto the last-good copy and heals the file (providers + key intact)');

  // ④ 重启进程（没有内存副本）+ 文件与 .prev 都坏 → 真正的降级：不覆盖、写入拒绝、文件修好后自动解除。
  killp(wb); await sleep(500);
  fs.writeFileSync(CONFIG, '{ broken after restart');
  fs.writeFileSync(PREV, 'also broken');
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
  ok(await waitForHttp(), 'D0 restarted workbench listening (degraded from the first read)');
  TOKEN = await getToken();
  ok(diskText() === '{ broken after restart', 'D1 startup never overwrites the broken file with defaults');
  r = await reqJson('POST', '/api/config', { locale: 'en-US' });
  ok(r.status >= 400, `D2 writes are refused while degraded (status ${r.status})`);
  ok(diskText() === '{ broken after restart', 'D3 the refused write left the file untouched');
  fs.writeFileSync(CONFIG, JSON.stringify({ ...seeded, locale: 'en-US' }, null, 2));
  r = await reqJson('GET', '/api/status');
  r = await reqJson('POST', '/api/config', { locale: 'zh-CN' });
  ok(r.status === 200 && diskJson().locale === 'zh-CN' && diskJson().providers.length === 1, 'D4 once readable again, writes resume and providers are still there');

  // ⑤ 文件被删但 .prev 在 → 从 .prev 恢复而不是当全新安装。
  fs.copyFileSync(CONFIG, PREV);
  fs.unlinkSync(CONFIG);
  r = await reqJson('GET', '/api/status');
  await sleep(300);
  ok(fs.existsSync(CONFIG) && diskJson().providers.length === 1, 'E1 missing config.json is restored from .prev');

  // ⑥ 文件与 .prev 都没有 → 这才是全新安装：默认配置落盘。
  fs.unlinkSync(CONFIG); try { fs.unlinkSync(PREV); } catch { /* ok */ }
  r = await reqJson('GET', '/api/status');
  await sleep(300);
  ok(fs.existsSync(CONFIG) && Array.isArray(diskJson().providers) && diskJson().providers.length === 0, 'F1 fresh install (no file, no .prev) writes defaults');
} catch (e) {
  fail++; console.log('FAIL exception ' + (e && e.stack || e));
} finally {
  killp(wb);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
console.log(fail ? `CONFIG READ SAFETY E2E: FAIL (${fail})` : 'CONFIG READ SAFETY E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
