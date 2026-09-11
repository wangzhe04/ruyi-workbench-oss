'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// mission-state.js — 任务单五态派生纯函数（任务台立项门 P0）
//
// 概念稿(UI-VNEXT-CONCEPT §0)的五态:交办中 dispatching / 进行中 running / 需要你 needs_you /
// 已收工 done / 已停工 stopped;quick_ask 是显式逃生舱(不硬套任务心智,概念稿风险 #1)。
// 117r-D5:那个逃生舱的【判据】从「kind 是不是 quick_ask」换成「调用方有没有这条线程的事实」
// (factsUnknown,默认有事实)。速查是一个 kind,不是一个 state —— 一条速查线程在跑就该说 running、
// 跑完就该说 done;它「是速查」这件事由 kind 说(看板行上的徽标),不再霸占状态位。
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
  // 117q-B3b（30 号文 §4.4）：LABELS 是服务端 06i-steward-core.js STEWARD_STATE_LABELS 那份表
  // 的抄写件镜像 —— 留着是为了让两边 derive* 返回值形状对齐（06i 的 label 字段真有人读，见服务端
  // 那一侧）。用户可见的人话一律走 t('mission.state.*')（steward-board.js / steward-drawer.js
  // 两处 stateLabel() 都查这一组键；121-K1 前还有交办台那第三处），前端任何地方都不许读本文件 LABELS
  // 或 deriveMissionState().label —— 那样会绕开 i18n，英文界面会看到中文。
  const LABELS = {
    dispatching: '交办中', running: '进行中', needs_you: '需要你',
    done: '已收工', stopped: '已停工', quick_ask: '速问',
  };

  function pendingTotal(p) {
    const o = (p && typeof p === 'object') ? p : {};
    return (Number(o.permissions) || 0) + (Number(o.questions) || 0) + (Number(o.plans) || 0) + (Number(o.pool) || 0);
  }

  // 归一化输入(卡片与详情快照都可适配进来,见 fromCard/fromSnapshot):
  //   { kind, autoMode, budgetExhausted, resultStatus, pending, activeTurn, liveRuns, runCount, turnSeq,
  //     milestonesTotal, milestonesDone, ledgerless, lastTurnFailed }
  function deriveMissionState(n) {
    const src = {
      // 117r-D5:kind 自此【只是证据】,不再参与判定 —— 「这条线程是什么」(kind)和「它在干什么」
      // (state)是两回事,把前者塞进五态正是 ①②③ 三条毛病的同一个根因。默认值留着不动:它对
      // state 已经完全无害(下面的守卫不读它),动它反而会改掉 sources 里那条已被消费的证据形状。
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
      // 117p-S2(30 号文 §8.3):无账本线程的两个新证据键。ledgerless 的唯一判据是卡片
      // status === 'none'(13d missionCardStatus(null) 的返回值)/ 会话头没有 mission 容器 ——
      // 不许用 milestonesTotal === 0 之类的近似,那会把还没定里程碑的 2.0 任务单误判成无账本线程。
      ledgerless: n.ledgerless === true,
      lastTurnFailed: n.lastTurnFailed === true,
      // 117r-D5(用户第八轮走查③的三条子症状):守卫从「是不是速查」换成「调用方手上有没有这条
      // 线程的事实」。默认【有事实】—— 只有明说 factsUnknown:true 的调用面才短路(全仓唯一一处:
      // 13d buildMissionAggregateRows 那条「没卡片、也不是 mission 会话」的 else 支,它刻意不读
      // 会话头以省 I/O,注释就写在那里)。于是 'quick_ask' 退回它唯一诚实的语义:【事实未知】,
      // 而不是「这是一条速查线程」。速查这个身份仍然在,它活在 kind 上(看板行上的徽标读它)。
      factsUnknown: n.factsUnknown === true,
    };
    let state;
    // 0. 事实未知的逃生舱:调用方明说「我没有这条线程的事实」时,不硬套五态(概念稿风险 #1 的
    // 落点仍在,只是判据从 kind 换成了 factsUnknown —— 117r-D5,理由见上面那条证据键的注释)。
    if (src.factsUnknown) state = 'quick_ask';
    // 1. 需要你:有未决 Intervention 永远最先亮(鎏金)——哪怕任务同时在跑/已停,等你拿主意是最高打扰级。
    else if (src.pendingTotal > 0) state = 'needs_you';
    // 2. 已收工:结果章 complete(72波持久化盖章,全部里程碑 done 的权威记录)。
    else if (src.resultStatus === 'complete') state = 'done';
    // 3. 进行中:活回合 / until-done 驱动中 / 有未暂停的活 run —— 有权威活证据才算在干,不靠猜。
    else if (src.activeTurn || src.autoMode === 'until-done' || src.liveRuns > 0) state = 'running';
    // 4. 交办中:立了单但还没有任何执行痕迹(无 run、无回合、无里程碑完成)——刚交办待启动。
    else if (src.runCount === 0 && src.turnSeq === 0 && src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';
    // 4b. 117p-S2:无账本线程(没有里程碑、没有结果章、没有班组)跑过回合且此刻没在跑 -> 已收工;
    // 末回合 ok:false 或 aborted -> 已停工;账缺席(lastTurn 为 null)按成功算,与 13i 的
    // @sessionTurn 解析器「账缺席一律 done」同口径。有账本的 2.0 任务单语义一个字不变。
    else if (src.ledgerless && src.turnSeq > 0) state = src.lastTurnFailed ? 'stopped' : 'done';
    // 5. 已停工:其余一切 —— 结果章 stopped / 预算耗尽(supervised 待命)/ 用户停驱(idle)——诚实:活没在干。
    else state = 'stopped';
    return { state, label: LABELS[state] || state, sources: src };
  }

  // 列表卡片(/api/missions 的 card)适配。
  function fromCard(card) {
    const m = (card && card.mission) || {};
    const lr = (card && card.lastRun) || null;
    return deriveMissionState({
      // 121-K3:身份取卡片的 `quick` 格,不再取 `kind`。**本行是 06i stewardThreadStateFromCard 的
      // 抄写件**(§11.15.4 纪律,unit/thread-state-quick-kind.test.js 钉两份输出逐字相等),
      // 服务端那一份改了这里就必须跟着改 —— 理由写在 06i 与 13d buildMissionCard 的 quick 注释里:
      // K3 之后普通会话也有卡片,而 sessionKind 对它们同样返回 'quick_ask'(档位),
      // 与「这是一条速查线程」(身份)分了家。kind 仍然不参与五态判定(117r-D5),只是证据那一格。
      kind: (card && card.quick === true) ? 'quick_ask' : 'mission',
      autoMode: m.autoMode,
      budgetExhausted: m.budgetExhausted === true,
      resultStatus: (m.result && m.result.status) || '',
      pending: card && card.pending,
      activeTurn: card && card.activeTurn === true,
      liveRuns: lr && lr.live && !lr.paused ? 1 : 0,
      runCount: card && card.runCount,
      // 117p-S2:卡片自 13e schema 4 起带 turnSeq / lastTurn(13d buildMissionCard 的会话头投影)。
      // 旧索引里的存量卡片没有这两个键 -> turnSeq 归一成 0、lastTurnFailed false,行为退回修前,
      // 升号强制整份重建正是为了让它们刷新(见 13e PRETENDER_INDEX_SCHEMA 注释)。
      turnSeq: card && card.turnSeq,
      ledgerless: !!(card && card.status === 'none'),
      lastTurnFailed: !!(card && card.lastTurn && (card.lastTurn.ok === false || card.lastTurn.aborted === true)),
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
