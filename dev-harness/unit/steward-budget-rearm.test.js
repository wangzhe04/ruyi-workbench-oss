'use strict';
// 管家收件箱「预算用尽」提醒的去重(代码走查 C7)。真源码、独立子进程跑一轮收件箱采集、临时 HOME。
// 修前:去重键只是会话 id(游标 budgetSeen)、收件箱行的 seq 位是常量 'exhausted' —— 任务重启
// (budgetExhaustedAt 清空)后再次用尽,是新的一件事,却永远不再提醒。
//   [B1] 第一次用尽 → 一行;同一次用尽再采一轮 → 仍是一行(不重复)。
//   [B2] 重启后再次用尽(新的 budgetExhaustedAt)→ 第二行。
//   [B3] 旧游标里只记了裸会话 id(升级前落盘的)→ 当前这一次认作已提醒,不重复。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-budget-rearm-'));
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: '', engineMode: 'interactive',
  permissionMode: 'default', includeWorkbenchMcp: false, defaultWorkspace: HOME,
  subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
}, null, 2), 'utf8');

const sid = 'sess_budget_rearm';
const sessPath = path.join(HOME, 'sessions', sid + '.json');
function writeSession(exhaustedAtIso) {
  const now = new Date().toISOString();
  fs.writeFileSync(sessPath, JSON.stringify({
    id: sid, schemaVersion: 3, storageVersion: 2, turnSeq: 3, title: '预算用尽的事项', summary: '',
    pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
    messageCount: 0, providerHistoryCount: 0, missionId: sid, kind: 'mission',
    mission: {
      goal: '把周报写完', createdAt: now, updatedAt: now, autoMode: 'off', milestones: [], changeSeq: 0,
      budget: { maxAutoTurns: 5, maxTokens: 1000 }, spent: { autoTurns: 5, tokens: 1000 },
      budgetExhaustedAt: exhaustedAtIso,
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(HOME, 'sessions', sid + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(HOME, 'sessions', sid + '.provider.ndjson'), '', 'utf8');
}

const childScript = path.join(HOME, 'inbox-child.js');
fs.writeFileSync(childScript, [
  "const fs = require('fs'), path = require('path');",
  'const [, , server, home] = process.argv;',
  'const srv = require(server);',
  '(async () => {',
  "  const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).config;",
  '  await srv.startStewardInbox(cfg);',
  '  srv.stopStewardInbox();',
  '  process.exit(0);',
  '})();',
].join('\n'), 'utf8');

function runChild() {
  const out = cp.spawnSync(process.execPath, [childScript, SERVER, HOME], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME },
  });
  if (out.status !== 0) console.error('child stderr:', out.stderr);
}

function budgetRows() {
  try {
    return fs.readFileSync(path.join(HOME, 'steward', 'inbox-v1.ndjson'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.kind === 'budget' && r.sessionId === sid);
  } catch { return []; }
}


test('[B1][B2] 同一次用尽只提醒一次;重启后再次用尽再提醒', () => {
  writeSession(new Date(Date.now() - 3600_000).toISOString());
  runChild();
  assert.equal(budgetRows().length, 1);
  runChild();
  assert.equal(budgetRows().length, 1, '同一次用尽被重复提醒');
  writeSession(new Date().toISOString());
  runChild();
  assert.equal(budgetRows().length, 2, '任务重启后再次用尽没有提醒');
});

test('[B3] 升级前的游标(裸会话 id)→ 当前这一次不重复提醒', () => {
  const cursorFile = path.join(HOME, 'steward', 'cursor-v1.json');
  const before = budgetRows().length;
  const cur = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  cur.sources.budgetSeen = [sid];
  fs.writeFileSync(cursorFile, JSON.stringify(cur), 'utf8');
  writeSession(new Date(Date.now() + 1000).toISOString());
  runChild();
  assert.equal(budgetRows().length, before, '旧游标已记过的会话被当成新的一次');
});

process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });
