// E2E (第40波): boot 中断恢复并发化 + syncRunEventSeq 尾窗化。
//   (U) 单元(require server.js,临时 RUYI_HOME):
//       ① mapPool 结果保序+全执行;  ② mapPool 真并发(1 < maxInFlight ≤ limit);
//       ③ syncRunEventSeq 小文件全读快进;  ④ 大文件(>512KB)尾窗与独立全扫结果一致;
//       ⑤ 窗内无任何 seq(>窗巨单行收尾)→ 回落全读仍正确;  ⑥ 撕裂尾行与旧全读同语义。
//   (L) 集成(真 boot 子进程):
//       ① running run × 6(各 ~1MB events)→ boot 全标 interrupted + run_interrupted 的 seq 精确快进
//         (证明尾窗路径在 boot 里生效且不错号)+ 宽松防卡死上界;
//       ② autoResume: exec-tier interrupted → paused + run_resume_deferred;
//          wait-node interrupted → autoResumeCount+1 先落盘 + run_auto_resume 事件(launch 无 provider
//          失败不影响护栏已落盘的观测)。
// Judgement line (exact): BOOT-RESUME-PARALLEL E2E: ALL PASS
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-boot-resume-e2e');   // 单元层 dataRoot
const HOME2 = path.join(os.tmpdir(), 'wcw-boot-resume-e2e-live'); // 集成层 dataRoot(子进程)
const { getFreePort } = require('./free-port.js');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // paths.* 在 module load 时定型,必须先设
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ──────────────────────── (U) 单元层 ────────────────────────
  // ① mapPool 保序 + 全执行
  {
    const items = Array.from({ length: 9 }, (_, i) => i);
    const out = await srv.mapPool(items, 4, async i => { await sleep(5); return i * 3; });
    ok(JSON.stringify(out) === JSON.stringify(items.map(i => i * 3)), 'U1 mapPool 结果保序且全执行');
  }
  // ② mapPool 真并发(受控延迟:顺序需 8×40=320ms,池(4) 应 ~80-120ms;跟踪 in-flight 证并发且有界)
  {
    let inFlight = 0, maxInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    const t0 = Date.now();
    await srv.mapPool(items, 4, async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(40); inFlight--; });
    const wall = Date.now() - t0;
    ok(maxInFlight > 1 && maxInFlight <= 4, 'U2 mapPool 并发度 1 < max(' + maxInFlight + ') ≤ 4');
    ok(wall < 280, 'U2 mapPool wall ' + wall + 'ms < 280ms(顺序需 ≥320ms,证明非串行)');
  }
  // ③-⑥ syncRunEventSeq
  const RUNS = () => path.join(HOME, 'agent-runs');
  const evFile = (sid, rid) => path.join(RUNS(), sid, rid + '.events.ndjson');
  const seedEvents = (sid, rid, lines) => {
    fs.mkdirSync(path.join(RUNS(), sid), { recursive: true });
    fs.writeFileSync(evFile(sid, rid), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  };
  const evLine = n => JSON.stringify({ seq: n, ts: '2026-07-18T00:00:00.000Z', runId: 'run_x', type: 'node_event', data: { pad: 'p'.repeat(60) } });
  // ③ 小文件:全读路径快进
  {
    seedEvents('sessu3', 'run_u3', [evLine(1), evLine(2), evLine(3)]);
    const run = { sessionId: 'sessu3', id: 'run_u3', eventSeq: 1 };
    await srv.syncRunEventSeq(run);
    ok(run.eventSeq === 3, 'U3 小文件全读快进 eventSeq 1→3(got ' + run.eventSeq + ')');
  }
  // ④ 大文件(8000 行 ≈ 900KB > 512KB 窗):尾窗结果 == 独立全扫
  {
    const lines = []; for (let i = 1; i <= 8000; i++) lines.push(evLine(i));
    seedEvents('sessu4', 'run_u4', lines);
    const raw = fs.readFileSync(evFile('sessu4', 'run_u4'), 'utf8');
    ok(raw.length > 512 * 1024, 'U4 夹具确超尾窗阈值(' + raw.length + 'B)');
    let truth = 0; for (const l of raw.split('\n')) { const m = l.match(/"seq":(\d+)/); if (m && +m[1] > truth) truth = +m[1]; }
    const run = { sessionId: 'sessu4', id: 'run_u4', eventSeq: 7990 };
    await srv.syncRunEventSeq(run);
    ok(run.eventSeq === truth && truth === 8000, 'U4 大文件尾窗快进 == 全扫真值(' + run.eventSeq + ' == ' + truth + ')');
  }
  // ⑤ 窗内无任何 seq(>窗巨单行收尾):回落全读仍正确(无回落则会漏掉 seq:1,eventSeq 停在 0)
  {
    fs.mkdirSync(path.join(RUNS(), 'sessu5'), { recursive: true });
    const giant = JSON.stringify({ ts: '2026-07-18T00:00:00.000Z', type: 'huge', data: { blob: 'y'.repeat(600 * 1024) } });
    fs.writeFileSync(evFile('sessu5', 'run_u5'), evLine(1) + '\n' + giant + '\n', 'utf8');
    const run = { sessionId: 'sessu5', id: 'run_u5', eventSeq: 0 };
    await srv.syncRunEventSeq(run);
    ok(run.eventSeq === 1, 'U5 窗内无 seq → 回落全读,eventSeq 0→1(got ' + run.eventSeq + ')');
  }
  // ⑥ 撕裂尾行(无 \n 终结的半行,但 "seq":N 前缀完整):与旧全读同语义 —— regex 扫片段,快进到撕裂行 seq
  {
    const lines = []; for (let i = 1; i <= 8000; i++) lines.push(evLine(i));
    fs.mkdirSync(path.join(RUNS(), 'sessu6'), { recursive: true });
    fs.writeFileSync(evFile('sessu6', 'run_u6'), lines.join('\n') + '\n' + '{"seq":9999,"ts":"2026-07-18T00:00', 'utf8'); // 撕裂:JSON 半行,无终结 \n
    const run = { sessionId: 'sessu6', id: 'run_u6', eventSeq: 8000 };
    await srv.syncRunEventSeq(run);
    ok(run.eventSeq === 9999, 'U6 撕裂尾行同旧语义:扫到片段内完整 "seq" 前缀(got ' + run.eventSeq + ')');
  }

  // ──────────────────────── (L) 集成层(真 boot) ────────────────────────
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(HOME2, { recursive: true });
  fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({ configSchema: 4, version: '0.7.0', permissionMode: 'bypass', autonomyAutoResume: true }, null, 2));
  const mkRun = (sid, rid, status, nodes, eventSeq) => {
    const dir = path.join(HOME2, 'agent-runs', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, rid + '.json'), JSON.stringify({
      id: rid, sessionId: sid, status, createdAt: '2026-07-18T01:00:00.000Z', updatedAt: '2026-07-18T01:00:00.000Z',
      permissionModeAtLaunch: 'bypass', eventSeq, nodes,
    }, null, 2));
    return dir;
  };
  // L1: 6 个 running run,各 1000 行 ≈ 1MB 事件(快进到 seq 1000 后,run_interrupted 应落 seq 1001)
  // run id 必须全 hex(listAgentRuns 只收 /^run_[a-f0-9]+\.json$/i)。
  const l1Runs = [];
  for (let i = 0; i < 6; i++) {
    const sid = 'sessl1' + i, rid = 'run_' + (0x100 + i).toString(16).padStart(8, '0');
    const dir = mkRun(sid, rid, 'running', [{ id: 'n1', status: 'running', engine: 'openai', toolTier: 'read' }], 990);
    const lines = []; for (let s = 1; s <= 1000; s++) lines.push(JSON.stringify({ seq: s, ts: '2026-07-18T00:00:00.000Z', runId: rid, type: 'node_output', data: { pad: 'q'.repeat(900) } }));
    fs.writeFileSync(path.join(dir, rid + '.events.ndjson'), lines.join('\n') + '\n', 'utf8');
    l1Runs.push({ sid, rid });
  }
  // L2a: exec-tier interrupted → manual → paused + deferred;L2b: wait-node interrupted → auto_resumable → 护栏落盘
  mkRun('sessl2a', 'run_00000a01', 'interrupted', [{ id: 'n1', status: 'interrupted', engine: 'openai', toolTier: 'exec' }], 0);
  mkRun('sessl2b', 'run_00000b01', 'interrupted', [{ id: 'n1', status: 'interrupted', engine: 'openai', wait: { kind: 'timer', seconds: 60 } }], 0);

  const WB_PORT = await getFreePort();
  // 子进程环境:删掉单元层的 RUYI_HOME(spawn env 里写 undefined 会变成字符串 "undefined" 的经典坑),
  // 只认 WIN_CLAUDE_WORKBENCH_HOME(与 resume-dangling 同款)。
  const childEnv = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2 };
  delete childEnv.RUYI_HOME;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: childEnv, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  const health = () => new Promise(res => { const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => res(resp.statusCode === 200)); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
  const readRun = (sid, rid) => { try { return JSON.parse(fs.readFileSync(path.join(HOME2, 'agent-runs', sid, rid + '.json'), 'utf8')); } catch { return null; } };
  const lastEventLine = (sid, rid) => {
    try { const ls = fs.readFileSync(path.join(HOME2, 'agent-runs', sid, rid + '.events.ndjson'), 'utf8').split('\n').filter(Boolean); return ls.length ? JSON.parse(ls[ls.length - 1]) : null; } catch { return null; }
  };
  try {
    const t0 = Date.now();
    let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(250); up = await health(); }
    const bootMs = Date.now() - t0;
    ok(up, 'L1 workbench up on :' + WB_PORT + '(boot ' + bootMs + 'ms)');
    ok(bootMs < 30000, 'L1 boot 防卡死上界(' + bootMs + 'ms < 30s;markInterrupted 是 listen 前 await)');
    // L1: run_interrupted 经 appendAgentRunEvent 异步写链落盘(markInterrupted 不 await 它);且 autoResume
    // 随后会在同一文件追加 run_auto_resume 等事件 —— 断言对象是【尾部窗口里的 run_interrupted 行】而非最后一行。
    let allInterrupted = true, seqOk = true;
    const tailEvents = (sid, rid, n) => {
      try { const ls = fs.readFileSync(path.join(HOME2, 'agent-runs', sid, rid + '.events.ndjson'), 'utf8').split('\n').filter(Boolean); return ls.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
    };
    for (const { sid, rid } of l1Runs) {
      const r = readRun(sid, rid);
      if (!r || r.status !== 'interrupted') allInterrupted = false;
      let hit = null;
      for (let i = 0; i < 40 && !hit; i++) { hit = tailEvents(sid, rid, 6).find(e => e.type === 'run_interrupted') || null; if (!hit) await sleep(150); }
      // 快进证明:夹具 eventSeq=990、磁盘事件到 1000 → run_interrupted 必须落 1001(尾窗错号会落 991 或偏小)
      if (!hit || hit.seq !== 1001) seqOk = false;
    }
    ok(allInterrupted, 'L1 6 个 running run 全标 interrupted');
    ok(seqOk, 'L1 run_interrupted 落 seq 1001(大文件尾窗快进精确,未错号)');
    // L2: autoResume 是 fire-and-forget —— 轮询等终态
    let l2a = null, l2b = null, deferred = null, autoEvt = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      l2a = readRun('sessl2a', 'run_00000a01');
      l2b = readRun('sessl2b', 'run_00000b01');
      deferred = lastEventLine('sessl2a', 'run_00000a01');
      const bDone = l2b && Number(l2b.autoResumeCount) >= 1;
      if (l2a && l2a.status === 'paused' && deferred && deferred.type === 'run_resume_deferred' && bDone) break;
    }
    ok(l2a && l2a.status === 'paused' && deferred && deferred.type === 'run_resume_deferred',
      'L2a exec-tier interrupted → paused + run_resume_deferred(got status=' + (l2a && l2a.status) + ', evt=' + (deferred && deferred.type) + ')');
    ok(l2b && Number(l2b.autoResumeCount) === 1 && l2b.resumeTier === 'auto_resumable',
      'L2b wait-node interrupted → autoResumeCount=1 护栏先落盘(got ' + (l2b && l2b.autoResumeCount) + ', tier=' + (l2b && l2b.resumeTier) + ')');
    autoEvt = lastEventLine('sessl2b', 'run_00000b01');
    ok(autoEvt && (autoEvt.type === 'run_auto_resume' || autoEvt.type === 'run_started' || autoEvt.type === 'run_resumed'),
      'L2b run_auto_resume 事件已 append(got ' + (autoEvt && autoEvt.type) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(HOME2, { recursive: true, force: true });
    console.log('\nBOOT-RESUME-PARALLEL E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
