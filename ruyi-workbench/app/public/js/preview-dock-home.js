'use strict';

export function missionCardSignature(card, ui = {}) {
  const pending = card && card.pending;
  return [
    card && card.missionId,
    card && card.updatedAt,
    (card && card.runCount) || 0,
    card && card.activeTurn || '',
    !!(card && card.mission && card.mission.done),
    pending ? (pending.permissions || 0) + ':' + (pending.questions || 0) + ':' + (pending.plans || 0) + ':' + (pending.pool || 0) : '',
    ui.pinned ? 1 : 0,
    ui.archived ? 1 : 0,
  ].join('|');
}
