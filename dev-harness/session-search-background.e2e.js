#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 151 阶段 4A(150 S6、S7):线程搜索的全文索引改由后台建。真服务进程 + 直写数据根(与 session-search.e2e 同形)。
//   [A1] 首次非预览搜索只付词法成本:80 条待建会话(>16)时这一发不在请求里建索引、不等后台(修前要建 1.5 s 的片);
//   [A2] 后台(无人再发搜索)自己把 80 条会话 + 1 条 1 MiB 中文正文的会话全部建完,≤60 s;大会话不挡后面的会话;
//   [A3] 重启后第一发搜索直接是完整覆盖,不重建(manifest 字节不变),也不重写 state.json;
//   [A4] 语义关时盘上没有任何向量文件(150 S15)。
// 反向验证:RUYI_E2E_SERVER 指到修前的 server.js,[A1]/[A2] 必须红(修前首发要建、没人发搜索时索引不前进)。
const cp = require('node:child_process'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { ok, done } = createRunner('SESSION SEARCH BACKGROUND');
const SERVER = process.env.RUYI_E2E_SERVER ? path.resolve(process.env.RUYI_E2E_SERVER) : path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(port, route, token) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 60000, headers: token ? { 'x-wcw-token': token } : {} }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* not json */ } resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); });
    });
    req.on('error', () => resolve({ status: 0, json: null, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, ms: Date.now() - t0 }); });
  });
}
function seed(home, count) {
  const dir = path.join(home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 6, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false, semanticRetrievalV1: false }, null, 2));
  const write = (id, title, messages, at) => {
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, storageVersion: 2, title, summary: '', cwd: 'C:/work/bg', pinned: false, createdAt: at, updatedAt: at, turnSeq: 1, messageCount: messages.length, providerHistoryCount: 0, messages: [], providerHistory: [] }));
    fs.writeFileSync(path.join(dir, id + '.messages.ndjson'), messages.map(m => JSON.stringify({ ...m, createdAt: at, turnSeq: 1 })).join('\n') + '\n');
  };
  let big = '';const unit = '工作台在大文本下建立全文索引需要分片处理这是一段用于压力测量的中文正文内容。';
  while (Buffer.byteLength(big) < 1048576) big += unit;
  // 大会话排在目录的最前面(ids 排序后第一个),修前「挡住后面的会话」的位置。
  write('sess_bg0000big', '大文本线程', [{ role: 'user', content: big + ' 大文本独有词甲乙丙丁' }, { role: 'assistant', content: '收到。' }], '2026-10-01T00:00:00.000Z');
  for (let n = 1; n <= count; n++) write('sess_bg' + String(n).padStart(4, '0') + 'x', '线程 ' + n, [
    { role: 'user', content: `第 ${n} 号线程:整理回滚预案` }, { role: 'assistant', content: `好的,第 ${n} 号的回滚预案见附录。` }], '2026-10-0' + (1 + n % 8) + 'T00:00:00.000Z');
}
async function bootstrap(port) {
  return new Promise(resolve => { const req = http.request({ host: '127.0.0.1', port, path: '/api/bootstrap', method: 'POST', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': 2 } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body).token || ''); } catch { resolve(''); } }); });
    req.on('error', () => resolve('')); req.on('timeout', () => { req.destroy(); resolve(''); }); req.write('{}'); req.end(); });
}
async function start(home, env) {
  const port = await getFreePort();
  const child = cp.spawn(process.execPath, [SERVER], { cwd: path.resolve(__dirname, '..', 'ruyi-workbench'), env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KIMI_CODE_HOME: path.join(home, '.kimi'), PORT: String(port), WCW_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
  for (let n = 0; n < 400; n++) { const r = await request(port, '/health'); if (r.json) break; await sleep(150); }
  return { port, child, token: await bootstrap(port), log: () => out };
}
async function stop(server) {
  if (!server || !server.child || server.child.exitCode !== null) return;
  const exited = new Promise(resolve => server.child.once('exit', resolve));
  try { killOwnTree(server.child); } catch { /* gone */ }
  await Promise.race([exited, sleep(10000)]);
}
const manifestsOf = home => { const root = path.join(home, 'sessions', '_fulltext-index-v1'); if (!fs.existsSync(root)) return []; return fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'manifest.json'))); };
const vectorFiles = home => { const root = path.join(home, 'sessions', '_fulltext-index-v1'); if (!fs.existsSync(root)) return []; return fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'vectors.json'))); };

(async () => {
  const COUNT = 80, env = null, home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-search-bg-'));
  let server = null;
  try {
    seed(home, COUNT);
    server = await start(home, env);
    ok(Boolean(server.token), 'A0 服务起来、拿到令牌');
    const route = (q, preview) => `/api/sessions/search?q=${encodeURIComponent(q)}&limit=30${preview ? '&preview=1' : ''}`;
    const first = await request(server.port, route('回滚预案', false), server.token);
    const firstIndexed = first.json && first.json.coverage ? first.json.coverage.indexedSessions : null;
    console.log('first full search', JSON.stringify({ status: first.status, ms: first.ms, coverage: first.json && first.json.coverage }));
    ok(first.status === 200, `A1a 首次非预览搜索 200(${first.status})`);
    ok(first.json && first.json.coverage && first.json.coverage.background && typeof first.json.coverage.background.state === 'string', 'A1b 覆盖率带后台状态');
    // 墙钟上界豁免：判的是首发没有在请求里建索引(修前每发至少建 16 条,实测一发建到 43 条),与调度快慢无关
    ok(firstIndexed !== null && firstIndexed < 16, `A1c 首发不在请求里建索引(返回时已索引 ${firstIndexed}/${COUNT + 1};修前每发至少 16 条)`);
    // 首发与后台建那条 1 MiB 会话同时进行(最坏的抢占形态),耗时只记录、只设防挂死的宽界;「不在请求里建」由 A1c 判。
    // 墙钟上界豁免：界 10 s 只防挂死,失败形态是首发等后台或在请求里把 81 条全建完(修前一发要建到截止)
    ok(first.ms < 10000, `A1d 首发不挂死(${first.ms} ms;首发同时后台正在建 1 MiB 会话)`);
    // 之后不再发任何搜索:后台自己建完。
    const t0 = Date.now(); let built = 0;
    while (Date.now() - t0 < 60000) { built = manifestsOf(home).length; if (built >= COUNT + 1) break; await sleep(250); }
    const elapsed = Date.now() - t0;
    console.log('background built', built, 'in', elapsed, 'ms');
    ok(built === COUNT + 1, `A2a 无人再发搜索,后台建完全部 ${COUNT + 1} 条会话(${built} 条,${elapsed} ms)`);
    // 墙钟上界豁免：60 s 是 151 阶段 4 的验收界,低负载实得约 3.5 s,失败形态是后台不推进(修前无人搜索时永远建不完)
    ok(elapsed <= 60000, `A2b 后台建完 ≤60 s(${elapsed} ms)`);
    const settled = await request(server.port, route('回滚预案', false), server.token);
    ok(settled.json && settled.json.coverage && settled.json.coverage.complete === true, 'A2c 之后的搜索覆盖完整');
    ok(settled.json && settled.json.results && settled.json.results.length === 30, `A2d 小会话都搜得到(前 30 条,${settled.json && settled.json.results && settled.json.results.length})`);
    const bigHit = await request(server.port, route('大文本独有词甲乙丙丁', false), server.token);
    ok(bigHit.json && bigHit.json.results && bigHit.json.results.some(row => row.id === 'sess_bg0000big'), 'A2e 1 MiB 大会话本身也建成、搜得到');
    ok(bigHit.json && bigHit.json.results && bigHit.json.results.every(row => row.matchMode === 'lexical'), 'A2f 命中方式标为关键词');
    ok(vectorFiles(home).length === 0, 'A4 语义关:盘上没有向量文件');
    const before = new Map(manifestsOf(home).map(id => [id, fs.readFileSync(path.join(home, 'sessions', '_fulltext-index-v1', id, 'manifest.json'))]));
    const stateFile = path.join(home, 'sessions', '_fulltext-index-v1', 'state.json'), stateBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
    await stop(server); server = await start(home, env);
    const restarted = await request(server.port, route('回滚预案', false), server.token);
    console.log('after restart', JSON.stringify({ ms: restarted.ms, coverage: restarted.json && restarted.json.coverage }));
    ok(restarted.json && restarted.json.coverage && restarted.json.coverage.complete === true, `A3a 重启后第一发就是完整覆盖(${restarted.ms} ms)`);
    await sleep(1500);
    const unchanged = [...before].every(([id, bytes]) => { const file = path.join(home, 'sessions', '_fulltext-index-v1', id, 'manifest.json'); return fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), bytes) === 0; });
    ok(unchanged, 'A3b 重启后不重建(全部 manifest 字节不变)');
    ok(stateBefore === null || fs.existsSync(stateFile) && Buffer.compare(fs.readFileSync(stateFile), stateBefore) === 0, 'A3c 重启后的只读搜索不重写 state.json');
  } catch (error) { ok(false, 'unexpected ' + (error && error.stack || error)); }
  finally { await stop(server); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* handles */ } }
  done();
})();
