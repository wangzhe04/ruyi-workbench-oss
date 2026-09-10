'use strict';

// 32 号文 §4（M2-b）：一个 agent run「现在能不能暂停／能不能恢复」的判据，全仓只此一份。
//
// 修前同一条判据在三个地方各写一遍（用户原话：「前端应该重复的很多，用户认知成本很大」）：
//   · 2.0 顶栏的 run 卡（js/agent-workflows.js）：`run.live && !run.paused` → 暂停键；
//     `run.live && run.paused` → 恢复键；`!run.live` → 「恢复未完成节点」；
//   · 3.0 看板行（js/steward-board.js）：行内那两枚键各判一次，`syncPauseAll` 与 `pauseAll`
//     又各判一次，两次还得靠注释声明「与上面那枚逐字同源」；
//   · 3.0 抽屉底部（js/steward-drawer.js）：顶层的 pausableRunOf(snapshot) 取最后一条 live run，
//     再看它的 paused 决定底部是「暂停」还是「继续」。
// 三处判的是同一件事：这条 run 现在能施加哪个动作。判据（不是按钮）住在这里，两个壳都调它。
//
// 纯函数、零 DOM、零全局、零请求：Node 里可直接 import 跑真值表（unit 与静态锁都按这个口径）。
// run 的三种来源同形（都有 live / paused 两个字段）：2.0 的 run 对象、3.0 快照里的 run 卡片、
// 看板行上的 row.lastRun。

// 文案键表：2.0 与 3.0 各有自己的 catalog 键（本波不动 locale），但「哪个动作配哪条键」只在
// 这一份里定义 —— 两个壳都从这里取，不再各写一遍字面量。
export const RUN_STATE_TEXT_KEYS = Object.freeze({
  // 2.0（顶栏 run 卡）：'恢复' 与 '恢复未完成节点' 是两件事，键也分两条。
  v2: Object.freeze({
    pause: 'workflow.pause',
    resume: 'workflow.resume',
    resumeIncomplete: 'workflow.resumeIncomplete',
    resumeIncompleteAria: 'workflow.resumeIncompleteAria',
    stop: 'workflow.stop',
  }),
  // 3.0（管家壳）：看板行与抽屉两枚键共用 board 那两条（抽屉原来的 drawer.pause/resume 逐字
  // 同值，本波不改 locale，故不新增键；抽屉那句「没有可暂停的运行」仍是它自己的键）。
  v3: Object.freeze({
    pause: 'stewardShell.board.pause',
    resume: 'stewardShell.board.resume',
    paused: 'stewardShell.board.paused',
    resumed: 'stewardShell.board.resumed',
    noPausableRun: 'stewardShell.drawer.noPausableRun',
  }),
});
export function runTextKeys(shell) { return shell === 'v2' ? RUN_STATE_TEXT_KEYS.v2 : RUN_STATE_TEXT_KEYS.v3; }

// 「还活着」＝ live 是真值。三态判据的地基，单独给一个名字，免得各处再写 `x.live === true`。
export function runIsLive(run) { return Boolean(run && run.live === true); }
// 还活着且没暂停 → 能暂停；还活着且暂停着 → 能恢复。两者互斥，都不成立就是「这一条没得点」。
export function runCanPause(run) { return runIsLive(run) && run.paused !== true; }
export function runCanResume(run) { return runIsLive(run) && run.paused === true; }
// 二选一的那一枚键该走哪个动作：'pause' | 'resume' | ''（已收工的 run 落 ''）。
export function runControlAction(run) {
  if (runCanPause(run)) return 'pause';
  if (runCanResume(run)) return 'resume';
  return '';
}

// 快照里「还活着的那一条 run」（117h 抽屉底部与看板行共用的那一段判据，逐字搬来）。
// 暂停／继续只对「还活着的那一条 run」有意义：快照里最后一条 live run 就是它。
export function pausableRunOf(snapshot) {
  const runs = (snapshot && Array.isArray(snapshot.runs)) ? snapshot.runs : [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run && run.live === true) return run;
  }
  return null;
}

// 批量面（看板「全部暂停」）：哪几行现在能暂停。名单与「那枚键能不能点」是同一份判据的两处用法。
export function pausableRunsOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && runCanPause(row.lastRun));
}
export function hasPausableRun(rows) { return pausableRunsOf(rows).length > 0; }
