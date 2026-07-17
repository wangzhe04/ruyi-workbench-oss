'use strict';
/*
 * E2E (v1.5 · Judge JSON 修复): 多 Agent 工作流的裁判/质量门(gate cross_review)节点 JSON 解析加固 + provider 兜底修复。
 *
 * 真实故障(用户生产环境,deepseek 引擎裁判): 输出一大篇 markdown 审查(含多个表格)+ 结尾 ```json 围栏,围栏内
 * JSON 的 summary 字段含【未转义的英文引号】(…未到"fail"级别…)。旧的 parseStructuredAgentOutput 两级容错都拿到
 * 同一段非法 JSON → 「输出不是有效 JSON」→ 节点 failed → failurePolicy 拖垮整个 run。本 e2e 三层防御全覆盖:
 *
 * 三层防御:
 *  1) parseStructuredAgentOutput 加固: 多候选提取(围栏块末→首 + 外层切片 + 行首 { 平衡扫描) + repairJson 修复器。
 *  2) repairJson 零依赖状态机: (a)智能引号 (b)尾逗号 (c)未转义内引号 → \" (d)裸控制符。幂等 + 合法 JSON 零误伤。
 *  3) provider 引擎节点兜底: 解析加固仍失败(如整体截断)→ 发一次(bounded=1)无工具 JSON 修复补全,记 aux 台账。
 *
 * Sections:
 *  1) IN-PROCESS 单测(require server.js 导出): 精确复刻的生产故障样本经加固后 parseStructuredAgentOutput 直接解析
 *     成功(verdict==='uncertain'、summary 含 fail);repairJson 四类样本各修复 + 幂等 + 合法 JSON(含转义引号/边界
 *     内容)零误伤;整体截断样本解析层无法修复(留给 provider 兜底)。
 *  2) 集成: 三节点 pro/con/judge(gate cross_review) DAG 三次运行:
 *     A) judge 输出生产故障样本(未转义内引号) → 解析层已修成功、无修复调用、节点得到确定性 verdict(uncertain →
 *        rejected,非 failed 的解析失败)、run 未被拖垮。
 *     B) judge 输出【整体截断】样本(解析层修不动) → 发出 1 次 json-repair 修复调用、fake 回干净 JSON、节点 succeeded、
 *        node.jsonRepaired===true、台账新增一行 kind:'aux'/note:'json-repair'。
 *     C) 回归: judge 输出干净 JSON → 节点 succeeded、无修复调用(修复计数不变)。
 *
 * 离线、零依赖。内联 fake-openai(9107) + workbench(9108)。判定行(exact): JUDGE-JSON-REPAIR E2E: ALL PASS
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const FP = await getFreePort(), WP = await getFreePort();
const HOME = path.join(os.tmpdir(), 'ruyi-judge-json-repair');
const UNIT_HOME = path.join(os.tmpdir(), 'ruyi-judge-json-repair-unit');
const MONTH = new Date().toISOString().slice(0, 7);
const LEDGER = path.join(HOME, 'usage', MONTH + '.jsonl');
const IN_PER_M = 1, OUT_PER_M = 2, CUR = 'CNY';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

// ---------- the exact production failure sample (markdown tables + trailing ```json fence + unescaped inner quotes) ----------
const BADFIX_SAMPLE = [
  '## 交叉审查报告',
  '',
  '| 维度 | 正方 | 反方 |',
  '|---|---|---|',
  '| 证据强度 | 中 | 中 |',
  '| 关键风险 | 覆盖不足 | 成本偏高 |',
  '',
  '综合双方论证,存在瑕疵但非致命。',
  '',
  '```json',
  '{',
  '  "verdict": "uncertain",',
  '  "confidence": 0.6,',
  '  "summary": "综合评估:整体质量虽不完全达标但未到"fail"级别——建议补充基准后再合并。",',
  '  "findings": [{"title": "缺少基准测试", "confidence": 0.5}]',
  '}',
  '```',
].join('\n');
// 整体截断: 未闭合的字符串 + 无收尾括号 + 无闭合围栏 → 解析层任何候选都修不动,必须走 provider 兜底修复。
const TRUNC_SAMPLE = '判决分析进行中:\n\n```json\n{"verdict": "uncertain", "confidence": 0.62, "summary": "响应在生成过程中被截断,此处缺少收尾';
const CLEAN_SAMPLE = '{"verdict": "pass", "confidence": 0.9, "summary": "双方论证充分,结论一致,予以通过。", "findings": []}';
// provider 兜底修复调用(system 含「JSON 修复器」)时 fake 回的干净 JSON。
const REPAIRED_JSON = '{"verdict": "pass", "confidence": 0.85, "summary": "修复后:整体达标,可以合并。", "findings": []}';

// ---------- inline fake-openai ----------
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse(res, { id, choices: [], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });
  res.write('data: [DONE]\n\n'); res.end();
}
function userTextOf(msgs) { return (msgs || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n'); }
let repairCalls = 0; // count of provider-side JSON-repair completions the fake served
const sockets = new Set();
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/__repairs')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ count: repairCalls }));
  }
  if (req.method === 'GET' && req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const id = 'chatcmpl-judge';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      // Non-stream: the provider JSON-repair aux call (system pins「JSON 修复器」). Return a clean JSON object.
      if (parsed.stream === false) {
        const isRepair = body.includes('JSON 修复器');
        if (isRepair) repairCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id, choices: [{ message: { role: 'assistant', content: isRepair ? REPAIRED_JSON : 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const ut = userTextOf(msgs);
      // JUDGE markers checked FIRST — a judge request also carries PRO_SIDE/CON_SIDE in its dependency section.
      if (ut.includes('JUDGE_BADFIX')) return emitText(res, id, BADFIX_SAMPLE);
      if (ut.includes('JUDGE_TRUNC')) return emitText(res, id, TRUNC_SAMPLE);
      if (ut.includes('JUDGE_CLEAN')) return emitText(res, id, CLEAN_SAMPLE);
      if (ut.includes('PRO_SIDE')) return emitText(res, id, '正方结论:该方案收益明确,建议采纳。');
      if (ut.includes('CON_SIDE')) return emitText(res, id, '反方结论:存在成本与回归风险,需谨慎。');
      return emitText(res, id, '节点已完成。');
    });
    return;
  }
  res.writeHead(404); res.end();
});
fake.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

// ---------- http helpers ----------
function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.write(raw); r.end(); }); }
async function up(port, p = '/health') { for (let i = 0; i < 50; i++) { if (await get(port, p)) return true; await sleep(120); } return false; }
async function waitFor(label, fn, tries = 80, gap = 150) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } ok(false, label + ' (timed out)'); return null; }
function readRecs() { try { return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function repairCount() { return get(FP, '/__repairs').then(r => (r && r.count) || 0); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

(async () => {
  // ================= Section 1: in-process unit (parse hardening + repairJson) =================
  fs.rmSync(UNIT_HOME, { recursive: true, force: true }); fs.mkdirSync(UNIT_HOME, { recursive: true });
  process.env.RUYI_HOME = UNIT_HOME; // sandbox any module-load I/O; require does NOT start a server
  const server = require(SERVER);
  const { parseStructuredAgentOutput, repairJson } = server;
  ok(typeof parseStructuredAgentOutput === 'function' && typeof repairJson === 'function', 'server.js exports parseStructuredAgentOutput + repairJson');

  // 1.1 the exact production sample parses directly via the hardening (no provider call needed).
  const p = parseStructuredAgentOutput(BADFIX_SAMPLE);
  ok(p.ok, 'production failure sample parses via hardening (multi-candidate + repairJson)');
  ok(p.ok && p.value.verdict === 'uncertain', 'parsed verdict === uncertain (got ' + (p.value && p.value.verdict) + ')');
  ok(p.ok && /fail/.test(String(p.value.summary || '')), 'parsed summary retains the word "fail" (inner quotes repaired, content preserved)');
  ok(p.ok && Array.isArray(p.value.findings) && p.value.findings.length === 1, 'parsed findings array survives');

  // 1.2 four repair categories, each in isolation.
  ok(JSON.parse(repairJson('{"summary":"未到"fail"级别","verdict":"uncertain"}')).summary === '未到"fail"级别', 'repairJson: unescaped inner quotes → content preserved');
  ok(JSON.stringify(JSON.parse(repairJson('{"a":1,"b":[1,2,],}'))) === '{"a":1,"b":[1,2]}', 'repairJson: trailing commas removed (structural only)');
  ok(JSON.parse(repairJson('{"s":"line1\nline2"}')).s === 'line1\nline2', 'repairJson: bare newline inside string escaped');
  ok(JSON.parse(repairJson('{“verdict”:“pass”}')).verdict === 'pass', 'repairJson: smart quotes normalized to delimiters');

  // 1.3 idempotency: repair(repair(x)) === repair(x).
  for (const x of ['{"summary":"未到"fail"级别"}', '{"a":1,"b":[1,2,],}', '{"s":"l1\nl2"}', '{“k”:“v”}', BADFIX_SAMPLE]) {
    ok(repairJson(repairJson(x)) === repairJson(x), 'repairJson idempotent on ' + JSON.stringify(x.slice(0, 16)));
  }

  // 1.4 legal JSON is NOT harmed — repairJson is a NO-OP on valid JSON, and parse returns the exact value.
  //     Boundary content: an escaped quote AND the literal chars "},[]" inside a string value.
  const valid = '{"note":"payload is \\"},[]\\" here","ok":true,"arr":["a","b"]}';
  ok(repairJson(valid) === valid, 'repairJson is a NO-OP on valid JSON (no false repair)');
  const pv = parseStructuredAgentOutput(valid);
  ok(pv.ok && pv.value.note === 'payload is "},[]" here' && pv.value.ok === true && pv.value.arr.length === 2, 'valid JSON parses to the exact value (boundary content intact)');
  // a fenced clean JSON (common tidy case) still works, and a bare scalar is not accepted as structured output.
  ok(parseStructuredAgentOutput('```json\n{"verdict":"pass","confidence":0.8,"summary":"ok"}\n```').ok, 'clean fenced JSON parses');
  ok(!parseStructuredAgentOutput('just prose, no json here').ok, 'prose with no JSON → not ok');

  // 1.5 wholesale truncation cannot be salvaged by the parse layer → provider fallback territory.
  ok(!parseStructuredAgentOutput(TRUNC_SAMPLE).ok, 'truncated JSON is NOT parseable by hardening (needs provider repair)');

  // ================= Section 2: integration (pro/con/judge cross_review DAG) =================
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.5.0', permissionMode: 'bypass', defaultWorkspace: HOME,
    subagentMaxPerTurn: 8, subagentMaxConcurrent: 3,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], pricing: { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, currency: CUR } }],
    activeProvider: 'fake',
  }));
  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    ok(await up(FP, '/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'judge-json-repair', cwd: HOME }, hdr);
    const sid = created.session.id;
    const judgeNodes = judgeMarker => ([
      { id: 'pro', task: 'PRO_SIDE 从支持方立场分析议题,给出证据与收益。', toolTier: 'read', failurePolicy: 'continue' },
      { id: 'con', task: 'CON_SIDE 从反对方立场分析议题,主动寻找反例与成本。', toolTier: 'read', failurePolicy: 'continue' },
      { id: 'judge', task: judgeMarker + ' 交叉审查正反双方,核验依据并给出最终裁决。', dependsOn: ['pro', 'con'], gate: { mode: 'cross_review' }, failurePolicy: 'block' },
    ]);

    // --- Run A: judge emits the production failure sample. Parse layer repairs it → NO provider repair call. ---
    const runA = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: judgeNodes('JUDGE_BADFIX') }, hdr);
    const jA = runA.results && runA.results.find(n => n.id === 'judge');
    ok(runA.ok === true, 'Run A launches synchronously (ok:true)');
    ok(jA && jA.status === 'rejected' && jA.gateVerdict === 'uncertain', 'Run A: judge reaches a deterministic gate verdict (rejected/uncertain), NOT a JSON parse failure (got ' + (jA && jA.status) + '/' + (jA && jA.gateVerdict) + ')');
    ok(jA && jA.structuredResult && /fail/.test(String(jA.structuredResult.summary || '')), 'Run A: judge.structuredResult parsed; summary content ("fail") preserved through repair');
    ok(jA && !jA.jsonRepaired, 'Run A: no provider repair used (jsonRepaired not set — parse hardening was enough)');
    ok(runA.status !== 'failed' && jA && jA.status !== 'failed', 'Run A: the failure sample no longer drags the run down (run not failed; judge not failed)');
    ok((await repairCount()) === 0, 'Run A: zero provider JSON-repair calls were issued');

    // --- Run B: judge emits a WHOLESALE-TRUNCATED sample the parse layer cannot fix → ONE provider repair call. ---
    const runB = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: judgeNodes('JUDGE_TRUNC') }, hdr);
    const jB = runB.results && runB.results.find(n => n.id === 'judge');
    ok((await repairCount()) === 1, 'Run B: exactly ONE (bounded) provider JSON-repair call was issued');
    ok(jB && jB.jsonRepaired === true, 'Run B: node.jsonRepaired === true (provider fallback kicked in)');
    ok(jB && jB.status === 'succeeded' && jB.structuredResult && jB.structuredResult.verdict === 'pass', 'Run B: judge succeeded on the repaired clean JSON (verdict pass)');
    ok(runB.ok === true && runB.status === 'succeeded', 'Run B: run reaches succeeded (repair unblocked the gate)');
    // ledger: exactly one kind:'aux'/note:'json-repair' row, priced by provider pricing (11/7 tokens).
    await waitFor('json-repair aux ledger row flushed', () => readRecs().some(r => r.kind === 'aux' && r.note === 'json-repair'));
    const auxRows = readRecs().filter(r => r.kind === 'aux' && r.note === 'json-repair');
    ok(auxRows.length === 1, 'Run B: exactly one kind:aux/note:json-repair ledger row (got ' + auxRows.length + ')');
    const AUX_COST = (11 * IN_PER_M + 7 * OUT_PER_M) / 1e6;
    ok(auxRows[0] && auxRows[0].engine === 'openai' && auxRows[0].provider === 'fake' && auxRows[0].inTok === 11 && auxRows[0].outTok === 7 && auxRows[0].currency === CUR && near(auxRows[0].cost, AUX_COST) && auxRows[0].agentKey === 'judge', 'Run B: aux/json-repair row billed 11/7 CNY, agentKey=judge (cost=' + (auxRows[0] && auxRows[0].cost) + ')');

    // --- Run C: regression — judge emits clean JSON → succeeds with NO repair call. ---
    const runC = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: judgeNodes('JUDGE_CLEAN') }, hdr);
    const jC = runC.results && runC.results.find(n => n.id === 'judge');
    ok(jC && jC.status === 'succeeded' && jC.structuredResult && jC.structuredResult.verdict === 'pass', 'Run C: clean-JSON judge succeeds (verdict pass)');
    ok(jC && !jC.jsonRepaired, 'Run C: no provider repair used on clean JSON');
    ok((await repairCount()) === 1, 'Run C: provider repair-call count unchanged (still 1 — no call for clean output)');
    ok(readRecs().filter(r => r.kind === 'aux' && r.note === 'json-repair').length === 1, 'Run C: no new json-repair ledger row (still exactly 1)');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb);
    for (const s of sockets) { try { s.destroy(); } catch {} }
    try { fake.close(); } catch {}
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(UNIT_HOME, { recursive: true, force: true });
    console.log('\nJUDGE-JSON-REPAIR E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
    process.exit(failures ? 1 : 0);
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
