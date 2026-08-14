'use strict';
// 主回合记忆维护工具 e2e：workbench_memory_relation_propose / workbench_memory_revise / workbench_memory_relation_revoke。
// 覆盖：提议(kind / 校验 / 单槽先到者胜) + apply(memory_revise 覆盖保留 id/createdAt、relation_propose 写 confirmed 边、
// relation_revoke 删边)。纯函数/无网络，对齐 memory-graph-relations 模式。
const fs = require('fs'), path = require('path'), os = require('os');

const HOME = path.join(os.tmpdir(), 'mem-maint-' + process.pid);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 首跑无目录 */ }
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // 必须在 require 前:paths.memory 在模块加载时定型

const {
  saveMemory, loadMemoryRegistry, listMemoryRelations,
  proposeMemoryRelation, confirmMemoryRelation,
  proposeMemoryRelationTool, proposeMemoryRevision, proposeMemoryRelationRevoke,
  applyMemoryRelationProposal,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

const PROJ = path.join(HOME, 'proj');
const SID = 'mem-maint-session';
const ctx = (cwd, turnSeq) => ({ sessionId: SID, session: { id: SID, turnSeq, cwd, messages: [] }, turnSeq, workingDir: cwd, config: null });
const readBody = async (cwd, id) => {
  const entry = (await loadMemoryRegistry(cwd)).find(m => m.id === id);
  return entry && entry.file ? fs.readFileSync(entry.file, 'utf8') : '';
};

(async () => {
  fs.mkdirSync(PROJ, { recursive: true });
  const m1 = await saveMemory({ scope: 'project', name: 'M1', body: '记忆 M1 原文', type: 'reference' }, PROJ);
  const m2 = await saveMemory({ scope: 'project', name: 'M2', body: '记忆 M2 原文', type: 'reference' }, PROJ);
  ok(m1.ok && m2.ok, 'fixture: 两条记忆落盘');
  const id1 = m1.memory.id, id2 = m2.memory.id;

  // ── 1. relation_propose ──
  const rp = await proposeMemoryRelationTool({ type: 'supports', from: id1, to: id2, scope: 'project', reason: '测试' }, ctx(PROJ, 1));
  ok(rp.ok && rp.pendingUserConfirmation === true && rp.proposal && rp.proposal.kind === 'relation_propose', 'relation_propose: 提议成功(kind=relation_propose)');
  const rpSameTurn = await proposeMemoryRelationTool({ type: 'supports', from: id1, to: id2, scope: 'project' }, ctx(PROJ, 1));
  ok(rpSameTurn.ok && rpSameTurn.alreadyPending === true, 'relation_propose: 同回合先到者胜(alreadyPending)');
  const rpBadType = await proposeMemoryRelationTool({ type: 'blocks', from: id1, to: id2 }, ctx(PROJ, 2));
  ok(!rpBadType.ok && /关系类型|relation type/.test(rpBadType.error || ''), 'relation_propose: 非法 type 被拒');
  const rpGhost = await proposeMemoryRelationTool({ type: 'supports', from: id1, to: 'ghost-id' }, ctx(PROJ, 3));
  ok(!rpGhost.ok && /不存在/.test(rpGhost.error || ''), 'relation_propose: 幽灵 to 被拒');
  const rpSensitive = await proposeMemoryRelationTool({ type: 'supports', from: id1, to: id2, note: 'api_key=sk-abcdef123456' }, ctx(PROJ, 3));
  ok(!rpSensitive.ok && /敏感/.test(rpSensitive.error || ''), 'relation_propose: 敏感 note 被拒');

  const applyRp = await applyMemoryRelationProposal(SID, rp.proposalId, PROJ);
  ok(applyRp.ok, 'apply relation_propose 成功');
  const rels = await listMemoryRelations(PROJ, 'project', { includePending: false });
  ok(rels.confirmed.some(r => r.from === id1 && r.to === id2 && r.type === 'supports'), 'relation_propose: confirmed 边已写入(跳过 pending)');

  // ── 2. memory_revise ──
  const rv = await proposeMemoryRevision({ id: id2, scope: 'project', body: '记忆 M2 修订后', reason: '内容过时' }, ctx(PROJ, 4));
  ok(rv.ok && rv.proposal && rv.proposal.kind === 'memory_revise', 'memory_revise: 提议成功(kind=memory_revise)');
  const rvMissing = await proposeMemoryRevision({ id: 'nope', scope: 'project', body: 'x', reason: 'x' }, ctx(PROJ, 5));
  ok(!rvMissing.ok && /不存在/.test(rvMissing.error || ''), 'memory_revise: 目标不存在被拒');
  const rvNoChange = await proposeMemoryRevision({ id: id2, scope: 'project', reason: 'x' }, ctx(PROJ, 6));
  ok(!rvNoChange.ok && /至少提供/.test(rvNoChange.error || ''), 'memory_revise: 无修改字段被拒');
  const rvSensitive = await proposeMemoryRevision({ id: id2, scope: 'project', body: '含密码: password=hunter2secret', reason: 'x' }, ctx(PROJ, 6));
  ok(!rvSensitive.ok && /敏感/.test(rvSensitive.error || ''), 'memory_revise: 敏感 body 被拒');

  const beforeEntry = (await loadMemoryRegistry(PROJ)).find(m => m.id === id2);
  const applyRv = await applyMemoryRelationProposal(SID, rv.proposalId, PROJ);
  ok(applyRv.ok, 'apply memory_revise 成功');
  const afterEntry = (await loadMemoryRegistry(PROJ)).find(m => m.id === id2);
  ok(afterEntry && afterEntry.id === id2 && afterEntry.createdAt === beforeEntry.createdAt, 'memory_revise: 覆盖后 id/createdAt 保留');
  const bodyNow = await readBody(PROJ, id2);
  ok(bodyNow.includes('记忆 M2 修订后'), 'memory_revise: 正文已覆盖为修订后内容');

  // ── 3. relation_revoke ──
  const edge = await proposeMemoryRelation({ type: 'contradicts', from: id1, to: id2, scope: 'project', note: '待撤销' }, PROJ);
  ok(edge.ok, 'revoke fixture: 建一条 pending 边');
  const confirmed = await confirmMemoryRelation(edge.relation.id, PROJ);
  ok(confirmed.ok, 'revoke fixture: confirm 成 confirmed 边');
  const edgeId = edge.relation.id;
  const rvEdge = await proposeMemoryRelationRevoke({ relationId: edgeId, reason: '误建' }, ctx(PROJ, 7));
  ok(rvEdge.ok && rvEdge.proposal && rvEdge.proposal.kind === 'relation_revoke', 'relation_revoke: 提议成功(kind=relation_revoke)');
  const rvEdgeMissing = await proposeMemoryRelationRevoke({ relationId: 'rel-ffffffff', reason: 'x' }, ctx(PROJ, 8));
  ok(!rvEdgeMissing.ok && /不存在/.test(rvEdgeMissing.error || ''), 'relation_revoke: 关系不存在被拒');

  const applyRevoke = await applyMemoryRelationProposal(SID, rvEdge.proposalId, PROJ);
  ok(applyRevoke.ok, 'apply relation_revoke 成功');
  const afterDelete = await listMemoryRelations(PROJ, 'project', { includePending: true });
  ok(!afterDelete.relations.some(r => r.id === edgeId), 'relation_revoke: 边已删除');

  // ── 4. 非关系/维护 kind 拒绝 apply ──
  const badApply = await applyMemoryRelationProposal(SID, 'proposal-nonexistent', PROJ);
  ok(!badApply.ok && /not found/.test(badApply.error || ''), 'apply: 不存在的 proposal 被拒');

  console.log(failures ? `\nMEMORY-MAINTENANCE E2E: ${failures} FAIL` : '\nMEMORY-MAINTENANCE E2E: ALL PASS');
  process.exit(failures ? 1 : 0);
})();
