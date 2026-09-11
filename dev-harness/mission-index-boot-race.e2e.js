(async () => {
'use strict';
// E2E(第 121 波 K3 · 34 号文 §13.3 登记的那条竞态):boot 之后才物化的会话,索引要看得见。
//
// 来路:121-K1 的执行者撤掉了 mission-index-scale.e2e.js 里的 `stewardEnabledV1:false` 种子,
// 依据是「K0b 已经把空索引持久化那条路结构性堵死 + 串行跑 4 次全绿」。随后 `--parallel 4` 的全量
// 回归里本件真红(冷列表 300 条没读满),还原种子才恢复。34 号文 §13.3 把这条登记给 K3,并且写下
// 那句结论:**「跑 N 次没复现」从来不是证伪竞态的证据**(30 号文 §8.14 形状阶梯)。
//
// 所以本件【不】靠时序赌博去复现,而是按形状阶梯把机制本身钉出来:
//
//   A 机制(确定性,零抖动):投影索引一旦被建进进程内存(pretenderIndexRuntime.value),
//     buildOrLoadPretenderIndex 的 `if (!value)` 就短路了整段「扫目录 + sameSourceMap 比对」——
//     此后【外部写进 sessions 目录的新会话文件永远不被发现】,因为没有任何人给它们打脏页
//     (markPretenderIndexDirty 只长在应用自己的写口上)。K0b 堵的是「空目录时不要建空索引」,
//     堵不住「非空索引建好之后目录又长出东西」。本支先读一次让索引落进内存,再往目录里写新会话,
//     然后反复读 —— 修前它会稳定停在旧条数(不是偶尔,是永远)。
//
//   B 登记的那个形状(boot 后批量物化 + 收件箱 tick 抢时序):管家开着、轮询钳到最小值,
//     一边写会话一边让 tick 跑。修前它是概率红;有了 A 支的修法(目录级自愈)之后它必然绿。
//     B 支单独跑【不】能证伪任何东西(它绿可能只是没抽中),它的价值是:A 支的修法上线后,
//     它是那条真实路径的见证者。两支一起看才是证据。
//
// 判定行:`MISSION INDEX BOOT RACE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(child) { if (child && child.pid) { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function request(pathname, token, opts = {}) {
  return new Promise(resolve => {
    const raw = opts.body == null ? '' : JSON.stringify(opts.body);
    const req = http.request({ host: '127.0.0.1', port: opts.port, path: pathname, method: opts.method || (raw ? 'POST' : 'GET'), headers: {
      ...(token ? { 'x-wcw-token': token } : {}),
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
    } }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body, text }); });
    });
    req.on('error', () => resolve(null));
    if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 300; i++) { const r = await request('/health', '', { port }); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}
function runtimeToken(home) { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
async function waitToken(home) {
  for (let i = 0; i < 300; i++) { const t = runtimeToken(home); if (t) return t; await sleep(100); }
  return runtimeToken(home);
}

// 会话造法照 mission-index-scale.e2e.js 的 seedScaleDataset,规模缩到能看清的量。
function writeMission(home, sid, i) {
  const sessionsDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const head = {
    schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'mission',
    title: 'Race mission ' + i, summary: '', cwd: ROOT, pinned: false,
    createdAt: stamp, updatedAt: stamp, turnSeq: i, messageCount: 0, providerHistoryCount: 0,
    mission: {
      goal: 'Boot-race mission ' + i, createdAt: stamp, updatedAt: stamp,
      autoMode: 'off', changeSeq: i,
      milestones: [{ id: 'm1', desc: 'race item', status: 'pending', evidence: '', check: null }],
      budget: { maxAutoTurns: 10, maxTokens: 100000 }, spent: { autoTurns: 0, tokens: 0 },
      stall: { lastSignature: '', sameCount: 0 }, result: null,
    },
  };
  fs.writeFileSync(path.join(sessionsDir, sid + '.json'), JSON.stringify(head), 'utf8');
  fs.writeFileSync(path.join(sessionsDir, sid + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessionsDir, sid + '.provider.ndjson'), '', 'utf8');
}
async function totalOf(port, token) {
  const res = await request('/api/missions?limit=200', token, { port });
  return (res && res.body && res.body.page && Number(res.body.page.total)) || 0;
}
// 读到期望值就停;读不到就把【最后一次实测值】带出来,断言里印出来(假红最怕的是只说 undefined)。
async function waitTotal(port, token, want, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = -1;
  for (;;) {
    last = await totalOf(port, token);
    if (last >= want) return last;
    if (Date.now() > deadline) return last;
    await sleep(250);
  }
}

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-index-boot-race-'));
const spawnServer = (home, port, config) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), 'utf8');
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home, RUYI_TEST_HOOKS: '1' },
    windowsHide: true, stdio: 'ignore',
  });
};

let serverA = null, serverB = null;
try {
  /* ═════════════ A 机制:索引进了内存之后,目录里新长出来的会话还看不看得见 ═════════════ */
  {
    const home = path.join(ROOT_TMP, 'a');
    const port = await getFreePort();
    fs.mkdirSync(home, { recursive: true });
    // boot 【之前】先放 2 条:这样索引不走 K0b 的空目录早退,而是真的被建出来并缓存进内存 ——
    // 病灶要的正是「非空索引已经建好」这个前置条件。
    for (let i = 0; i < 2; i++) writeMission(home, 'sess_race_a_' + String(i).padStart(3, '0'), i);
    // 管家关掉:A 支要的是【确定性】,不要收件箱 tick 在旁边制造噪音。病灶与管家无关 ——
    // tick 只是最常见的那个「第一个把索引读进内存的人」。
    serverA = spawnServer(home, port, { configSchema: 7, includeWorkbenchMcp: false, stewardEnabledV1: false });
    ok(await waitHealth(port), 'A0 workbench up');
    const token = await waitToken(home); ok(!!token, 'A0b runtime token');

    const first = await totalOf(port, token);
    ok(first === 2, `A1 起手 2 条 mission 读得到(索引此刻被建出来并缓存进进程内存;实 ${first})`);

    // 现在往目录里【外部】写 8 条。没有任何人给它们打脏页 —— 导入、多进程写入、以及本仓大量
    // 夹具(包括 boot 后 seed 的那一类)都是这个形状。
    for (let i = 2; i < 10; i++) writeMission(home, 'sess_race_a_' + String(i).padStart(3, '0'), i);

    const after = await waitTotal(port, token, 10, 12000);
    ok(after === 10,
      `A2 【病灶】索引建好之后目录又长出 8 条 —— 必须自愈发现它们(want 10,实 ${after};` +
      '修前这里会永远停在 2:buildOrLoadPretenderIndex 的 `if (!value)` 短路了整段扫目录)');

    // 再删两条,反向面:自愈不能只认「多了」,还得认「少了」。
    for (let i = 0; i < 2; i++) {
      const sid = 'sess_race_a_' + String(i).padStart(3, '0');
      try { fs.unlinkSync(path.join(home, 'sessions', sid + '.json')); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(home, 'sessions', sid + '.messages.ndjson')); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(home, 'sessions', sid + '.provider.ndjson')); } catch { /* ignore */ }
    }
    let shrunk = -1;
    for (let i = 0; i < 48; i++) { shrunk = await totalOf(port, token); if (shrunk === 8) break; await sleep(250); }
    ok(shrunk === 8, `A3 外部删掉 2 条之后索引跟着缩(want 8,实 ${shrunk})—— 自愈是双向的,不是只管加`);

    // 稳定之后不该无限重扫:连读三次,条数不许再抖(钉的是「自愈收敛」,不是「每次都重建」)。
    await sleep(1500);
    const a = await totalOf(port, token), b = await totalOf(port, token), c = await totalOf(port, token);
    ok(a === 8 && b === 8 && c === 8, `A4 目录不再变之后读数稳定收敛(实 ${a}/${b}/${c})`);
  }

  /* ═════════════ B 登记的那个形状:boot 后批量物化 + 收件箱 tick 抢时序 ═════════════ */
  {
    const home = path.join(ROOT_TMP, 'b');
    const port = await getFreePort();
    // 管家【开着】、轮询钳到 13i 允许的最小值 5000ms —— 就是 §13.3 描述的那个现场。
    serverB = spawnServer(home, port, { configSchema: 7, includeWorkbenchMcp: false, stewardEnabledV1: true, stewardPollMs: 5000 });
    ok(await waitHealth(port), 'B0 workbench up(管家开着,轮询 5s)');
    const token = await waitToken(home); ok(!!token, 'B0b runtime token');

    // 边写边让 tick 跑:40 条,每条之间留 40ms —— 整个 seed 横跨 1.6 秒以上,必然覆盖若干次
    // 「有人在 seed 没写完的时候读索引」的窗口(这里由我们自己的 /api/missions 扮演那个读者,
    // 比等 tick 抽中更稳,读的是同一个 getPretenderProjectionIndex)。
    const reads = [];
    for (let i = 0; i < 40; i++) {
      writeMission(home, 'sess_race_b_' + String(i).padStart(3, '0'), i);
      if (i % 5 === 0) reads.push(totalOf(port, token));
      await sleep(40);
    }
    const partials = await Promise.all(reads);
    ok(partials.length >= 8, `B1 seed 期间确实读了 ${partials.length} 次索引(每一次都可能建出一份【部分】索引)`);
    ok(partials.some(n => n > 0 && n < 40),
      `B2 其中至少一次读到的是【部分】索引 —— 抢时序这件事本身真实存在,不是我编的(实测各次:${partials.join(',')})`);

    const total = await waitTotal(port, token, 40, 20000);
    ok(total === 40, `B3 seed 写完之后必须读满 40 条(want 40,实 ${total})—— 这就是 §13.3 那条真红的产品面`);
  }

  /* ═════════════ 静态锁 ═════════════ */
  const src = readServerSource();
  ok(/sources_dir_changed/.test(src), 'S1 自愈分支的 buildReason 字面量在编译产物里(可从 index.buildReason 事后对账)');
  ok(/PRETENDER_DIR_SETTLE_MS/.test(src), 'S2 「目录刚变过就不信任这次扫描」的沉降窗口是具名常量,不是裸字面量');
} finally {
  kill(serverA); kill(serverB);
  await sleep(400);
  try { fs.rmSync(ROOT_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\nMISSION INDEX BOOT RACE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });

// ────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION(32 号文 §4 纪律 5)
//   1. A2/A3/B3:把 13e-pretender-index.js 的目录级自愈整段(`if (pretenderIndexRuntime.value && !trusted)`)
//      注释掉 -> A2 必须 FAIL(永远停在 2)、A3 必须 FAIL、B3 大概率 FAIL。
//      **修前实测(121-K3 报告有原文,修法落地【之前】跑的)**:A2 want 10 实得 2、A3 want 8 实得 2、
//      A4 实得 2/2/2、B3 want 40 实得 1(B2 那一行更刺眼:seed 期间八次读数是 1,1,1,1,1,1,1,1 ——
//      索引在第一条会话那一刻就冻住了,后面 39 条一条都没进去)。
//   2. A4:把「沉降窗口」那一半判据去掉(每次都重扫)-> A4 仍然绿(条数是对的),
//      但那会让每一次 /api/missions 都付一次全量扫目录 —— 这一条钉的是收敛,不是正确性,
//      它的反向面在 mission-index-scale.e2e.js 的性能预算断言上(那件才是量成本的)。
//   3. B2:如果哪天它变绿不了(每次都读满 40),说明这台机器上 seed 快到抢不出窗口 —— 那不是产品变好,
//      是夹具失去了见证力;把 sleep(40) 调大到能抽出部分索引为止,别把断言删掉。
// 每改一次都要 `node ruyi-workbench/app/build.js` 再单跑本件;跑完照原样改回来。
// ────────────────────────────────────────────────────────────────────────────
