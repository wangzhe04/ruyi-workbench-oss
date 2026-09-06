'use strict';
// 2026-09-06 事故回归锁：用户的五个 Provider（含密钥）被一次整份 POST /api/config 写成 providers: [] 清空。
// 两道保险：
//   ① 服务端（13-http-router applyConfigPatch）：现值有 Provider、来件把它清成空数组时，先把当前 config
//      原样另存 config.json.bak-providers-<时间戳>，并记 config_providers_cleared 审计事件；不拦截。
//   ② 前端（provider-settings.js saveSettings）：providersDraft 没被 config 播种过就不上传 providers 键
//      （providersDraftSeeded），服务端 {...current, ...body} 因此保留现值。这里用源码锚锁住。
// 判定行：`CONFIG PROVIDERS GUARD E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-providers-guard-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

(async () => {
const WB_PORT = await getFreePort();
const CONFIG = path.join(HOME, 'config.json');
const providers = [
  { id: 'fake-a', label: 'A', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real-key-A', model: 'm-a', models: [{ id: 'm-a', label: 'm-a' }] },
  { id: 'fake-b', label: 'B', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real-key-B', model: 'm-b', models: [{ id: 'm-b', label: 'm-b' }] },
];
fs.writeFileSync(CONFIG, JSON.stringify({ configSchema: 7, activeProvider: 'fake-a', engineMode: 'interactive', providers, locale: 'zh-CN' }, null, 2));

let TOKEN = '';
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 1500 }, resp => {
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
async function waitForHttp(attempts = 100) {
  for (let i = 0; i < attempts; i++) { try { const r = await reqJson('GET', '/api/status'); if (r.status === 200) return true; } catch { /* not up yet */ } await sleep(150); }
  return false;
}
const readDisk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
  ok(await waitForHttp(), 'A0 workbench listening');
  TOKEN = await getToken();
  ok(!!TOKEN, 'A0b got UI token (POST /api/config is token-level)');

  // ① 部分 patch 不带 providers → 现值原样保留（合并语义）。
  let r = await reqJson('POST', '/api/config', { locale: 'en-US', stewardProviderId: 'fake-a' });
  ok(r.status === 200 && r.json && r.json.ok === true, `A1 partial patch accepted (status ${r.status})`);
  let disk = readDisk();
  ok(Array.isArray(disk.providers) && disk.providers.length === 2 && disk.providers[0].apiKey === 'sk-real-key-A',
    'A2 partial patch keeps both providers and the real keys on disk');
  ok(!fs.readdirSync(HOME).some(f => f.startsWith('config.json.bak-providers-')), 'A3 no backup written for a harmless patch');

  // ② 掩码回传（UI 把 GET /api/status 的 ••••… 原样发回）→ 密钥经 unmaskSecrets 复原，不被抹掉。
  const status = await reqJson('GET', '/api/status');
  const masked = status.json && status.json.config && status.json.config.providers;
  ok(Array.isArray(masked) && masked.length === 2 && String(masked[0].apiKey || '').includes('•'), 'B1 GET /api/status masks provider keys');
  r = await reqJson('POST', '/api/config', { providers: masked });
  disk = readDisk();
  ok(r.status === 200 && disk.providers.length === 2 && disk.providers[1].apiKey === 'sk-real-key-B', 'B2 masked round-trip restores the real keys');

  // ②b 缩水（2 → 1，丢 fake-b）也要备份 + 审计（设置弹窗子审查：草稿未播种时「添加一条再保存」正是这种丢法）。
  r = await reqJson('POST', '/api/config', { providers: [masked[0]] });
  disk = readDisk();
  const shrinkBackups = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-'));
  ok(r.status === 200 && disk.providers.length === 1 && disk.providers[0].id === 'fake-a', 'B3 shrinking to a partial list is still honoured');
  ok(shrinkBackups.length === 1, `B4 a backup is written on shrink, not only on clear (${shrinkBackups.join(',')})`);
  await sleep(300);
  ok(/config_providers_shrunk/.test(fs.existsSync(path.join(HOME, 'logs')) ? fs.readdirSync(path.join(HOME, 'logs')).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(HOME, 'logs', f), 'utf8')).join('\n') : ''),
    'B5 audit event config_providers_shrunk logged with the lost ids');
  // 恢复成两条（fake-b 已不在盘上，掩码无从复原，这里显式带真密钥），下面的清空场景从两条开始。
  r = await reqJson('POST', '/api/config', { providers: [masked[0], { ...masked[1], apiKey: 'sk-real-key-B' }] });
  ok(r.status === 200 && readDisk().providers.length === 2 && readDisk().providers[1].apiKey === 'sk-real-key-B', 'B6 re-adding the second provider with an explicit key lands on disk');
  const backupsBeforeClear = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-')).length;

  // ③ 整份保存把 providers 清成 [] → 仍然写入（不拦截），但先另存一份备份 + 审计事件。
  r = await reqJson('POST', '/api/config', { providers: [], permissionMode: 'default' });
  disk = readDisk();
  const backups = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-'));
  ok(r.status === 200 && Array.isArray(disk.providers) && disk.providers.length === 0, 'C1 clearing providers is still honoured (last-one-deleted is legal)');
  ok(backups.length === backupsBeforeClear + 1, `C2 exactly one more backup written before the wipe (${backups.join(',')})`);
  const newestBackup = backups.slice().sort().pop();
  const backup = newestBackup ? JSON.parse(fs.readFileSync(path.join(HOME, newestBackup), 'utf8')) : null;
  ok(backup && Array.isArray(backup.providers) && backup.providers.length === 2 && backup.providers[0].apiKey === 'sk-real-key-A',
    'C3 the backup carries both providers with real keys (recoverable)');
  await sleep(300);
  const logDir = path.join(HOME, 'logs');
  const logText = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n') : '';
  ok(/config_providers_cleared/.test(logText), 'C4 audit event config_providers_cleared logged');

  // ④ 已经是空的再发 [] → 不再重复备份。
  r = await reqJson('POST', '/api/config', { providers: [] });
  ok(fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-')).length === backupsBeforeClear + 1, 'C5 no extra backup when there was nothing to lose');

  // ⑤ 前端守门的源码锚：saveSettings 只在草稿播种后上传 providers。
  const ps = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'provider-settings.js'), 'utf8');
  ok(/providers: state\.providersDraftSeeded === true \? \(state\.providersDraft \|\| \[\]\) : undefined/.test(ps),
    'D1 saveSettings uploads providers only when the draft was seeded from config');
  ok((ps.match(/state\.providersDraftSeeded = true/g) || []).length >= 2,
    'D2 the draft is marked seeded both at fillSettings replay and when the user adds a provider by hand');
} catch (e) {
  fail++; console.log('FAIL exception ' + (e && e.stack || e));
} finally {
  killp(wb);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
console.log(fail ? `CONFIG PROVIDERS GUARD E2E: FAIL (${fail})` : 'CONFIG PROVIDERS GUARD E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
