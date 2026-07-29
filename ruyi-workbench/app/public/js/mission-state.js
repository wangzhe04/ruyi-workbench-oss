'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// mission-state.js — 任务单五态派生纯函数(第56波 Pretender 立项门 P0)
//
// 概念稿(UI-VNEXT-CONCEPT §0)的五态:交办中 dispatching / 进行中 running / 需要你 needs_you /
// 已收工 done / 已停工 stopped;Quick Ask 是显式逃生舱(纯问答不硬套任务心智,概念稿风险 #1)。
//
// go 条件 #1(状态可信):每个状态只从【权威字段】派生 —— 持久化 mission 账本(autoMode/result/
// budgetExhaustedAt)、持久化 Intervention 计数(pending)、会话 kind、run 快照/活标志;绝不读
// assistant 文本猜。activeTurn/run.live 是内存叠加的活标志(与 /api/agent-runs 的 live 同型),
// 仅用于「进行中」增强,不是终态判据。每条派生带 sources 证据(评审与 PoC tooltip 可查来源)。
//
// 双导出:浏览器挂 window.MissionState(PoC 与将来新壳层共用);node module.exports(e2e 直接 require
// 跑纯函数,不起浏览器)。零依赖,与全仓前端纪律一致。
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MissionState = api;
})(typeof window !== 'undefined' ? window : null, function () {

  const STATES = ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask'];
  const LABELS = {
    dispatching: '交办中', running: '进行中', needs_you: '需要你',
    done: '已收工', stopped: '已停工', quick_ask: '速问',
  };

  function pendingTotal(p) {
    const o = (p && typeof p === 'object') ? p : {};
    return (Number(o.permissions) || 0) + (Number(o.questions) || 0) + (Number(o.plans) || 0) + (Number(o.pool) || 0);
  }

  // 归一化输入(卡片与详情快照都可适配进来,见 fromCard/fromSnapshot):
  //   { kind, autoMode, budgetExhausted, resultStatus, pending, activeTurn, liveRuns, runCount, turnSeq, milestonesTotal, milestonesDone }
  function deriveMissionState(n) {
    const src = {
      kind: n.kind || 'quick_ask',
      autoMode: n.autoMode || 'off',
      budgetExhausted: n.budgetExhausted === true,
      resultStatus: n.resultStatus || '',
      pendingTotal: pendingTotal(n.pending),
      activeTurn: n.activeTurn === true,
      liveRuns: Math.max(0, Number(n.liveRuns) || 0),
      runCount: Math.max(0, Number(n.runCount) || 0),
      turnSeq: Math.max(0, Number(n.turnSeq) || 0),
      milestonesTotal: Math.max(0, Number(n.milestonesTotal) || 0),
      milestonesDone: Math.max(0, Number(n.milestonesDone) || 0),
    };
    let state;
    // 0. Quick Ask 逃生舱:显式 kind,不进入任务五态(概念稿:速问是必需品不是锦上添花)。
    if (src.kind === 'quick_ask') state = 'quick_ask';
    // 1. 需要你:有未决 Intervention 永远最先亮(鎏金)——哪怕任务同时在跑/已停,等你拿主意是最高打扰级。
    else if (src.pendingTotal > 0) state = 'needs_you';
    // 2. 已收工:结果章 complete(72波持久化盖章,全部里程碑 done 的权威记录)。
    else if (src.resultStatus === 'complete') state = 'done';
    // 3. 进行中:活回合 / until-done 驱动中 / 有未暂停的活 run —— 有权威活证据才算在干,不靠猜。
    else if (src.activeTurn || src.autoMode === 'until-done' || src.liveRuns > 0) state = 'running';
    // 4. 交办中:立了单但还没有任何执行痕迹(无 run、无回合、无里程碑完成)——刚交办待启动。
    else if (src.runCount === 0 && src.turnSeq === 0 && src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';
    // 5. 已停工:其余一切 —— 结果章 stopped / 预算耗尽(supervised 待命)/ 用户停驱(idle)——诚实:活没在干。
    else state = 'stopped';
    return { state, label: LABELS[state] || state, sources: src };
  }

  // 列表卡片(/api/missions 的 card)适配。
  function fromCard(card) {
    const m = (card && card.mission) || {};
    const lr = (card && card.lastRun) || null;
    return deriveMissionState({
      kind: (card && card.kind) || 'mission',
      autoMode: m.autoMode,
      budgetExhausted: m.budgetExhausted === true,
      resultStatus: (m.result && m.result.status) || '',
      pending: card && card.pending,
      activeTurn: card && card.activeTurn === true,
      liveRuns: lr && lr.live && !lr.paused ? 1 : 0,
      runCount: card && card.runCount,
      turnSeq: 0, // 卡片无 turnSeq;dispatching 判据由 runCount + milestonesDone 承担(卡片语义足够)
      milestonesTotal: m.milestonesTotal,
      milestonesDone: m.done,
    });
  }

  // 详情快照(/api/missions/:id 的 snapshot)适配。
  function fromSnapshot(snap) {
    const m = (snap && snap.mission) || {};
    const runs = Array.isArray(snap && snap.runs) ? snap.runs : [];
    const acc = (snap && snap.acceptance) || {};
    return deriveMissionState({
      kind: (snap && snap.kind) || 'mission',
      autoMode: m.autoMode,
      budgetExhausted: m.budgetExhaustedAt ? true : false,
      resultStatus: (snap && snap.result && snap.result.status) || (m.result && m.result.status) || '',
      pending: snap && snap.pending,
      activeTurn: snap && snap.activeTurn === true,
      liveRuns: runs.filter(r => r && r.live && !r.paused).length,
      runCount: runs.length,
      turnSeq: snap && snap.cursor && snap.cursor.turnSeq,
      milestonesTotal: acc.total,
      milestonesDone: acc.done,
    });
  }

  return { STATES, LABELS, deriveMissionState, fromCard, fromSnapshot };
});
