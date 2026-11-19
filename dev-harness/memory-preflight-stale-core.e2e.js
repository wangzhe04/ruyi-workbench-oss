'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:记忆预检不自伤、stale 时不丢核心(150 号文 S10 / S11)。进程内装真 server.js,数据根在临时目录,断网可跑。
//
//   [A] S10 核心超席位(席位 1)+ 本轮命中的是【候补】核心:修前预检先 touchMemoryUsage 再回验,候补那条的 lastUsedAt
//       一刷新就挤进核心席位,回验看到核心集合变了 → 判 stale → 本轮记忆连核心一起清空。修后本轮 mode=default、核心与
//       命中都在;usage 仍照记(下一轮那条候补按 LRU 晋升),且下一轮同样不 stale。
//   [B] S11 预检期间库真的被改了(回验前删掉一条核心记忆):修前返回空核心 mode=stale;修后按当前库、不走语义重算一次,
//       核心里只剩没被删的那条(删掉的记忆不会被披露),回执标 recovered=stale、semantic-fallback="stale"。
//   [C] 会话本身已 stale(执行权不再属于本回合):不重算,仍退回空结果(不变量)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preflight-stale-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(ROOT, 'workbench');
process.env.RUYI_DISABLE_SEMANTIC = '1';
const S = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));
const t = createRunner('MEMORY PREFLIGHT STALE CORE');
const { ok } = t;

const session = () => ({ memoriesExplicit: false, memoryExclusions: [] });
const ids = list => (list || []).map(e => e.id).sort().join(',');
function backdate(file) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^updatedAt: .*$/m, 'updatedAt: 2010-01-01T00:00:00.000Z').replace(/^createdAt: .*$/m, 'createdAt: 2010-01-01T00:00:00.000Z'), 'utf8');
}

(async () => {
  try {
    // ── [A] S10 ──
    const workA = path.join(ROOT, 'work-a'); fs.mkdirSync(workA, { recursive: true });
    const standby = await S.saveMemory({ id: 'core-standby', scope: 'project', type: 'reference', name: 'deploy pipeline checklist',
      description: 'deploy pipeline release workflow checklist', core: true, body: 'standby body' }, workA);
    const active = await S.saveMemory({ id: 'core-active', scope: 'project', type: 'reference', name: 'repository layout',
      description: 'where the sources live', core: true, body: 'active body' }, workA);
    ok(standby.ok && active.ok, 'A0 两条核心记忆落盘');
    backdate(standby.memory.file);
    const cfgA = { coreMemoryMaxItemsV1: 1, semanticRetrievalV1: false };
    const before = await S.resolveCoreMemoryState(workA, null, cfgA);
    ok(ids(before.active) === 'core-active' && ids(before.standby) === 'core-standby', `A1 席位 1:core-active 在席、core-standby 候补(${ids(before.active)} / ${ids(before.standby)})`);
    const p1 = await S.resolveMemoryPreflight(session(), workA, 'how do I run the deploy pipeline', undefined, cfgA, {});
    ok(p1.status.mode === 'default' && p1.status.checked === true, `A2 本轮不判 stale(mode=${p1.status.mode}, checked=${p1.status.checked};修前自己 touch 挤动席位 → stale)`);
    ok(ids(p1.coreEntries) === 'core-active' && p1.entries.some(e => e.id === 'core-standby'), `A3 本轮核心与命中都在(core=${ids(p1.coreEntries)}, related=${ids(p1.entries)})`);
    const after = await S.resolveCoreMemoryState(workA, null, cfgA);
    ok(ids(after.active) === 'core-standby', `A4 usage 仍在回验后照记:下一轮候补按 LRU 晋升(${ids(after.active)})`);
    const p2 = await S.resolveMemoryPreflight(session(), workA, 'how do I run the deploy pipeline', undefined, cfgA, {});
    ok(p2.status.mode === 'default' && ids(p2.coreEntries) === 'core-standby', `A5 下一轮同样不 stale,核心是晋升后的那条(mode=${p2.status.mode}, core=${ids(p2.coreEntries)})`);

    // ── [B] S11 ──
    const workB = path.join(ROOT, 'work-b'); fs.mkdirSync(workB, { recursive: true });
    const keep = await S.saveMemory({ id: 'core-keep', scope: 'project', type: 'preference', name: 'reply in Chinese', description: 'answer in simplified Chinese', core: true, body: 'k' }, workB);
    const doomed = await S.saveMemory({ id: 'core-doomed', scope: 'project', type: 'reference', name: 'old secret note', description: 'user deletes this mid-turn', core: true, body: 'd' }, workB);
    const hit = await S.saveMemory({ id: 'vite-hmr', scope: 'project', type: 'lesson', name: 'vite hot reload broken', description: 'vite hot reload broken: check watch config', body: 'v' }, workB);
    ok(keep.ok && doomed.ok && hit.ok, 'B0 夹具落盘(两条核心 + 一条教训)');
    let calls = 0, deletedAt = 0;
    const cfgB = { semanticRetrievalV1: false };
    // executionOwnerRevalidate runs at the opening and closing authority step of every preflight check (150 号文 S2 起每个 check
    // 两次;修前每个 await 之后一次、每个 check 五次)。The first check (phase start) passes; on the first authority step after it
    // (call 3; 修前是 call 6), the user deletes a core memory — a genuine library change.
    const pB = await S.resolveMemoryPreflight(session(), workB, 'vite hot reload broken again', undefined, cfgB, {
      executionOwnerRevalidate: async () => { calls++; if (calls === 3 && !deletedAt) { fs.rmSync(doomed.memory.file); deletedAt = calls; } },
    });
    ok(deletedAt === 3, `B1 库在预检中途被改(第 ${deletedAt} 次回验前删掉 core-doomed)`);
    ok(pB.status.checked === true && pB.status.recovered === 'stale', `B2 stale 后按当前库重算,不交空结果(checked=${pB.status.checked}, recovered=${pB.status.recovered}, mode=${pB.status.mode})`);
    ok(ids(pB.coreEntries) === 'core-keep', `B3 核心保住了,且删掉的那条不披露(core=${ids(pB.coreEntries)})`);
    ok(pB.entries.some(e => e.id === 'vite-hmr'), `B4 关键词命中照常(related=${ids(pB.entries)})`);
    ok(pB.status.semantic && pB.status.semantic.fallback && pB.status.semantic.fallback.reason === 'stale', 'B5 回执带 semantic.fallback.reason=stale(前端「本轮记忆检索未完成,已用基础结果」)');
    const prompt = S.buildMemoryCheckPrompt(pB.status, {});
    ok(/semantic-fallback="stale"/.test(prompt) && /checked="true"/.test(prompt), 'B6 模型看到的回执 checked=true、semantic-fallback="stale"');

    // ── [C] session-level staleness keeps the old empty result ──
    const pC = await S.resolveMemoryPreflight(session(), workB, 'vite hot reload broken again', undefined, cfgB, { executionOwnerCurrent: () => false });
    ok(pC.status.mode === 'stale' && pC.status.checked === false && pC.coreEntries.length === 0 && pC.entries.length === 0,
      `C1 执行权已不属于本回合:不重算,仍返回空(mode=${pC.status.mode}, core=${pC.coreEntries.length})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (!t.failures) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log('[kept for inspection] ' + ROOT);
  }
  t.done({ exit: true });
})();
