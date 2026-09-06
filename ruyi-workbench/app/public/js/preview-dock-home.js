'use strict';

// 116-3 A4：签名要覆盖【卡片真的画出来的每一样事实】。117h 第 0 步给 /api/missions 的行加了
// missionTitle / goal / acceptanceItems（事项容器直出），而 acceptance.done/total 早就在画了 ——
// 它们都不在旧签名里。改事项标题、改目标、勾一条验收项时 updatedAt 不一定动（容器与会话是两份文件），
// 签名不变 → 主页整块不重绘，用户看到的还是旧标题/旧进度。补齐这四个维度，不新增任何数据依赖。
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
