(async () => {
// E2E (108c): 只读原生工具 workbench_self_status —— 自身运行时详情。
// 覆盖:
//   (a) 身份字段与 108a buildRuntimeIdentityFacts 同源:version 与 package.json 一致、instanceId 与
//       /api/status 的 overlayId 一致、dataDir 与临时 HOME 一致、address 以 http://127.0.0.1: 开头。
//   (b) counts.nativeTools === 63(第 62 波起注册表工具数;本波 62→63)。
//   (c) config 段只回显白名单标量字段 —— fixture provider 带假密钥 sk-test-SECRETVALUE,整段序列化结果
//       不得出现该密钥子串或 apiKey 字段名(F2 纪律:绝不回显密钥材料)。
//   (d) section:'identity' 只返回身份字段,不含 health/counts/config。
//   (e) section:'health'/'counts'/'config' 各自只返回对应段 + 身份字段。
//   (f) 注册表侧:tier=read、pack=core(经 require(server.js) 直读 NATIVE_TOOL_TIER/NATIVE_TOOL_PACKS)。
// 全程离线,临时 HOME + 健康轮询 + finally taskkill 清理,PASS/FAIL 逐条,exit(fail?1:0)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-self-status-e2e');
const FAKE_KEY = 'sk-test-SECRETVALUE12345';
const WB_PORT = await getFreePort();

// require(server.js) 不启动服务(14-main.js require.main===module 门控);仅用于直读注册表元数据。
const S = require(SERVER);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
// POST /api/tools/workbench_self_status,返回内层 .result。
async function selfStatus(port, token, sid, extra) {
  const body = sid ? { sessionId: sid, ...(extra || {}) } : { ...(extra || {}) };
  const r = await postJson(port, '/api/tools/workbench_self_status', body, { 'x-wcw-token': token });
  return r.body && r.body.result;
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  // fixture: 一个带假密钥的 openai-compat provider,作为激活端点 —— 用来断言 config 段绝不回显密钥材料。
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 11, version: '2.6.2', permissionMode: 'bypass', outputStyle: 'concise', locale: 'zh-CN',
    providers: [{ id: 'p1', label: 'Test Provider', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: FAKE_KEY, model: 'test-model' }],
    activeProvider: 'p1',
  }, null, 2));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'self-status', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // ── 注册表侧:tier/pack(独立进程内直读,不走 HTTP)──
    ok(S.NATIVE_TOOL_TIER && S.NATIVE_TOOL_TIER.workbench_self_status === 'read', 'tier: workbench_self_status = read');
    ok(S.NATIVE_TOOL_PACKS && S.NATIVE_TOOL_PACKS.workbench_self_status === 'core', 'pack: workbench_self_status = core');
    ok(S.TOOL_HANDLERS && typeof S.TOOL_HANDLERS.workbench_self_status === 'object', '注册表含 workbench_self_status 条目');

    // ── package.json 版本三角(与 facts.static 同一口径)──
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'package.json'), 'utf8'));

    // ── /api/status 作对照(overlayId)──
    const status = await getJson(WB_PORT, '/api/status', { 'x-wcw-token': token });
    ok(status.status === 200 && status.body && status.body.ok === true, '/api/status 可用作对照');
    const overlayId = status.body.overlayId;
    ok(!!overlayId, '/api/status 返回 overlayId');

    // ── (a)(b)(c) 默认(section 省略 = all)──
    {
      const r = await selfStatus(WB_PORT, token, sid);
      ok(r && r.ok === true, 'workbench_self_status(all): ok:true');
      ok(r && r.app === '如意 Ruyi', 'app 字段为产品名');
      ok(r && r.version === pkg.version, `version(${r && r.version}) === package.json(${pkg.version})`);
      ok(r && r.launchMode === 'node', `launchMode(${r && r.launchMode}) = node(源码模式,e2e 非 pkg 打包)`);
      ok(r && r.instanceId === overlayId, `instanceId(${r && r.instanceId}) === /api/status overlayId(${overlayId})`);
      ok(r && r.dataDir === HOME, `dataDir(${r && r.dataDir}) === 临时 HOME(${HOME})`);
      ok(r && typeof r.address === 'string' && r.address.startsWith('http://127.0.0.1:'), `address(${r && r.address}) 以 http://127.0.0.1: 开头`);
      ok(r && r.address === `http://127.0.0.1:${WB_PORT}`, `address 端口与实际监听端口一致(${WB_PORT})`);

      ok(r && Array.isArray(r.health) && r.health.length > 0, `health[] 非空(${r && r.health && r.health.length} 项)`);
      ok(r && r.health.every(x => typeof x.id === 'string' && typeof x.ok === 'boolean'), 'health[] 每项含 id/ok');

      ok(r && r.counts && r.counts.nativeTools === 63, `counts.nativeTools === 63(got ${r && r.counts && r.counts.nativeTools})`);
      ok(r && r.counts && Number.isInteger(r.counts.accTools) && r.counts.accTools >= 0, 'counts.accTools 为非负整数');
      ok(r && r.counts && Number.isInteger(r.counts.skills) && r.counts.skills >= 0, 'counts.skills 为非负整数');
      ok(r && r.counts && Number.isInteger(r.counts.commands) && r.counts.commands >= 0, 'counts.commands 为非负整数');
      ok(r && r.counts && Number.isInteger(r.counts.playbooks) && r.counts.playbooks >= 0, 'counts.playbooks 为非负整数');
      ok(r && r.counts && Number.isInteger(r.counts.workflows) && r.counts.workflows > 0, `counts.workflows > 0(内置模板,got ${r && r.counts && r.counts.workflows})`);

      ok(r && r.config && r.config.engine === 'openai', `config.engine(${r && r.config && r.config.engine}) = openai(fixture 激活 openai-compat provider)`);
      ok(r && r.config && r.config.providerId === 'p1', 'config.providerId = fixture provider id');
      ok(r && r.config && r.config.providerLabel === 'Test Provider', 'config.providerLabel = fixture provider label');
      ok(r && r.config && r.config.model === 'test-model', 'config.model = fixture provider model');
      ok(r && r.config && r.config.permissionMode === 'bypass', 'config.permissionMode 回显 fixture 值');
      ok(r && r.config && r.config.outputStyle === 'concise', 'config.outputStyle 回显 fixture 值');
      ok(r && r.config && r.config.locale === 'zh-CN', 'config.locale 回显 fixture 值');

      // F2: config 段绝不回显密钥材料 —— 对整份结果的序列化文本做黑名单扫描。
      const serialized = JSON.stringify(r);
      ok(!serialized.includes(FAKE_KEY), '序列化结果不含 fixture 假密钥原文');
      ok(!/SECRET/i.test(serialized), '序列化结果不含 SECRET 子串');
      ok(!/apiKey/i.test(serialized), '序列化结果不含 apiKey 字段名');
      ok(!/\bsk-/.test(serialized), '序列化结果不含 sk- 前缀');
      ok(!/\btoken\b/i.test(serialized), '序列化结果不含 token 字段/子串');
    }

    // ── (d) section:'identity' 只含身份字段 ──
    {
      const r = await selfStatus(WB_PORT, token, sid, { section: 'identity' });
      const keys = Object.keys(r || {}).sort();
      const expected = ['address', 'app', 'dataDir', 'instanceId', 'installDir', 'launchMode', 'ok', 'version'].sort();
      ok(JSON.stringify(keys) === JSON.stringify(expected), `section:'identity' 键集精确为身份字段(got ${keys.join(',')})`);
      ok(!('health' in r) && !('counts' in r) && !('config' in r), `section:'identity' 不含 health/counts/config`);
    }

    // ── (e) section:'health' / 'counts' / 'config' 各自只带对应段 ──
    {
      const rh = await selfStatus(WB_PORT, token, sid, { section: 'health' });
      ok(rh && Array.isArray(rh.health) && rh.health.length > 0, `section:'health' 含 health[]`);
      ok(!('counts' in rh) && !('config' in rh), `section:'health' 不含 counts/config`);

      const rc = await selfStatus(WB_PORT, token, sid, { section: 'counts' });
      ok(rc && rc.counts && rc.counts.nativeTools === 63, `section:'counts' 含 counts.nativeTools=63`);
      ok(!('health' in rc) && !('config' in rc), `section:'counts' 不含 health/config`);

      const rcfg = await selfStatus(WB_PORT, token, sid, { section: 'config' });
      ok(rcfg && rcfg.config && rcfg.config.engine === 'openai', `section:'config' 含 config.engine`);
      ok(!('health' in rcfg) && !('counts' in rcfg), `section:'config' 不含 health/counts`);
      const serializedCfg = JSON.stringify(rcfg);
      ok(!serializedCfg.includes(FAKE_KEY) && !/SECRET/i.test(serializedCfg), `section:'config' 同样不回显密钥`);
    }

    // ── 未知/非法 section 回落 'all'(与 schema enum 之外的宽容默认一致)──
    {
      const r = await selfStatus(WB_PORT, token, sid, { section: 'bogus' });
      ok(r && r.counts && r.config && Array.isArray(r.health), `非法 section 回落 all(仍含 counts/config/health)`);
    }

  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    killp(wb);
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nWORKBENCH-SELF-STATUS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
