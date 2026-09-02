#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// exec-result-cache.e2e.js — 106 #2a 受限执行结果缓存(22 号文 §6.1)
//
// 覆盖:
//   [U] 开关三态/上限钳位 + 直调 toolCall 的行为矩阵:
//       冷 miss→store→hit、结果等价(命中仅多 cacheHit 标记)、外部写入/删除/重建失效、
//       错误不缓存、权限隔离(命中前重新验权,拒绝不泄内容不污染缓存)、参数归一与
//       分段、行/列模式分键、会话隔离、LRU 淘汰、中断不缓存、开关关零缓存路径。
//   [E] 集成(fake-openai + FAKE_TOOL_SEQUENCE 两次相同 file_read):
//       开关开:第二次调用命中(exec_result_cache hit/store 事件 + 配对 tool 消息仅差
//       cacheHit 标记);开关关:零缓存事件、两条 tool 消息逐字节一致(现状基线)。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 隔离纪律(同 budget-guard):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-2a-unit-'));

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function postStream(port, payload) { return new Promise(resolve => { const events = []; const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let buf = ''; res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } }); res.on('end', () => resolve(events)); }); req.on('error', () => resolve(events)); req.on('timeout', () => { req.destroy(); resolve(events); }); req.write(data); req.end(); }); }

// 起一套 fake-openai + workbench;flags 写进 config.json;fakeEnv 追加环境变量。
async function launchStack(tag, flags, fakeEnv) {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-2a-e-' + tag + '-'));
  const CAP = path.join(EHOME, 'caps'); fs.mkdirSync(CAP, { recursive: true });
  fs.writeFileSync(path.join(EHOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', allowOutsideWorkspace: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 40000 }],
    activeProvider: 'fake',
    autoCompactThreshold: 0.8,
    ...(flags || {}),
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_CAPTURE_DIR: CAP, ...(fakeEnv || {}) },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: EHOME, RUYI_HOME: EHOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!' + tag + '] ' + l.trim())));
  let h = null; for (let i = 0; i < 80 && !h; i++) { await sleep(250); h = await new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 3000 }, res => { res.resume(); resolve({ status: res.statusCode }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
  const readCap = n => { try { return JSON.parse(fs.readFileSync(path.join(CAP, 'req-' + String(n).padStart(3, '0') + '.json'), 'utf8')); } catch { return null; } };
  const capCount = () => { try { return fs.readdirSync(CAP).filter(f => f.startsWith('req-')).length; } catch { return 0; } };
  // logEvent 是异步追加流 —— 轮询读当日 ndjson,容忍 flush 延迟。
  const logFile = path.join(EHOME, 'logs', 'workbench-' + new Date().toISOString().slice(0, 10) + '.ndjson');
  const waitLog = async (pred, ms) => {
    const deadline = Date.now() + (ms || 4000);
    while (Date.now() < deadline) {
      let lines = []; try { lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* not yet */ }
      const hit = lines.filter(pred);
      if (hit.length) return hit;
      await sleep(200);
    }
    return [];
  };
  const cleanup = async () => { kill(wb); kill(fake); await sleep(300); fs.rmSync(EHOME, { recursive: true, force: true }); };
  return { EHOME, WB_PORT, CAP, readCap, capCount, waitLog, cleanup, healthy: !!h };
}
// 捕获请求里 role:'tool' 消息解析后的对象列表。
function toolMsgs(body) {
  return (((body && body.messages) || []).filter(m => m && m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return null; } }));
}

(async () => {
  console.log('── [U] 开关三态 / 上限钳位 ──');
  ok(srv.execResultCacheEnabled(srv.defaultConfig()) === true, 'U1 默认配置结果缓存开启(大文件真实门后,显式 false 回退)');
  ok(srv.execResultCacheEnabled({ runtimeExecResultCacheV1: true }) === true, 'U2 显式 true 生效(上限缺省 200)');
  ok(srv.execResultCacheEnabled({ runtimeExecResultCacheV1: true, execResultCacheMaxEntriesV1: 0 }) === false, 'U3 上限 0 → 不缓存(双门之二)');
  const cfgStr = srv.normalizeConfig({ runtimeExecResultCacheV1: 'true' }).config;
  ok(srv.execResultCacheEnabled(cfgStr) === false, 'U4 字符串 "true" 洗回 false(严格布尔)');
  ok(srv.execResultCacheMaxEntries({ execResultCacheMaxEntriesV1: -5 }) === 0 && srv.execResultCacheMaxEntries({ execResultCacheMaxEntriesV1: 99999 }) === 2000 && srv.execResultCacheMaxEntries({ execResultCacheMaxEntriesV1: 'x' }) === 200, 'U5 上限钳位 [0,2000],坏值落默认 200');
  ok(srv.execResultCacheMaxEntries(srv.normalizeConfig({ execResultCacheMaxEntriesV1: 99999 }).config) === 2000, 'U6 sanitize 钳位同步落盘');

  console.log('── [U] 行为矩阵(直调 toolCall) ──');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-2a-files-'));
  const F1 = path.join(TMP, 'a.txt'); fs.writeFileSync(F1, 'alpha-内容-v1');
  const ctxOn = sid => ({ sessionId: sid, config: { allowOutsideWorkspace: true, runtimeExecResultCacheV1: true } });
  const read1 = (ctx, extra) => srv.toolCall('file_read', { path: F1, ...(extra || {}) }, ctx);

  const r1 = await read1(ctxOn('u-main'));
  ok(r1 && r1.ok === true && r1.content === 'alpha-内容-v1' && !('cacheHit' in r1), 'U7 首读冷 miss:结果正常且无 cacheHit 标记');
  const r2 = await read1(ctxOn('u-main'));
  ok(r2 && r2.ok === true && r2.cacheHit && typeof r2.cacheHit.cachedAt === 'number', 'U8 二读命中:带 cacheHit 诚实标记(不冒称重新执行)');
  const strip = o => { const c = { ...o }; delete c.cacheHit; return JSON.stringify(c); };
  ok(strip(r1) === strip(r2), 'U9 结果等价:命中结果除 cacheHit 外与冷读逐字节一致');

  const r3 = await srv.toolCall('file_read', { path: F1, annotate_non_ascii: true }, ctxOn('u-main'));
  const r4 = await srv.toolCall('file_read', { path: F1, annotate_non_ascii: 'true' }, ctxOn('u-main'));
  ok(r3.ok && !r3.cacheHit && r4.ok && !!r4.cacheHit, 'U10 参数归一:annotate true 与 "true" 同键命中(handler 布尔口径)');
  const r5 = await srv.toolCall('file_read', { path: F1, limit: 100000 }, ctxOn('u-main'));
  const r6 = await srv.toolCall('file_read', { path: F1, limit: 100000 }, ctxOn('u-main'));
  ok(r5.ok && !r5.cacheHit && r6.ok && !!r6.cacheHit, 'U11 显式 limit 与缺省分键(宁多分段);同键复读命中');

  fs.writeFileSync(F1, 'beta-内容-v2-更长的内容改变size');
  const r7 = await read1(ctxOn('u-main'));
  ok(r7.ok && !r7.cacheHit && r7.content === 'beta-内容-v2-更长的内容改变size', 'U12 外部写入 → 版本失效重读,内容为新值(不依赖如意写工具监听)');
  const r8 = await read1(ctxOn('u-main'));
  ok(r8.ok && !!r8.cacheHit && r8.content === r7.content, 'U13 失效后重存,再次复读命中新内容');

  fs.rmSync(F1);
  const r9 = await read1(ctxOn('u-main'));
  ok(r9 && r9.ok === false && !r9.cacheHit && /不存在/.test(String(r9.error)), 'U14 外部删除 → miss 走 ENOENT 现状路径(不供旧缓存)');
  const r9b = await read1(ctxOn('u-main'));
  ok(r9b && r9b.ok === false && !r9b.cacheHit, 'U15 错误结果不缓存:再次读仍走真实路径');
  fs.writeFileSync(F1, 'gamma-v3');
  const r10 = await read1(ctxOn('u-main'));
  ok(r10.ok && !r10.cacheHit && r10.content === 'gamma-v3', 'U16 删除后重建 → miss 读到新文件');

  { // 权限隔离:命中前重新验权 —— 远端 provider 配置下越界读必须拒,且不得泄缓存内容、不得污染缓存。
    const sid = 'u-perm';
    const rp = await read1(ctxOn(sid));
    ok(rp.ok === true, 'U17a 预存:允许配置下读成功');
    const denyCfg = { runtimeExecResultCacheV1: true, providers: [{ id: 'r', type: 'openai-compat', baseUrl: 'https://remote.example.com', apiKey: 'k', model: 'm' }], activeProvider: 'r' };
    const rd = await srv.toolCall('file_read', { path: F1 }, { sessionId: sid, config: denyCfg });
    ok(rd && rd.ok === false && !rd.content && /拒绝|不在允许/.test(String(rd.error || '')), 'U17b 命中在场时越权 ctx 仍被拒(缓存查找在守卫之后,零内容泄露)');
    const rp2 = await read1(ctxOn(sid));
    ok(rp2.ok === true && !!rp2.cacheHit, 'U17c 拒绝不污染缓存:恢复原 ctx 仍命中');
  }

  const rLine = await srv.toolCall('file_read', { path: F1, lineOffset: 1 }, ctxOn('u-main'));
  ok(rLine.ok && rLine.mode === 'lines' && !rLine.cacheHit, 'U18 行模式与字符模式分键(行模式首读 miss)');
  const rIso = await srv.toolCall('file_read', { path: F1 }, ctxOn('u-other-session'));
  ok(rIso.ok && !rIso.cacheHit, 'U19 会话隔离:同文件异 sessionId 冷 miss(跨会话不共享,22 §6.1 首批范围)');

  { // LRU 淘汰:上限 2,依次读 A B C → A 被淘汰。
    const sid = 'u-evict';
    const ctxE = { sessionId: sid, config: { allowOutsideWorkspace: true, runtimeExecResultCacheV1: true, execResultCacheMaxEntriesV1: 2 } };
    const FA = path.join(TMP, 'ea.txt'), FB = path.join(TMP, 'eb.txt'), FC = path.join(TMP, 'ec.txt');
    fs.writeFileSync(FA, 'EA'); fs.writeFileSync(FB, 'EB'); fs.writeFileSync(FC, 'EC');
    await srv.toolCall('file_read', { path: FA }, ctxE);
    await srv.toolCall('file_read', { path: FB }, ctxE);
    await srv.toolCall('file_read', { path: FC }, ctxE);
    const reA = await srv.toolCall('file_read', { path: FA }, ctxE);
    const reC = await srv.toolCall('file_read', { path: FC }, ctxE);
    ok(reA.ok && !reA.cacheHit && reC.ok && !!reC.cacheHit, 'U20 LRU:上限 2 时最旧条目被淘汰,新条目保留');
  }

  { // 中断不缓存:signal 已 aborted 的调用结果正常返回但不入库。
    const sid = 'u-abort';
    const FA = path.join(TMP, 'ab.txt'); fs.writeFileSync(FA, 'ABORT-ME');
    const ctxAb = { sessionId: sid, config: { allowOutsideWorkspace: true, runtimeExecResultCacheV1: true }, signal: { aborted: true } };
    const ra = await srv.toolCall('file_read', { path: FA }, ctxAb);
    const rb = await srv.toolCall('file_read', { path: FA }, ctxOn(sid));
    ok(ra.ok && !ra.cacheHit && rb.ok && !rb.cacheHit, 'U21 中断信号下的结果不缓存(22 §6.1 不缓存中断结果)');
  }

  const rOff1 = await srv.toolCall('file_read', { path: F1 }, { sessionId: 'u-off', config: { allowOutsideWorkspace: true } });
  const rOff2 = await srv.toolCall('file_read', { path: F1 }, { sessionId: 'u-off', config: { allowOutsideWorkspace: true } });
  ok(rOff1.ok && rOff2.ok && !('cacheHit' in rOff1) && !('cacheHit' in rOff2) && JSON.stringify(rOff1) === JSON.stringify(rOff2), 'U22 开关关:两次读结果逐字节一致、零缓存字段(现状回退)');

  console.log('── [E] 集成:两次相同 file_read(开关开 vs 关) ──');
  const EFILE = path.join(TMP, 'e2e-target.txt');
  fs.writeFileSync(EFILE, 'E2E-CACHE-TARGET-CONTENT');
  const SEQ2 = JSON.stringify([{ name: 'file_read', args: { path: EFILE } }, { name: 'file_read', args: { path: EFILE } }]);
  { // A: 开关关基线 —— 零缓存事件,两条 tool 消息逐字节一致(现状)。
    const A = await launchStack('off', { runtimeExecResultCacheV1: false }, { FAKE_TOOL_SEQUENCE: SEQ2 });
    ok(A.healthy, 'E0a workbench A listening on :' + A.WB_PORT);
    try {
      const ev = await postStream(A.WB_PORT, { message: '把目标文件读两遍' });
      ok(A.capCount() === 3 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E1 基线:3 次模型调用跑完两次读');
      const tm = toolMsgs(A.readCap(3));
      ok(tm.length === 2 && tm[0] && tm[1] && JSON.stringify(tm[0]) === JSON.stringify(tm[1]) && !('cacheHit' in tm[0]), 'E2 基线:两条配对 tool 消息逐字节一致且无 cacheHit(现状锁定)');
      const logs = await A.waitLog(l => l.kind === 'exec_result_cache', 1500);
      ok(logs.length === 0, 'E3 基线:零 exec_result_cache 事件(开关关零开销)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await A.cleanup(); }
  }
  { // B: 开关开 —— 第二次读命中,事件账齐全,配对消息仅差 cacheHit 标记。
    const B = await launchStack('on', { runtimeExecResultCacheV1: true }, { FAKE_TOOL_SEQUENCE: SEQ2 });
    ok(B.healthy, 'E0b workbench B listening on :' + B.WB_PORT);
    try {
      const ev = await postStream(B.WB_PORT, { message: '把目标文件读两遍' });
      ok(B.capCount() === 3 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E4 开关开:3 次模型调用跑完(缓存不改编排)');
      const tm = toolMsgs(B.readCap(3));
      ok(tm.length === 2 && tm[0] && !('cacheHit' in tm[0]) && tm[1] && !!tm[1].cacheHit, 'E5 第一次读正常执行、第二次读带 cacheHit 标记(诚实来源)');
      const s0 = { ...tm[0] }; const s1 = { ...tm[1] }; delete s1.cacheHit;
      ok(JSON.stringify(s0) === JSON.stringify(s1), 'E6 结果等价:命中消息除 cacheHit 外与首读逐字节一致');
      const logs = await B.waitLog(l => l.kind === 'exec_result_cache' && l.outcome === 'hit', 4000);
      ok(logs.length === 1 && typeof logs[0].bytes === 'number' && typeof logs[0].lookupMs === 'number', 'E7 命中落审计账:恰好一条 hit,含 bytes/lookupMs(命中开销口径)');
      const all = await B.waitLog(l => l.kind === 'exec_result_cache', 1000);
      ok(all.some(l => l.outcome === 'miss' && l.reason === 'cold') && all.some(l => l.outcome === 'store'), 'E8 零命中路径落账:cold miss + store(零命中开销可计量)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await B.cleanup(); }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\nEXEC-RESULT-CACHE E2E: ALL PASS' : `\nEXEC-RESULT-CACHE E2E: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
