#!/usr/bin/env node
'use strict';

// LIVE GATE · 106 #3 批量输出纪律 —— 逐项 vs 批量 真实模型配对对照（22 号文 §6.2 / §4.3 row 5）。
//
// 限定场景：design-and-decide 的 option 扇出（独立、同构、容量受控的三方案生成）。
//   baseline  逐项臂: clarify → option_a / option_b / option_c 三个独立节点 → decide → rollout
//   candidate 批量臂: clarify → options_batch 一个节点用槽位对象 outputSchema 一次产三方案 → decide → rollout
// 两臂同 provider/模型/题目/槽位 schema；逐 rep 全新 temp HOME + 独立 server，互不清缓存/台账。
//
// 对账口径：
//   调用数/费用 = temp HOME 的 usage/*.jsonl（kind=subagent，服务端 computeProviderCost 已计）
//   失败重试    = 节点 attempts/status（批量臂 maxRetries 1，漏项时整体重试一次）
//   质量        = 槽位覆盖（3/3 + 每槽最小字段字符）、decide 逐 option 总分与 winner
// 报告只落计量数字、槽位字符数、winner/scores，不落方案正文、不落 API key。
//
// 用法: node dev-harness/batch-output-gate-live.js [结果JSON路径]
//   env: RUYI_REAL_CONFIG（provider 来源，默认 ~/.win-claude-workbench/config.json）
//        RUYI_REAL_MODEL（模型覆盖）  RUYI_BATCH_REPS（每臂重复次数，默认 2）

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const DEFAULT_CONFIG = path.join(os.homedir(), '.win-claude-workbench', 'config.json');
const CONFIG_PATH = process.env.RUYI_REAL_CONFIG || DEFAULT_CONFIG;
const OUT = process.argv[2] || process.env.RUYI_REAL_OUT || path.join(ROOT, 'docs', 'optimization-plan', '106-batch-output-gate-report.json');
// 断点续跑：每个 run 完成即追加一行到 PROGRESS；进程被杀后重跑只补未完成的 (arm,rep)。
// 报告成功落盘后 PROGRESS 删除；runKey 不匹配（换了 provider/model/reps）的旧进度一律忽略。
const PROGRESS = OUT.replace(/\.json$/i, '') + '.progress.jsonl';
const MODEL_OVERRIDE = process.env.RUYI_REAL_MODEL || '';
const REPS = Math.max(1, Math.min(5, Math.round(Number(process.env.RUYI_BATCH_REPS) || 2)));

const SUBJECT = [
  '为 50 人团队设计内部知识库的搜索功能。硬约束：',
  'C1 文档以中文为主，必须正确处理中文分词/检索；',
  'C2 P95 搜索延迟 < 500ms（约 10 万篇文档规模）；',
  'C3 权限过滤必须在服务端强制执行（按部门/项目隔离）；',
  'C4 优先复用现有基础设施，控制新增运维成本。',
].join('\n');

const OPTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['orientation', 'overview', 'tradeoffs', 'constraints_met', 'risks', 'rough_cost'],
  properties: {
    orientation: { type: 'string' },
    overview: { type: 'string' },
    tradeoffs: { type: 'string' },
    constraints_met: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    rough_cost: { type: 'string' },
  },
};
const SLOTS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['option_a', 'option_b', 'option_c'],
  properties: { option_a: OPTION_SCHEMA, option_b: OPTION_SCHEMA, option_c: OPTION_SCHEMA },
};
const DECIDE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scores', 'winner'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['option_id', 'total'],
        properties: { option_id: { type: 'string' }, total: { type: 'number' }, rationale: { type: 'string' } },
      },
    },
    winner: { type: 'string' },
    rationale: { type: 'string' },
  },
};

const ORIENTATIONS = [
  ['option_a', '稳妥成熟取向'],
  ['option_b', '性能/能力优先或创新取向'],
  ['option_c', '最简/最低成本、最快落地取向'],
];
const CLARIFY_TASK = '把上面的需求拆清并结构化：目标与非目标、四条硬约束的验收口径、评价维度及权重。输出简洁的结构化需求说明。';
const optionTask = (id, label) => `就需求给出【${label}】的候选方案 ${id}：方案概述、核心取舍、逐条说明如何满足 C1–C4、主要风险、粗略成本/工期。只输出该方案的 JSON（schema 已给定）。`;
const BATCH_TASK = '就需求一次产出三个候选方案，分别以稳定槽位 option_a（稳妥成熟）、option_b（性能/创新优先）、option_c（最简低成本）放入输出 JSON 的同名属性；三方案取向必须明显不同。每个槽位的字段由 schema 给定：overview/tradeoffs/constraints_met(对照 C1–C4 逐条)/risks/rough_cost。只输出该 JSON。';
const DECIDE_TASK = '对照需求的四条硬约束与评价维度，对 option_a/option_b/option_c 三个候选方案逐维打分（每方案给 total 0–100 与一句理由），选出 winner（填 option_id），说明它为何优于其余。只输出 schema 给定的 JSON。';
const ROLLOUT_TASK = '把 decide 选定的方案落成可执行清单：分阶段任务与依赖顺序、每步验收点、主要风险应对、最早可验证价值的里程碑。输出纯文本清单。';

function baselineNodes() {
  return [
    { id: 'clarify', task: CLARIFY_TASK, role: 'planner' },
    ...ORIENTATIONS.map(([id, label]) => ({ id, task: optionTask(id, label), role: 'explorer', dependsOn: ['clarify'], outputSchema: OPTION_SCHEMA, failurePolicy: 'continue' })),
    { id: 'decide', task: DECIDE_TASK, role: 'reviewer', dependsOn: ['option_a', 'option_b', 'option_c'], dependencyPolicy: 'all_settled', outputSchema: DECIDE_SCHEMA, failurePolicy: 'continue' },
    { id: 'rollout', task: ROLLOUT_TASK, role: 'planner', dependsOn: ['decide'], dependencyPolicy: 'all_settled', failurePolicy: 'continue' },
  ];
}
function candidateNodes() {
  return [
    { id: 'clarify', task: CLARIFY_TASK, role: 'planner' },
    { id: 'options_batch', task: BATCH_TASK, role: 'explorer', dependsOn: ['clarify'], outputSchema: SLOTS_SCHEMA, failurePolicy: 'retry', maxRetries: 1, retryFallback: 'continue' },
    { id: 'decide', task: DECIDE_TASK, role: 'reviewer', dependsOn: ['options_batch'], outputSchema: DECIDE_SCHEMA, failurePolicy: 'continue' },
    { id: 'rollout', task: ROLLOUT_TASK, role: 'planner', dependsOn: ['decide'], dependencyPolicy: 'all_settled', failurePolicy: 'continue' },
  ];
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeReadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2500 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function kill(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGTERM');
  } catch { /* already exited */ }
}
function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}, timeoutMs = 1800000) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('http timeout')); });
    r.write(raw); r.end();
  });
}
function readJsonlDir(dir, ext) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort(); } catch { return []; }
  const rows = [];
  for (const file of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (const line of lines) { try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); } catch { /* ignore */ } }
  }
  return rows;
}

function slotQuality(nodes, arm) {
  // 返回 {covered, minChars, perSlot:{id:chars}}；逐项臂看三个节点，批量臂看槽位对象。
  const perSlot = {};
  if (arm === 'baseline') {
    for (const [id] of ORIENTATIONS) {
      const n = nodes.find(x => x.id === id);
      const sr = n && n.structuredResult;
      perSlot[id] = sr ? ['overview', 'tradeoffs', 'rough_cost'].reduce((a, k) => a + String(sr[k] || '').length, 0)
        + (Array.isArray(sr.constraints_met) ? sr.constraints_met.join('').length : 0)
        + (Array.isArray(sr.risks) ? sr.risks.join('').length : 0) : 0;
    }
  } else {
    const n = nodes.find(x => x.id === 'options_batch');
    const sr = n && n.structuredResult;
    for (const [id] of ORIENTATIONS) {
      const s = sr && sr[id];
      perSlot[id] = s ? ['overview', 'tradeoffs', 'rough_cost'].reduce((a, k) => a + String(s[k] || '').length, 0)
        + (Array.isArray(s.constraints_met) ? s.constraints_met.join('').length : 0)
        + (Array.isArray(s.risks) ? s.risks.join('').length : 0) : 0;
    }
  }
  const vals = Object.values(perSlot);
  return { covered: vals.filter(v => v > 0).length, minChars: vals.length ? Math.min(...vals) : 0, perSlot };
}

async function runArm(arm, rep, provider, workspace) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ruyi-106-batch-${arm}-`));
  const port = await getFreePort();
  const cfg = {
    configSchema: 11, version: '1.0.0', permissionMode: 'bypass', allowOutsideWorkspace: true,
    defaultWorkspace: workspace, providers: [provider], activeProvider: provider.id,
    toolLoadingMode: 'auto', toolEconomicsShadowV1: true, subagentMaxConcurrent: 4,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home },
  });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  const rec = { arm, rep, ok: false, wallMs: 0, nodes: [], calls: 0, inTok: 0, outTok: 0, cachedInTok: 0, cost: 0, currency: '', errors: [] };
  try {
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i++) { await sleep(250); healthy = await health(port); }
    if (!healthy) throw new Error('workbench did not become healthy');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(port, '/api/sessions', { title: `batch-gate-${arm}-${rep}`, cwd: workspace }, hdr);
    const sid = created.session.id;
    const started = Date.now();
    const launch = await post(port, '/api/agent-workflow/launch', {
      token, sessionId: sid, context: SUBJECT,
      nodes: arm === 'baseline' ? baselineNodes() : candidateNodes(),
    }, hdr);
    rec.wallMs = Date.now() - started;
    rec.ok = launch && launch.ok === true;
    const results = (launch && launch.results) || [];
    rec.nodes = results.map(n => ({ id: n.id, status: n.status, attempts: Number(n.attempts) || 0, errorClass: n.errorClass || '' }));
    const q = slotQuality(results, arm);
    rec.slotsCovered = q.covered; rec.slotMinChars = q.minChars; rec.slotChars = q.perSlot;
    const decide = results.find(n => n.id === 'decide');
    const dsr = decide && decide.structuredResult;
    if (dsr && Array.isArray(dsr.scores)) {
      rec.decideWinner = String(dsr.winner || '');
      rec.decideScores = Object.fromEntries(dsr.scores.map(s => [String(s.option_id || '?'), Number(s.total) || 0]));
    }
    const rollout = results.find(n => n.id === 'rollout');
    rec.rolloutChars = String((rollout && rollout.result) || '').length;
    if (!rec.ok) rec.errors.push('launch not ok');
    for (const n of rec.nodes) if (n.status === 'failed') rec.errors.push(`${n.id}:${n.errorClass || 'failed'}`);
    await sleep(600); // 台账为异步追加链，落盘后再读
    const usage = readJsonlDir(path.join(home, 'usage'), '.jsonl').filter(r => r.sessionId === sid);
    rec.calls = usage.length;
    for (const row of usage) {
      rec.inTok += Number(row.inTok) || 0;
      rec.outTok += Number(row.outTok) || 0;
      rec.cachedInTok += Number(row.cachedInTok) || 0;
      if (Number.isFinite(Number(row.cost))) rec.cost += Number(row.cost);
      if (row.currency) rec.currency = row.currency;
    }
    rec.modelCallEvents = readJsonlDir(path.join(home, 'logs'), '.ndjson').filter(e => e.kind === 'model_call_completed').length;
  } catch (error) {
    rec.errors.push(String(error.message || error));
  } finally {
    kill(wb); await sleep(350); fs.rmSync(home, { recursive: true, force: true });
  }
  return rec;
}

function aggregate(runs) {
  const n = runs.length || 1;
  const sum = (k) => runs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    reps: runs.length,
    okRuns: runs.filter(r => r.ok).length,
    calls: sum('calls'), modelCallEvents: sum('modelCallEvents'),
    inTok: sum('inTok'), outTok: sum('outTok'), cachedInTok: sum('cachedInTok'),
    cost: sum('cost'), wallMs: sum('wallMs'),
    avgCalls: sum('calls') / n, avgCost: sum('cost') / n, avgWallMs: sum('wallMs') / n,
    slotsCovered: runs.map(r => r.slotsCovered), slotMinChars: runs.map(r => r.slotMinChars),
    winners: runs.map(r => r.decideWinner || ''), retries: runs.map(r => Math.max(0, ...r.nodes.map(x => x.attempts)) - 1),
  };
}
const delta = (x, y) => (x && Number.isFinite(x) && Number.isFinite(y)) ? (y - x) / x : null;

(async () => {
  let source;
  try { source = safeReadJson(CONFIG_PATH); } catch (error) { console.error('无法读取本地 provider 配置:', error.message); process.exit(2); }
  const active = (source.providers || []).find(p => p.id === source.activeProvider) || (source.providers || [])[0];
  if (!active || !active.apiKey || !active.baseUrl) { console.error('active provider 缺少 apiKey/baseUrl'); process.exit(2); }
  const model = MODEL_OVERRIDE || active.model || '';
  const provider = { ...active, id: active.id || 'provider', model, apiStyle: active.apiStyle || 'responses', apiKey: active.apiKey, models: [{ id: model, label: model }] };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-batch-work-'));

  console.log(`#3 批量输出纪律 live gate · provider=${provider.id} model=${model} reps=${REPS}`);
  const runKey = `${provider.id}/${model}/reps${REPS}`;
  const resumed = readJsonlDir(path.dirname(PROGRESS), '.jsonl')
    .filter(r => r && r.__gate === '106-batch' && r.key === runKey && r.ok === true);
  // 同 (arm,rep) 只保留最后一条（历史里可能有失败重跑的残留）。
  const doneMap = new Map();
  for (const r of resumed) doneMap.set(`${r.arm}#${r.rep}`, r);
  const runs = [...doneMap.values()];
  if (runs.length) console.log(`  续跑：已有 ${runs.length} 条完成记录（${[...doneMap.keys()].join(', ')}）`);
  for (let rep = 1; rep <= REPS; rep++) {
    for (const arm of ['baseline', 'candidate']) {
      if (doneMap.has(`${arm}#${rep}`)) { console.log(`  ${arm}#${rep}: 跳过（已有完成记录）`); continue; }
      const rec = await runArm(arm, rep, provider, workspace);
      runs.push(rec);
      if (rec.ok) fs.appendFileSync(PROGRESS, JSON.stringify({ __gate: '106-batch', key: runKey, ...rec }) + '\n');
      console.log(`  ${arm}#${rep}: ok=${rec.ok} wall=${(rec.wallMs / 1000).toFixed(1)}s calls=${rec.calls} cost=${rec.cost.toFixed(4)} slots=${rec.slotsCovered}/3 winner=${rec.decideWinner || '-'} ${rec.errors.length ? 'errors=' + rec.errors.join('|') : ''}`);
    }
  }
  const baseline = aggregate(runs.filter(r => r.arm === 'baseline'));
  const candidate = aggregate(runs.filter(r => r.arm === 'candidate'));
  const comparison = {
    comparable: baseline.okRuns > 0 && candidate.okRuns > 0,
    callsDelta: delta(baseline.avgCalls, candidate.avgCalls),
    costDelta: delta(baseline.avgCost, candidate.avgCost),
    wallDelta: delta(baseline.avgWallMs, candidate.avgWallMs),
    inputDelta: delta(baseline.inTok / baseline.reps, candidate.inTok / candidate.reps),
    outputDelta: delta(baseline.outTok / baseline.reps, candidate.outTok / candidate.reps),
    winnerAgreement: baseline.winners.filter((w, i) => w && w === candidate.winners[i]).length + '/' + REPS,
  };
  const report = {
    schema: '106-batch-output-gate/1', generatedAt: new Date().toISOString(),
    provider: { id: provider.id, model, apiStyle: provider.apiStyle },
    subject: 'knowledge-base-search-50p (C1 中文/C2 P95<500ms/C3 服务端权限/C4 复用基础设施)',
    reps: REPS,
    arms: { baseline, candidate },
    comparison,
    runs: runs.map(r => ({ ...r, slotChars: r.slotChars })),
    notes: [
      '逐项臂三方案并行 spawn（subagentMaxConcurrent=4），批量臂单 spawn；wall 对比含此并发差异。',
      '批量臂 maxRetries=1：漏项/异常候选时整体重试一次；逐项修补可行性已由 batch-output-discipline.e2e.js 离线实证（schema 失败保留部分结果+schemaErrors）。',
      'cost 为服务端 usage 台账 computeProviderCost 合计，币种见 currency；calls 为 subagent 台账行数，modelCallEvents 为 model_call_completed 事件数（含节点内多轮迭代）。',
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n对比: calls ${baseline.avgCalls.toFixed(1)} → ${candidate.avgCalls.toFixed(1)} (${comparison.callsDelta == null ? '-' : (comparison.callsDelta * 100).toFixed(1) + '%'}), cost ${baseline.avgCost.toFixed(4)} → ${candidate.avgCost.toFixed(4)} (${comparison.costDelta == null ? '-' : (comparison.costDelta * 100).toFixed(1) + '%'}), wall ${(comparison.wallDelta == null ? '-' : (comparison.wallDelta * 100).toFixed(1) + '%')}, winner 一致 ${comparison.winnerAgreement}`);
  console.log('报告:', OUT);
  try { fs.rmSync(PROGRESS, { force: true }); } catch { /* ignore */ }
  fs.rmSync(workspace, { recursive: true, force: true });
})();
