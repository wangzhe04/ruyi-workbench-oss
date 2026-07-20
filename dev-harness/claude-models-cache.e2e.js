(async () => {
// E2E: 第44波「Claude 模型列表 API 化 + 代理发现缓存 + 自定义模型可删」。
// fake Anthropic 兼容代理(GET /v1/models)→ workbench(claude 引擎,modelsApiBase 指向 fake):
//   a) /api/models = 默认 ∪ 代理 live ∪ 自定义(extraModels/knownModels);【无】版本化硬编码型号;【无】别名(44e)
//   b) 发现成功写 sidecar <dataRoot>/proxy-models-cache.json(不写 config.json,防竞态)
//   c) 代理挂掉、重启 workbench 后,/api/models 与 /api/status 仍含缓存模型(离线兜底,proxyCount=0 佐证非 live)
//   d) POST /api/config 清空 extraModels/knownModels(= 前端行内 × 的后端半)→ 自定义条目消失、缓存条目保留
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort(), WB_PORT2 = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-claude-models-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function up(port) { for (let i = 0; i < 60; i++) { try { const r = await req(port, 'GET', '/health'); if (r.status === 200) return true; } catch { /* ignore */ } await sleep(150); } return false; }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'bypass',
  modelsApiBase: 'http://127.0.0.1:' + FAKE_PORT, modelsApiKey: 'test-key',
  extraModels: ['my-custom|我的自定义'], knownModels: ['remembered-1'],
}, null, 2));

// fake Anthropic 兼容代理:只答 /v1/models。
const fake = http.createServer((q, res) => {
  if (q.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'claude-fake-strong', display_name: 'Claude Fake Strong', type: 'model' },
      { id: 'claude-fake-fast', display_name: 'Claude Fake Fast', type: 'model' },
    ] }));
  } else { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));

function startWb(port) {
  const w = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  w.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  w.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  w.on('error', e => console.log('[wb!] spawn error: ' + (e && e.message || e)));
  w.on('exit', (code, sig) => console.log('[wb] exited code=' + code + ' sig=' + sig));
  return w;
}

let wb = startWb(WB_PORT);
try {
  ok(await up(WB_PORT), 'workbench up(第 1 轮,代理在线)');
  const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
  const H = { 'x-wcw-token': token };

  // ── a) 列表构成 ──
  const r1 = (await req(WB_PORT, 'GET', '/api/models', null, H)).json;
  ok(r1 && r1.ok && r1.engine === 'claude', 'a) /api/models engine=claude');
  const ids1 = ((r1 && r1.models) || []).map(m => m.id);
  ok(r1 && r1.proxyCount === 2, 'a) proxyCount=2(got ' + (r1 && r1.proxyCount) + ')');
  ok(ids1.includes('claude-fake-strong') && ids1.includes('claude-fake-fast'), 'a) 含代理 live 模型');
  ok(!ids1.includes('claude-opus-4-8') && !ids1.includes('claude-fable-5') && !ids1.includes('claude-sonnet-5') && !ids1.includes('claude-haiku-4-5'), 'a) 无版本化硬编码型号(第44波去硬编码)');
  ok(ids1.includes('') && !ids1.includes('opus') && !ids1.includes('sonnet') && !ids1.includes('haiku'), 'a) 保留 默认(CLI 配置);44e 别名也出列表');
  ok(ids1.includes('my-custom') && ids1.includes('remembered-1'), 'a) 含自定义(extraModels ∪ knownModels)');
  const mc = ((r1 && r1.models) || []).find(m => m.id === 'my-custom');
  ok(mc && mc.label === '我的自定义', 'a) extraModels 的 "id|label" 标注生效');

  // ── b) sidecar 缓存落盘(discoverModels 的写是 fire-and-forget,短轮询等落盘) ──
  const sidecar = path.join(HOME, 'proxy-models-cache.json');
  let cache = null;
  for (let i = 0; i < 30 && !cache; i++) { cache = readJson(sidecar); if (!cache) await sleep(100); }
  ok(cache && Array.isArray(cache.models), 'b) sidecar proxy-models-cache.json 落盘');
  const cids = ((cache && cache.models) || []).map(m => m.id);
  ok(cids.includes('claude-fake-strong') && cids.includes('claude-fake-fast'), 'b) 缓存含代理模型(带 display_name label)');
  const cfgRaw = readJson(path.join(HOME, 'config.json')) || {};
  ok(!('proxyModelsCache' in cfgRaw), 'b) 缓存【不】写进 config.json(防陈旧全量快照竞态)');

  // ── c) 杀代理 + 重启 workbench → 缓存兜底 ──
  kill(wb); wb = null;
  await new Promise(r => fake.close(r));
  await sleep(500);
  wb = startWb(WB_PORT2);
  ok(await up(WB_PORT2), 'workbench up(第 2 轮,代理离线)');
  const token2 = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
  const H2 = { 'x-wcw-token': token2 };
  const r2 = (await req(WB_PORT2, 'GET', '/api/models', null, H2)).json;
  const ids2 = ((r2 && r2.models) || []).map(m => m.id);
  ok(r2 && r2.proxyCount === 0, 'c) 代理不可达 proxyCount=0(got ' + (r2 && r2.proxyCount) + ')');
  ok(ids2.includes('claude-fake-strong') && ids2.includes('claude-fake-fast'), 'c) 代理离线后缓存模型仍在 /api/models');
  const st = (await req(WB_PORT2, 'GET', '/api/status', null, H2)).json;
  const sids = ((st && st.models) || []).map(m => m.id);
  ok(sids.includes('claude-fake-strong') && sids.includes('claude-fake-fast'), 'c) /api/status 即时列表(offlineModelList)也含缓存模型');
  ok(!sids.includes('claude-opus-4-8'), 'c) 即时列表同样无版本化硬编码型号');

  // ── d) 删除流后端半(前端行内 × 就是 POST 这两个字段) ──
  const rd = (await req(WB_PORT2, 'POST', '/api/config', { extraModels: [], knownModels: [] }, H2)).json;
  ok(rd && rd.ok, 'd) POST /api/config 清空自定义条目 ok');
  const r3 = (await req(WB_PORT2, 'GET', '/api/models', null, H2)).json;
  const ids3 = ((r3 && r3.models) || []).map(m => m.id);
  ok(!ids3.includes('my-custom') && !ids3.includes('remembered-1'), 'd) 自定义条目已删除');
  ok(ids3.includes('claude-fake-strong') && ids3.includes('claude-fake-fast'), 'd) 缓存的 API 条目不受删除影响(端点真实清单非用户数据)');
  ok(ids3.includes('') && !ids3.includes('opus'), 'd) 默认仍在,别名已移除');
} catch (e) { ok(false, '异常:' + (e && e.stack || e)); }
finally {
  kill(wb);
  try { fake.close(() => {}); } catch { /* ignore */ }
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('');
  if (fail) { console.log('CLAUDE-MODELS-CACHE E2E: FAIL (' + fail + ')'); process.exit(1); }
  console.log('CLAUDE-MODELS-CACHE E2E: ALL PASS');
}

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
