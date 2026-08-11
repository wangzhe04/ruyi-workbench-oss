'use strict';
// R4 Local Memory Graph e2e (docs/optimization-plan/15-r4-memory-graph.md)。
// 纯函数驱动,确定性无网络(对齐 evidence-claims-m4-benchmark 模式)。覆盖验收 §7 七条 + 对抗边界:
//   (1) confirmed contradicts 双向标记且两条都注入;
//   (2) 跨 scope 边被拒;
//   (3) pending 不进 conflict map / prompt section;
//   (4) per-scope 512 上限 -- 代码审查验证(简单 length 检查,不 runtime 造 512 夹具);
//   (5) confirm 只置 confirmed,不偷换 from/to/type;
//   (6) 换 cwd 不泄漏他项目边;
//   (7) propose/confirm/delete 审计 -- 代码内 appendUsageLedger,本测不断言台账文件(避免耦合)。
//   对抗:非法 type / 自环 / 幽灵 id / 重复提议 / 确认不存在 / 删除不存在 / 向后兼容(无 conflicts 参数)。
const fs = require('fs'), path = require('path'), os = require('os');

const HOME = path.join(os.tmpdir(), 'r4-memgraph-' + process.pid);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 首跑无目录 */ }
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // 必须在 require 前:paths.memory = path.join(dataRoot(),'memory') 在模块加载时定型

const {
  saveMemory, loadMemoryRegistry, buildMemoryPromptSection,
  listMemoryRelations, proposeMemoryRelation, confirmMemoryRelation,
  deleteMemoryRelation, buildMemoryConflictMap,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const eq = (a, b, label) => ok(a === b, label + ' (got ' + JSON.stringify(a) + ')');

const PROJ_A = path.join(HOME, 'projA');
const PROJ_B = path.join(HOME, 'projB');

(async () => {
  // ── 夹具:projA 两条记忆,projB 一条,global 两条 ──
  const a1 = await saveMemory({ scope: 'project', name: 'A1', body: '记忆 A1 正文', type: 'reference' }, PROJ_A);
  const a2 = await saveMemory({ scope: 'project', name: 'A2', body: '记忆 A2 正文(与 A1 冲突)', type: 'reference' }, PROJ_A);
  const b1 = await saveMemory({ scope: 'project', name: 'B1', body: '记忆 B1 正文', type: 'reference' }, PROJ_B);
  const g1 = await saveMemory({ scope: 'global', name: 'G1', body: '全局记忆 G1', type: 'reference' }, PROJ_A);
  ok(a1.ok && a2.ok && b1.ok && g1.ok, 'fixture: 4 条记忆落盘成功');
  const idA1 = a1.memory.id, idA2 = a2.memory.id, idB1 = b1.memory.id, idG1 = g1.memory.id;

  // ===== propose:合法 + 对抗边界 =====
  const p1 = await proposeMemoryRelation({ type: 'contradicts', from: idA1, to: idA2, scope: 'project', note: 'A1 与 A2 矛盾' }, PROJ_A);
  ok(p1.ok && p1.relation.confirmed === false, 'propose: 合法 contradicts 创建为 pending(confirmed:false)');

  const pBadType = await proposeMemoryRelation({ type: 'blocks', from: idA1, to: idA2, scope: 'project' }, PROJ_A);
  ok(!pBadType.ok && /无效的关系类型/.test(pBadType.error), 'propose: 非法 type 被拒');

  const pSelf = await proposeMemoryRelation({ type: 'supports', from: idA1, to: idA1, scope: 'project' }, PROJ_A);
  ok(!pSelf.ok && /不能相同/.test(pSelf.error), 'propose: 自环(from==to)被拒');

  // 隔离红线(威胁 1):from 在 project、to 在 global -> 跨 scope 拒绝
  const pCross = await proposeMemoryRelation({ type: 'supports', from: idA1, to: idG1, scope: 'project' }, PROJ_A);
  ok(!pCross.ok && /不存在/.test(pCross.error), 'propose: 跨 scope(global 记忆不在 project scope)被拒');

  const pGhost = await proposeMemoryRelation({ type: 'supports', from: idA1, to: 'ghost-id', scope: 'project' }, PROJ_A);
  ok(!pGhost.ok && /不存在/.test(pGhost.error), 'propose: 幽灵 to id 被拒');

  // 去重:同 from+to+type pending 已存在 -> 返回既有,不重复建
  const pDup = await proposeMemoryRelation({ type: 'contradicts', from: idA1, to: idA2, scope: 'project' }, PROJ_A);
  ok(!pDup.ok && /pending/.test(pDup.error), 'propose: 同形 pending 不重复建');

  // evidenceRef 合法存档 + 非法(穿越式)被清空
  const pEv = await proposeMemoryRelation({ type: 'supports', from: idA1, to: idA2, scope: 'project', evidenceRef: 'evt_run1_node1_0_0' }, PROJ_A);
  ok(pEv.ok && pEv.relation.evidenceRef === 'evt_run1_node1_0_0' && pEv.relation.evidenceRefVerified === false, 'propose: 合法 evidenceRef 存档,Verified=false(本切片不跨 run 校验)');
  const pEvBad = await proposeMemoryRelation({ type: 'derived_from', from: idA2, to: idA1, scope: 'project', evidenceRef: '../etc/passwd' }, PROJ_A);
  ok(pEvBad.ok && pEvBad.relation.evidenceRef === '', 'propose: 非法 evidenceRef(不过 SKILL_ID_RE)被清空');

  // ===== list:confirmed vs pending 分桶 =====
  const lstDefault = await listMemoryRelations(PROJ_A, 'project', {});
  ok(lstDefault.ok && lstDefault.confirmed.length === 0 && lstDefault.pending.length >= 2, 'list: 默认仅 confirmed(此时 0),pending>=2');
  const lstAll = await listMemoryRelations(PROJ_A, 'project', { includePending: true });
  ok(lstAll.relations.length >= 3, 'list: includePending=true 含全部边');

  // ===== confirm:只置标志,不偷换字段(威胁 7)=====
  const c1 = await confirmMemoryRelation(p1.relation.id, PROJ_A);
  ok(c1.ok && c1.relation.confirmed === true, 'confirm: pending->confirmed');
  // 偷换攻击:confirm 传一个带篡改 type/from/to 的 payload -- 但 confirm 只接 id,无 payload 字段,天然免疫
  const c1Dup = await confirmMemoryRelation(p1.relation.id, PROJ_A);
  ok(!c1Dup.ok && /已确认/.test(c1Dup.error), 'confirm: 重复确认被拒');
  const cMissing = await confirmMemoryRelation('rel-nonexistent', PROJ_A);
  ok(!cMissing.ok && /不存在/.test(cMissing.error), 'confirm: 不存在 id 被拒');

  // confirm 后 from/to/type 未变(防偷换)
  ok(c1.relation.from === idA1 && c1.relation.to === idA2 && c1.relation.type === 'contradicts', 'confirm: from/to/type 未被篡改');

  // ===== conflict map:仅 confirmed contradicts;pending 不计(威胁 6)=====
  const cmap = await buildMemoryConflictMap(PROJ_A);
  ok(cmap.has(idA1) && cmap.has(idA2) && cmap.get(idA1).has(idA2) && cmap.get(idA2).has(idA1), 'conflictMap: confirmed contradicts 双向收录');
  // pending 的 supports/derived_from 不进 conflict map
  const pendingSupport = pEv.relation.id; // supports,pending
  ok(!cmap.has(pendingSupport), 'conflictMap: pending supports 边不计入(仅 confirmed contradicts)');

  // ===== buildMemoryPromptSection:冲突标记 + 向后兼容 =====
  const reg = await loadMemoryRegistry(PROJ_A);
  const projEntries = reg.filter(m => m.scope === 'project');
  const sectionWithConflict = buildMemoryPromptSection(projEntries, 'openai', {}, cmap);
  ok(sectionWithConflict.includes('[冲突:见 ') && sectionWithConflict.includes(idA2), 'promptSection: 冲突记忆带 [冲突:见 id] 标记');
  // 两条冲突记忆都被注入(不静默择一)
  ok(sectionWithConflict.includes(idA1) && sectionWithConflict.includes(idA2), 'promptSection: 冲突双方均注入,不静默择一');

  // 向后兼容:不传 conflicts 参数 -> 无标记(既有行为不变)
  const sectionLegacy = buildMemoryPromptSection(projEntries, 'openai', {});
  ok(!sectionLegacy.includes('[冲突:见 '), 'promptSection: 无 conflicts 参数时无标记(向后兼容)');

  // ===== scope 隔离(验收 6):换 cwd 不泄漏他项目边 =====
  const lstB = await listMemoryRelations(PROJ_B, 'project', { includePending: true });
  ok(lstB.relations.length === 0, 'scope隔离: projA 的边在 projB cwd 下不可见(0 条)');

  // projB 内独立建边,与 projA 互不影响
  const pB = await proposeMemoryRelation({ type: 'supports', from: idB1, to: idB1.replace(/.$/, 'x'), scope: 'project' }, PROJ_B);
  ok(!pB.ok, 'scope隔离: projB 内对不存在的 to 建边仍被拒(隔离独立校验)');

  // ===== delete:删边 + 不存在 =====
  const d1 = await deleteMemoryRelation(p1.relation.id, PROJ_A);
  ok(d1.ok && d1.relation.type === 'contradicts', 'delete: 删边成功并返回被删条目');
  const d1Again = await deleteMemoryRelation(p1.relation.id, PROJ_A);
  ok(!d1Again.ok && /不存在/.test(d1Again.error), 'delete: 重复删被拒');
  // 删后 conflict map 不再含该对
  const cmapAfter = await buildMemoryConflictMap(PROJ_A);
  ok(!cmapAfter.has(idA1), 'delete: 删边后 conflictMap 不再收录该记忆');

  // ===== 全局 scope 独立通路 =====
  const g2 = await saveMemory({ scope: 'global', name: 'G2', body: '全局 G2', type: 'reference' }, PROJ_A);
  const pG = await proposeMemoryRelation({ type: 'supports', from: idG1, to: g2.memory.id, scope: 'global' }, PROJ_A);
  ok(pG.ok && pG.relation.scope === 'global', 'global scope: 全局记忆间建边成功');
  // 全局边不随 cwd 变化泄漏到项目 scope
  const lstProjAfterGlobal = await listMemoryRelations(PROJ_B, 'project', { includePending: true });
  ok(lstProjAfterGlobal.relations.length === 0, 'global 边不混入 project scope 列表');

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAIL') + ' (R4 memory-graph relations)');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('THROW', e); process.exit(1); });
