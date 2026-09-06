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
} finally {
  try { srv.stopStewardInbox(); } catch { /* ignore */ }
}

console.log('');
if (fail) { console.log(`STEWARD INBOX INTEGRITY E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD INBOX INTEGRITY E2E: ALL PASS');
process.exit(0);
})();
