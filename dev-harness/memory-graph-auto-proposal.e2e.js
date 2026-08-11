'use strict';
// R4-S2 e2e (docs/optimization-plan/15-r4-memory-graph.md §9): 模型自动提议接线 + evidenceRef 内存内校验。
// 纯函数驱动,确定性无网络(对齐 m4-benchmark 模式)。覆盖:
//   (1) extractMemoryRelationProposals:合法提取 + 对抗过滤(非法 type/自环/坏 id/超 maxItems);
//   (2) proposeMemoryRelation opts.evidenceCatalog:evidenceRef 命中 run.evidence -> Verified=true;未命中/无 catalog -> false;
//   (3) 端到端:gate 节点 structuredResult.memoryRelations -> 落盘 pending 边(用户确认前),evidenceRefVerified 正确;
//   (4) 向后兼容:无 memoryRelations 的 gate 输出 -> 零提议零异常;
//   (5) prompt section 暴露记忆 id(模型据此引用)。
const fs = require('fs'), path = require('path'), os = require('os');

const HOME = path.join(os.tmpdir(), 'r4s2-memgraph-' + process.pid);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 首跑无目录 */ }
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // 必须在 require 前:paths.memory 在模块加载时定型

const {
  saveMemory, loadMemoryRegistry, buildMemoryPromptSection,
  proposeMemoryRelation, confirmMemoryRelation, listMemoryRelations,
  extractMemoryRelationProposals, buildMemoryConflictMap,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

const PROJ = path.join(HOME, 'projX');

(async () => {
  // ── 夹具:两条项目记忆 + 一个 run 的证据目录 ──
  const m1 = await saveMemory({ scope: 'project', name: 'M1', body: '记忆 M1', type: 'reference' }, PROJ);
  const m2 = await saveMemory({ scope: 'project', name: 'M2', body: '记忆 M2(与 M1 冲突)', type: 'reference' }, PROJ);
  ok(m1.ok && m2.ok, 'fixture: 2 条记忆落盘');
  const id1 = m1.memory.id, id2 = m2.memory.id;

  // 模拟 run.evidence(与 R1 indexNodeEvidence 产出的结构一致)
  const run = { id: 'run-abc123', cwd: PROJ, evidence: [
    { eventId: 'evt_run-abc123_worker_0_0', kind: 'tool', content: 'read file A', ref: {} },
    { eventId: 'evt_run-abc123_worker_0_1', kind: 'tool', content: 'ran tests', ref: {} },
  ], nodes: [] };
  const realEventId = 'evt_run-abc123_worker_0_0';

  // ===== (1) extractMemoryRelationProposals 纯函数 =====
  const sr = {
    verdict: 'fail', confidence: 0.8, summary: 'M1 与 M2 冲突',
    memoryRelations: [
      { type: 'contradicts', from: id1, to: id2, evidenceRef: realEventId, note: '依据测试结果' },
      { type: 'blocks', from: id1, to: id2 },            // 非法 type -> 过滤
      { type: 'supports', from: id1, to: id1 },           // 自环 -> 过滤
      { type: 'supports', from: id1, to: 'bad id!' },     // 坏 to id -> 过滤
      { type: 'derived_from', from: id2, to: id1, note: 'M2 源自 M1' }, // 合法,无 evidenceRef
    ],
  };
  const props = extractMemoryRelationProposals(sr, run);
  ok(props.length === 2, 'extract: 5 条输入 -> 2 条合法(过滤非法 type/自环/坏 id)');
  ok(props[0].type === 'contradicts' && props[0].from === id1 && props[0].to === id2, 'extract: 首条字段正确');
  ok(props[0].evidenceRef === realEventId, 'extract: evidenceRef 保留');
  ok(props[0].sourceRunId === 'run-abc123', 'extract: sourceRunId 取自 run.id');
  ok(props[1].evidenceRef === '' && props[1].type === 'derived_from', 'extract: 无 evidenceRef 时留空,合法');

  // 空/缺 memoryRelations -> 空数组(向后兼容)
  ok(extractMemoryRelationProposals({ verdict: 'pass' }, run).length === 0, 'extract: 无 memoryRelations -> 空数组');
  ok(extractMemoryRelationProposals(null, run).length === 0, 'extract: null structuredResult -> 空数组');
  ok(extractMemoryRelationProposals({}, null).length === 0, 'extract: null run -> 空数组(sourceRunId 空)');

  // maxItems 20 兜底
  const many = { memoryRelations: Array.from({ length: 30 }, (_, i) => ({ type: 'supports', from: id1, to: id2, note: String(i) })) };
  // 注意:同 from+to+type 会去重,这里只测提取层截断到 20(extract 不过滤重复,propose 才去重)
  ok(extractMemoryRelationProposals(many, run).length === 20, 'extract: 超 maxItems 截断到 20');

  // ===== (2) proposeMemoryRelation opts.evidenceCatalog =====
  // evidenceRef 命中 run.evidence -> Verified=true
  const p1 = await proposeMemoryRelation({ type: 'contradicts', from: id1, to: id2, scope: 'project', evidenceRef: realEventId, sourceRunId: 'run-abc123' }, PROJ, { evidenceCatalog: run.evidence });
  ok(p1.ok && p1.relation.evidenceRefVerified === true, 'propose+catalog: evidenceRef 命中 run.evidence -> Verified=true');

  // evidenceRef 不在 catalog -> Verified=false
  const p2 = await proposeMemoryRelation({ type: 'supports', from: id1, to: id2, scope: 'project', evidenceRef: 'evt_run-abc123_worker_9_9', sourceRunId: 'run-abc123' }, PROJ, { evidenceCatalog: run.evidence });
  ok(p2.ok && p2.relation.evidenceRefVerified === false, 'propose+catalog: evidenceRef 未命中 -> Verified=false');

  // 无 catalog(API 手动提议)-> Verified=false
  const p3 = await proposeMemoryRelation({ type: 'derived_from', from: id2, to: id1, scope: 'project', evidenceRef: realEventId, sourceRunId: 'run-abc123' }, PROJ);
  ok(p3.ok && p3.relation.evidenceRefVerified === false, 'propose 无 catalog: Verified=false(仅存档)');

  // ===== (3) 端到端:extractMemoryRelationProposals -> proposeMemoryRelation(模拟 09-workflow 钩子)=====
  // 用全新项目,避免与上面 p1/p2/p3 的边 dedup 冲突(同 from+to+type 已 pending 会被正确去重)。
  const PROJ2 = path.join(HOME, 'projHook');
  const h1 = await saveMemory({ scope: 'project', name: 'H1', body: 'hook 记忆 1', type: 'reference' }, PROJ2);
  const h2 = await saveMemory({ scope: 'project', name: 'H2', body: 'hook 记忆 2', type: 'reference' }, PROJ2);
  const idH1 = h1.memory.id, idH2 = h2.memory.id;
  const runHook = { id: 'run-hook-001', cwd: PROJ2, evidence: [
    { eventId: 'evt_run-hook-001_worker_0_0', kind: 'tool', content: 'read', ref: {} },
  ], nodes: [] };
  const srHook = {
    verdict: 'fail', confidence: 0.8, summary: 'H1 与 H2 冲突',
    memoryRelations: [
      { type: 'contradicts', from: idH1, to: idH2, evidenceRef: 'evt_run-hook-001_worker_0_0', note: '依据' },
      { type: 'derived_from', from: idH2, to: idH1, note: 'H2 源自 H1' },
    ],
  };
  // 模拟 09-workflow 钩子:对 srHook 跑提取 + 逐项 propose(传 run.evidence 作 catalog)
  const hookProps = extractMemoryRelationProposals(srHook, runHook);
  const results = [];
  for (const p of hookProps) {
    try { results.push(await proposeMemoryRelation(p, runHook.cwd, { evidenceCatalog: runHook.evidence })); } catch (e) { results.push({ ok: false, error: String(e) }); }
  }
  const okResults = results.filter(r => r.ok);
  ok(okResults.length === 2, 'e2e 钩子: 2 条合法提议成功落盘');
  const verifiedOne = okResults.find(r => r.relation.evidenceRefVerified === true);
  ok(!!verifiedOne, 'e2e 钩子: 含 realEventId 的提议 Verified=true(内存内校验生效)');
  ok(okResults.every(r => r.relation.confirmed === false), 'e2e: 自动提议落盘为 pending(confirmed:false,用户确认前)');

  // 防御:from/to 不存在时 propose 返回 ok:false,不抛异常(钩子 catch 不触发,节点不受影响)
  const ghostPropose = await proposeMemoryRelation({ type: 'supports', from: id1, to: 'ghost-id', scope: 'project' }, PROJ, { evidenceCatalog: run.evidence });
  ok(!ghostPropose.ok, 'e2e 防御: 幽灵 to id -> ok:false 不抛异常(节点结果不受影响)');

  // ===== (4) 向后兼容:无 memoryRelations 的 gate 输出 =====
  const noOp = extractMemoryRelationProposals({ verdict: 'pass', confidence: 1, summary: 'ok' }, run);
  ok(noOp.length === 0, '向后兼容: 无 memoryRelations 的 gate 输出 -> 零提议');

  // ===== (5) prompt section 暴露记忆 id =====
  const reg = await loadMemoryRegistry(PROJ);
  const projEntries = reg.filter(m => m.scope === 'project');
  const section = buildMemoryPromptSection(projEntries, 'openai', {});
  ok(section.includes('[' + id1 + ']'), 'promptSection: 暴露记忆 id(模型可引用)');
  ok(section.includes(id1) && section.includes(id2), 'promptSection: 两条记忆均含 id');

  // ===== 确认链路:自动提议的 pending 边可被用户确认 =====
  const lst = await listMemoryRelations(PROJ, 'project', { includePending: true });
  ok(lst.pending.length >= 2, '确认链路: 自动提议产生 >=2 条 pending');
  const onePending = lst.pending[0];
  const c = await confirmMemoryRelation(onePending.id, PROJ);
  ok(c.ok && c.relation.confirmed === true, '确认链路: 自动提议的 pending 边可被用户确认');

  // 确认后 conflict map 生效(若确认的是 contradicts)
  if (c.relation.type === 'contradicts') {
    const cmap = await buildMemoryConflictMap(PROJ);
    ok(cmap.has(c.relation.from) && cmap.has(c.relation.to), '确认链路: 确认 contradicts 后 conflictMap 双向收录');
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAIL') + ' (R4-S2 memory-graph auto-proposal)');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('THROW', e); process.exit(1); });
