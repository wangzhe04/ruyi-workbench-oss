#!/usr/bin/env node
'use strict';

// 113b: 会话内容搜索的第一件 e2e。
//
// 摸底时这条路径【一件测试都没有】—— 侧栏搜索是纯前端子串过滤,只看 title/summary/cwd,
// 会话正文一个字都不查。本件同时补上「新端点」与「此前没有的现状覆盖」两件事。
//
// 夹具直接往数据目录写会话 head + messages.ndjson,不走真实回合:本件要验的是索引与检索,
// 不是引擎。这样也让「正文里有什么」完全可控(脱敏断言需要一个确定的假密钥)。

(async () => {
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-session-search-e2e');
const HOME_OFF = path.join(os.tmpdir(), 'ruyi-session-search-e2e-off');
const PORT = await getFreePort();
const PORT_OFF = await getFreePort();

let failed = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failed += 1; console.error('FAIL ' + label); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kill(child) { if (child && child.pid) { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

function get(port, route, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 8000, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}
function post(port, route, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = '';
      res.on('data', chunk => { out += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(raw); req.end();
  });
}
async function up(port) { for (let i = 0; i < 80; i++) { const r = await get(port, '/health'); if (r.json) return true; await sleep(150); } return false; }
function isolatedEnv(home) {
  return { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KIMI_CODE_HOME: path.join(home, '.kimi') };
}

// ── 夹具:直接写会话文件 ────────────────────────────────────────────────────────────────────
const FAKE_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345';
const SESSIONS = [
  {
    id: 'sess-alpha', title: '无关标题甲', summary: '', cwd: 'C:/work/alpha',
    messages: [
      { role: 'user', content: '帮我把导出的 CSV 加上 BOM,Excel 打开老是乱码' },
      { role: 'assistant', content: '已经在导出函数里补了 UTF-8 BOM,再导一次试试。' },
    ],
  },
  {
    id: 'sess-beta', title: '无关标题乙', summary: '', cwd: 'C:/work/beta',
    messages: [
      { role: 'user', content: '把 powershell 脚本里的多行字符串改成 here-string' },
      { role: 'assistant', content: '改好了,单引号 here-string 不会展开变量。' },
    ],
  },
  {
    id: 'sess-gamma', title: '无关标题丙', summary: '', cwd: 'C:/work/gamma',
    messages: [
      { role: 'user', content: `这是我的密钥 ${FAKE_KEY},帮我配置一下 provider 的超时时间` },
      { role: 'assistant', content: 'provider 超时已经设成 60 秒,首字节 20 秒。' },
    ],
  },
  {
    id: 'sess-delta', title: '无关标题丁', summary: '', cwd: 'C:/work/delta',
    messages: [
      { role: 'user', content: '灰度发布应该放多少流量' },
      { role: 'assistant', content: '先放 10%,观察一小时再全量。' },
    ],
  },
];

function seed(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false,
  }, null, 2));
  SESSIONS.forEach((fixture, index) => {
    const updatedAt = `2026-09-0${index + 1}T00:00:00.000Z`;
    fs.writeFileSync(path.join(home, 'sessions', `${fixture.id}.json`), JSON.stringify({
      id: fixture.id, storageVersion: 2, title: fixture.title, summary: fixture.summary, cwd: fixture.cwd,
      pinned: false, createdAt: updatedAt, updatedAt, turnSeq: 1,
      messageCount: fixture.messages.length, providerHistoryCount: 0, messages: [], providerHistory: [],
    }, null, 2));
    fs.writeFileSync(path.join(home, 'sessions', `${fixture.id}.messages.ndjson`),
      fixture.messages.map(m => JSON.stringify({ ...m, createdAt: updatedAt, turnSeq: 1 })).join('\n') + '\n');
  });
}

seed(HOME);
seed(HOME_OFF);
fs.writeFileSync(path.join(HOME_OFF, 'config.json'), JSON.stringify({
  configSchema: 6, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false,
  sessionSearchIndexV1: false,
}, null, 2));

const server = cp.spawn(process.execPath, [path.join(WB, 'app', 'server.js')],
  { env: { ...isolatedEnv(HOME), PORT: String(PORT), WCW_NO_BROWSER: '1' }, cwd: WB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
const serverOff = cp.spawn(process.execPath, [path.join(WB, 'app', 'server.js')],
  { env: { ...isolatedEnv(HOME_OFF), PORT: String(PORT_OFF), WCW_NO_BROWSER: '1' }, cwd: WB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
serverOff.stdout.on('data', () => {});
serverOff.stderr.on('data', () => {});

try {
  ok(await up(PORT), 'S0 工作台已启动(开关默认开)');
  ok(await up(PORT_OFF), 'S0b 第二实例已启动(开关显式关)');
  const token = (await post(PORT, '/api/bootstrap', {}))?.token;
  const tokenOff = (await post(PORT_OFF, '/api/bootstrap', {}))?.token;
  ok(typeof token === 'string' && token.length > 0, 'S1 取到工作台 token');
  const auth = { 'x-wcw-token': token };

  // ── A 鉴权与入参 ──────────────────────────────────────────────────────────────────────────
  const noToken = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('乱码'));
  ok(noToken.status === 403, `A1 无 token -> 403(实得 ${noToken.status})`);

  const short = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('乱'), auth);
  ok(short.json && short.json.ok === true && Array.isArray(short.json.results) && short.json.results.length === 0
    && short.json.reason === 'query_too_short',
    'A2 查询短于 2 字符 -> 空结果 + 明确原因(不是报错)');

  // ── B 正文命中:这四条会话的 title/summary/cwd 里都没有查询词,只有正文里有 ───────────────
  const bom = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('Excel 乱码'), auth);
  const bomIds = (bom.json?.results || []).map(r => r.id);
  ok(bom.json?.ok === true && bomIds[0] === 'sess-alpha',
    `B1 只在正文里出现的词能命中且排第一(实得 ${JSON.stringify(bomIds)})`);
  ok((bom.json?.results?.[0]?.snippet || '').includes('乱码'),
    'B2 结果带正文摘录(命中词落在摘录里)');

  const hereString = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('here-string'), auth);
  ok((hereString.json?.results || [])[0]?.id === 'sess-beta', 'B3 ASCII 词命中正文');

  const canary = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('流量 观察'), auth);
  ok((canary.json?.results || []).some(r => r.id === 'sess-delta'), 'B4 多词查询命中');

  // 拼写漂移:词法子串必然落空,靠向量层的 3-gram 兜回来
  const typo = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('powersell here string'), auth);
  ok((typo.json?.results || []).some(r => r.id === 'sess-beta'),
    `B5 拼写漂移(powersell)仍能命中(实得 ${JSON.stringify((typo.json?.results || []).map(r => r.id))})`);

  // ── C 脱敏:正文里粘过的密钥不能因为"搜了一下"就漏出去 ─────────────────────────────────
  const secret = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('provider 超时'), auth);
  const secretBody = JSON.stringify(secret.json || {});
  ok((secret.json?.results || []).some(r => r.id === 'sess-gamma'), 'C1 含密钥的会话本身能被搜到');
  ok(!secretBody.includes(FAKE_KEY), 'C2 响应里不含明文密钥(摘录过 redact,与 /api/audit 同一条脱敏路径)');

  // ── D 索引落盘与增量 ──────────────────────────────────────────────────────────────────────
  const indexPath = path.join(HOME, 'sessions', '_search-index-v1.json');
  ok(fs.existsSync(indexPath), 'D1 索引文件已落盘');
  const index1 = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  // 工作台首次启动会自己建一条空会话，所以不能硬碰夹具数量 ——
  // 对账口径是“与 /api/sessions 列出的会话一一对应”。
  const listed = (await get(PORT, '/api/sessions', auth)).json?.sessions || [];
  ok(index1.version === 1 && Object.keys(index1.entries).length === listed.length,
    `D2 索引版本 1 且与会话列表一一对应(索引 ${Object.keys(index1.entries || {}).length} 条 / 列表 ${listed.length} 条)`);
  ok(SESSIONS.every(fixture => fixture.id in index1.entries), 'D2b 四条夹具会话全在索引里');
  ok(Object.values(index1.entries).every(entry => typeof entry.unit === 'string' && entry.unit.length <= 4096),
    'D3 每条检索单元不超过 4KB 上限');

  // 改一条会话的正文与 updatedAt -> 只有它的 stamp 变
  const betaHead = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'sess-beta.json'), 'utf8'));
  betaHead.updatedAt = '2026-09-09T00:00:00.000Z';
  betaHead.messageCount = 3;
  fs.writeFileSync(path.join(HOME, 'sessions', 'sess-beta.json'), JSON.stringify(betaHead, null, 2));
  fs.appendFileSync(path.join(HOME, 'sessions', 'sess-beta.messages.ndjson'),
    JSON.stringify({ role: 'user', content: '再加一条:顺便把编码统一成 UTF-8 无 BOM', createdAt: betaHead.updatedAt, turnSeq: 2 }) + '\n');
  fs.rmSync(path.join(HOME, 'sessions', 'index.json'), { force: true }); // 强制 listSessions 重扫,读到新的 head
  await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('编码统一'), auth);
  const index2 = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const changedIds = Object.keys(index2.entries).filter(id => index2.entries[id].stamp !== index1.entries[id]?.stamp);
  ok(changedIds.length === 1 && changedIds[0] === 'sess-beta',
    `D4 只有被改动的会话重建了检索单元(实得 ${JSON.stringify(changedIds)})`);
  const afterEdit = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('无 BOM 编码统一'), auth);
  ok((afterEdit.json?.results || []).some(r => r.id === 'sess-beta'), 'D5 新追加的正文立刻可搜到');

  // 索引损坏 -> 全量重建,不影响本次搜索
  fs.writeFileSync(indexPath, '{ this is not json');
  const afterCorrupt = await get(PORT, '/api/sessions/search?q=' + encodeURIComponent('here-string'), auth);
  ok((afterCorrupt.json?.results || [])[0]?.id === 'sess-beta', 'D6 索引损坏时自动重建,搜索结果不受影响');
  ok(JSON.parse(fs.readFileSync(indexPath, 'utf8')).version === 1, 'D7 损坏的索引已被重写为合法版本');

  // ── E 上限与形状 ──────────────────────────────────────────────────────────────────────────
  const limited = await get(PORT, '/api/sessions/search?limit=1&q=' + encodeURIComponent('一下'), auth);
  ok((limited.json?.results || []).length <= 1, 'E1 limit 生效');
  const shape = (bom.json?.results || [])[0] || {};
  ok(['id', 'title', 'cwd', 'updatedAt', 'pinned', 'messageCount', 'score', 'snippet'].every(key => key in shape),
    `E2 结果字段齐全(实得 ${Object.keys(shape).join(',')})`);

  // ── F 开关显式关 ──────────────────────────────────────────────────────────────────────────
  const off = await get(PORT_OFF, '/api/sessions/search?q=' + encodeURIComponent('here-string'), { 'x-wcw-token': tokenOff });
  // 错误体有两种形状:裸字符串,或被统一错误信封包成 {code,message,params}。
  // 118 波在 help.doc_missing 上栓过这一下(只判裸字符串 -> 恒假 -> 界面直接印 [object Object]),
  // 所以这里两种形状都接受；前端也只看 ok 不看 error 形状，任何一种都会回退子串过滤。
  const offError = off.json && (typeof off.json.error === 'string' ? off.json.error : off.json.error?.code);
  ok(off.json && off.json.ok === false && offError === 'session_search.disabled',
    `F1 显式关闭时端点明确回「已关闭」(实得 ${JSON.stringify(off.json)})`);
  ok(!fs.existsSync(path.join(HOME_OFF, 'sessions', '_search-index-v1.json')),
    'F2 关闭时不建索引(零新增持久化面)');
} finally {
  kill(server);
  kill(serverOff);
}

console.log(`SESSION SEARCH E2E: ${failed ? 'FAIL (' + failed + ')' : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
})();
