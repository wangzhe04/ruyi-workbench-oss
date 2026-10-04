require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(61 号文 C3:记忆批量提案)。workbench_memory_propose 一次可带 items[≤3] —— 仍是【一个】待决提案(同一个
// 候选单槽、一张卡),用户在卡上逐条确认:确认的落库、其余丢弃,每条结论各记一行历史。仍然只有用户点了才写。
//   [A] 进程内直调(临时 RUYI_HOME,零网络):
//       A1 批量 3 条 → 一个 proposalId、kind:'memory_batch'、items 3 条全 pending;此刻一条记忆都没写;
//       A2 apply accept=[0,2] → 落库 2 条(正文/范围/来源会话都对),回执 saved 2 条、dismissed 1 条,如实;
//          状态文件里每条各自的结论 + 三行历史(saved/dismissed/saved);同一份 apply 再来一次 → proposal not found(不重存);
//       A3 超过 3 条整体拒绝、点明上限与改法,槽不被占(同回合随后的单条照样提交成功);
//       A4 单条旧形式不变:同一份参数照旧成功、回执形状一致(没有 kind/batch/items);items 只有一条 = 单条形式;
//       A5 同回合互斥不变:批量先到 → relation_propose 回 alreadyPending;relation_propose 先到 → 批量回 alreadyPending
//          且 submitted:false、不覆盖;
//       A6 跨回合新提案顶掉旧的批量 pending:旧卡每条各记一行 superseded,之后再提其中一条被认出是评审过的;
//       A7 批量里不合格的点名退回(rejected:缺字段 / 敏感 / 与已有记忆重复 / 同一次调用里两条重复),其余照样成卡;
//          只剩一条退回单条形式;一条都不剩整体失败、不占槽;items 与单条字段同时给 → 拒绝;
//       A8 容量边界:3 条 × 4000 字中文正文 + 32 行满历史,状态文件 > 64KB(修前读侧会把它判空)仍读得回来;
//          > 256KB 的状态文件照旧判空;写侧超限时先丢最旧历史、当前提案不丢(写进去的下次读得回来)。
//   [H] 真服务 + 假 provider(主回合工具循环真的调 workbench_memory_propose{items}):
//       H1 工具结果回给模型 batch:true/count:3;H2 回合后 /api/memory/proposal 回放这张批量卡;
//       H3 批量卡不能走编辑弹窗那条「存一条 = 整张 settle」的 /api/memory 路;
//       H4 /api/memory/proposal/apply accept=[0,2] → 落库 2 条、回执如实;H5 再点一次 404、不重存;
//       H6 另一会话的批量卡「全部忽略」→ 每条 dismissed、一条不写;H7 decision:'saved' 不能替用户整张存。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const t = createRunner('MEMORY BATCH PROPOSAL');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');

// [A] 用的临时数据根:必须在 require(server.js) 之前定(paths.memory 在模块加载时定型)。
const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mem-batch-a-'));
process.env.RUYI_HOME = HOME_A;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_A;
const srv = require(path.join(WB, 'app', 'server.js'));

// 夹具的名称/描述用每条独有的合成词:去重判据按 name+description 的词面相似度(≥0.72 算同一条),只差一个数字的
// 两条在它眼里就是同一条 —— 那样测的就成了去重,不是批量。
const item = (n, extra = {}) => ({
  name: `kq${n}vale kq${n}mirt`, description: `when editing kq${n}sorn kq${n}pelt`, type: n % 3 === 2 ? 'lesson' : 'convention', scope: 'project',
  body: `结论 ${n}:${['生成物不手改', '提交前跑静态门', '测试收尾只杀自己的进程树', '路径按 Windows 形处理'][n % 4]}。适用:动到相关模块时。`,
  reason: `第 ${n} 条是用户确认过的长期规则`, ...extra,
});
const memFiles = root => {
  const dir = path.join(root, 'memory', 'project');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(dir, f));
};
const stateOf = (root, sid) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'memory', 'proposals', sid + '.json'), 'utf8')); } catch { return null; }
};

try {
  /* ───────────────────────── [A] 进程内直调 ───────────────────────── */
  const PROJ = path.join(HOME_A, 'proj');
  fs.mkdirSync(PROJ, { recursive: true });
  let sidN = 0;
  const newSid = () => 'mem-batch-' + (++sidN);
  const ctx = (sid, turnSeq, userText = '把这几条记下来') => ({ sessionId: sid, turnSeq, workingDir: PROJ, config: null,
    session: { id: sid, turnSeq, cwd: PROJ, messages: [{ role: 'user', content: userText }] } });

  // A1
  const S1 = newSid();
  const b1 = await srv.proposeWorkbenchMemory({ items: [item(1), item(2), item(3)] }, ctx(S1, 1));
  ok(b1.ok && b1.batch === true && b1.count === 3 && b1.pendingUserConfirmation === true && typeof b1.proposalId === 'string',
    `A1 批量 3 条 → 一个待决提案(batch/count/pendingUserConfirmation)(got ${JSON.stringify({ ok: b1.ok, batch: b1.batch, count: b1.count, error: b1.error })})`);
  ok(b1.proposal && b1.proposal.kind === 'memory_batch' && Array.isArray(b1.proposal.items) && b1.proposal.items.length === 3
    && b1.proposal.items.every(x => x.status === 'pending') && b1.proposal.sourceSessionId === S1 && b1.proposal.sourceTurnSeq === 1,
  'A1b proposal 是 kind:memory_batch、3 条全 pending、钉着来源会话与回合');
  ok(memFiles(HOME_A).length === 0, 'A1c 提议阶段一条记忆都没写(仍须用户确认)');
  const st1 = stateOf(HOME_A, S1);
  ok(st1 && st1.current && st1.current.id === b1.proposalId && st1.current.status === 'pending' && st1.current.source === 'tool',
    'A1d 状态文件里是同一个候选单槽(current 一个、source:tool)');

  // A2
  const ap = await srv.applyMemoryRelationProposal(S1, b1.proposalId, PROJ, { accept: [0, 2] });
  ok(ap.ok && ap.kind === 'memory_batch' && ap.status === 'saved', `A2 apply accept=[0,2] 成功(got ${JSON.stringify(ap).slice(0, 200)})`);
  ok(Array.isArray(ap.saved) && ap.saved.length === 2 && ap.saved.map(x => x.index).join() === '0,2' && ap.saved.every(x => x.id && x.scope === 'project')
    && Array.isArray(ap.dismissed) && ap.dismissed.length === 1 && ap.dismissed[0].index === 1 && ap.dismissed[0].name === item(2).name,
  'A2b 回执如实:saved=[0,2](带 id/scope)、dismissed=[1](带名字)');
  const files = memFiles(HOME_A);
  const texts = files.map(f => fs.readFileSync(f, 'utf8'));
  ok(files.length === 2 && texts.some(x => x.includes(item(1).body)) && texts.some(x => x.includes(item(3).body)) && !texts.some(x => x.includes(item(2).body)),
    `A2c 落库正好 2 条(1、3),被拒的那条没写(实得 ${files.length} 个 .md)`);
  ok(texts.every(x => x.includes('sourceSessionId: ' + S1)) && texts.every(x => /\ncore: true\n/.test(x)),
    'A2d 落库的记忆带来源会话;convention 默认进核心(与单条卡编辑弹窗的默认勾选一致)');
  const st2 = stateOf(HOME_A, S1);
  const its = st2 && st2.current && st2.current.proposal && st2.current.proposal.items || [];
  ok(st2.current.status === 'saved' && its.map(x => x.status).join() === 'saved,dismissed,saved' && its[0].memoryId === ap.saved[0].id,
    'A2e 状态文件:整张卡 settle(saved),每条各自的结论与落库 id');
  const hist = (st2.history || []).slice(-3);
  ok(hist.length === 3 && hist.map(h => h.status).join() === 'saved,dismissed,saved' && hist.every(h => h.semanticKey && h.summary && h.turnSeq === 1),
    `A2f 历史按条各记一行(saved/dismissed/saved)(got ${JSON.stringify(hist.map(h => h.status))})`);
  const again = await srv.applyMemoryRelationProposal(S1, b1.proposalId, PROJ, { accept: [0, 1, 2] });
  ok(!again.ok && /not found/.test(again.error || '') && memFiles(HOME_A).length === 2, 'A2g 同一张卡再 apply 一次 → proposal not found,不重存');

  // A3
  const S3 = newSid();
  const tooMany = await srv.proposeWorkbenchMemory({ items: [item(4), item(5), item(6), item(7)] }, ctx(S3, 1));
  ok(!tooMany.ok && tooMany.maxItems === 3 && /at most 3/.test(tooMany.error || '') && /got 4/.test(tooMany.error || '') && /nothing was submitted/.test(tooMany.error || ''),
    `A3 超过 3 条整体拒绝、点明上限/实得/没提交(got ${JSON.stringify(tooMany).slice(0, 220)})`);
  ok(!stateOf(HOME_A, S3) || !stateOf(HOME_A, S3).current, 'A3b 被拒的那次不占槽');
  const after3 = await srv.proposeWorkbenchMemory(item(4), ctx(S3, 1));
  ok(after3.ok && !after3.alreadyPending, 'A3c 同回合随后的单条照样提交成功');

  // A4
  const S4 = newSid();
  const single = await srv.proposeWorkbenchMemory(item(8), ctx(S4, 2));
  ok(single.ok && single.pendingUserConfirmation === true && single.proposal && single.proposal.name === item(8).name
    && !('kind' in single.proposal) && !('items' in single.proposal) && !('batch' in single) && !('rejected' in single)
    && single.proposal.sourceTurnSeq === 2 && /候选已提交/.test(single.note || ''),
  'A4 单条旧形式:同一份参数照旧成功,回执与卡片形状不变(无 kind/items/batch)');
  const S4b = newSid();
  const oneItem = await srv.proposeWorkbenchMemory({ items: [item(9)] }, ctx(S4b, 1));
  ok(oneItem.ok && oneItem.proposal && oneItem.proposal.name === item(9).name && !('kind' in oneItem.proposal) && !oneItem.batch,
    'A4b items 只有一条 = 单条形式(单条卡)');
  const legacyErr = await srv.proposeWorkbenchMemory({ name: 'x', body: 'y' }, ctx(newSid(), 1));
  ok(!legacyErr.ok && legacyErr.error === 'description/reason are required and body must be at most 4000 characters', 'A4c 单条缺字段的报错逐字不变');

  // A5
  const m1 = await srv.saveMemory({ scope: 'project', name: '关系夹具甲', description: '夹具', body: '甲', type: 'reference' }, PROJ);
  const m2 = await srv.saveMemory({ scope: 'project', name: '关系夹具乙', description: '夹具', body: '乙', type: 'reference' }, PROJ);
  const S5 = newSid();
  const b5 = await srv.proposeWorkbenchMemory({ items: [item(10), item(11)] }, ctx(S5, 3));
  const rel5 = await srv.proposeMemoryRelationTool({ type: 'supports', from: m1.memory.id, to: m2.memory.id, scope: 'project', reason: 'x' }, ctx(S5, 3));
  ok(b5.ok && b5.batch && rel5.ok && rel5.alreadyPending === true && rel5.proposalId === b5.proposalId && rel5.proposal.kind === 'memory_batch',
    'A5 批量先到 → 同回合 relation_propose 回 alreadyPending(同一个槽)');
  const S5b = newSid();
  const rel5b = await srv.proposeMemoryRelationTool({ type: 'supports', from: m1.memory.id, to: m2.memory.id, scope: 'project', reason: 'x' }, ctx(S5b, 3));
  const b5b = await srv.proposeWorkbenchMemory({ items: [item(12), item(13)] }, ctx(S5b, 3));
  ok(rel5b.ok && !rel5b.alreadyPending && b5b.ok && b5b.alreadyPending === true && b5b.submitted === false && b5b.proposalId === rel5b.proposalId
    && b5b.proposal.kind === 'relation_propose' && stateOf(HOME_A, S5b).current.proposal.kind === 'relation_propose',
  'A5b relation_propose 先到 → 同回合批量回 alreadyPending、submitted:false、不覆盖');
  const parallel = await Promise.all([
    srv.proposeWorkbenchMemory({ items: [item(14), item(15)] }, ctx('mem-batch-par', 1)),
    srv.proposeMemoryRelationTool({ type: 'supports', from: m1.memory.id, to: m2.memory.id, scope: 'project', reason: 'x' }, ctx('mem-batch-par', 1)),
  ]);
  const winners = parallel.filter(r => r.ok && !r.alreadyPending);
  ok(winners.length === 1 && parallel.every(r => r.proposalId === winners[0].proposalId) && stateOf(HOME_A, 'mem-batch-par').current.id === winners[0].proposalId,
    `A5c 同回合并行派发:恰好一个先到者占槽,另一个回 alreadyPending、指向同一个提案(winners=${winners.length})`);

  // A6
  const S6 = newSid();
  const b6 = await srv.proposeWorkbenchMemory({ items: [item(16), item(17)] }, ctx(S6, 1));
  const next6 = await srv.proposeWorkbenchMemory(item(18), ctx(S6, 2));
  const st6 = stateOf(HOME_A, S6);
  ok(b6.ok && next6.ok && !next6.alreadyPending && st6.current.id === next6.proposalId
    && st6.history.filter(h => h.status === 'superseded').length === 2 && st6.history.every(h => h.turnSeq === 1),
  'A6 跨回合新提案顶掉旧的批量 pending:旧卡两条各记一行 superseded');
  const repeat6 = await srv.proposeWorkbenchMemory(item(16), ctx(S6, 3));
  ok(!repeat6.ok && repeat6.duplicate === true && /already reviewed/.test(repeat6.error || ''), 'A6b 之后再提被顶掉的其中一条 → 认出是本会话评审过的');

  // A7
  const S7 = newSid();
  const existing = await srv.saveMemory({ scope: 'project', name: '已经有的那条约定', description: '已有记忆', body: '已有', type: 'convention' }, PROJ);
  const mixed = await srv.proposeWorkbenchMemory({ items: [
    item(20),
    { name: '缺原因', description: 'd', type: 'lesson', scope: 'project', body: 'b' },
    item(21, { body: 'password=hunter2secret 写进去' }),
    item(22, { name: '已经有的那条约定' }),
    item(20, { body: '换个说法的同一条' }),
    'not-an-object',
  ].slice(0, 3) }, ctx(S7, 1));
  ok(mixed.ok && !mixed.batch && mixed.proposal && mixed.proposal.name === item(20).name && Array.isArray(mixed.rejected)
    && mixed.rejected.map(r => r.index).join() === '1,2' && /required/.test(mixed.rejected[0].error) && /sensitive/.test(mixed.rejected[1].error),
  `A7 只剩一条合格 → 退回单条形式,另两条点名退回(缺字段/敏感)(got ${JSON.stringify(mixed.rejected || mixed.error)})`);
  const S7b = newSid();
  const mixed2 = await srv.proposeWorkbenchMemory({ items: [item(23), item(22, { name: '已经有的那条约定' }), item(23, { body: '换个说法的同一条' })] }, ctx(S7b, 1));
  ok(!mixed2.batch && mixed2.ok && mixed2.rejected && mixed2.rejected.length === 2
    && mixed2.rejected[0].index === 1 && mixed2.rejected[0].existingId === existing.memory.id
    && mixed2.rejected[1].index === 2 && /items\[0\]/.test(mixed2.rejected[1].error),
  `A7b 与已有记忆重复(点名 existingId)、与同一次调用里的另一条重复(点名 items[0])都退回(got ${JSON.stringify(mixed2.rejected || mixed2.error)})`);
  const S7c = newSid();
  const mixed3 = await srv.proposeWorkbenchMemory({ items: [item(24), item(25), { name: '缺正文', description: 'd', reason: 'r' }] }, ctx(S7c, 1));
  ok(mixed3.ok && mixed3.batch && mixed3.count === 2 && mixed3.rejected.length === 1 && mixed3.rejected[0].index === 2 && mixed3.proposal.items.length === 2,
    'A7c 两条合格一条不合格 → 2 条成卡、1 条退回');
  const S7d = newSid();
  const none = await srv.proposeWorkbenchMemory({ items: [{ name: 'a' }, 'x'] }, ctx(S7d, 1));
  ok(!none.ok && Array.isArray(none.rejected) && none.rejected.length === 2 && (!stateOf(HOME_A, S7d) || !stateOf(HOME_A, S7d).current),
    'A7d 一条都不合格 → 整体失败、不占槽');
  const both = await srv.proposeWorkbenchMemory({ ...item(26), items: [item(27), item(28)] }, ctx(newSid(), 1));
  ok(!both.ok && /not both/.test(both.error || ''), 'A7e items 与单条字段同时给 → 拒绝(不猜哪个才是本意)');

  // A8
  const longBody = n => ('第' + n + '条长正文:生成物只能从源模块重建,手改会在下次构建时被静默覆盖。').repeat(200).slice(0, 4000);
  const S8 = newSid();
  const fullHistory = Array.from({ length: 32 }, (_, i) => ({ semanticKey: 'h' + i, summary: ('历史候选摘要' + i).padEnd(500, '长'), status: 'dismissed', turnSeq: 0, decidedAt: new Date().toISOString() }));
  fs.mkdirSync(path.join(HOME_A, 'memory', 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(HOME_A, 'memory', 'proposals', S8 + '.json'), JSON.stringify({ schema: 1, lastEvaluatedTurn: 0, lastShownTurn: 0, current: null, history: fullHistory }, null, 2));
  const PAD = ['', '甲', '乙', '丙'];   // 各条用不同的填充字:撑满 400/240 字上限,又不让三条的描述在词面上撞成「同一条」
  const big = await srv.proposeWorkbenchMemory({ items: [1, 2, 3].map(n => item(30 + n, { description: ('when editing kq' + (30 + n) + 'sorn ').padEnd(400, PAD[n]), reason: ('理由' + n).padEnd(240, PAD[n]), body: longBody(n) })) }, ctx(S8, 1));
  const size8 = fs.statSync(path.join(HOME_A, 'memory', 'proposals', S8 + '.json')).size;
  ok(big.ok && big.batch && big.count === 3, `A8 3 条 × 4000 字中文正文 + 满历史:批量照常提交(got ${JSON.stringify({ ok: big.ok, err: big.error, rej: big.rejected })})`);
  ok(size8 > 64 * 1024 && size8 < 256 * 1024, `A8b 状态文件 ${size8} 字节:> 64KB(修前读侧判空的线)、< 256KB`);
  const replay8 = await srv.proposeWorkbenchMemory(item(34), ctx(S8, 1));
  ok(replay8.ok && replay8.alreadyPending === true && replay8.proposalId === big.proposalId && replay8.proposal.items.length === 3,
    'A8c 这份 > 64KB 的状态仍读得回来(同回合再提回 alreadyPending、指向那张 3 条的卡)');
  const S8b = newSid();
  fs.writeFileSync(path.join(HOME_A, 'memory', 'proposals', S8b + '.json'), JSON.stringify({ schema: 1, current: { id: 'proposal-huge', status: 'pending', source: 'tool', proposal: { name: 'h', sourceTurnSeq: 1 } }, history: [], pad: 'x'.repeat(257 * 1024) }));
  const overCap = await srv.proposeWorkbenchMemory(item(35), ctx(S8b, 1));
  ok(overCap.ok && !overCap.alreadyPending && overCap.proposalId !== 'proposal-huge', 'A8d > 256KB 的状态文件照旧判空(不被一份坏/超大文件卡死)');
  const S8c = newSid();
  const fatHistory = Array.from({ length: 32 }, (_, i) => ({ semanticKey: 'f' + i, summary: '\u0001'.repeat(1300), status: 'dismissed', turnSeq: 0, decidedAt: '' }));
  fs.writeFileSync(path.join(HOME_A, 'memory', 'proposals', S8c + '.json'), JSON.stringify({ schema: 1, current: null, history: fatHistory }));
  const fatSize = fs.statSync(path.join(HOME_A, 'memory', 'proposals', S8c + '.json')).size;
  const fat = await srv.proposeWorkbenchMemory({ items: [1, 2, 3].map(n => item(40 + n, { body: longBody(n) })) }, ctx(S8c, 1));
  const stFat = stateOf(HOME_A, S8c);
  const sizeFat = fs.statSync(path.join(HOME_A, 'memory', 'proposals', S8c + '.json')).size;
  ok(fatSize < 256 * 1024 && fat.ok && fat.batch && stFat && stFat.current && stFat.current.id === fat.proposalId
    && sizeFat <= 256 * 1024 && stFat.history.length < 32,
  `A8e 写侧超限:先丢最旧历史(${stFat && stFat.history.length} 行留下)、当前提案不丢,落盘 ${sizeFat} ≤ 256KB`);
  const replayFat = await srv.proposeWorkbenchMemory(item(44), ctx(S8c, 1));
  ok(replayFat.alreadyPending === true && replayFat.proposalId === fat.proposalId, 'A8f 写进去的那张卡下次读得回来');

  /* ───────────────────────── [H] 真服务 + 假 provider ───────────────────────── */
  const HOME_H = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mem-batch-h-'));
  const WS = path.join(HOME_H, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  const BATCH = [item(51), item(52), item(53)];      // SET-A 会话
  const BATCH_B = [item(54), item(55), item(56)];    // SET-B 会话(A 的两条已落库,再提同样三条会被当重复退回)
  const errText = e => (typeof e === 'string' ? e : (e && e.message) || '');   // HTTP 失败体是 { code, params, message }(P2 错误契约)
  const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
  const fake = await startFakeProvider({
    handler(req) {
      if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
      const lastUser = req.messages.map(m => m && m.role === 'user').lastIndexOf(true);
      const answered = req.messages.slice(lastUser + 1).some(m => m && m.role === 'tool');
      const offered = (req.tools || []).some(x => x && x.function && x.function.name === 'workbench_memory_propose');
      const setB = /SET-B/.test(contentText(req.messages[lastUser] && req.messages[lastUser].content));
      if (!answered && offered) return toolCallFrames('workbench_memory_propose', { items: setB ? BATCH_B : BATCH }, 'mb1');
      return textFrames('已把这三条作为一张候选卡提交,等你确认。');
    },
  });
  fs.writeFileSync(path.join(HOME_H, 'config.json'), JSON.stringify({
    configSchema: 9, version: '1.0.0', permissionMode: 'bypass', engineMode: 'interactive', defaultWorkspace: WS,
    autoImportClaudeCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
    activeProvider: 'fake',
  }));
  const WP = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUYI_HOME: HOME_H, WIN_CLAUDE_WORKBENCH_HOME: HOME_H } });
  const requestJson = (method, route, payload) => new Promise((resolve, reject) => {
    const data = payload == null ? '' : JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 20000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* non-json */ } resolve({ status: res.statusCode, body: json }); });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
  const streamTurn = payload => new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.write(raw); r.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await requestJson('GET', '/health')).status === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
    ok(up, 'H0 工作台起来了');
    const turnBatch = async (tag) => {
      const created = await requestJson('POST', '/api/sessions', { cwd: WS });
      const sid = created.body && created.body.session && created.body.session.id;
      const out = await streamTurn({ sessionId: sid, cwd: WS, message: '把这三条项目约定记下来,以后都按这个来。' + tag });
      return { sid, out };
    };
    const { sid: H1, out } = await turnBatch('SET-A');
    ok(Boolean(H1) && /"type":"result","ok":true/.test(out), 'H1 回合跑完(主回合真的调了 workbench_memory_propose{items})');
    const second = fake.requests.filter(r => r.stream && /SET-A/.test(JSON.stringify(r.messages))).find(r => r.messages.some(m => m && m.role === 'tool' && m.tool_call_id === 'mb1'));
    const toolResult = second ? JSON.parse(contentText(second.messages.find(m => m.role === 'tool' && m.tool_call_id === 'mb1').content) || 'null') : null;
    ok(toolResult && toolResult.ok === true && toolResult.batch === true && toolResult.count === 3 && toolResult.pendingUserConfirmation === true,
      `H1b 工具结果如实回给模型:batch/count:3/待用户确认(got ${JSON.stringify(toolResult).slice(0, 200)})`);
    const replay = await requestJson('POST', '/api/memory/proposal', { sessionId: H1 });
    const rp = replay.body || {};
    ok(replay.status === 200 && rp.reason === 'tool_proposal' && rp.proposal && rp.proposal.kind === 'memory_batch' && rp.proposal.items.length === 3 && rp.proposalId === toolResult.proposalId,
      'H2 回合后 /api/memory/proposal 回放这张批量卡(UI 据此画一张卡)');
    const viaModal = await requestJson('POST', '/api/memory', { memory: { ...BATCH[0], scope: 'project' }, cwd: WS, proposalId: rp.proposalId, sourceSessionId: H1 });
    ok(viaModal.status === 404 && memFiles(HOME_H).length === 0 && stateOf(HOME_H, H1).current.status === 'pending',
      `H3 批量卡不走编辑弹窗那条路(404、一条不写、卡仍 pending)(got ${viaModal.status})`);
    const applied = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H1, proposalId: rp.proposalId, cwd: WS, accept: [0, 2] });
    const ab = applied.body || {};
    ok(applied.status === 200 && ab.ok && ab.saved.length === 2 && ab.dismissed.length === 1 && ab.dismissed[0].index === 1,
      `H4 apply accept=[0,2] → 200,回执 saved 2 / dismissed 1(got ${applied.status} ${JSON.stringify(ab).slice(0, 160)})`);
    const hFiles = memFiles(HOME_H).map(f => fs.readFileSync(f, 'utf8'));
    ok(hFiles.length === 2 && hFiles.some(x => x.includes(BATCH[0].body)) && hFiles.some(x => x.includes(BATCH[2].body)) && !hFiles.some(x => x.includes(BATCH[1].body)),
      'H4b 落库 2 条(勾上的那两条),第 2 条没写');
    const hState = stateOf(HOME_H, H1);
    ok(hState.current.status === 'saved' && hState.history.slice(-3).map(h => h.status).join() === 'saved,dismissed,saved', 'H4c 每条结论各记一行历史');
    const reapply = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H1, proposalId: rp.proposalId, cwd: WS, accept: [0, 1, 2] });
    ok(reapply.status === 404 && memFiles(HOME_H).length === 2, 'H5 同一张卡再点一次 → 404,不重存');
    const { sid: H6 } = await turnBatch('SET-B');
    const rp6 = (await requestJson('POST', '/api/memory/proposal', { sessionId: H6 })).body || {};
    const saveAll = await requestJson('POST', '/api/memory/proposal/decision', { sessionId: H6, proposalId: rp6.proposalId, decision: 'saved' });
    ok(saveAll.status === 404 && saveAll.body && /item by item/.test(errText(saveAll.body.error)) && stateOf(HOME_H, H6).current.status === 'pending',
      'H7 decision:saved 不能替用户把整张批量卡记成已存(要存哪几条走 apply 的 accept)');
    const dismissAll = await requestJson('POST', '/api/memory/proposal/decision', { sessionId: H6, proposalId: rp6.proposalId, decision: 'dismissed' });
    const st6h = stateOf(HOME_H, H6);
    ok(dismissAll.status === 200 && dismissAll.body.status === 'dismissed' && st6h.current.proposal.items.every(x => x.status === 'dismissed')
      && st6h.history.slice(-3).every(h => h.status === 'dismissed') && memFiles(HOME_H).length === 2,
    'H6 另一会话「全部忽略」→ 每条 dismissed、三行历史、一条不写');
  } finally {
    const exited = new Promise(resolve => { if (wb.exitCode !== null) resolve(); else wb.once('exit', resolve); });
    try { killOwnTree(wb.pid); } catch { /* gone */ }
    await Promise.race([exited, sleep(5000)]);
    await fake.close();
    try { fs.rmSync(HOME_H, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(HOME_A, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  t.done({ exit: true });
}
})();
