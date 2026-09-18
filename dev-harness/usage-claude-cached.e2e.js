'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E (第117波117q-B5,30号文§3 总表 P2-18): Claude 引擎两条路径此前从不写 cachedInTok —— 05-claude-engine.js
// 的两处主回合 appendUsageLedger(:943/:952 附近)与 07-autonomy.js 的 Claude 子代理 appendUsageLedger
// 都没传这个字段,用量看板「缓存输入 tokens」那一栏对 Claude 会话恒为空(06-provider-engine.js/08/09 走
// provider 侧则一直有值)。数据其实拿得到:05-claude-engine.js:761 早就在读
// usage.usage.cache_read_input_tokens / cache_creation_input_tokens(用于上下文估算),只是没塞进 ledger。
//
// 本件验证修复后 ledger/看板口径不再对 Claude 会话空缺,同时反证「费用计算不受影响」——Claude 引擎走
// CLI 自带 costUsd 计费,cache 命中数值只改变 cachedInTok,不改变 cost/currency。
//
// fake-claude.js 的新增 'cachehit' 测试缝场景(见 ruyi-workbench/tools/fake-claude.js)结果帧带
// cache_read_input_tokens:500 + cache_creation_input_tokens:100(=600),input/output/cost 与既有 'happy'
// 场景一致(812/214/0.0123 USD) —— 纯加字段,不改变任何既有场景/既有 e2e 的行为。
//
// 覆盖:
//   ① 普通(无 cachehit 关键词)Claude 主回合:ledger 行 cachedInTok 字段存在且为 0(「缺失按 0」,不是
//      undefined/NaN/字段整个不存在)——回归锁,证明此前「整个字段不写」的口径不再出现。
//   ② cachehit 主回合(05-claude-engine.js 的 appendUsageLedger,§P2-18 三处之一):cachedInTok === 600,
//      inTok/outTok/cost/currency/costTrusted 与无 cache 时完全一致(费用计算不受影响)。
//   ③ cachehit Claude 子代理(07-autonomy.js 的 appendUsageLedger,§P2-18 三处之二):同样 cachedInTok === 600。
//   ④ 下游 GET /api/usage/summary:totals.cachedInTok 与 byEngine claude 一行都反映非零缓存,
//      不再对 Claude 会话恒为空(用户可见口径的最终验收点)。
// Judgement line (exact): USAGE-CLAUDE-CACHED E2E: ALL PASS
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'wcw-usage-claude-cached-e2e');
const USAGE_DIR = path.join(HOME, 'usage');
const MONTH = new Date().toISOString().slice(0, 7);
const LEDGER = path.join(USAGE_DIR, MONTH + '.jsonl');

const CACHE_READ = 500, CACHE_CREATE = 100, CACHED_EXPECT = CACHE_READ + CACHE_CREATE; // 与 fake-claude.js 'cachehit' 场景对齐
const CL_IN = 812, CL_OUT = 214, CL_COST = 0.0123; // fake-claude.js resultEvt 的既有默认值(cache 字段是纯加项,不改这三个)

function writeConfig() {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.4.0', permissionMode: 'bypass', defaultWorkspace: HOME,
    activeProvider: '', // 空 → 无 openai provider,顶层 /api/chat/stream 走 Claude 引擎(agentCliType 默认 'claude')
    autoImportClaudeCodeMcp: false, // 117q 教训:离线 e2e 别读真实 ~/.claude.json,污染 temp-HOME
    subagentMaxConcurrent: 1,
  }, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
async function waitHealth(port) { for (let i = 0; i < 300; i++) { const h = await health(port); if (h) return h; await sleep(120); } return null; }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function reqJson(port, method, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }
function readRecs() { try { return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
const runOf = (r, runId) => r && Array.isArray(r.runs) && r.runs.find(x => x.id === runId);
const isTerminal = s => s === 'succeeded' || s === 'failed' || s === 'partial' || s === 'stopped' || s === 'cancelled';

(async () => {
  const WB_PORT = await getFreePort();
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  async function waitFor(label, fn, tries = 160, gap = 150) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } ok(false, label + ' (timed out)'); return null; }

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  writeConfig();

  // 117q(usage-subagent-ledger.e2e.js 同款教训):清空 dev 机可能带的 Anthropic 端点 env,否则
  // claudeLedgerSource 会把 costTrusted/provider 判成第三方端点,cost 断言 flake。
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_BASE: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    ok(!!(await waitHealth(WB_PORT)), 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'got workbench token');
    const hdr = { 'x-wcw-token': token };

    const created = await reqJson(WB_PORT, 'POST', '/api/sessions', { title: 'claude-cached', cwd: HOME }, hdr);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, 'created a session');

    // ① 普通主回合(无 cachehit 关键词 → fake-claude 走默认 'happy' 场景,resultEvt 无 cache 字段)。
    await postStream(WB_PORT, { sessionId: sid, message: '普通回合，不含缓存关键词', cwd: HOME });
    await waitFor('baseline turn ledger row flushed', () => readRecs().some(r => r.kind === 'turn'));
    const baseline = readRecs().find(r => r.kind === 'turn');
    ok(baseline && baseline.engine === 'claude', '① 普通主回合写了 engine:claude 的 kind:turn 行');
    ok(baseline && typeof baseline.cachedInTok === 'number' && baseline.cachedInTok === 0,
      '① cachedInTok 字段存在且为 0(「缺失按 0」，不是此前那种整个字段不写；got ' + JSON.stringify(baseline && baseline.cachedInTok) + ')');

    // ② cachehit 主回合(05-claude-engine.js 的 appendUsageLedger)。
    await postStream(WB_PORT, { sessionId: sid, message: 'cachehit 请证明缓存命中被记账', cwd: HOME });
    await waitFor('cachehit turn ledger row flushed', () => readRecs().filter(r => r.kind === 'turn').length >= 2);
    const turnRows = readRecs().filter(r => r.kind === 'turn');
    const cachedRow = turnRows.find(r => Number(r.cachedInTok) > 0);
    ok(!!cachedRow, '② 出现 cachedInTok > 0 的主回合行(共 ' + turnRows.length + ' 条 turn 行)');
    ok(cachedRow && cachedRow.cachedInTok === CACHED_EXPECT,
      '② cachedInTok === ' + CACHED_EXPECT + '(500 读 + 100 创建相加，读法与 05:761 对齐；got ' + (cachedRow && cachedRow.cachedInTok) + ')');
    const cr = cachedRow || {};
    ok(cachedRow && cr.inTok === CL_IN && cr.outTok === CL_OUT && near(cr.cost, CL_COST) && cr.currency === 'USD' && cr.costTrusted === true,
      '② 费用计算不受影响：inTok/outTok/cost/currency/costTrusted 与无缓存时的既有值一致(812/214/0.0123 USD trusted；got '
      + cr.inTok + '/' + cr.outTok + '/' + cr.cost + '/' + cr.currency + '/' + cr.costTrusted + ')');

    // ③ cachehit Claude 子代理(07-autonomy.js 的 appendUsageLedger)。
    const launched = await reqJson(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [{ id: 'cl', task: 'cachehit 请证明子代理缓存命中也被记账', engine: 'claude', toolTier: 'read' }],
    }, hdr);
    ok(launched.json && launched.json.ok === true && /^run_/.test(launched.json.runId || ''), '③ 子代理工作流已异步启动');
    const runId = launched.json && launched.json.runId;
    const run = await waitFor('③ workflow reaches a terminal state', async () => {
      const r = await getJson(WB_PORT, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r.json, runId);
      return run && isTerminal(run.status) && run;
    });
    ok(!!run, '③ 子代理工作流已终止');
    if (run) {
      const cl = (run.nodes || []).find(n => n.id === 'cl');
      ok(cl && cl.status === 'succeeded', '③ claude 子代理节点成功(status ' + (cl && cl.status) + ')');
    }
    await waitFor('③ subagent ledger row flushed', () => readRecs().some(r => r.kind === 'subagent'));
    const subRow = readRecs().find(r => r.kind === 'subagent' && r.engine === 'claude');
    ok(!!subRow, '③ 出现 kind:subagent 且 engine:claude 的 ledger 行');
    ok(subRow && subRow.cachedInTok === CACHED_EXPECT,
      '③ 子代理行 cachedInTok === ' + CACHED_EXPECT + '(got ' + (subRow && subRow.cachedInTok) + ')');
    const sr = subRow || {};
    ok(subRow && sr.inTok === CL_IN && sr.outTok === CL_OUT && near(sr.cost, CL_COST),
      '③ 子代理行费用计算同样不受影响(812/214/0.0123；got ' + sr.inTok + '/' + sr.outTok + '/' + sr.cost + ')');

    // ④ 下游 /api/usage/summary:看板口径不再对 Claude 会话恒为空。
    const sum = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json;
    ok(sum && sum.ok === true && sum.totals, '④ summary ok:true');
    ok(sum && Number(sum.totals.cachedInTok) === CACHED_EXPECT * 2,
      '④ totals.cachedInTok 汇总两行缓存命中之和(' + (CACHED_EXPECT * 2) + '，got ' + (sum && sum.totals && sum.totals.cachedInTok) + ')');
    const engClaude = sum && sum.byEngine.find(e => e.engine === 'claude');
    ok(engClaude && Number(engClaude.cachedInTok) > 0,
      '④ byEngine claude 一行 cachedInTok > 0(此前对 Claude 会话恒为空的那一栏；got ' + (engClaude && engClaude.cachedInTok) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    killp(wb);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nUSAGE-CLAUDE-CACHED E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
