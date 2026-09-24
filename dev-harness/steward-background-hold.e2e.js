require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
(async () => {
'use strict';
// E2E(2026-09-24,用户:「有时候线程没跑完交付就一直把进度同步给我(可能和后台任务跑完有关?),每次带上
// 『它交付的原文』『这一次没取到原文』」):管家看管的线程,回合收了、后台活儿还在跑时,收件箱【不】报这一回合;
// 后台活儿落地后的那一轮报【一次】;之后再跑几轮也不重复。
//
//   H1 冷启动只建基线(第 1 回合不倒灌);
//   H2 第 2 回合收了、后台命令还在跑 → 这条线程 0 行(修前:当场报「第 2 回合跑完了」);
//   H3 游标基线停在已报过的第 1 回合(没被推到 2 —— 推了的话后台跑完就再也报不出来);
//   H4 后台命令跑完 → 正好一行,turnSeq === 2;
//   H5 再跑两轮 → 仍然一行(去重);
//   H6 没交给管家看管的线程:后台在跑时同样不报,放开之后也不报(看管判据没变);
//   S1-S3 源码锁:判据用进程内真值、班组 done 并进回合报告、交付卡只挂真回合。
// 判定行:`STEWARD BACKGROUND HOLD E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-bg-hold-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: '', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, defaultWorkspace: HOME, subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
}, null, 2), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);
const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;

const inboxRows = async () => (await srv.StewardHooks.inboxRead({ since: 0, limit: 200 })).items;
const tick = async () => { await srv.startStewardInbox(cfg); await sleep(500); };

// 两条线程:一条由管家开(launchedBy:steward = 看管),一条是用户自己的(不看管)。第 1 回合都已跑完。
async function makeThread(title, watched) {
  const s = await srv.createSession({ title, cwd: HOME });
  s.kind = 'mission';
  s.turnSeq = 1;
  if (watched) { s.launchedBy = 'steward'; s.stewardLastTurn = { seq: 1, ok: true, at: new Date().toISOString() }; }
  s.messages = [{ role: 'assistant', content: '第 1 回合的交付。', turnSeq: 1, createdAt: new Date().toISOString() }];
  await srv.saveSession(s);
  return s.id;
}
async function finishTurn(sid, seq, watched) {
  const s = await srv.loadSession(sid);
  s.turnSeq = seq;
  if (watched) s.stewardLastTurn = { seq, ok: true, at: new Date().toISOString() };
  // 以工具调用收尾、没有收口的话 —— 正是用户看到「没取到原文」的那种回合。
  s.messages.push({ role: 'assistant', content: '', turnSeq: seq, createdAt: new Date().toISOString(),
    segments: [{ type: 'text', text: '我先在后台跑一下。' }, { type: 'tool', toolUseId: 't1' }] });
  await srv.saveSession(s);
}

const watchedId = await makeThread('管家开的线程', true);
const plainId = await makeThread('用户自己的线程', false);

// 后台命令表经 EventStreamHooks 延迟绑定取(11 的真表);这里换成可控的假表。
const busy = new Set();
const realShells = srv.EventStreamHooks.backgroundShells;
srv.EventStreamHooks.backgroundShells = {
  ...realShells,
  rows: sid => (busy.has(sid) ? [{ id: 'shell:fake', kind: 'shell', shellId: 'fake', name: 'npm test', command: 'npm test', startedAt: new Date().toISOString(), tail: '' }] : []),
};

try {
  await tick();
  ok((await inboxRows()).length === 0, 'H1 冷启动只建基线,第 1 回合不倒灌');

  busy.add(watchedId); busy.add(plainId);
  await finishTurn(watchedId, 2, true);
  await finishTurn(plainId, 2, false);
  await tick();
  {
    const mine = (await inboxRows()).filter(r => r.sessionId === watchedId);
    ok(mine.length === 0, `H2 第 2 回合收了、后台还在跑 → 0 行(got ${mine.length};修前当场报一次)`);
    const cursor = JSON.parse(fs.readFileSync(path.join(HOME, 'steward', 'cursor-v1.json'), 'utf8'));
    const entry = cursor.sources && cursor.sources.sessionTurns && cursor.sources.sessionTurns[watchedId];
    ok(entry && Number(entry.turnSeq) === 1, `H3 游标基线停在已报过的第 1 回合(got ${entry && entry.turnSeq})`);
  }
  await tick();
  ok((await inboxRows()).filter(r => r.sessionId === watchedId).length === 0, 'H2b 后台还在跑的第二轮照样不报');

  busy.clear();
  await tick();
  {
    const mine = (await inboxRows()).filter(r => r.sessionId === watchedId);
    ok(mine.length === 1 && mine[0].kind === 'done' && mine[0].payload.turnSeq === 2,
      `H4 后台跑完 → 正好一行,第 2 回合(got ${JSON.stringify(mine.map(r => [r.kind, r.payload && r.payload.turnSeq]))})`);
  }
  await tick(); await tick();
  ok((await inboxRows()).filter(r => r.sessionId === watchedId).length === 1, 'H5 再跑两轮仍然一行(不重复)');
  ok((await inboxRows()).filter(r => r.sessionId === plainId).length === 0, 'H6 没交给管家看管的线程一行都不报(看管判据没变)');
} finally {
  srv.EventStreamHooks.backgroundShells = realShells;
  try { srv.stopStewardInbox(); } catch { /* ignore */ }
}

// 源码锁
{
  const src13i = fs.readFileSync(path.join(WB, 'app', 'src', '13i-steward-inbox.js'), 'utf8');
  const busyFn = (src13i.match(/function stewardThreadBackgroundBusy\(sid\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/EventStreamHooks\.backgroundShells/.test(busyFn) && /activeAgentRuns/.test(busyFn),
    'S1 「后台还在跑」读进程内真值:后台命令表 + 活着的 agent run(不读盘、不猜时间)');
  ok(/if \(normalized && normalized\.kind === 'done' && \(turnEvt \|\| stewardHeldTurnSessions\.has\(sid\)\)\) continue;/.test(src13i),
    'S2 班组收工与本线程回合报告是同一件事:回合报告在箱里或被按住时,done 不单独叫醒管家');
  const conv = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'steward-conversation.js'), 'utf8');
  ok(/if \(!\(Number\(source\.turnSeq\) > 0\)\) return null;/.test(conv)
    && /if \(fetched && \(!found \|\| !found\.text\.trim\(\)\)\) \{ block\.remove\(\); return null; \}/.test(conv),
    'S3 交付卡只挂真回合;信封取到但这一回合没有交付正文 → 整块撤掉(不再垫「没取到原文」)');
  const narrative = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'turn-narrative.js'), 'utf8');
  ok(/if \(message && message\.backgroundJobId\) continue;/.test(narrative),
    'S4 后台任务完成回执不进对话流(数据仍在,模型下一回合照读)');
}

// 纯函数:回执行被滤掉,其余原样
{
  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(path.join(WB, 'app', 'public', 'js', 'turn-narrative.js')).href);
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'system', content: '[后台任务 succeeded] npm test', backgroundJobId: 'job_1' },
    { role: 'assistant', content: 'ok' },
  ];
  const visible = mod.visibleSessionMessageEntries(msgs, 0, {}).map(e => e.index);
  ok(JSON.stringify(visible) === JSON.stringify([0, 2]), `P1 visibleSessionMessageEntries 滤掉回执行,别的原样(got ${JSON.stringify(visible)})`);
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
console.log('\nSTEWARD BACKGROUND HOLD E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
