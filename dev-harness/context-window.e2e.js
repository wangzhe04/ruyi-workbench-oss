(async () => {
const { getFreePort } = require('./free-port.js');
// E2E for v1.0.2-S2「上下文窗口三级自适应」. 零依赖、离线、node 直跑。
// 解析链(优先级从高到低):manual(provider.contextWindow) > probe(/v1/models context_length, 缓存 10min)
//   > table(模型名子串对照) > fallback(65536)。
//
// 两半:
//  (a) 直接单元(require server.js, 无需起服务):
//      · contextWindowFromTable 子串命中(deepseek-v4→1M, deepseek→131072, kimi→262144, claude→200000, 无命中→undefined);
//      · extractContextLength 从 /v1/models 条目取 context_length 类字段的第一个正数;
//      · resolveContextWindow 四级优先级:①手动覆盖探测;③无探测无手动命中名称表;④全无→65536。
//  (b) 动态(起 fake-openai + workbench):
//      · FAKE_MODELS_CONTEXT_LEN=200000 → GET /api/models 每个模型带 contextLength=200000(探测生效);
//      · 探测后 GET /api/status 的 contextWindowResolved.source==='probe' 且 value===200000;
//      · 关掉 FAKE_MODELS_CONTEXT_LEN(默认)时 provider model 'fake-model' 无名称表命中 → source==='fallback' value 65536。
//  判定行:`CONTEXT-WINDOW E2E: ALL PASS`。Port 9142(fake)+9143(wb)。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const srv = require(path.join(WB, 'app', 'server.js'));



const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];

  // ── (a) 直接单元 ──────────────────────────────────────────────────────────────────────────────────
  ok(srv.contextWindowFromTable('deepseek-v4') === 1000000, '(unit) table: deepseek-v4 → 1000000');
  ok(srv.contextWindowFromTable('DeepSeek-Chat') === 131072, '(unit) table: deepseek(其余) → 131072 (大小写不敏感)');
  ok(srv.contextWindowFromTable('qwen-max') === 131072, '(unit) table: qwen → 131072');
  ok(srv.contextWindowFromTable('glm-4.6') === 131072, '(unit) table: glm → 131072');
  ok(srv.contextWindowFromTable('kimi-k2') === 262144 && srv.contextWindowFromTable('moonshot-v1') === 262144, '(unit) table: kimi/moonshot → 262144');
  ok(srv.contextWindowFromTable('gpt-4o-mini') === 128000 && srv.contextWindowFromTable('gpt-4.1') === 128000, '(unit) table: gpt-4o/gpt-4.1 → 128000');
  ok(srv.contextWindowFromTable('o3-mini') === 200000 && srv.contextWindowFromTable('o4') === 200000, '(unit) table: o3/o4 → 200000');
  ok(srv.contextWindowFromTable('claude-3-5-sonnet') === 200000, '(unit) table: claude → 200000');
  ok(srv.contextWindowFromTable('totally-unknown-model') === undefined, '(unit) table: 无命中 → undefined');

  ok(srv.extractContextLength({ context_length: 128000 }) === 128000, '(unit) extract: context_length');
  ok(srv.extractContextLength({ max_model_len: 65536 }) === 65536, '(unit) extract: max_model_len');
  ok(srv.extractContextLength({ context_window: 0, max_context_length: 262144 }) === 262144, '(unit) extract: 跳过非正数取第一个正数');
  ok(srv.extractContextLength({ foo: 1 }) === undefined, '(unit) extract: 无相关字段 → undefined');

  // resolveContextWindow 四级:
  // ① 手动覆盖探测/表:contextWindow 手动填 → source manual, 即便模型名命中表也不用表。
  const rManual = srv.resolveContextWindow({ id: 'p', model: 'claude-3', contextWindow: 500000, models: [] });
  ok(rManual.value === 500000 && rManual.source === 'manual', '(unit) resolve: 手动 contextWindow 优先(source manual)');
  // ③ 无探测无手动 → 命中名称表。
  const rTable = srv.resolveContextWindow({ id: 'p2', model: 'deepseek-chat', contextWindow: '', models: [] });
  ok(rTable.value === 131072 && rTable.source === 'table', '(unit) resolve: 无手动无探测 → 命中名称表(source table)');
  // ④ 全无 → 65536 fallback。
  const rFb = srv.resolveContextWindow({ id: 'p3', model: 'some-obscure-model', contextWindow: '', models: [] });
  ok(rFb.value === srv.CONTEXT_WINDOW_FALLBACK && rFb.value === 65536 && rFb.source === 'fallback', '(unit) resolve: 全无 → 65536 (source fallback)');

  // ② 探测生效 + 手动覆盖探测:先用 fetchOpenAiModels 填探测缓存, 再断言 resolve 命中 probe;然后加 contextWindow 手动覆盖。
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_MODELS_CONTEXT_LEN: '200000' }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  procs.push(fake);
  // 等 fake 就绪。
  for (let i = 0; i < 30; i++) { const r = await getJson(FAKE_PORT, '/v1/models'); if (r.status === 200) break; await sleep(100); }
  const prov = { id: 'fakep', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model' }] };
  const live = await srv.fetchOpenAiModels(prov, 4000);
  ok(live && live.ok && (live.models || []).some(m => m.id === 'fake-model' && m.contextLength === 200000), '(unit) fetchOpenAiModels 保留 contextLength=200000');
  const rProbe = srv.resolveContextWindow(prov, 'fake-model');
  ok(rProbe.value === 200000 && rProbe.source === 'probe', '(unit) resolve: 探测缓存命中(source probe, value 200000)');
  // 手动覆盖探测(同一 provider 加 contextWindow):
  const rManOverProbe = srv.resolveContextWindow({ ...prov, contextWindow: 999999 }, 'fake-model');
  ok(rManOverProbe.value === 999999 && rManOverProbe.source === 'manual', '(unit) resolve: 手动覆盖探测(manual 优先于 probe)');

  // ── (b) 动态:GET /api/models 带 contextLength + GET /api/status.contextWindowResolved ─────────────
  const HOME = path.join(os.tmpdir(), 'wcw-ctxwin-e2e');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fakep', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fakep',
  }, null, 2));
  const env = { ...process.env }; delete env.RUYI_HOME; env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);

    // GET /api/models → 探测生效, 每模型带 contextLength=200000。
    const models = await getJson(WB_PORT, '/api/models');
    const mlist = (models.json && models.json.models) || [];
    const fm = mlist.find(m => m.id === 'fake-model');
    ok(fm && fm.contextLength === 200000, '(b) GET /api/models: fake-model.contextLength === 200000 (探测生效)');

    // GET /api/status → contextWindowResolved.source==='probe' value 200000 (探测缓存已被 /api/models 填充)。
    const st = await getJson(WB_PORT, '/api/status');
    const cwr = st.json && st.json.contextWindowResolved;
    ok(cwr && typeof cwr === 'object', '(b) /api/status 有 contextWindowResolved 附加字段');
    ok(cwr && cwr.source === 'probe' && cwr.value === 200000, '(b) contextWindowResolved: source probe, value 200000 (got ' + (cwr && cwr.source) + '/' + (cwr && cwr.value) + ')');
    ok(cwr && cwr.provider === 'fakep' && cwr.model === 'fake-model', '(b) contextWindowResolved 回显 provider+model');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCONTEXT-WINDOW E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
