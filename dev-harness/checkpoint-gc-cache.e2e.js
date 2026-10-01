require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E (PF1 「性能专项」): checkpoint GC size-cap cache. Offline, zero-dep, IN-PROCESS (no server spawn) —
// requires server.js directly and drives the exported journalRecord/journalGc + journalGcProbe.
//
// Background: the global size cap used to run a full dirSize() sweep of EVERY session's checkpoint tree on
// EVERY checkpoint-triggering file write (O(all checkpoint files), awaited before the tool returns), so a
// single tool call's latency grew with the app's TOTAL checkpoint history (a 50-edit workflow = 50 sweeps).
// PF1 keeps a process-local approximate byte cache and only runs the authoritative sweep when it might matter.
//
// Asserts:
//  ① Cold start calibrates with exactly ONE sweep, and MANY subsequent journalGc calls under budget add ZERO
//     further sweeps (proves the sweep no longer runs on every call — the whole point of PF1).
//  ② When the cache-gated total crosses the cap, the authoritative sweep STILL purges whole sessions
//     oldest-first (cleaning is never skipped): the oldest session dir is gone, the newest survives, and the
//     on-disk total is back under the cap.
//  ③ Extra sweeps only happen when over budget (fullScans grows in phase ② but was pinned at 1 in phase ①).
// Judgement line (exact): CHECKPOINT-GC-CACHE E2E: ALL PASS
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-ckgc-cache-e2e');
const CAP = 50 * 1024;            // small cap so we can cross it deterministically without writing 200MB
const CHUNK = 12 * 1024;          // per-checkpoint incompressible before-content (gz ~= same size)

// Env MUST be set before requiring server.js: paths.checkpoints derives from RUYI_HOME and the cap constant
// reads RUYI_JOURNAL_GLOBAL_MAX_BYTES, both captured at module load.
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME;
process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES = String(CAP);
const srv = require(path.join(WB, 'app', 'server.js'));

const CK = path.join(HOME, 'checkpoints');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = n => crypto.randomBytes(n); // incompressible → gzip preserves size, so bytes are predictable
function dirSize(dir) {
  let total = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
  }
  return total;
}
const sessDirExists = sid => fs.existsSync(path.join(CK, sid));

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  try {
    // ── ① cold-start calibration = 1 sweep; many under-budget journalGc calls add NO further sweeps ──────
    const A = 'sess_ckgc_a';
    await srv.journalRecord(A, 1, 'file_edit', path.join(HOME, 'a1.txt'), 'modify', rnd(CHUNK));
    await srv.journalRecord(A, 2, 'file_edit', path.join(HOME, 'a2.txt'), 'modify', rnd(CHUNK));
    const scansAfterWrites = srv.journalGcProbe.fullScans;
    ok(scansAfterWrites === 1, '① cold start → exactly 1 authoritative sweep after 2 writes (got ' + scansAfterWrites + ')');
    ok(sessDirExists(A), '① session A checkpoint dir present (~24KB, under 50KB cap)');

    // Hammer journalGc while comfortably under budget: the sweep must NOT run again.
    for (let i = 0; i < 30; i++) await srv.journalGc(A);
    ok(srv.journalGcProbe.fullScans === scansAfterWrites,
       '① 30 extra journalGc calls under budget → ZERO extra sweeps (still ' + srv.journalGcProbe.fullScans + ') — no per-call full scan');
    ok(srv.journalGcProbe.calls >= 32, '① probe counted every journalGc call (calls=' + srv.journalGcProbe.calls + ')');

    const sweepsBeforeOverflow = srv.journalGcProbe.fullScans;

    // ── ② crossing the cap STILL purges oldest-first (cleaning never skipped) ────────────────────────────
    // Write more sessions (newest mtimes) so the cache-gated total crosses the cap and forces real sweeps
    // that purge whole oldest sessions. Sleep between sessions so dir mtimes are strictly increasing.
    for (const sid of ['sess_ckgc_b', 'sess_ckgc_c', 'sess_ckgc_d', 'sess_ckgc_e']) {
      await sleep(35);
      await srv.journalRecord(sid, 1, 'file_edit', path.join(HOME, sid + '1.txt'), 'modify', rnd(CHUNK));
      await srv.journalRecord(sid, 2, 'file_edit', path.join(HOME, sid + '2.txt'), 'modify', rnd(CHUNK));
    }

    ok(srv.journalGcProbe.fullScans > sweepsBeforeOverflow,
       '② over-budget writes triggered real sweeps (fullScans ' + sweepsBeforeOverflow + ' → ' + srv.journalGcProbe.fullScans + ')');
    ok(!sessDirExists('sess_ckgc_a'),
       '② oldest session (A) was PURGED once total exceeded the cap (cleaning not skipped by the cache)');
    ok(sessDirExists('sess_ckgc_e'),
       '② newest session (E) survives the purge');
    const remaining = fs.existsSync(CK) ? fs.readdirSync(CK).filter(n => fs.statSync(path.join(CK, n)).isDirectory()) : [];
    ok(remaining.length < 5, '② some sessions purged (surviving dirs=' + remaining.length + ' < 5)');
    const totalNow = dirSize(CK);
    ok(totalNow <= CAP, '② on-disk total back under the cap after purge (' + totalNow + ' <= ' + CAP + ')');

    // ── ③ safety: even after all the writes, the cache never left a stale dir over the cap ────────────────
    // One more journalGc must be idempotent (already under cap → no purge, total unchanged).
    await srv.journalGc('sess_ckgc_e');
    ok(dirSize(CK) === totalNow, '③ extra journalGc when already under cap is a no-op (idempotent)');

    // ── ④ PF1 FIX: writeHistorySnapshot (auto-compact safety net) grows the SAME cap-governed tree, but used
    //     to update NEITHER the byte cache NOR trigger a sweep. A compaction-heavy / edit-light session could
    //     therefore blow past the hard cap unbounded (journalGc is only called on file writes, which never
    //     happen in that load). Assert that repeated history snapshots ALONE (no journalRecord) both cross the
    //     cap AND get cleaned up: the fire-and-forget journalGc inside writeHistorySnapshot triggers a sweep
    //     (fullScans grows) that purges over-cap sessions oldest-first — proving the cap is no longer soft.
    const scansBeforeHist = srv.journalGcProbe.fullScans;
    // Each snapshot ~15KB incompressible (base64 of random bytes) → 2 snapshots/session ~30KB; 5 history-only
    // sessions ~150KB >> 50KB cap. Sleep between sessions so dir mtimes strictly increase (oldest-first purge).
    const histSessions = ['sess_ckgc_hist_a', 'sess_ckgc_hist_b', 'sess_ckgc_hist_c', 'sess_ckgc_hist_d', 'sess_ckgc_hist_e'];
    const bigHistory = () => [{ role: 'user', content: rnd(15 * 1024).toString('base64') }];
    for (const sid of histSessions) {
      await sleep(35);
      await srv.writeHistorySnapshot(sid, 1, bigHistory());
      await srv.writeHistorySnapshot(sid, 2, bigHistory());
    }
    await sleep(250); // let the fire-and-forget journalGc calls (dispatched under each session's write lock) drain
    ok(srv.journalGcProbe.fullScans > scansBeforeHist,
       '④ history snapshots ALONE auto-triggered a sweep (fullScans ' + scansBeforeHist + ' → ' + srv.journalGcProbe.fullScans + ') — NOT missed as pre-fix');
    const histTotal = dirSize(CK);
    ok(histTotal <= CAP, '④ over-cap history-only tree was purged back under the cap (' + histTotal + ' <= ' + CAP + ')');
    ok(!sessDirExists('sess_ckgc_hist_a'), '④ oldest history-only session (hist_a) purged (cap enforced, not soft)');
    ok(sessDirExists('sess_ckgc_hist_e'), '④ newest history-only session (hist_e) survives');

    // ── ⑤ 正在写快照的那一条会话,自己的检查点树就超过整仓上限:不许把它整个目录当「最旧」清掉 ────────────────
    //     (用户报告 observation_recall → `observation recall failed: ENOENT` 的根因:清扫把刚写完快照的活会话连目录删光,
    //      刚给出去的 rawRef 立刻失效、文件回滚点也一并消失。)旧会话照旧被清;受保护会话最多被削掉自己最旧的历史快照,最近几份与回滚点留着。
    await sleep(35);
    await srv.journalRecord('sess_ckgc_old_unrelated', 1, 'file_edit', path.join(HOME, 'u.txt'), 'modify', rnd(CHUNK));
    await sleep(60);
    const PROT = 'sess_ckgc_protected';
    await srv.journalRecord(PROT, 1, 'file_edit', path.join(HOME, 'p.txt'), 'modify', rnd(2 * 1024));
    let lastRef = '';
    for (let i = 1; i <= 8; i++) {
      await sleep(15);
      lastRef = await srv.writeHistorySnapshot(PROT, 7, [{ role: 'user', content: rnd(15 * 1024).toString('base64') }], true);
    }
    await sleep(400); // 让每次写后的 fire-and-forget journalGc / 清扫落定
    const protFiles = fs.existsSync(path.join(CK, PROT)) ? fs.readdirSync(path.join(CK, PROT)) : [];
    const protSnaps = protFiles.filter(f => /^history-7-[a-f0-9]{16}\.json\.gz$/.test(f));
    ok(sessDirExists(PROT), '⑤ 自己就超限的活会话(' + PROT + ')目录没被整仓清扫删掉(修前:整个目录消失)');
    ok(lastRef && protSnaps.includes(lastRef.replace(/^history:(\d+):/, 'history-$1-') + '.json.gz'), '⑤ 它刚写的最新快照(' + lastRef + ')仍在盘上,rawRef 可回读');
    ok(protFiles.includes('1-0.gz'), '⑤ 它的文件回滚点(1-0.gz)一份没动');
    ok(protSnaps.length >= 4, '⑤ 最近几份历史快照被保留(≥4,实际 ' + protSnaps.length + ')');
    ok(!sessDirExists('sess_ckgc_old_unrelated'), '⑤ 与本会话无关的旧会话照旧被按上限清掉(上限没被放弃)');
  } catch (e) {
    console.log('ERROR ' + (e && e.stack || e.message || e)); fail++;
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCHECKPOINT-GC-CACHE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
