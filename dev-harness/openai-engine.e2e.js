require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
﻿// E2E: start a fake OpenAI-compatible server, start the REAL workbench with a config whose
// activeProvider points at it, then drive /api/chat/stream and /api/models. Fully offline.
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort(); // 自内层 IIFE 提升:顶层 fixture 也要用(9642e26 codemod 事故修复)

const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-openai-e2e');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const config = {
  configSchema: 4,
  version: '1.0.0',
  permissionMode: 'bypass',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key',
    model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], reasoning: true,
    // 124 走查②（用户 2026-09-14「现在似乎没法在列表里删掉特定的模型了」）：provider 那一组删一行
    // = 把 id 记进 hiddenModels。fake-openai 的 live /models 永远返回 fake-model 与 fake-reasoner，
    // 于是这一条正好钉住「服务端在合并点挡掉，↻ 刷新不会把刚删的那一行还回来」。
    hiddenModels: ['fake-reasoner'],
  }],
  activeProvider: 'fake',
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    ok(h && h.version === require(require('path').resolve(__dirname,'..','ruyi-workbench','package.json')).version, 'version === package.json (got ' + (h && h.version) + ')'); // 第23波: 动态读

    const models = await getJson(WB_PORT, '/api/models').catch(e => ({ error: e.message }));
    ok(models && models.engine === 'openai', 'GET /api/models engine=openai (got ' + (models && models.engine) + ')');
    ok(models && Array.isArray(models.models) && models.models.some(m => m.id === 'fake-model'), 'models include fake-model');
    ok(models && models.proxyCount >= 1, 'live /models fetched (proxyCount=' + (models && models.proxyCount) + ')');
    // 上一条先证明 live 真的到货（否则「清单里没有 fake-reasoner」只是「没发现」），这一条才问得成：
    // providers[].hiddenModels 里的那一个必须被合并点挡掉 —— 线程头模型菜单删掉的行，↻ 刷新不回来。
    ok(models && Array.isArray(models.models) && !models.models.some(m => m.id === 'fake-reasoner'),
      'GET /api/models 跳过 providers[].hiddenModels（live 仍返回它，但删过的那行不该被刷新还回来）');

    const events = await postStream(WB_PORT, { message: 'hi there' });
    const types = events.map(e => e.type);
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const think = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
    const usage = events.find(e => e.type === 'usage');
    const result = events.find(e => e.type === 'result');
    const meta = events.find(e => e.type === 'meta');
    ok(/Hello, world/.test(text), 'assistant text streamed ("' + text.slice(0, 40) + '")');
    ok(/think about/.test(think), 'reasoning streamed ("' + think.slice(0, 40) + '")');
    ok(usage && usage.contextTokens === 57, 'usage.contextTokens=57 (got ' + (usage && usage.contextTokens) + ')');
    ok(result && result.ok === true, 'result ok=true');
    ok(meta && meta.engine === 'openai', 'meta.engine=openai');
    ok(types.includes('process'), 'process events present');

    // second turn should keep history (providerHistory grows); just assert it still streams ok
    const events2 = await postStream(WB_PORT, { message: 'again', sessionId: (events.find(e => e.type === 'session') || {}).session?.id });
    const text2 = events2.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(/Hello, world/.test(text2), 'second turn streams ("' + text2.slice(0, 30) + '")');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }
    await sleep(300);
    console.log('\nOPENAI-ENGINE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
