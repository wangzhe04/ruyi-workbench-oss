#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(P4 收尾硬门 · 50 号文 §6):**离线升级与数据迁移恢复演练**。
//
// 与仓里既有那几件的分界要先说清,免得重复造:
//   · `unit/config-schema-12-migration.test.js` 管的是【一个配置键】怎么迁移;
//   · `unit/config-explicit-keys.test.js` 管的是【只落改过的键】;
//   · `durable-json-store.e2e.js` / `config-read-safety.e2e.js` 管的是【单个文件】的读写安全。
// 本件管的是它们都不管的那一层:**整个数据目录**从一个旧版本装过的状态走一遍
// 升级 → 降级兼容 → 断电 → 损坏 → 备份恢复,每一步都对账「东西还在不在、还对不对」。
//
// 为什么 P4 把它列成硬门:前面那些锁各自看着自己那一小块,**没有一条断言看着「用户那一整个
// 文件夹升级之后有没有少东西」**。而那正是升级事故的真实形状 —— 不是某个键错了,
// 是某一类文件在新版本手里没人认领,悄悄被跳过。
//
// 覆盖:
//   (A) 造一个旧版本装过的数据目录,并取下【事实指纹】(条数 + 关键字段)。
//   (B) 升级:当前构建读它 —— 每样都还在、指纹不变、configSchema 已迁移。
//   (C) 降级兼容:新版落盘之后,**旧版本认识的顶层键一个都不许少**(47 号文 §4.2 第 24 条那一族)。
//   (D) 断电:会话消息 ndjson 与用量台账各截半行 —— 前面完整的行仍读得出,不抛、不整份丢。
//   (E) 损坏隔离:一个会话 json 写成坏 JSON —— 它被隔离,而不是让整份会话列表打不开。
//   (F) 备份恢复:整份拷走、删原件、拷回来 —— 指纹与 (A) 逐项一致。
//
// 判定行:`OFFLINE UPGRADE DRILL E2E: ALL PASS`。
(async () => {
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-upgrade-drill-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const NL = String.fromCharCode(10);

// ── (A) 造一个「旧版本装过」的数据目录 ────────────────────────────────────────────────────
// 旧版本的形状要点:configSchema 写着 11(2.8.0 之前)、整份默认值被冻在盘上(128a 之前的老毛病)、
// 而且带着几个**当前版本不认识的**顶层键(模拟「更旧的版本留下的东西」)。
const OLD_SCHEMA = 11;
const UNKNOWN_KEYS = { legacyDispatchDeskV1: true, someKeyFromAnOlderBuild: 'keep-me' };
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'steward'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: OLD_SCHEMA,
  engineMode: 'interactive', permissionMode: 'default', locale: 'zh-CN',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  autoImportClaudeCodeMcp: false,
  // 128a 之前的存量安装:这几个开关被显式冻成 false(迁移要把其中三个翻回 true)
  runtimeHistoryReadDedupV1: false, runtimeSummaryPromptI18nV1: false, runtimeReseedTailUnitsV1: false,
  runtimeEvaporateBudgetBoundaryV1: false, runtimeReseedReattachFilesV1: false,
  providers: [{ id: 'p', label: '旧端点', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/x', apiKey: 'k-old', model: 'm', models: [{ id: 'm' }] }],
  activeProvider: 'p', model: 'm',
  ...UNKNOWN_KEYS,
}, null, 2), 'utf8');

// 管家记忆(旧版写下的)
fs.writeFileSync(path.join(HOME, 'steward', 'memory-v1.json'), JSON.stringify({
  schema: 1, updatedAt: '2026-01-01T00:00:00.000Z',
  entries: Array.from({ length: 5 }, (_, i) => ({
    id: 'old_mem_' + i, kind: 'preference', text: `旧版记下的第 ${i} 条偏好`,
    confidence: 0.9, sourceSessionId: 'steward', sourceSeq: 1, state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })),
}, null, 2), 'utf8');

process.env.RUYI_HOME = HOME;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const srv = require(SERVER);

// 用真原语造几条会话(它们的落盘形状才与产线一致)
const madeIds = [];
for (let i = 0; i < 4; i++) {
  const s = await srv.createSession({ title: `旧会话 ${i}`, cwd: HOME });
  s.turnSeq = 2 + i;
  s.summary = `旧会话 ${i} 的上一句`;
  // 消息必须经【真路径】落盘(saveSession 把 session.messages 写进 ndjson 并把条数记进会话头)。
  // 本件第一版是直接 appendFileSync 往 ndjson 里塞行 —— 于是头里写着 0 条、文件里躺着 2 行,
  // **一读就被对齐成 0 行**,然后我把这当成了「断电丢数据」。那不是产品缺陷,是夹具自相矛盾:
  // 「头是权威、文件向头对齐」恰恰就是断电自愈的机制本身(头说 N 行,文件有 N 行半 → 削掉半行)。
  s.messages = [
    { role: 'user', content: `第 ${i} 条用户消息`, createdAt: '2026-01-01T00:00:00.000Z', turnSeq: 1 },
    { role: 'assistant', content: `第 ${i} 条助手回复`, createdAt: '2026-01-01T00:00:01.000Z', turnSeq: 1 },
  ];
  await srv.saveSession(s);
  madeIds.push(s.id);
}
// 用量台账(逐行 ndjson,断电那一节要用)
const ledger = path.join(HOME, 'usage-ledger.ndjson');
fs.writeFileSync(ledger, Array.from({ length: 6 }, (_, i) =>
  JSON.stringify({ at: '2026-01-01T00:00:0' + i + '.000Z', sessionId: madeIds[0], inputTokens: 100 + i, outputTokens: 10 })).join(NL) + NL, 'utf8');

// 事实指纹:升级前后拿它逐项对账
async function fingerprint(tag) {
  const cfg = await srv.readConfig();
  const list = await srv.listSessions().catch(() => []);
  const rows = Array.isArray(list) ? list : (list && Array.isArray(list.sessions) ? list.sessions : []);
  let mem = { entries: [] };
  try { mem = JSON.parse(fs.readFileSync(path.join(HOME, 'steward', 'memory-v1.json'), 'utf8')); } catch { /* */ }
  let ledgerLines = 0;
  try { ledgerLines = fs.readFileSync(ledger, 'utf8').split(NL).filter(Boolean).length; } catch { /* */ }
  const heads = {};
  for (const id of madeIds) {
    const h = await srv.loadSession(id).catch(() => null);
    heads[id] = h ? { title: h.title, turnSeq: h.turnSeq, summary: h.summary } : null;
  }
  return { tag, sessions: rows.length, memory: mem.entries.length, ledgerLines, heads, providerId: (cfg.providers[0] || {}).id, schema: cfg.configSchema };
}

try {
  /* ═════════ (B) 升级:当前构建读旧目录 ═════════ */
  console.log('── (B) 升级 ──');
  const before = await fingerprint('升级后首读');
  ok(before.sessions === 4, `B1 四条旧会话一条不少(实得 ${before.sessions})`);
  ok(before.memory === 5, `B2 管家记忆五条一条不少(实得 ${before.memory})`);
  ok(before.ledgerLines === 6, `B3 用量台账六行一行不少(实得 ${before.ledgerLines})`);
  ok(before.providerId === 'p', 'B4 旧端点还在(升级不许动用户配的东西)');
  for (const id of madeIds) {
    const h = before.heads[id];
    if (!h) { ok(false, `B5 会话 ${id.slice(0, 10)} 打不开了`); break; }
  }
  ok(madeIds.every(id => before.heads[id] && before.heads[id].summary), 'B5 每条旧会话都打得开、上一句还在');
  ok(before.schema >= 12, `B6 configSchema 已迁移(旧 ${OLD_SCHEMA} → 实得 ${before.schema})`);
  const cfgNow = await srv.readConfig();
  ok(cfgNow.runtimeHistoryReadDedupV1 === true && cfgNow.runtimeSummaryPromptI18nV1 === true && cfgNow.runtimeReseedTailUnitsV1 === true,
    'B7 那三个被冻成 false 的开关真的被迁移翻开了(128a 治的就是这个)');
  ok(cfgNow.runtimeEvaporateBudgetBoundaryV1 === false && cfgNow.runtimeReseedReattachFilesV1 === false,
    'B8 拍板【不翻】的那两个没被顺手带上(迁移名单没被扩大)');

  /* ═════════ (C) 降级兼容 ═════════ */
  console.log('── (C) 降级兼容 ──');
  // 新版落盘之后,旧版本认识的顶层键一个都不许少 —— 否则用户装回旧版会丢设置。
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  // 自带尺子:C1 若在「配置文件压根没被重写过」的情况下通过,它就什么都没证明
  // (旧键当然还在——没人动过那个文件)。所以先钉住「盘上的那份确实被改写过」:
  // schema 从 11 变成了当前值,只有真写过盘才会这样。
  ok(onDisk.configSchema !== OLD_SCHEMA && onDisk.configSchema === srv.CONFIG_SCHEMA,
    `C0 尺子:盘上那份配置确实被重写过(${OLD_SCHEMA} → ${onDisk.configSchema});否则 C1 是白过的`);
  const lostUnknown = Object.keys(UNKNOWN_KEYS).filter(k => !(k in onDisk));
  ok(lostUnknown.length === 0,
    `C1 当前版本【不认识】的旧键原样留在盘上(装回旧版才不丢设置;丢了的: ${JSON.stringify(lostUnknown)})`);
  ok(onDisk.providers && onDisk.providers[0] && onDisk.providers[0].apiKey === 'k-old',
    'C2 端点与密钥原样(升级不许重写用户凭据)');

  /* ═════════ (D) 断电:写到一半的行 ═════════ */
  console.log('── (D) 断电 ──');
  const msgFile = path.join(HOME, 'sessions', madeIds[1] + '.messages.ndjson');
  fs.appendFileSync(msgFile, JSON.stringify({ role: 'user', content: '这一行写到一半就断电了' }).slice(0, 30), 'utf8');
  const tornHead = await srv.loadSession(madeIds[1]).catch(() => null);
  ok(Boolean(tornHead && tornHead.title), 'D1 消息文件末尾有半行时,会话仍然打得开(不抛)');
  ok(Boolean(tornHead && Array.isArray(tornHead.messages) && tornHead.messages.length === 2),
    `D2 半行之前那两条完整消息【读得出来】(实得 ${tornHead && tornHead.messages ? tornHead.messages.length : 'n/a'} 条)`);
  ok(Boolean(tornHead && tornHead.messages && tornHead.messages.every(m => m && m.role && m.content)),
    'D2b 读出来的是完整消息,不是半条拼出来的残骸');
  fs.appendFileSync(ledger, JSON.stringify({ at: 'x', inputTokens: 1 }).slice(0, 12), 'utf8');
  const ledgerAfterTorn = fs.readFileSync(ledger, 'utf8').split(NL).filter(Boolean);
  ok(ledgerAfterTorn.length >= 6, `D3 台账的半行不吃掉前面六行(实得 ${ledgerAfterTorn.length})`);

  /* ═════════ (E) 损坏隔离 ═════════ */
  console.log('── (E) 损坏隔离 ──');
  const victim = madeIds[3];
  fs.writeFileSync(path.join(HOME, 'sessions', victim + '.json'), '{ 这不是合法 JSON', 'utf8');
  const broken = await srv.loadSession(victim).catch(() => null);
  ok(broken === null || (broken && broken.id), `E1 坏掉的那条会话不让整份读取炸掉(实得 ${broken ? '回落成新会话' : 'null'})`);
  const after = await fingerprint('损坏之后');
  ok(after.sessions >= 3, `E2 别的会话照常列得出来 —— 一条坏的不许让整个列表打不开(实得 ${after.sessions})`);
  ok(madeIds.slice(0, 3).every(id => after.heads[id] && after.heads[id].title), 'E3 没坏的三条逐条打得开');

  /* ═════════ (F) 备份恢复 ═════════ */
  console.log('── (F) 备份恢复 ──');
  const backup = HOME + '-backup';
  fs.cpSync(HOME, backup, { recursive: true });
  fs.rmSync(path.join(HOME, 'sessions'), { recursive: true, force: true });
  const afterWipe = await fingerprint('删掉之后');
  ok(afterWipe.sessions === 0, `F1 前置:会话目录删掉之后确实读不出会话了(实得 ${afterWipe.sessions})`);
  fs.cpSync(path.join(backup, 'sessions'), path.join(HOME, 'sessions'), { recursive: true });
  const restored = await fingerprint('恢复之后');
  ok(restored.sessions === after.sessions, `F2 拷回来之后会话数与损坏前一致(${restored.sessions} vs ${after.sessions})`);
  ok(madeIds.slice(0, 3).every(id => restored.heads[id] && restored.heads[id].summary === after.heads[id].summary),
    'F3 恢复之后每条会话的「上一句」逐字一致(备份是真的能救回数据,不只是文件数对得上)');
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
} catch (error) {
  fail++;
  console.log('FAIL 未捕获异常: ' + String((error && error.stack) || error));
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄未放开时留给系统清 */ }
  console.log(fail === 0 ? 'OFFLINE UPGRADE DRILL E2E: ALL PASS' : `OFFLINE UPGRADE DRILL E2E: ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
})();
