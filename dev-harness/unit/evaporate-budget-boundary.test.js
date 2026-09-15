'use strict';
// 126-111a(25 号文 §1.2 / 44 号文 §4):L1 蒸发的边界从「倒数第 2 条 assistant」改为 token 预算。
// 真源码、临时存储、零模型请求。
//
// 判据分三组:
//   [A] 开关关 / 不给预算 —— 与今天【逐字节】等价(老边界 assistantsSeen===2)。
//   [B] 开关开 —— 保护区按 clamp(min, ratio×budget, max) 算,尾部护住的观测按 token 记,
//       而不是按「几条 assistant」;老边界与新边界在同一份历史上给出【可见的不同】。
//   [C] 配对铁律 —— 边界永远落在单元起点(非 tool),绝不把 assistant 与它的 tool 回复劈开;
//       最后一个单元无条件护住(再紧也不蒸发当前这一回合的观测)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-evap-boundary-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const EVAPORATED = '[已省略:';
const big = n => JSON.stringify({ ok: true, rows: Array.from({ length: n }, (_, i) => ({ i, text: 'X'.repeat(200) })) });

// 一条 user ＋ turns 个「assistant(tool_calls) ＋ tool 回复」单元。每个 tool 结果约 n×220 字符。
function buildHistory(turns, rowsPerTool) {
  const history = [{ role: 'user', content: '把这个仓库里所有用到 foo 的地方找出来' }];
  for (let t = 0; t < turns; t++) {
    history.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${t}`, type: 'function', function: { name: 'file_search', arguments: '{}' } }] });
    history.push({ role: 'tool', tool_call_id: `t${t}`, content: big(rowsPerTool) });
  }
  history.push({ role: 'assistant', content: '找完了' });
  return history;
}
const evaporatedCount = h => h.filter(m => m.role === 'tool' && String(m.content || '').startsWith(EVAPORATED)).length;
const toolCount = h => h.filter(m => m.role === 'tool').length;

test('126-111a · L1 蒸发边界改 token 预算', () => {
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

  // ── [A] 开关关 = 逐字节等价今天 ──────────────────────────────────────────────────────
  ok(srv.evaporateBudgetBoundaryEnabled({}) === false, 'A1 缺省不生效');
  ok(srv.evaporateBudgetBoundaryEnabled({ runtimeEvaporateBudgetBoundaryV1: false }) === false, 'A2 显式 false 不生效');
  ok(srv.evaporateBudgetBoundaryEnabled({ runtimeEvaporateBudgetBoundaryV1: 'true' }) === false, 'A3 字符串 "true" 不生效(只认 JSON 布尔)');
  ok(srv.evaporateBudgetBoundaryEnabled({ runtimeEvaporateBudgetBoundaryV1: true }) === true, 'A4 显式 true 生效');
  {
    const legacy = buildHistory(6, 40);
    const withOffSwitch = JSON.parse(JSON.stringify(legacy));
    srv.evaporateHistory(legacy);                                            // 今天的调法(不带 opts)
    srv.evaporateHistory(withOffSwitch, { config: {}, boundaryBudget: 0 });   // 开关关 -> 调用点给 0
    ok(JSON.stringify(legacy) === JSON.stringify(withOffSwitch), 'A5 开关关与不带 opts 的结果逐字节相同');
    // 老边界护住「倒数第 2 条 assistant」及其之后 —— 6 个工具单元里只有最后那一个躲得掉。
    ok(evaporatedCount(legacy) === toolCount(legacy) - 1, `A6 老边界确实只护住最后一条观测(实得蒸发 ${evaporatedCount(legacy)}/${toolCount(legacy)})`);
  }

  // ── [B] 开关开:护住的是 token,不是「几条 assistant」──────────────────────────────────
  //
  // 夹具按【生产里的真实前置】搭:L1 只在「历史已经超预算」时才跑(maybeAutoCompact 里
  // `if (before <= armedBudget) return false`)。第一版我拿 400K 预算配一份小历史,保护区吃得下
  // 整段 -> 一条都不蒸发 -> 断言红。那读数没有意义:那种状态在生产里根本不出现。
  //
  // 真正要量的是 25 号文点的那件事:**一条 assistant 回合可能带 1 个工具结果,也可能带 60 个**。
  // 老边界数 assistant,所以不管尾巴上那一回合带了多少观测,它只护得住最后【一条】;新边界数
  // token,该护几条就护几条。
  {
    const SHAPE = [60, 8]; // 单 user 回合里连着 60 次工具调用,每个结果不大(典型的找代码/翻日志)
    const probe = buildHistory(...SHAPE);
    const total = srv.estimateHistoryTokens(probe);
    const budget = Math.floor(total * 0.7); // 已经超预算 —— 与生产里 L1 被调用时的状态同形
    ok(total > budget, `B0 夹具确实超预算(历史 ${total} tokens > 预算 ${budget})`);

    const legacy = buildHistory(...SHAPE);
    srv.evaporateHistory(legacy);
    const withBudget = buildHistory(...SHAPE);
    srv.evaporateHistory(withBudget, { config: { runtimeEvaporateBudgetBoundaryV1: true }, boundaryBudget: budget });

    const legacyEvap = evaporatedCount(legacy), budgetEvap = evaporatedCount(withBudget);
    const tools = toolCount(legacy);
    ok(legacyEvap === tools - 1, `B1 老边界:不管尾巴上有多少观测,只护得住最后一条(蒸发 ${legacyEvap}/${tools})`);
    ok(budgetEvap < legacyEvap, `B2 新边界护住的观测【严格更多】(新蒸发 ${budgetEvap}/${tools}，老蒸发 ${legacyEvap}/${tools})`);
    ok(budgetEvap > 0, `B3 但仍然在缩,没退化成「一条都不蒸发」(蒸发 ${budgetEvap}/${tools})`);
    ok(tools - budgetEvap >= 2, `B4 尾部至少护住两条观测 —— 这正是老边界做不到的那件事(实得护住 ${tools - budgetEvap} 条)`);
  }
  {
    // 同一份历史、同一个开关,只换预算 —— 蒸发条数必须单调:预算越大护得越多。
    const counts = [2000, 20000, 120000].map(budget => {
      const h = buildHistory(30, 10);
      srv.evaporateHistory(h, { config: { runtimeEvaporateBudgetBoundaryV1: true }, boundaryBudget: budget });
      return evaporatedCount(h);
    });
    ok(counts[0] >= counts[1] && counts[1] >= counts[2], `B5 预算越大蒸发越少(实得 ${counts.join(' ≥ ')})`);
    ok(counts[0] > counts[2], `B6 而且不是三个一样的数(那说明预算压根没参与判断;实得 ${counts.join(' / ')})`);
  }

  // ── [C] 配对铁律与「最后一个单元无条件护住」────────────────────────────────────────
  {
    const h = buildHistory(5, 30);
    const starts = srv.historyUnitStarts(h);
    ok(starts.every(i => h[i].role !== 'tool'), 'C1 单元起点上没有一条是 tool');
    ok(starts.length === 1 + 5 + 1, `C1b 单元数 = 1 user + 5 assistant(tool_calls) + 1 assistant(实得 ${starts.length})`);
    for (const budget of [1, 100, 1000, 50000, 1000000]) {
      const b = srv.evaporateBudgetBoundary(h, budget);
      ok(b === 0 || h[b].role !== 'tool', `C2 预算 ${budget} 时边界落在非 tool 上(实得 index ${b} / role ${b < h.length ? h[b].role : 'EOF'})`);
      ok(b <= starts[starts.length - 1], `C3 预算 ${budget} 时最后一个单元无条件护住(边界 ${b} ≤ 最后单元起点 ${starts[starts.length - 1]})`);
    }
  }
  {
    // C3b:**单个单元就撑爆保护区**的情形 —— 这才是「最后一个单元无条件护住」那条真正生效的地方。
    // 第一版的 C2/C3 用的是每单元 ~2000 token 的历史,而保护区被 l1ProtectMinTokens=4000 托底,
    // 于是那条保护【从来没被触发过】:把它从源码里拔掉,断言照样全绿(反向当场逮到)。
    // 改成单个工具结果就 >4000 token:没有那条保护的话,连【当前这一回合刚拿到的观测】都会被蒸发。
    const h = buildHistory(3, 220);
    const lastUnit = srv.historyUnitStarts(h).slice(-2)[0]; // 最后一个带 tool 的单元起点
    const lastToolIndex = h.length - 2;
    ok(h[lastToolIndex].role === 'tool', 'C3b 夹具自检:倒数第二条确实是 tool');
    const oneUnitTokens = srv.estimateHistoryTokens(h.slice(lastUnit, lastUnit + 2));
    ok(oneUnitTokens > 4000, `C3b 夹具自检:单个单元 ${oneUnitTokens} tokens 已撑爆保护区下限 4000`);
    srv.evaporateHistory(h, { config: { runtimeEvaporateBudgetBoundaryV1: true }, boundaryBudget: 1 });
    ok(!String(h[lastToolIndex].content || '').startsWith(EVAPORATED),
      'C3c 预算再紧,当前这一回合刚拿到的观测也不蒸发(拔掉这条保护 -> 模型看不见自己刚拿到的工具结果)');
  }
  {
    // 蒸发之后配对仍然完整:每个 assistant.tool_calls[].id 都还有对应的 tool 消息。
    const h = buildHistory(6, 40);
    srv.evaporateHistory(h, { config: { runtimeEvaporateBudgetBoundaryV1: true }, boundaryBudget: 8000 });
    const callIds = h.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(c => c.id));
    const replyIds = new Set(h.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    ok(callIds.length > 0 && callIds.every(id => replyIds.has(id)), `C4 蒸发后 tool_call 配对零孤儿(${callIds.length} 个调用全部有回复)`);
    ok(h.length === buildHistory(6, 40).length, 'C5 蒸发不删消息、不改长度(只改 content)');
  }
  {
    // 幂等:再跑一遍不应该有新的蒸发(已带前缀的跳过)。
    const h = buildHistory(6, 40);
    const opts = { config: { runtimeEvaporateBudgetBoundaryV1: true }, boundaryBudget: 8000 };
    const first = srv.evaporateHistory(h, opts);
    const second = srv.evaporateHistory(h, opts);
    ok(first > 0 && second === 0, `C6 幂等:第二遍零蒸发(第一遍 ${first}、第二遍 ${second})`);
  }

  console.log('\nEVAPORATE BUDGET BOUNDARY UNIT: ' + (fail ? `${fail} FAILURE(S)` : 'ALL PASS'));
  assert.equal(fail, 0, `${fail} 条判据未通过`);
});
