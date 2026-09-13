require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
'use strict';
// E2E(第122波 §2.4):mission start 与首回合的写口竞争。
//
// 用户触发:管家开线程后立刻派第一回合,再 POST /api/mission {action:'start'}。
// 病根:/api/mission 落盘后只在 activeChildren.get(sessionId) 命中时才把 mission 同步进活回合内存(C4);
//   09-workflow 从「路由把会话读进内存」到「activeChildren.set(reg)」之间隔着 providerHistory 同步、
//   配对/参数自愈、turnSeq 落盘、onTurnStart 钩子与 captureWorkspaceTurnBaseline —— 落在这一段里的 start
//   已经写进磁盘却谁也同步不进回合内存,回合收尾 saveSession(内存 session)把整本账本盖回「没有」。
// 修法:回合收尾落盘前做落盘前合并(02 的 mergeMissionBeforeSave,三个引擎共用)。
//
// 判据(§2.4):`POST /api/chat/stream` 之后 0／50／200 ms 三个时点各发一次 start,回合结束后
//   `GET /api/sessions/:id` 的 mission.milestones 非空、startedTurnSeq 与 start 那一刻 API 自己回的
//   那个值逐字相等(账本被原样保住,不是被另一本顶掉)、kind 仍是 'mission';每时点 5 轮全绿。
//
// 为什么用 provider 引擎而不是 fake-claude 的 WCW_FAKE_SLOW_MS:05-claude-engine 与 05b-kimi-bridge 的
// 收尾【本来就】回读磁盘 mission(它们的 mission_update 走 MCP 子进程 loopback 落盘),这条竞态在那两路
// 天然不成立,拿它们测只会永远绿。真正漏的是 09(provider 引擎 in-process 改内存、收尾整份覆盖),
// 所以这里用一个「慢回合」的 fake provider 把窗口撑开。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-mission-start-race-e2e');
const WORK = path.join(HOME, 'workspace');
const WB_PORT = 8730;        // 本件固定端口(端口审计:跨文件零撞车)
const PROVIDER_PORT = 8731;
const SLOW_MS = 700;         // 慢回合:每个时点的 start 都必须落在回合【里面】(provider 约 40 ms 时被联系上)
// 号文 §2.4 点名 0／50／200 三个时点;10／25 是本件实测加出来的两个【真窗口内】时点 ——
// 本机探针量到:回合起跑那一存(turnSeq 落盘)与 activeChildren.set 都发生在 chat 请求后 ≈39 ms,
// 两者相距 <3 ms。也就是说 50／200 ms 的 start 早已被 C4 同步接住(压根不进竞态),真正危险的是
// 「路由把会话读进内存 → 起跑那一存」这 0–39 ms;10／25 落在它中间,是这条竞态最灵敏的探针。
const TIMINGS = [0, 10, 25, 50, 200];
const ROUNDS = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function requestJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
// 117q-P1-31/32/33 同款等待预算(冷启动实测 4.6-6.3 s;/health 200 不蕴含 runtime.json 已落盘)。
async function waitHealth(port) {
  for (let i = 0; i < 300; i++) { const r = await requestJson(port, '/health', null).catch(() => null); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}
async function waitToken() {
  for (let i = 0; i < 300; i++) { const t = readToken(); if (t) return t; await sleep(100); }
  return readToken();
}

function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || (req.url || '').includes('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    for await (const chunk of req) void chunk;   // drain
    // 慢回合:先挂住 SLOW_MS 再吐 —— 这一段就是「回合在跑」的时间,start 必须落在它里面。
    await sleep(SLOW_MS);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const id = 'chatcmpl-race';
    res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { content: '慢回合结束' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}
function streamChat(body, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { /* partial */ } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
const MISSION_INPUT = {
  goal: '把两件事做完',
  milestones: [{ id: 'm1', desc: '第一步' }, { id: 'm2', desc: '第二步' }],
};

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  // 工作区里放点真文件:回合起跑那一段的 captureWorkspaceTurnBaseline 会真去扫它 —— 这正是竞态窗口
  // 里最占时间的一步,真机上用户的工作区更大,这里给它一点活干,让窗口贴近真实而不是空转。
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(WORK, `f${i}.txt`), 'x'.repeat(64), 'utf8');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass',
    includeWorkbenchMcp: false, defaultWorkspace: WORK,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');

  const provider = await startProvider();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    ok(await waitHealth(WB_PORT), 'workbench up');
    const token = await waitToken();
    ok(!!token, 'runtime token available');

    for (const delayMs of TIMINGS) {
      let greens = 0;
      const notes = [];
      for (let round = 1; round <= ROUNDS; round++) {
        const created = await requestJson(WB_PORT, '/api/sessions', { title: `race-${delayMs}-${round}`, cwd: WORK }, token);
        const sid = created.json && created.json.session && created.json.session.id;
        if (!sid) { notes.push(`r${round}: 建会话失败`); continue; }
        // 回合先发(不 await);start 在 delayMs 之后打进去,落在回合里面。
        const turn = streamChat({ sessionId: sid, message: '修一下工作区里的代码,然后把两个里程碑做掉' }, token);
        await sleep(delayMs);
        const started = await requestJson(WB_PORT, '/api/mission', { action: 'start', sessionId: sid, mission: MISSION_INPUT }, token);
        const startedSeq = started.json && started.json.mission && Number(started.json.mission.startedTurnSeq);
        await turn;
        const after = await requestJson(WB_PORT, `/api/sessions/${encodeURIComponent(sid)}`, null, token);
        const session = after.json && after.json.session;
        const mission = session && session.mission;
        const milestones = mission && Array.isArray(mission.milestones) ? mission.milestones : [];
        const good = Boolean(started.json && started.json.ok)
          && milestones.length === 2
          && milestones.map(m => m.id).join(',') === 'm1,m2'
          && Number(mission.startedTurnSeq) === startedSeq
          && session.kind === 'mission';
        if (good) greens++;
        else notes.push(`r${round}: milestones=${milestones.length} startedTurnSeq=${mission ? mission.startedTurnSeq : 'n/a'}(期望 ${startedSeq}) kind=${session ? session.kind : 'n/a'}`);
      }
      ok(greens === ROUNDS, `start @${delayMs}ms：${ROUNDS} 轮账本全在（实得 ${greens}/${ROUNDS}）${notes.length ? ' | ' + notes.join(' ; ') : ''}`);
    }

    // ── 钉点(静态):上面那五组是【时序】判据 —— 竞态窗口在快机器上只有几十毫秒宽,窗口没被命中时它们
    //    也会绿。故把修法的形状另外钉死一遍,防「窗口漂了 → 断言从此永远绿」这种假绿。
    const src = readServerSource();
    ok(/function mergeMissionBeforeSave\(session, onDisk\)/.test(src), 's 02 落盘前合并是【一个共用函数】(三引擎同一份语义)');
    ok(/if \(!disk\) return false;/.test(src) && /if \(diskSeq <= memSeq\) return false;/.test(src)
      && /String\(disk\.createdAt \|\| ''\) !== String\(mem\.createdAt \|\| ''\)/.test(src),
    's 02 合并三支:磁盘无账本不动／内存不比磁盘旧不动／换了另一本账本以磁盘为准');
    ok(/session\.mission = applyMissionUpdate\(disk, \{/.test(src), 's 02 同一本账本时以磁盘为底、用 applyMissionUpdate 语义重放内存增量');
    ok(/async function saveSession\(session, opts\)/.test(src) && /if \(opts && opts\.mergeMissionFromDisk\)/.test(src)
      && /mergeMissionBeforeSave\(session, onDiskHead\)/.test(src),
    's 02 saveSession 的落盘前合并在【写链内】重读头(链外读+写中间还能插进路由那一存)');
    ok((src.match(/await saveSession\(session, \{ mergeMissionFromDisk: true \}\);/g) || []).length === 2,
      's 09／05 两处【起跑存】都带落盘前合并(claude 与 kimi 共用 05 那一处)');
    ok((src.match(/mergeMissionBeforeSave\(session, onDisk\);/g) || []).length === 3,
      's 09／05／05b 三处【收尾存】前都调同一个合并函数');
  } finally {
    kill(wb); await new Promise(r => provider.close(r));
    await sleep(200);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
  console.log('\nMISSION START RACE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
