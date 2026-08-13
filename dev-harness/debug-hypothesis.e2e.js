(async () => {
// E2E (M5 候选 D 波 #2): debug_hypothesis 假设/实验/证伪确定性状态机。
// 纯函数驱动,require server.js 直调 toolCall(同 tool-dispatch B 段模式),无 provider/无网络。
// 覆盖:init 登记、test 三态转换(supports/refutes/inconclusive)、重复实验检测、conclude 锁定 + 早停完整性、非法参数拒绝。
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const UNIT_DATA = path.join(os.tmpdir(), 'wcw-debug-hypothesis-e2e');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.rmSync(UNIT_DATA, { recursive: true, force: true }); fs.mkdirSync(UNIT_DATA, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = UNIT_DATA;
const S = require(SERVER);
const dh = (args) => S.toolCall('debug_hypothesis', args, null);

try {
  // (a) init: 3 个假设
  const a = await dh({ action: 'init', hypotheses: [
    { id: 'H1', description: '并发竞态导致状态覆盖' },
    { id: 'H2', description: '空值未初始化' },
    { description: '资源泄漏' },  // 无 id → 自动 H3
  ] });
  ok(a && a.ok === true, '(a) init ok, err=' + (a && a.error));
  ok(a && Array.isArray(a.ledger.hypotheses) && a.ledger.hypotheses.length === 3, '(a) init 登记 3 个假设');
  ok(a && a.ledger.hypotheses[2].id === 'H3', '(a) 缺 id 自动生成 H3');
  ok(a && a.stats.total === 3 && a.stats.pending === 3, '(a) stats total=3 pending=3');
  let ledger = a.ledger;

  // (b) test H1 refutes → refuted
  const b = await dh({ action: 'test', ledger, hypothesisId: 'H1', result: 'refutes', evidence: '加锁后仍复现' });
  ok(b && b.ok === true && b.hypothesis.status === 'refuted', '(b) H1 证伪 → refuted');
  ok(b && b.stats.refuted === 1 && b.stats.pending === 2, '(b) stats refuted=1 pending=2');
  ledger = b.ledger;

  // (c) test H2 supports → supported
  const c = await dh({ action: 'test', ledger, hypothesisId: 'H2', result: 'supports', evidence: '初始化后不再崩溃' });
  ok(c && c.ok === true && c.hypothesis.status === 'supported', '(c) H2 支持 → supported');
  ledger = c.ledger;

  // (d) test H3 inconclusive → 保持 pending
  const d = await dh({ action: 'test', ledger, hypothesisId: 'H3', result: 'inconclusive', evidence: '未观察到变化' });
  ok(d && d.ok === true && d.hypothesis.status === 'pending', '(d) H3 无结论 → 保持 pending');
  ledger = d.ledger;

  // (e) 证伪 sticky(对抗 HIGH-2): refuted 假设不能被 supports 复活
  const e = await dh({ action: 'test', ledger, hypothesisId: 'H1', result: 'supports', evidence: '试图复活' });
  ok(e && e.ok === false && /证伪/.test(e.error || ''), '(e) H1 已 refuted, supports 不能复活(拒绝)');

  // (f) 矛盾检测(对抗 HIGH-2): H2 再 refutes → refuted + contradictionWarning(supports+refutes 并存)
  const f = await dh({ action: 'test', ledger, hypothesisId: 'H2', result: 'refutes', evidence: '换环境又崩溃了' });
  ok(f && f.ok === true && f.hypothesis.status === 'refuted', '(f) H2 证伪 → refuted');
  ok(f && typeof f.contradictionWarning === 'string' && /H2/.test(f.contradictionWarning), '(f) H2 矛盾证据触发 contradictionWarning');
  ledger = f.ledger;

  // (g) conclude 边界(对抗 HIGH-1): 不能 conclude pending / refuted
  const g1 = await dh({ action: 'conclude', ledger, hypothesisId: 'H3' });
  ok(g1 && g1.ok === false && /pending/.test(g1.error || ''), '(g) conclude pending 假设拒绝');
  const g2 = await dh({ action: 'conclude', ledger, hypothesisId: 'H1' });
  ok(g2 && g2.ok === false && /refuted/.test(g2.error || ''), '(g) conclude refuted 假设拒绝');

  // (h) 重复实验检测(对抗 LOW-8): 新台账 H1 两次 refutes
  const hInit = await dh({ action: 'init', hypotheses: [{ id: 'H1', description: 'x' }] });
  const h1 = await dh({ action: 'test', ledger: hInit.ledger, hypothesisId: 'H1', result: 'refutes', evidence: 'a' });
  const h2 = await dh({ action: 'test', ledger: h1.ledger, hypothesisId: 'H1', result: 'refutes', evidence: 'b' });
  ok(h2 && h2.ok === true && typeof h2.duplicateWarning === 'string' && /H1/.test(h2.duplicateWarning), '(h) H1 refutes x2 触发 duplicateWarning');

  // (i) 合法 conclude 流程 + 竞争假设告警(对抗 MEDIUM-3): H1/H2 supported, H3 pending
  const iInit = await dh({ action: 'init', hypotheses: [{ id: 'H1', description: 'a' }, { id: 'H2', description: 'b' }, { id: 'H3', description: 'c' }] });
  let il = iInit.ledger;
  il = (await dh({ action: 'test', ledger: il, hypothesisId: 'H1', result: 'supports', evidence: 's1' })).ledger;
  il = (await dh({ action: 'test', ledger: il, hypothesisId: 'H2', result: 'supports', evidence: 's2' })).ledger;
  const iConclude = await dh({ action: 'conclude', ledger: il, hypothesisId: 'H1' });
  ok(iConclude && iConclude.ok === true && iConclude.rootCause === 'H1', '(i) conclude 锁定 H1(supported)');
  ok(iConclude && typeof iConclude.earlyStopWarning === 'string' && /H2/.test(iConclude.earlyStopWarning) && /H3/.test(iConclude.earlyStopWarning), '(i) 竞争假设 H2(supported)+H3(pending) 未排除 → earlyStopWarning 含两者');
  ok(iConclude && Array.isArray(iConclude.pendingHypotheses) && iConclude.pendingHypotheses.includes('H2') && iConclude.pendingHypotheses.includes('H3'), '(i) pendingHypotheses 含 H2 和 H3');

  // (j) 全排除后 conclude 不再警告 + 重复 conclude 拒绝 + test confirmed 拒绝
  let jl = iConclude.ledger;
  jl = (await dh({ action: 'test', ledger: jl, hypothesisId: 'H2', result: 'refutes', evidence: '排除 H2' })).ledger;
  jl = (await dh({ action: 'test', ledger: jl, hypothesisId: 'H3', result: 'refutes', evidence: '排除 H3' })).ledger;
  const jConclude = await dh({ action: 'conclude', ledger: jl, hypothesisId: 'H1' });
  ok(jConclude && jConclude.ok === false && /锁定/.test(jConclude.error || ''), '(j) 已锁定 H1,重复 conclude 拒绝');
  const jTest = await dh({ action: 'test', ledger: jl, hypothesisId: 'H1', result: 'refutes', evidence: '再测' });
  ok(jTest && jTest.ok === false && /confirmed/.test(jTest.error || ''), '(j) confirmed 假设不能再实验');

  // (k) status 统计
  const k = await dh({ action: 'status', ledger: il });
  ok(k && k.ok === true && k.stats.pending === 1 && k.stats.supported === 2, '(k) status 统计正确(pending=1 supported=2)');

  // (l) 非法参数拒绝
  const l1 = await dh({ action: 'bogus' });
  ok(l1 && l1.ok === false && /action/.test(l1.error || ''), '(l) 非法 action 拒绝');
  const l2 = await dh({ action: 'test', ledger, hypothesisId: 'H1' });  // 缺 result
  ok(l2 && l2.ok === false && /result/.test(l2.error || ''), '(l) test 缺 result 拒绝');
  const l3 = await dh({ action: 'test', ledger, hypothesisId: 'NOPE', result: 'refutes' });
  ok(l3 && l3.ok === false && /不存在/.test(l3.error || ''), '(l) 不存在 hypothesisId 拒绝');
  const l4 = await dh({ action: 'status' });  // 缺 ledger
  ok(l4 && l4.ok === false && /ledger/.test(l4.error || ''), '(l) 缺 ledger 拒绝');
  const l5 = await dh({ action: 'init', hypotheses: [] });
  ok(l5 && l5.ok === false && /假设/.test(l5.error || ''), '(l) init 空假设拒绝');
} catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
finally {
  fs.rmSync(UNIT_DATA, { recursive: true, force: true });
  console.log('\nDEBUG-HYPOTHESIS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})();
