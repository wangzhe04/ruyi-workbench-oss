'use strict';
// 126-111b(25 号文 §1.2 / 44 号文 §4):L2 尾部按单元保留 ＋ 桥接。真源码、临时存储、零模型请求。
//
// 今天的毛病:`recentTurnsBoundary` 只在 user 回合边界上切,**最新一整个 user 回合放不下时一条都不留**
// (boundary 停在 history.length -> kept = [])。而一个 user 回合里带几十个工具往来是常态 ——
// 于是「摘要 ＋ 一句收到」之后模型手里什么都没有,它刚做过的事全靠摘要转述。
//
// 判据分四组:
//   [A] 开关关 —— 逐字节等价今天(装不下就 kept=[])。
//   [B] 开关开 —— 装得下时【仍然】走老路(只在装不下时才退化);装不下时按单元从尾部装。
//   [C] 配对铁律 —— 切口永远不落在 tool 上;reseed 之后 tool_call 零孤儿。
//   [D] 桥接 —— 保留段以 assistant 打头时插一条 user;以 user 打头时不插(不无缘无故多一条)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-reseed-units-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const big = n => JSON.stringify({ ok: true, rows: Array.from({ length: n }, (_, i) => ({ i, text: 'Y'.repeat(200) })) });

// 一条 user 打头、后面跟着 turns 个「assistant(tool_calls) ＋ tool 回复」单元、最后一条收尾 assistant。
// 整个历史只有【一个】user 回合 —— 正是「最新一整回合放不下」那个形状。
function oneBigTurn(turns, rowsPerTool) {
  const h = [{ role: 'user', content: '把这个仓里所有用到 foo 的地方找出来并改掉' }];
  for (let t = 0; t < turns; t++) {
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: `u${t}`, type: 'function', function: { name: 'file_search', arguments: '{}' } }] });
    h.push({ role: 'tool', tool_call_id: `u${t}`, content: big(rowsPerTool) });
  }
  h.push({ role: 'assistant', content: '改完了' });
  return h;
}
const planOf = (history, config, tailCap) => srv.CompactionPlan.create({
  scope: 'main', trigger: 'auto', history, config,
  provider: { id: 'p', model: 'm', contextWindow: tailCap },
  model: 'm',
});

test('126-111b · L2 尾部单元边界＋桥接', () => {
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

  const H = oneBigTurn(12, 40);
  const total = srv.estimateHistoryTokens(H);
  // 尾预算 = min(reseedTailMaxTokens, budget×0.5);把窗口压到让整个 user 回合装不下。
  const tightWindow = Math.floor(total * 0.5);

  // ── [A] 开关关 = 今天的行为:一条不留 ───────────────────────────────────────────────
  {
    const off = planOf(H, {}, tightWindow);
    ok(off.kept.length === 0, `A1 开关关:最新一整回合放不下 -> 一条不留(实得 kept ${off.kept.length})`);
    const reseeded = srv.CompactionPlan.reseed(off, 'SUMMARY');
    ok(reseeded.length === 2 && reseeded[0].role === 'user' && reseeded[1].role === 'assistant',
      `A2 开关关:重播种就是「摘要 user ＋ 一句收到」两条(实得 ${reseeded.length} 条)`);
    const offExplicit = planOf(H, { runtimeReseedTailUnitsV1: false }, tightWindow);
    ok(JSON.stringify(off.kept) === JSON.stringify(offExplicit.kept), 'A3 显式 false 与缺省逐字节相同');
  }

  // ── [B] 开关开 ───────────────────────────────────────────────────────────────────
  {
    const on = planOf(H, { runtimeReseedTailUnitsV1: true }, tightWindow);
    ok(on.kept.length > 0, `B1 开关开:装不下时按单元从尾部装,不再一条不留(实得 kept ${on.kept.length} 条)`);
    ok(on.kept.length < H.length, `B2 但也没把整段都留下(实得 ${on.kept.length}/${H.length})`);
    const keptTools = on.kept.filter(m => m.role === 'tool').length;
    ok(keptTools >= 1, `B3 尾部至少留住一次完整的工具往来(实得 ${keptTools} 条 tool)`);
  }
  {
    // 装得下的历史:开关开也必须走【老路】,逐字节相同。
    const small = oneBigTurn(2, 4);
    const roomy = srv.estimateHistoryTokens(small) * 40;
    const a = planOf(small, {}, roomy);
    const b = planOf(small, { runtimeReseedTailUnitsV1: true }, roomy);
    ok(a.boundary === b.boundary && JSON.stringify(a.kept) === JSON.stringify(b.kept),
      `B4 **装得下时开关开也走老路**,逐字节相同(boundary ${a.boundary} vs ${b.boundary})`);
  }

  // ── [C] 配对铁律 ─────────────────────────────────────────────────────────────────
  {
    // **扫一段预算区间**,而不是只看一个档。单看一个档时边界碰巧落在 assistant 上,于是
    // 「把单元起点换成『每一条都能当起点』」这种反向照样绿 —— 判据没咬住它声称要咬的东西
    // (本会话第四次同一族)。逐档扫过去,危险档必然被覆盖到。
    //
    // 还要**两种形状都扫**。只用 H(工具结果大、assistant 文本小)时,从尾部往回装总是「大块的 tool
    // 撑爆预算」而断在 assistant 上 —— 于是上面那个反向照样绿。反过来的形状(assistant 文本大、
    // 工具结果小)才会让断点真的可能落在 tool 上:装完 tool、再装它前面那条大 assistant 时溢出。
    const heavyText = [{ role: 'user', content: '开始' }];
    for (let t = 0; t < 10; t++) {
      heavyText.push({ role: 'assistant', content: '解释一大段'.repeat(400), tool_calls: [{ id: `h${t}`, type: 'function', function: { name: 'file_read', arguments: '{}' } }] });
      heavyText.push({ role: 'tool', tool_call_id: `h${t}`, content: big(1) });
    }
    heavyText.push({ role: 'assistant', content: '收工' });
    const caps = [];
    for (let cap = 300; cap <= 30000; cap += 311) caps.push(cap);
    const bad = [];
    for (const [name, hist] of [['工具大', H], ['文本大', heavyText]]) {
      for (const cap of caps) {
        const b = srv.recentTurnsBoundary(hist, cap, true);
        if (b < hist.length && hist[b] && hist[b].role === 'tool') bad.push(`${name}/${cap}->${b}`);
      }
    }
    ok(bad.length === 0,
      `C0 两种形状各扫 ${caps.length} 个尾预算,边界**从不落在 tool 上**(落了就会把 assistant 与它的回复劈开 -> 下次请求 400)${bad.length ? ';实得:' + bad.slice(0, 6).join(' ') : ''}`);
    const on = planOf(H, { runtimeReseedTailUnitsV1: true }, tightWindow);
    ok(on.boundary === 0 || H[on.boundary].role !== 'tool',
      `C1 切口永远不落在 tool 上(boundary ${on.boundary} / role ${on.boundary < H.length ? H[on.boundary].role : 'EOF'})`);
    const reseeded = srv.CompactionPlan.reseed(on, 'SUMMARY');
    const callIds = reseeded.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(c => c.id));
    const replyIds = new Set(reseeded.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    ok(callIds.length > 0 && callIds.every(id => replyIds.has(id)),
      `C2 重播种之后 tool_call 零孤儿(${callIds.length} 个调用全部有回复)`);
    const orphanTools = reseeded.filter(m => m.role === 'tool' && !callIds.includes(m.tool_call_id)).length;
    ok(orphanTools === 0, `C3 也没有「回复找不到调用」的那一头(实得 ${orphanTools} 条)`);
  }

  // ── [D] 桥接 ─────────────────────────────────────────────────────────────────────
  {
    const on = planOf(H, { runtimeReseedTailUnitsV1: true }, tightWindow);
    const reseeded = srv.CompactionPlan.reseed(on, 'SUMMARY');
    const startsWithAssistant = on.kept[0] && on.kept[0].role === 'assistant';
    ok(startsWithAssistant, 'D0 夹具自检:这一档下保留段确实以 assistant 打头(否则 D1 是空断言)');
    ok(reseeded[2] && reseeded[2].role === 'user' && String(reseeded[2].content).includes('接续执行'),
      `D1 保留段以 assistant 打头时插了桥接 user(实得第三条 role=${reseeded[2] && reseeded[2].role})`);
    // 没有两条连着的 assistant —— 那正是桥接要防的事。
    let consecutive = 0;
    for (let i = 1; i < reseeded.length; i++) {
      if (reseeded[i].role === 'assistant' && reseeded[i - 1].role === 'assistant') consecutive++;
    }
    ok(consecutive === 0, `D2 重播种结果里没有两条连着的 assistant(实得 ${consecutive} 处)`);
  }
  {
    // 保留段以 user 打头(走老路的那一档):**不插**桥接,不无缘无故多一条。
    //
    // 夹具第一版用的是单回合历史 ＋ 宽窗口,以为 kept 会以 user 打头 —— 实测 `boundary === 0` 时
    // `kept` 按设计就是**空的**(`boundary <= 0 ? [] : slice`):整段都装得进尾预算,等于摘要已经
    // 覆盖了它,再留一遍是重复。于是 D4 成了空断言(没有第三条,当然不含桥接)。改成**多个 user 回合**,
    // 让边界落在靠后的某个 user 起点上,kept 才真的以 user 打头。
    const multi = [];
    for (let t = 0; t < 6; t++) {
      multi.push({ role: 'user', content: `第 ${t} 件事` });
      multi.push({ role: 'assistant', content: null, tool_calls: [{ id: `m${t}`, type: 'function', function: { name: 'file_search', arguments: '{}' } }] });
      multi.push({ role: 'tool', tool_call_id: `m${t}`, content: big(20) });
      multi.push({ role: 'assistant', content: `第 ${t} 件做完了` });
    }
    // 窗口调到「只装得下最后一两个 user 回合」:边界落在某个 user 起点上,且不是 0。
    const window = Math.floor(srv.estimateHistoryTokens(multi) * 0.8);
    const plan = planOf(multi, { runtimeReseedTailUnitsV1: true }, window);
    const reseeded = srv.CompactionPlan.reseed(plan, 'SUMMARY');
    ok(plan.boundary > 0 && plan.kept.length > 0 && plan.kept[0] && plan.kept[0].role === 'user',
      `D3 夹具自检:这一档保留段以 user 打头(boundary ${plan.boundary}、kept ${plan.kept.length} 条、首条 ${plan.kept[0] && plan.kept[0].role})`);
    ok(!String(reseeded[2] && reseeded[2].content || '').includes('接续执行'),
      'D4 以 user 打头时**不插**桥接(不无缘无故多一条)');
    ok(reseeded[2] && reseeded[2].role === 'user' && reseeded[2] === plan.kept[0],
      'D4b 第三条就是 kept 的首条本身(没有被塞进别的东西)');
  }

  console.log('\nRESEED TAIL UNITS UNIT: ' + (fail ? `${fail} FAILURE(S)` : 'ALL PASS'));
  assert.equal(fail, 0, `${fail} 条判据未通过`);
});
