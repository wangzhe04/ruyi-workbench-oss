'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// thread-facts.js — 线程/任务的「事实折算」纯函数叶子（121 波 K1，34 号文 §8.2）。
//
// 这些函数 121 波之前住在 js/preview-task-sheet.js（交办台的任务单层）。交办台退役后它们的消费者
// 只剩管家视角的看板与抽屉，以及新开任务时的验收里程碑 —— 它们本来就与任何一个壳无关：
// 入参是 /api/missions 的行或 /api/missions/:id 的快照，出参是可直接画的数字与条目。
// 纪律与 mission-state.js 一致：纯函数、零 DOM、零 t()、零 fetch。
// ─────────────────────────────────────────────────────────────────────────────

// 五态 → 圆点色调。原住 preview-shell.js:54。
// 117n-M1③：settled 只在 done 且【调用方主动选它】时才出（看板的 paintDot 传 settleDone:true）；
// 不传这个选项时的返回值一个字没变（done 仍落 quiet）。
// 121-K1 落点交代：34 号文 §8.2 原计划把它搬进 mission-state.js（「五态的表现与五态同住」）。
// 实测不行，两条硬理由：① mission-state.js 是 UMD（六件 Node 测试 require 它），加不了 ESM 命名导出，
// 消费者只能改成读 globalThis.MissionState —— 而 steward-board.static.e2e.js B1 钉着「看板零直接
// MissionState 引用」（那是「不许长出第二份五态判据」的机械保证），搬过去等于把一把真锁拆了；
// ② steward-tools.static.e2e.js ⑥ 拿 mission-state.js 与服务端 06i 逐条机械对账，那个文件应当
// 只住五态判据本身。而 tone 是「五态的显示事实」，与本文件的 taskProgress／elapsedLabel 同族。
export function dockToneForMissionState(value, { settleDone = false } = {}) {
  if (value === 'needs_you') return 'attention';
  if (value === 'running' || value === 'dispatching') return 'active';
  if (settleDone && value === 'done') return 'settled';
  return 'quiet';
}

// 任务卡的重绘签名（原住 preview-dock-home.js:7）。116-3 A4：签名要覆盖【卡片真的画出来的每一样
// 事实】。117h 第 0 步给 /api/missions 的行加了 missionTitle / goal / acceptanceItems（事项容器直出），
// 而 acceptance.done/total 早就在画了 —— 它们都不在旧签名里。改事项标题、改目标、勾一条验收项时
// updatedAt 不一定动（容器与会话是两份文件），签名不变 → 整块不重绘，用户看到的还是旧标题/旧进度。
export function missionCardSignature(card, ui = {}) {
  const pending = card && card.pending;
  const acceptance = (card && card.acceptance) || {};
  return [
    card && card.missionId,
    card && card.updatedAt,
    (card && card.runCount) || 0,
    card && card.activeTurn || '',
    !!(card && card.mission && card.mission.done),
    pending ? (pending.permissions || 0) + ':' + (pending.questions || 0) + ':' + (pending.plans || 0) + ':' + (pending.pool || 0) : '',
    (card && card.missionTitle) || '',
    (card && card.goal) || '',
    (Number(acceptance.done) || 0) + '/' + (Number(acceptance.total) || 0),
    ui.pinned ? 1 : 0,
    ui.archived ? 1 : 0,
  ].join('|');
}

// 验收进度。有详情快照就以快照的 acceptance 为准（容器直出的整表），否则退回卡片账本的里程碑计数。
// 124-P1：快照自此带 acceptance.merged（会话账本里程碑 ＋ 事项容器里那些不与账本重文案的验收项，
// 判据单点在服务端 buildMissionAcceptanceProjection）。有它就用它 —— 界面上画的是哪几条，a/b 就该数
// 哪几条；没有它（老快照 / 只喂了 done|total 的调用点）退回既有口径，一个字不变。
export function taskProgress(card, snapshot = null) {
  if (snapshot && snapshot.acceptance) {
    const merged = snapshot.acceptance.merged;
    const source = (merged && typeof merged === 'object') ? merged : snapshot.acceptance;
    const total = Math.max(0, Number(source.total) || 0);
    const done = Math.min(total, Math.max(0, Number(source.done) || 0));
    return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
  }
  const mission = card && card.mission || {};
  const total = Math.max(0, Number(mission.milestonesTotal) || 0);
  const done = Math.min(total, Math.max(0, Number(mission.done) || 0));
  return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
}

// 124-P1（40 号文 §2 ①）：一条验收项现在还带着「这条是谁判的」。四态的判据【全在服务端】
// （02 的 buildMissionAcceptanceProjection，一处），本函数只归一化成界面用的形状，不在前端补第二套
// 推导 —— 前端一旦自己按 checkType 推「机器检查」，服务端那条「有检查 ≠ 跑过检查」的判据就白钉了。
//   provenance: 'machine' 机器检查落过通过的章 ｜ 'self' 账本上自报完成 ｜ 'human' 事项验收项里人勾的
//               ｜ 'open' 还没完成
//   checkState: 'none' 没有机器检查 ｜ 'never' 有检查但一次没跑过 ｜ 'pass' ｜ 'fail'（最近一次）
// 事项容器那一套（人工复核）只在【这条线程没有自己的账本】时才接到清单后面：事项级验收项属于整个
// 事项，挂到每条线程上会把同一份账印好几遍；而一条没有账本的线程此前在这一块里只有「暂无」——
// 那是 40 号文 §1 结论 3 说的「问不出答案」。有账本时「人工复核」仍然出得来：服务端把【逐字同文
// 且用户已勾】的容器验收项接到对应的里程碑上（buildMissionAcceptanceProjection 的 humanCheckedTexts）。
export function acceptanceItems(snapshot) {
  const acceptance = (snapshot && snapshot.acceptance) || null;
  const source = Array.isArray(acceptance && acceptance.items) ? acceptance.items : [];
  const rows = source.map((item, index) => ({
    id: String(item && item.id || `item-${index + 1}`),
    desc: String(item && item.desc || '').trim(),
    status: ['done', 'blocked', 'pending'].includes(String(item && item.status)) ? String(item.status) : 'pending',
    evidence: String(item && item.evidence || '').trim(),
    checkType: String(item && item.checkType || 'none'),
    provenance: ['machine', 'self', 'human', 'open'].includes(String(item && item.provenance)) ? String(item.provenance) : '',
    checkState: ['none', 'never', 'pass', 'fail'].includes(String(item && item.checkState)) ? String(item.checkState) : 'none',
    checkedAt: String(item && item.checkedAt || ''),
    checkDetail: String(item && item.checkDetail || ''),
    source: 'ledger',
  }));
  const containerRows = (acceptance && acceptance.ledger !== true && Array.isArray(acceptance.container && acceptance.container.items))
    ? acceptance.container.items : [];
  for (const row of containerRows) {
    if (row && row.duplicate === true) continue;
    const text = String(row && row.text || '').trim();
    if (!text) continue;
    rows.push({
      id: String(row && row.id || `acc-${rows.length + 1}`),
      desc: text,
      status: row && row.done === true ? 'done' : 'pending',
      evidence: '',
      checkType: 'none',
      provenance: row && row.done === true ? 'human' : 'open',
      checkState: 'none',
      checkedAt: String(row && row.doneAt || ''),
      checkDetail: '',
      source: 'container',
    });
  }
  return rows;
}

// 「这条线程有没有验收记录」。判据不是 items.length —— 立了账本还没定里程碑的 2.0 任务单也是 0 条，
// 但那是「还没写」不是「没记过」。ledger 由服务端按【与 06i ledgerless 同一条判据】（会话头有没有
// mission 容器）给出；容器里有验收项同样算有记录。两者都没有 → 界面说「未记录验收」，不说 0/0
// （0/0 会被读成「一条都没做完」—— 41 号方案 §9 J15「从真实记录答复，不靠猜」）。
export function acceptanceRecorded(snapshot) {
  const acceptance = (snapshot && snapshot.acceptance) || null;
  if (!acceptance) return false;
  if (acceptance.ledger === true) return true;
  // 两种入参形状读的是【同一件事实】：
  //   · 详情快照（/api/missions/:id → 02 的 buildMissionAcceptanceProjection）把事项验收项放在
  //     `acceptance.container.items`，而 `acceptance.items` 那一层是【账本里程碑】；
  //   · 列表行（/api/missions → 13d 的 buildMissionAggregateRows）没有第二层，事项验收项就直接
  //     放在 `acceptance.items`。
  // 先看 container、没有再回落 items 是安全的：详情那边 `ledger === false` 时里程碑必为空
  // （`ms` 由 `mission.milestones` 来，没账本就没里程碑），所以回落读到的不可能是里程碑。
  // 124 还债①：这条回落就是让【看板】也能用上这一个判据的那半句 —— 全仓判「记过验收没有」
  // 仍然只有本函数一处。
  const containerItems = (acceptance.container && Array.isArray(acceptance.container.items))
    ? acceptance.container.items
    : (Array.isArray(acceptance.items) ? acceptance.items : []);
  return containerItems.length > 0;
}

export function activeAcceptanceIndex(items) {
  const list = Array.isArray(items) ? items : [];
  const pending = list.findIndex(item => item && item.status === 'pending');
  if (pending >= 0) return pending;
  return list.findIndex(item => item && item.status === 'blocked');
}

// 前端【唯一】的 mission 里程碑生产者（34 号文 §8.3 第 1 条）。
// 服务端 POST /api/mission action:start 要求至少一条里程碑，否则账本立不起来 —— 而账本一旦为空，
// 抽屉的验收块（steward-drawer.js）与看板的验收计数（steward-board.js）对这条新任务就永远是空的。
// 目标（goal）保持用户原话，验收另行措辞：账本要说清「什么叫做完」，不是把任务再抄一遍。
//
// 121-K6b（34 号文 §13.3 ①「里程碑不丢」）：接线点已经落定 —— js/steward-conversation.js 的
// `ensureAcceptanceLedger`，挂在 finishReply 里「这一回合真开出了一条新线程」那一刻
// （判据是全仓唯一那条 executedThreadSessionId，只认 ok===true 的开线程工具）。
// 121-K1 那段「暂无生产调用点」的历史交代留在这里，因为它解释了这个洞是怎么来的：
//   · 唯一那条 POST /api/mission {action:'start'} 的路径（原 app.js 的 startPreviewDispatchCommand）
//     住在交办台的派单输入框里，随交办台一起删了；幸存的 /api/mission 调用只剩
//     session-experience.js 那一处 {action:'stop'}。
//   · 服务端 13k stewardImplThreadNew 只写 session.kind='mission'，【不】建里程碑账本 ——
//     所以账本必须由前端在开线程回执到手那一刻立起来（本刀零后端）。
// 行为仍由 dev-harness/unit/thread-facts.test.js 钉住；接线本身由 steward-conversation.e2e 钉
// 「新开任务后 /api/mission 的 milestones 非空」（反向：注释掉这一处调用 → 红）。
export function dispatchAcceptanceMilestones(prompt) {
  const source = String(prompt || '').trim();
  const chinese = /[\u3400-\u9fff]/.test(source);
  const research = /(?:分析|研究|调研|趋势|走势|比较|对比|报告|数据|市场|股票|美股|A股|research|analy[sz]e|trend|compare|market|stock)/i.test(source);
  const engineering = /(?:实现|开发|修复|重构|代码|接口|页面|组件|测试|bug|fix|implement|refactor|code|api|ui|test)/i.test(source);
  const artifact = /(?:文档|方案|表格|幻灯片|文件|交付|导出|生成|document|spreadsheet|slides?|file|deliver|export|create)/i.test(source);
  let outcome;
  let evidence;
  if (research) {
    outcome = chinese
      ? '结论直接回答目标问题，并覆盖点名的对象、范围与时间口径'
      : 'The conclusions directly answer the question and cover the named subjects, scope, and time frame';
    evidence = chinese
      ? '关键判断附有可核验的数据、事实或来源，并说明必要的限制与不确定性'
      : 'Key judgments include verifiable data, facts, or sources and state material limitations and uncertainty';
  } else if (engineering) {
    outcome = chinese
      ? '请求的功能或改动已按约定范围落地，且不引入无关行为变化'
      : 'The requested behavior or change is implemented within scope without unrelated behavior changes';
    evidence = chinese
      ? '相关检查或测试通过，关键交互、边界情况与回归风险均有可核验结果'
      : 'Relevant checks pass with verifiable coverage of key interactions, edge cases, and regression risk';
  } else if (artifact) {
    outcome = chinese
      ? '请求的交付物已生成并可正常打开或使用，内容覆盖明确要求'
      : 'The requested deliverable is produced, usable, and covers the explicit requirements';
    evidence = chinese
      ? '交付物的格式、完整性与关键内容已经过核验，并提供可定位的产出'
      : 'The deliverable format, completeness, and key content are verified with a locatable output';
  } else {
    outcome = chinese
      ? '最终结果完整回应任务目标及其中明确提出的约束'
      : 'The final result fully addresses the task goal and its explicit constraints';
    evidence = chinese
      ? '关键结论或交付附有可核验的事实、产出或检查结果'
      : 'Key conclusions or deliverables include verifiable facts, outputs, or check results';
  }
  return [
    { id: 'accept-outcome', desc: outcome, status: 'pending' },
    { id: 'accept-evidence', desc: evidence, status: 'pending' },
  ];
}

// 时长（不是「多久以前」—— 那一支走 Intl.RelativeTimeFormat，见 steward-conversation.js 的注释）。
export function elapsedLabel(startedAt, current = new Date()) {
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt || ''));
  const end = current instanceof Date ? current.getTime() : Date.parse(String(current || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// 124 还债①（40 号文 §8.5 ①）：这一件「收工了没有」。
// 与上面的 dockToneForMissionState 同族 —— 它**不判五态**，只对调用方已经算好的那个字符串做一次
// 折算（五态的正身仍然只有 mission-state.js 一处）。
// **为什么放在这里而不是 steward-board.js**：看板那边的 M6／N3 两条静态锁钉着「本模块零
// 'done'／'stopped' 字面量」，那正是「不许在看板里长出第二套五态判据」的机械保证 —— 不该为了
// 一行便利把它拆了（第一版就是写在看板里，M6／N3 当场转红，那一红是对的）。
// 只认 done／stopped：quick_ask 虽然同属「此刻没在动」，但它不是一件交办出去的活，
// 调用方那一侧的 tracked 门本来就把它挡在外面，这里不越权替它下定义。
export function missionStateSettled(value) {
  return value === 'done' || value === 'stopped';
}

// 124 还债④（40 号文 §8.5 ④）：这个函数原住 steward-board.js。走查② 把右栏那一份改成「最近发生的
// 那一件」之后，服务端 13q stewardVisit 里还留着自己那一份挑选式（`rows.find(needs_you) ||
// rows.find(running) || rows[0]`，且 rows 的排序把 dispatching 顶到了「其余」之前）—— **同一个问题
// 两处判**：右栏挑一条、问候语那枚「打开这一件」挑另一条，迟早各说各话。
// 收法：服务端**不再挑**（只投影 threads 事实），挑哪一条由这一份纯函数判。于是它得住在
// **看板与管家对话都够得着的叶子**里 —— 本文件零 import、零 DOM、零 t()、零 fetch，正是这个位置
// （与 121-K1 把 dockTone 一族搬进来同一条理由）。steward-board.js 仍按原名 re-export，既有的
// C1/C3 静态锁与 focus-rail B1 那份页面真值表一个字都不用改。
//
// ── 焦点线程：等你 ＞ 在跑 ＞ 最近发生的那一件（§8.10／§5 117h 行）──────────────────
// 纯函数、零 DOM、零 import 依赖：dev-harness/unit/steward-focus-thread.test.js 直接 import 跑真值表。
// 入参是【已经带好五态】的行（五态由调用方经 mission-state.js 算出，本函数不认识卡片形状，也就
// 不可能在这里长出第二套五态判据）。
//
// 124 走查（用户 2026-09-15 真机：「每次线程跑完了都会切到同一个线程」）：第三档原来是
// **已停工**（`pick('stopped')`，「失败要看得见」），但它**没有时效尺** —— 一条昨天停工的线程
// 会永远赢过今天刚做完的那条，于是每有一条线程跑完，右栏「现在这一件」就被拽回那条旧的停工
// 线程。用户报的那条美股线程正是这个形状（已停工、昨天、一句话都没说过）。
//
// 拍板（用户 2026-09-15）：**第三档改成「最近发生的那一件」，不分 done/stopped。**
// 理由是这一栏回答的问题是「此刻最该看的是哪一条」，那只可能是刚刚发生的那一条；失败的可见性
// 由左栏的五态药丸与收工卡承担，不靠把一条旧的失败永久钉在右栏来实现。
// 于是实现就是把 `pick('stopped')` 那一档整个去掉 —— 最后那条「最近更新的赢」本来就在，
// 它自然接住 done 与 stopped 两种收工态。
export function focusThreadFor(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && row.sessionId);
  if (!list.length) return null;
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const pick = state => list.filter(row => row.state === state).sort(newest)[0] || null;
  return pick('needs_you') || pick('running') || list.slice().sort(newest)[0] || null;
}
