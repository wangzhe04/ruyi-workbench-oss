'use strict';
/*
 * E2E (第118波 118a): 欢迎向导的服务端契约: 只加,不改现有语义。
 *
 *   ① 全新 HOME 起服务 -> GET /api/status 的 config.onboarding 是加法默认 null(未 bump CONFIG_SCHEMA)。
 *   ② POST /api/config {onboarding:{completedAt,version:1,skipped:false}} 落盘并可读回(「完成」路径)。
 *   ③ 「以后再说」变体 {completedAt:null,skipped:true} 同样落盘可读回。
 *   ④ 非法形状被 normalizeConfig 收敛:字符串/数组 -> null;脏对象 -> 只留三字段且类型收紧,额外键被丢弃。
 *   ⑤ locale 往返:合法值落盘,非法值回落 'auto'(向导第 1 步依赖这条)。
 *   ⑥ POST /api/provider/test:对 fake-openai 成功 -> {ok:true, models[]};对 401 端点 -> errorClass
 *      provider_misconfigured + 中文人话;对不可达端点 -> errorClass network_down。
 *
 * 全离线。判定行:`ONBOARDING E2E: ALL PASS`。
 */
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-onboarding-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

let PORT = 0;
let TOKEN = '';
function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}),
      ...headers,
    };
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, timeout: 15000, headers: h }, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* non-JSON */ } resolve({ status: res.statusCode, json, raw }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
    if (data) req.write(data);
    req.end();
  });
}
async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}
const configNow = async () => (await request('GET', '/api/status')).json.config;

// 401 端点桩:GET /v1/models 一律回 401。fake-openai.js 的 /models 恒 200,不适合驱动「密钥错」路径,
// 而这条正是首跑最高频故障 : 用一个本地桩把它钉住,不改共享夹具。
function unauthorizedStub(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  PORT = await getFreePort();
  const FAKE_PORT = await getFreePort();
  const DENY_PORT = await getFreePort();
  const DEAD_PORT = await getFreePort(); // 拿到就不监听 -> 保证不可达

  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const denyServer = await unauthorizedStub(DENY_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    ok(await up(), 'workbench listening on :' + PORT);
    const boot = await request('POST', '/api/bootstrap', {});
    TOKEN = (boot.json && boot.json.token) || '';
    ok(boot.status === 200 && !!TOKEN, '① bootstrap 换到 token(写配置的路由是 token 级)');

    // ① 加法默认
    const fresh = await configNow();
    ok(Object.prototype.hasOwnProperty.call(fresh, 'onboarding') && fresh.onboarding === null,
      '① 全新安装 config.onboarding === null(加法默认,未完成也未跳过)');
    const schemaBefore = fresh.configSchema;

    // ② 完成路径
    const completedAt = new Date().toISOString();
    const save = await request('POST', '/api/config', { onboarding: { completedAt, version: 1, skipped: false } });
    ok(save.status === 200 && save.json && save.json.config, '② POST /api/config 接受 onboarding 补丁');
    const afterComplete = await configNow();
    ok(afterComplete.onboarding
      && afterComplete.onboarding.completedAt === completedAt
      && afterComplete.onboarding.version === 1
      && afterComplete.onboarding.skipped === false,
    '② 完成记录原样读回 {completedAt,version:1,skipped:false}');
    ok(afterComplete.configSchema === schemaBefore, '② CONFIG_SCHEMA 未被本波 bump');
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(onDisk.onboarding && onDisk.onboarding.completedAt === completedAt, '② 记录真的落到 config.json(重启后可复现)');

    // ③ 以后再说
    await request('POST', '/api/config', { onboarding: { completedAt: null, version: 1, skipped: true } });
    const afterSkip = await configNow();
    ok(afterSkip.onboarding && afterSkip.onboarding.skipped === true && afterSkip.onboarding.completedAt === null,
      '③ 「以后再说」记录读回 {completedAt:null,skipped:true}');

    // ④ 非法形状收敛
    await request('POST', '/api/config', { onboarding: 'yes-i-am-done' });
    ok((await configNow()).onboarding === null, '④ 字符串 -> null');
    await request('POST', '/api/config', { onboarding: [1, 2, 3] });
    ok((await configNow()).onboarding === null, '④ 数组 -> null');
    await request('POST', '/api/config', { onboarding: { completedAt: 12345, version: 'nine', skipped: 'yes', extra: 'smuggled' } });
    const dirty = (await configNow()).onboarding;
    ok(dirty && dirty.completedAt === null && dirty.version === 0 && dirty.skipped === false,
      '④ 脏对象类型收紧(非字符串时间 -> null;非数字版本 -> 0;非 true 的 skipped -> false)');
    ok(dirty && Object.keys(dirty).sort().join(',') === 'completedAt,skipped,version', '④ 额外键被丢弃(只留三字段)');
    await request('POST', '/api/config', { onboarding: { completedAt: 'x'.repeat(200), version: 99999, skipped: true } });
    const clamped = (await configNow()).onboarding;
    ok(clamped.completedAt.length === 64 && clamped.version === 1000, '④ 超长时间串截断到 64、版本号 clamp 到 1000');

    // ⑤ locale 往返(向导第 1 步)
    await request('POST', '/api/config', { locale: 'en-US' });
    ok((await configNow()).locale === 'en-US', '⑤ locale 合法值往返');
    await request('POST', '/api/config', { locale: 'fr-FR' });
    ok((await configNow()).locale === 'auto', '⑤ locale 非法值回落 auto');
    await request('POST', '/api/config', { locale: 'zh-CN' });

    // ⑥ 测试连接三态
    const good = await request('POST', '/api/provider/test', {
      provider: { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'sk-test-key-value', model: 'fake-model' },
    });
    ok(good.status === 200 && good.json && good.json.ok === true && Array.isArray(good.json.models) && good.json.models.length >= 1,
      '⑥ 可用端点 -> {ok:true} 且回模型清单(向导据此让用户挑模型)');
    const denied = await request('POST', '/api/provider/test', {
      provider: { id: 'deny', label: 'Deny', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + DENY_PORT, apiKey: 'sk-wrong-key-value', model: 'x' },
    });
    ok(denied.json && denied.json.ok !== true && denied.json.errorClass === 'provider_misconfigured',
      '⑥ 密钥错(401) -> errorClass provider_misconfigured');
    // 服务端把错误字符串包成 {code,params,message} 信封,向导的 errorMessageOf() 两种形状都读。
    const deniedMessage = typeof (denied.json && denied.json.error) === 'string' ? denied.json.error : ((denied.json && denied.json.error && denied.json.error.message) || '');
    ok(/[一-鿿]/.test(deniedMessage) && deniedMessage.includes('401'),
      '⑥ 401 错误是中文人话且保留原始状态码(向导直接展示,不自造诊断)');
    const dead = await request('POST', '/api/provider/test', {
      provider: { id: 'dead', label: 'Dead', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + DEAD_PORT, apiKey: 'sk-any-key-value', model: 'x' },
    });
    ok(dead.json && dead.json.ok !== true && dead.json.errorClass === 'network_down',
      '⑥ 不可达端点 -> errorClass network_down');

    // 保存 provider 并设为活动引擎(向导第 3 步的落盘路径)
    await request('POST', '/api/config', {
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'sk-test-key-value', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
      activeProvider: 'fake',
    });
    const withProvider = await configNow();
    ok(withProvider.activeProvider === 'fake' && (withProvider.providers || []).length === 1,
      '⑥ 向导保存的 provider 成为活动端点');
    ok(String(((withProvider.providers || [])[0] || {}).apiKey || '').includes('•'),
      '⑥ 读回时密钥仍被遮盖(向导界面拿不到明文)');
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
  } finally {
    try { wb.kill(); } catch { /* already gone */ }
    try { fake.kill(); } catch { /* already gone */ }
    try { denyServer.close(); } catch { /* already closed */ }
  }

  console.log('\nONBOARDING E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
