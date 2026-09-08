(async () => {
'use strict';
// E2E(第 116 波 116-3 · 27 号文 §11.3 收件箱):收件箱的【不丢事件】完整性。
//
// (A) P0-3 单轮上限与游标的先后顺序。修前 `stewardTickOnce` 是「合并 -> slice(0,200)」,而三条源日志的
//     游标在 `stewardCollectEvents` 内部就已经推进到「这一轮看到的最新版本号」——被切掉的那些事件
//     (合并后按时间升序,即【最新】的那一批 needs_you / failed)永久静默丢失,下一轮也补不回来。
//     修后:截断改在合并【之前】、对原始事件做,超出的部分原样结转到下一轮。
//     判定:一次灌入 300 条待决 -> 两轮之后 300 条全在箱里,零丢失零重复。
//
// 进程内直调(单进程 = 单份运行时游标与去重集合,轮次可判定)。判定行:
// `STEWARD INBOX INTEGRITY E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-inbox-integrity-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const sessionsDir = path.join(HOME, 'sessions');
const stewardDir = path.join(HOME, 'steward');
const inboxFile = path.join(stewardDir, 'inbox-v1.ndjson');
const cursorFile = path.join(stewardDir, 'cursor-v1.json');

function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: '', engineMode: 'interactive',
    permissionMode: 'default', includeWorkbenchMcp: false, defaultWorkspace: HOME,
    subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
    ...patch,
  }, null, 2), 'utf8');
}
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
writeConfig({});
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const readInbox = () => {
  try {
    return fs.readFileSync(inboxFile, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// 合成线程 + 一批 pending 待决。requestedAt 按分钟拉开 —— 5 秒合并窗口只并「同 session 同 kind 且
// 距该组首条 ≤5 秒」的事件,拉开之后每条自成一组,300 条事件就是 300 行,轮次算术才干净。
const PER_SESSION = 100;
const SIDS = ['sess_inbox_a', 'sess_inbox_b', 'sess_inbox_c'];
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const expectedKeys = new Set();
for (const sid of SIDS) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessionsDir, sid + '.json'), JSON.stringify({
    id: sid, schemaVersion: 3, storageVersion: 2, turnSeq: 1, title: '线程 ' + sid, summary: '',
    pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
    messageCount: 0, providerHistoryCount: 0, mission: null, missionId: sid, kind: 'quick_ask',   // mission:null + kind:'mission' 会让投影卡片装配读空对象,合成夹具一律走非 mission 分支
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessionsDir, sid + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessionsDir, sid + '.provider.ndjson'), '', 'utf8');
  const rows = [];
  for (let i = 0; i < PER_SESSION; i++) {
    const id = `iv_${sid}_${String(i).padStart(3, '0')}`;
    expectedKeys.add(sid + '|' + id);
    rows.push(JSON.stringify({
      id, type: 'permission', sessionId: sid, status: 'pending',
      requestedAt: new Date(BASE_MS + i * 60000).toISOString(),
      interventionVersion: 1, toolName: 'file_write', tier: 'edit',
    }));
  }
  fs.writeFileSync(path.join(sessionsDir, sid + '.interventions.ndjson'), rows.join('\n') + '\n', 'utf8');
}
const TOTAL = SIDS.length * PER_SESSION;

const config = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;

try {
  /* ═════════ (A) P0-3 截断不丢事件 ═════════ */
  console.log('── (A) P0-3 单轮上限 vs 游标 ──');
  ok(TOTAL === 300, `A0 夹具:一次灌入 ${TOTAL} 条待决(3 条线程 × ${PER_SESSION})`);

  await srv.startStewardInbox(config);                 // 第 1 轮
  const afterOne = readInbox();
  ok(afterOne.length === 200, `A1 第 1 轮按单轮上限只写 200 条(got ${afterOne.length})`);
  ok(fs.existsSync(cursorFile), 'A2 游标照常落盘(结转不影响游标的既有语义)');

  await srv.startStewardInbox(config);                 // 第 2 轮(幂等 start = 补一轮 tick)
  const afterTwo = readInbox();
  ok(afterTwo.length === TOTAL, `A3 第 2 轮把结转下来的补齐:${TOTAL} 条全在箱里(got ${afterTwo.length})`);

  const seen = afterTwo.map(row => String(row.sessionId) + '|' + String(row.seq));
  const unique = new Set(seen);
  ok(unique.size === seen.length, `A4 零重复(${unique.size} 个去重键 / ${seen.length} 行)`);
  const missing = [...expectedKeys].filter(k => !unique.has(k));
  ok(missing.length === 0, `A5 零丢失:300 条待决一条不少`
    + (missing.length ? ` → 漏了 ${missing.length} 条,例如 ${missing.slice(0, 3).join(', ')}` : ''));
  ok(afterTwo.every(row => row.kind === 'needs_you'), 'A6 全部归到 needs_you(最该被看到的那一类)');

  // 修前被丢掉的正是【最新】的那一批(合并后按时间升序切前 200)。这里把它钉死:
  // 第 2 轮补进来的 100 条,at 必须严格晚于第 1 轮写的那 200 条里的最大值。
  {
    const firstBatchMaxAt = afterOne.reduce((max, row) => (String(row.at) > max ? String(row.at) : max), '');
    const secondBatch = afterTwo.slice(200);
    ok(secondBatch.length === 100 && secondBatch.every(row => String(row.at) >= firstBatchMaxAt),
      `A7 结转下来的正是最新的那 100 条(修前被永久丢掉的就是它们;got ${secondBatch.length} 条)`);
  }

  await srv.startStewardInbox(config);                 // 第 3 轮:该空了
  ok(readInbox().length === TOTAL, `A8 第 3 轮零新增(游标 + 去重集合都稳住了;got ${readInbox().length})`);

  // inboxSeq 连续、单调 —— 结转不该在序号上留洞。
  {
    const seqs = readInbox().map(row => Number(row.inboxSeq));
    const monotonic = seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1);
    ok(seqs[0] === 1 && monotonic && seqs[seqs.length - 1] === TOTAL,
      `A9 inboxSeq 从 1 连续到 ${TOTAL}(结转不留序号洞;got ${seqs[0]}..${seqs[seqs.length - 1]})`);
  }
  /* ═════════ (B) P1-7 5 秒合并窗口不再吞掉不同事件 ═════════ */
  console.log('── (B) P1-7 合并窗口 ──');
  {
    const ev = (runId, seq, atMs, payload) => ({
      kind: 'failed', sessionId: 'sess_merge', missionId: 'sess_merge', runId, seq,
      at: new Date(Date.parse('2026-09-05T10:00:00.000Z') + atMs).toISOString(), payload,
    });
    // 修前:分组键只有 sessionId+kind,两个不同 run 的 failed 合成一条,run_1 的 nodeId/errorClass/
    // summary 全部被 run_2 覆盖掉 —— 管家永远看不到「节点 X 因超时失败」。
    const twoRuns = srv.stewardMergeInboxEvents([
      ev('run_1', 1, 0, { nodeId: 'nodeX', errorClass: 'timeout', summary: '节点 X 超时' }),
      ev('run_2', 2, 2000, { nodeId: 'nodeY', errorClass: 'oom', summary: '节点 Y OOM' }),
    ], 5000);
    ok(twoRuns.length === 2, `B1 两个不同 run 的 failed 不再被合成一条(got ${twoRuns.length} 行)`);
    const text = JSON.stringify(twoRuns);
    ok(text.includes('节点 X 超时') && text.includes('节点 Y OOM'), 'B2 两条摘要都还在(修前只剩后到的那条)');

    // 同一个 run 里先后两个节点失败:仍然合成一条(它就是「重复事件收敛」的本意),
    // 但 nodeId / errorClass 累加成列表,不再是「后到的把先到的盖掉」。
    const sameRun = srv.stewardMergeInboxEvents([
      ev('run_9', 1, 0, { nodeId: 'nodeA', errorClass: 'timeout', summary: 'A 超时' }),
      ev('run_9', 2, 1500, { nodeId: 'nodeB', errorClass: 'oom', summary: 'B OOM' }),
    ], 5000);
    ok(sameRun.length === 1 && sameRun[0].count === 2, `B3 同一个 run 的两条 failed 照常合并(got ${sameRun.length} 行 / count ${sameRun[0] && sameRun[0].count})`);
    const acc = sameRun[0].payload || {};
    ok(Array.isArray(acc.nodeIds) && acc.nodeIds.join(',') === 'nodeA,nodeB',
      `B4 nodeId 累加成列表(got ${JSON.stringify(acc.nodeIds)})`);
    ok(Array.isArray(acc.errorClasses) && acc.errorClasses.join(',') === 'timeout,oom',
      `B5 errorClass 累加成列表(got ${JSON.stringify(acc.errorClasses)})`);
    ok(Array.isArray(acc.mergedSeqs) && acc.mergedSeqs.length === 2, 'B6 mergedSeqs 仍回填(重启重建去重集合的既有口径不变)');

    /* ── 117m-A1:真实 tick 用的那个窗口是 5s → 30s ── */
    // 用户第六轮走查②「管家还是会一条条汇报,没有必要还费 Token」。5 秒窗口在真机上几乎不合并任何
    // 东西 —— 同一条线程的失败/停滞信号往往隔十几秒才来第二条,于是每一条各起一个管家回合。
    // 上面 B1–B6 显式传 5000,钉的是【分组键】的行为,与窗口长度无关,故一字未改;下面钉的是
    // 「不传 windowMs 时用的那个常量到底是多长」——它才是 stewardTickOnce 真正走的那条路。
    const spread = (gapMs, windowMs) => srv.stewardMergeInboxEvents([
      ev('run_w', 1, 0, { summary: '第一条' }),
      ev('run_w', 2, gapMs, { summary: '第二条' }),
      ev('run_w', 3, gapMs * 2, { summary: '第三条' }),
    ], windowMs);
    ok(spread(12000, undefined).length === 1, 'B7 缺省窗口下:同 session 同 kind 同 run、相隔 12s/24s 的三条并成一条(修前 5s 窗口是三条,管家要汇报三次)');
    ok(spread(12000, undefined)[0].count === 3, 'B7b 并成的那一条 count=3(既有「同类 N 条」文案原样复用,不新起措辞)');
    ok(spread(20000, undefined).length === 2, 'B8 距【本组首条】超过 30s 的照样另起一组(窗口是 30s,不是无限攒批)');
    ok(spread(12000, 5000).length === 3, 'B8b 显式传 5000 时仍旧是三条 —— 变的只有缺省常量,函数本身的语义一字未动');
    const src13i = fs.readFileSync(path.join(WB, 'app', 'src', '13i-steward-inbox.js'), 'utf8');
    ok(/const STEWARD_MERGE_WINDOW_MS = 30000;/.test(src13i), 'B9 源码常量就是 30000(缺省值的唯一来源,防止有人只改注释)');
    ok(/stewardMergeInboxEvents\(head, STEWARD_MERGE_WINDOW_MS\)/.test(src13i), 'B9b stewardTickOnce 用的正是这个常量(没有第二个写死的窗口)');
  }
} finally {
  try { srv.stopStewardInbox(); } catch { /* ignore */ }
}

/* ═════════ (C) P1-8 游标损坏 = 从零开始(不是「从现在开始」) ═════════ */
// 必须开子进程:游标只在【本进程首次装载】时读一次(stewardRuntime.loaded),同一个进程里改不动它。
// A/B 两个 HOME 只差一件事 —— 一个有坏掉的 cursor-v1.json,一个压根没有游标文件(真冷启动)。
console.log('── (C) P1-8 游标损坏 ──');
{
  const cp = require('child_process');
  const childScript = path.join(HOME, 'inbox-child.js');
  fs.writeFileSync(childScript, [
    "const fs = require('fs'), path = require('path');",
    'const [, , server, home] = process.argv;',
    'const srv = require(server);',
    '(async () => {',
    "  const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).config;",
    '  await srv.startStewardInbox(cfg);',
    '  srv.stopStewardInbox();',
    '  let rows = [];',
    "  try { rows = fs.readFileSync(path.join(home, 'steward', 'inbox-v1.ndjson'), 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)); } catch { rows = []; }",
    "  let audit = '';",
    '  await new Promise(r => setTimeout(r, 400));   // logEvent 走 createWriteStream,exit 前先给它时间刷盘',
    "  try { for (const f of fs.readdirSync(path.join(home, 'logs'))) audit += fs.readFileSync(path.join(home, 'logs', f), 'utf8'); } catch { audit = ''; }",
    "  console.log('RESULT ' + JSON.stringify({ rows: rows.length, corruptLogged: audit.includes('steward_cursor_corrupt') }));",
    '  process.exit(0);',
    '})();',
  ].join('\n'), 'utf8');

  // 一个带 5 条 failure 历史的会话。kind 留 quick_ask(不建投影卡片),但 mission.changeSeq 照常被
  // 投影读走 —— 那正是「这条会话有没有新变化」的免费信号。
  const seedHome = (home, withCorruptCursor) => {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    // logEvent 只在 <data>/logs 已经存在时才建得起写流(建目录是 serve 启动时做的事,子进程只 require)。
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const sid = 'sess_cursor_case';
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(home, 'sessions', sid + '.json'), JSON.stringify({
      id: sid, schemaVersion: 3, storageVersion: 2, turnSeq: 5, title: '有历史的线程', summary: '',
      pinned: false, cwd: home, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
      messageCount: 0, providerHistoryCount: 0, mission: { changeSeq: 5 }, missionId: sid, kind: 'quick_ask',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(home, 'sessions', sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(home, 'sessions', sid + '.provider.ndjson'), '', 'utf8');
    const journal = [];
    for (let i = 1; i <= 5; i++) {
      journal.push(JSON.stringify({
        // occurredAt 是归一化器认的时间字段(不是 at)——不给它,5 条会全部落到 epoch 0、被 5 秒窗口并成一条。
        seq: i, type: 'failure', occurredAt: new Date(BASE_MS + i * 60000).toISOString(),
        detail: { errorClass: 'timeout', summary: '第 ' + i + ' 次回合失败' },
      }));
    }
    fs.writeFileSync(path.join(home, 'sessions', sid + '.changes.ndjson'), journal.join('\n') + '\n', 'utf8');
    if (withCorruptCursor) {
      fs.mkdirSync(path.join(home, 'steward'), { recursive: true });
      fs.writeFileSync(path.join(home, 'steward', 'cursor-v1.json'), '{ 这不是合法 JSON', 'utf8');
    }
  };
  const runChild = home => {
    const out = cp.spawnSync(process.execPath, [childScript, SERVER, home], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home },
    });
    const line = String(out.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
    try { return JSON.parse(line.slice(7)); } catch { return { rows: -1, corruptLogged: false, raw: String(out.stdout) + String(out.stderr) }; }
  };

  const coldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-inbox-cold-'));
  const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-inbox-corrupt-'));
  seedHome(coldHome, false);
  seedHome(corruptHome, true);

  const cold = runChild(coldHome);
  ok(cold.rows === 0, `C1 真冷启动(压根没有游标文件)只建基线、不把历史灌进箱子(got ${cold.rows} 行)`);
  const corrupt = runChild(corruptHome);
  ok(corrupt.rows === 5, `C2 游标损坏 -> 真的「从零开始」,5 条历史 failure 补进箱子(修前是 0 —— 基线被悄悄拉到现在;got ${corrupt.rows})`);
  ok(corrupt.corruptLogged === true, 'C3 损坏留下痕迹(审计里有 steward_cursor_corrupt;修前连 lastError 都不置)');
  fs.rmSync(coldHome, { recursive: true, force: true });
  fs.rmSync(corruptHome, { recursive: true, force: true });

  /* ═════════ (D) P1-9 budget_exhausted 的持久去重键 ═════════ */
  // 修前 budget 类事件唯一的去重保护是内存 seen 集合,而它无论启动重建还是运行时收缩都【只回看
  // inbox 尾部 2000 行】;card 上的 budgetExhausted 却是一次性【持久】标记。于是只要箱子在那条记录
  // 之后又多了 2000 行,它就滑出重建窗口,下一轮 tick 会把同一件事重新写进箱子。
  // 这里就按这个形状复现:先跑一轮拿到 1 条 budget,再往箱子里灌 2100 行让它滑出窗口,再跑一轮。
  console.log('── (D) P1-9 预算触顶的持久去重 ──');
  const budgetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-inbox-budget-'));
  {
    const sid = 'sess_budget_case';
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(budgetHome, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(budgetHome, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(budgetHome, 'config.json'), fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    fs.writeFileSync(path.join(budgetHome, 'sessions', sid + '.json'), JSON.stringify({
      id: sid, schemaVersion: 3, storageVersion: 2, turnSeq: 3, title: '预算用尽的事项', summary: '',
      pinned: false, cwd: budgetHome, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
      messageCount: 0, providerHistoryCount: 0, missionId: sid, kind: 'mission',
      mission: {
        goal: '把周报写完', createdAt: now, updatedAt: now, autoMode: 'off', milestones: [], changeSeq: 0,
        budget: { maxAutoTurns: 5, maxTokens: 1000 }, spent: { autoTurns: 5, tokens: 1000 },
        budgetExhaustedAt: now,
      },
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(budgetHome, 'sessions', sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(budgetHome, 'sessions', sid + '.provider.ndjson'), '', 'utf8');

    const budgetRows = () => {
      try {
        return fs.readFileSync(path.join(budgetHome, 'steward', 'inbox-v1.ndjson'), 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(r => r && r.kind === 'budget' && r.sessionId === sid).length;
      } catch { return 0; }
    };
    runChild(budgetHome);
    ok(budgetRows() === 1, `D1 第一轮:预算触顶入箱一次(got ${budgetRows()})`);
    const cursor = JSON.parse(fs.readFileSync(path.join(budgetHome, 'steward', 'cursor-v1.json'), 'utf8'));
    ok(Array.isArray(cursor.sources.budgetSeen) && cursor.sources.budgetSeen.includes(sid),
      `D2 去重键落进游标 sources.budgetSeen(修前这个字段根本不存在;got ${JSON.stringify(cursor.sources.budgetSeen)})`);

    // 把那条记录挤出 2000 行的重建窗口 —— 内存去重集合从此看不见它。
    const filler = [];
    for (let i = 1; i <= 2100; i++) {
      filler.push(JSON.stringify({
        inboxSeq: 10000 + i, kind: 'done', sessionId: 'sess_filler', missionId: 'sess_filler', runId: '',
        seq: i, at: new Date(BASE_MS + i * 1000).toISOString(), payload: { summary: '填充 ' + i }, count: 1,
      }));
    }
    fs.appendFileSync(path.join(budgetHome, 'steward', 'inbox-v1.ndjson'), filler.join('\n') + '\n', 'utf8');
    runChild(budgetHome);
    ok(budgetRows() === 1, `D3 滑出 2000 行尾窗后再跑一轮:仍然只有 1 条(修前会重复入箱;got ${budgetRows()})`);
  }
  fs.rmSync(budgetHome, { recursive: true, force: true });
}

/* ═════════ (E) P1-10 收件箱内存队列自持排空 ═════════ */
// 修前 stewardOnInboxBatch 只在「轮询器又写了新的一批」时排一次去抖定时器,一批只切走队首 30 条,
// 处理完不给剩下的重排 —— 只要活动很快安静下来,余下的条目会一直躺在纯内存队列里没人处理,
// 进程重启整份丢失。修后:一批处理完队列还有就接着排。
console.log('── (E) P1-10 队列自持排空 ──');
{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitUntil = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(400); }
    return false;
  };
  try { srv.StewardHooks.resumeRunner(); } catch { /* 前面 stopStewardInbox 顺带停了回合队列,这里放开 */ }
  const events = [];
  for (let i = 1; i <= 45; i++) {
    events.push({
      inboxSeq: 900 + i, kind: 'done', sessionId: 'sess_inbox_a', missionId: 'sess_inbox_a', runId: '',
      seq: 900 + i, at: new Date().toISOString(), payload: { summary: '收工 ' + i }, count: 1,
    });
  }
  srv.StewardHooks.onInboxBatch(events);
  const queued = async () => Number((await srv.StewardHooks.runnerState(config).catch(() => ({}))).queued) || 0;
  ok(await queued() === 45, `E1 45 条事件先全部进内存队列(一个回合最多带 30 条;got ${await queued()})`);
  // 一轮去抖 5 秒切走 30 条,修前剩下的 15 条就永远躺在这里了(没有新事件 = 没人再排定时器)。
  const drained = await waitUntil(async () => (await queued()) === 0, 45000);
  ok(drained, `E2 不再有任何新事件进来,队列仍然自己排空(修前会永久停在 15 条;got ${await queued()})`);
}

console.log('');
if (fail) { console.log(`STEWARD INBOX INTEGRITY E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD INBOX INTEGRITY E2E: ALL PASS');
process.exit(0);
})();
