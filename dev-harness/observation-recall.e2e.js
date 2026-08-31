#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// observation-recall.e2e.js — 第 105 波切片 a · observation_recall 工具外壳(23 号方案 §4.1)
//
// 覆盖:
//   [U] 白盒(require server.js,临时数据根):
//       happy path 逐字节还原 / maxChars head-tail 截断 / 每回合配额 8 次第 9 次 quota_exceeded /
//       双开关关闭 → disabled / 伪造 rawRef → invalid_ref / 篡改内容 hash → hash_mismatch /
//       不存在快照 → not_found / args.sessionId 伪造被忽略(只按 ctx 会话解析) /
//       缩减视图回读提示仅在开关生效时出现(默认关零漂移) / buildOpenAiTools offer 门
//   [R] 跨进程:本进程写快照,子进程 rehydrateObservation 仍成功(rawRef 跨重启可解析)
//   [E] 集成(fake-openai + 双开关):真实 HTTP 回合中 fake 主动调用 observation_recall →
//       offer 门生效 + 稳定信封(invalid_ref)经 HTTP 链路回传 + 配对铁律
//       (真实 rawRef 回读成功见 observation-recall-realhistory.e2e.js)
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// 隔离纪律:require server.js 之前把数据根指向临时目录(快照会写 <data>/checkpoints)。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105a-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function postStream(port, payload) { return new Promise(resolve => { const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let buf = ''; const events = []; res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } }); res.on('end', () => resolve(events)); }); req.on('error', () => resolve(events)); req.on('timeout', () => { req.destroy(); resolve(events); }); req.write(data); req.end(); }); }

function writeCfg(flags) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true, ...(flags || {}),
  }, null, 2));
}

(async () => {
  // ═══ [U] 白盒:工具外壳契约 ═══
  console.log('── [U] observation_recall 白盒契约 ──');
  const SID = 'recall-u1';
  const BIG = 'observation-payload ' + 'x'.repeat(6000);
  const history = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: BIG },
    { role: 'assistant', content: 'done' },
  ];
  const prefix = await srv.writeHistorySnapshot(SID, 7, history, true);
  ok(/^history:7:[a-f0-9]{16}$/.test(prefix), 'U0 stable 快照前缀已生成(' + prefix + ')');
  const contentHash = crypto.createHash('sha256').update(BIG).digest('hex').slice(0, 16);
  const rawRef = `${prefix}:2:${contentHash}`;
  const ctx = { session: { id: SID, providerHistory: [{ role: 'user', content: 'u1' }] } };

  writeCfg(); // 双开关开
  const r1 = await srv.toolCall('observation_recall', { rawRef }, ctx);
  ok(r1.ok === true && r1.content === BIG && r1.originalChars === BIG.length && r1.truncated === false && r1.toolCallId === 'c1',
    'U1 happy path 逐字节还原原文');
  const r2 = await srv.toolCall('observation_recall', { rawRef, maxChars: 1000 }, ctx);
  ok(r2.ok === true && r2.truncated === true && r2.content.length < BIG.length && r2.content.includes('chars omitted'),
    'U2 maxChars=1000 head/tail 截断并标注');
  const r3 = await srv.toolCall('observation_recall', { rawRef: 'not-a-ref' }, ctx);
  ok(r3.ok === false && r3.error === 'invalid_ref', 'U3 伪造 rawRef → invalid_ref');
  const tampered = rawRef.slice(0, -1) + (rawRef.endsWith('0') ? '1' : '0');
  const r4 = await srv.toolCall('observation_recall', { rawRef: tampered }, ctx);
  ok(r4.ok === false && r4.error === 'hash_mismatch', 'U4 篡改内容 hash → hash_mismatch');
  const r5 = await srv.toolCall('observation_recall', { rawRef: 'history:7:ffffffffffffffff:2:' + contentHash }, ctx);
  ok(r5.ok === false && r5.error === 'not_found', 'U5 不存在快照 → not_found');
  const r6 = await srv.toolCall('observation_recall', { rawRef, sessionId: 'evil-other-session' }, ctx);
  ok(r6.ok === true && r6.content === BIG, 'U6 args.sessionId 伪造被忽略(仍按 ctx 会话解析)');
  // 已用 6 次(失败调用同样计配额定,防滥用循环);第 7/8 次成功,第 9 次超额
  await srv.toolCall('observation_recall', { rawRef }, ctx);
  await srv.toolCall('observation_recall', { rawRef }, ctx);
  const r9 = await srv.toolCall('observation_recall', { rawRef }, ctx);
  ok(r9.ok === false && r9.error === 'quota_exceeded', 'U7 每回合配额 8 次,第 9 次 → quota_exceeded');
  // 下一回合(user 数 +1)配额独立恢复
  const ctx2 = { session: { id: SID, providerHistory: [{ role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }] } };
  const r10 = await srv.toolCall('observation_recall', { rawRef }, ctx2);
  ok(r10.ok === true, 'U8 新回合配额独立恢复');

  writeCfg({ runtimeObservationRecallV1: false }); // recall 关、reducer 开
  const r11 = await srv.toolCall('observation_recall', { rawRef }, ctx2);
  ok(r11.ok === false && r11.error === 'disabled', 'U9 recall 单关 → disabled(fail-closed)');
  writeCfg({ runtimeObservationReducerV1: false }); // 双关
  const r12 = await srv.toolCall('observation_recall', { rawRef }, ctx2);
  ok(r12.ok === false && r12.error === 'disabled', 'U10 双关 → disabled');
  writeCfg(); // 恢复双开,供 [R]/[E]

  // 缩减视图回读提示:仅在 recall 生效时出现;默认关时文案逐字节不变
  const textBig = 'z'.repeat(5000);
  const refDummy = 'history:1:aaaaaaaaaaaaaaaa:0:bbbbbbbbbbbbbbbb';
  const withHint = srv.reduceObservationContent('file_read', textBig, refDummy, { recallEnabled: true });
  const noHint = srv.reduceObservationContent('file_read', textBig, refDummy);
  ok(withHint.reduced && withHint.content.includes('recall=observation_recall(rawRef)') && withHint.content.includes('do not conclude that a fact is absent'), 'U11 开关生效时缩减视图含回读决策提示');
  ok(noHint.reduced && !noHint.content.includes('recall=') && !noHint.content.includes('Recovery instruction'), 'U12 默认关时缩减视图零提示(快照零漂移)');
  const jsonBig = JSON.stringify({ data: 'q'.repeat(5000) });
  const jsonHint = srv.reduceObservationContent('file_read', jsonBig, refDummy, { recallEnabled: true });
  ok(jsonHint.reduced && jsonHint.content.includes('"recall":"observation_recall(rawRef)"') && jsonHint.content.includes('"instruction":"This view is incomplete.'), 'U13 JSON 缩减 meta 含回读决策提示');

  // offer 门:105a 实历史采用门通过后默认出现；显式双关可完整回退隐藏。
  const cfgDefault = srv.normalizeConfig({}).config;
  const toolsDefault = srv.buildOpenAiTools(cfgDefault, null, {});
  ok(toolsDefault.some(t => t.function && t.function.name === 'observation_recall'), 'U14 默认配置 offer observation_recall');
  const cfgOff = srv.normalizeConfig({ runtimeObservationReducerV1: false, runtimeObservationRecallV1: false }).config;
  const toolsOff = srv.buildOpenAiTools(cfgOff, null, {});
  ok(!toolsOff.some(t => t.function && t.function.name === 'observation_recall'), 'U14b 显式双关隐藏 observation_recall');
  const cfgOn = srv.normalizeConfig({ runtimeObservationReducerV1: true, runtimeObservationRecallV1: true }).config;
  const toolsOn = srv.buildOpenAiTools(cfgOn, null, {});
  const recallTool = toolsOn.find(t => t.function && t.function.name === 'observation_recall');
  ok(recallTool && /before answering/.test(recallTool.function.description) && /never conclude/.test(recallTool.function.description), 'U15 双开时 offer observation_recall 且工具描述含调用条件');
  const recallPrompt = srv.buildObservationRecallPrompt([{ role: 'tool', content: withHint.content }], cfgOn);
  ok(recallPrompt.includes(refDummy) && recallPrompt.includes('before answering') && srv.buildObservationRecallPrompt([{ role: 'tool', content: withHint.content }], cfgOff) === '', 'U15b recovery index 双开时携带 rawRef、默认关闭时为空');
  // 目录门:adaptiveCatalogForMcp 同样按开关隐藏
  const catOff = await srv.adaptiveCatalogForMcp(cfgOff);
  const catOn = await srv.adaptiveCatalogForMcp(cfgOn);
  const catNames = c => (c.catalog.tools || c.catalog || []).map(t => (t.function && t.function.name) || t.name);
  ok(!catNames(catOff).includes('observation_recall') && catNames(catOn).includes('observation_recall'), 'U16 adaptive 目录按双开关隐藏/显示');

  // ═══ [R] 跨进程:rawRef 跨重启可解析 ═══
  console.log('── [R] 跨进程 rehydrate ──');
  {
    const child = cp.spawnSync(process.execPath, ['-e',
      `const srv=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});` +
      `srv.rehydrateObservation(${JSON.stringify(SID)},${JSON.stringify(rawRef)}).then(r=>{console.log(JSON.stringify({ok:r.ok,len:r.content&&r.content.length}));});`],
      { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, encoding: 'utf8', timeout: 30000 });
    let out = null; try { out = JSON.parse(String(child.stdout || '').trim().split('\n').pop()); } catch { /* ignore */ }
    ok(out && out.ok === true && out.len === BIG.length, 'R1 子进程(模拟重启后)rehydrate 成功且长度一致');
  }

  // ═══ [E] 集成:fake-openai 真实 HTTP 回合中模型主动调用 observation_recall ═══
  // 注:本段验证「工具经 HTTP 回合可用」(offer→调用→稳定信封回传→配对铁律)。「真实 rawRef 回读成功」
  // 由 [U](工具层)/[R](跨进程)/observation-recall-realhistory.e2e.js(真实历史+工具分发)覆盖——
  // 因为 observation_reduced 事件与自动压缩触发绑定,而真实回合里单条大 tool 结果+完整系统提示的估算
  // 会首读即触发压缩→L1 蒸发 0 条(boundary 保护最近回合)→L2 摘要 reseed→fake 序列重置,形成请求循环,
  // 无法在 HTTP 回合内稳定产生 rawRef。信封闭环(伪造 rawRef→invalid_ref)在 HTTP 链路稳定可达。
  console.log('── [E] fake-openai 集成(双开关开) ──');
  {
    const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
    const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105a-e-'));
    fs.writeFileSync(path.join(EHOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 40000 }],
      activeProvider: 'fake',
      autoCompactThreshold: 0.8,
      runtimeObservationReducerV1: true,
      runtimeObservationRecallV1: true,
    }, null, 2));
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
      windowsHide: true,
      env: { ...process.env, FAKE_NO_USAGE: '1', FAKE_TOOL_SEQUENCE: JSON.stringify([
        { name: 'observation_recall', args: { rawRef: 'not-a-ref' } },
      ]) },
    });
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: EHOME, RUYI_HOME: EHOME }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    try {
      let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await get(WB_PORT, '/health'); }
      ok(!!h, 'E0 workbench listening on :' + WB_PORT);
      const events = await postStream(WB_PORT, { message: '调用 observation_recall 工具试试' });
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'E1 回合 result ok:true');
      const sid = (events.find(e => e.type === 'session') || {}).session?.id;
      ok(!!sid, 'E2 session id captured');
      const s1 = sid ? await get(WB_PORT, '/api/sessions/' + encodeURIComponent(sid)) : null;
      const ph = (s1 && s1.session && s1.session.providerHistory) || [];
      // fake 主动发起 observation_recall → offer 门在 HTTP 回合生效
      const recallCall = ph.find(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc.function && tc.function.name === 'observation_recall'));
      ok(!!recallCall, 'E3 fake 在真实回合中主动调用 observation_recall(offer 生效)');
      const recallId = recallCall && recallCall.tool_calls.find(tc => tc.function.name === 'observation_recall').id;
      const recallMsg = ph.find(m => m && m.role === 'tool' && m.tool_call_id === recallId);
      let recallResult = null; try { recallResult = JSON.parse(recallMsg && recallMsg.content || 'null'); } catch { /* ignore */ }
      ok(recallResult && recallResult.ok === false && recallResult.error === 'invalid_ref',
        'E4 稳定信封经 HTTP 链路回传(invalid_ref)');
      // 配对铁律:所有 assistant.tool_calls 都有 role:tool 应答
      const toolIds = new Set(ph.filter(m => m && m.role === 'tool').map(m => m.tool_call_id));
      let allPaired = true, tcCount = 0;
      for (const m of ph) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { tcCount++; if (!toolIds.has(tc.id)) allPaired = false; }
      ok(tcCount >= 1 && allPaired, 'E5 配对铁律:' + tcCount + ' 个 tool_call 全部有应答');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally {
      kill(wb); kill(fake);
      await sleep(300);
      fs.rmSync(EHOME, { recursive: true, force: true });
    }
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nOBSERVATION-RECALL E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  // 显式退出:残留的 workbench/fake 子进程句柄可能让事件循环挂住(观察实测 300s 不退出)
  setImmediate(() => process.exit(failures ? 1 : 0));
})();
