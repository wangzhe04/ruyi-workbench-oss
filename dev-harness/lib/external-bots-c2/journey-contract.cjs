'use strict';
const TYPES = Object.freeze(['permission', 'question', 'plan', 'pool', 'replan']);
const TERMINALS = Object.freeze({ permission: ['allowed', 'denied'], question: ['answered'], plan: ['approved', 'rejected'], pool: ['approved', 'rejected'], replan: ['approved', 'rejected'] });
function assertThat(value, message) { if (!value) throw new Error(message); return value; }
function platformText(row) {
  if (row.host === 'api.bot.qq.com') return String(row.body.content || '');
  const content = typeof row.body.content === 'string' ? JSON.parse(row.body.content) : row.body.content;
  return String(content?.text || '');
}
function findView(text, type, title) {
  for (const line of text.split('\n')) {
    const match = /^(rv_[A-Za-z0-9_-]{22}) (permission|question|plan|pool|replan) (.*)$/.exec(line);
    if (match && match[2] === type && match[3] === title) return match[1];
  }
  return '';
}
function actionCommand(type, code, action) {
  assertThat(TYPES.includes(type) && /^ra_[A-Za-z0-9_-]{22}$/.test(code), 'invalid decision fixture');
  return type === 'question' ? '/answer ' + code + ' [{"q":1,"options":[2],"text":"C2 自定义补充"}]'
    : '/decide ' + code + ' ' + action + (type === 'plan' ? ' C2 完整计划反馈' : '');
}
function inspectTerminal(rows, iv, type) {
  const relevant = rows.filter(row => row.id === iv.id);
  const terminals = relevant.filter(row => row.source === 'external_human' && TERMINALS[type].includes(row.status));
  assertThat(terminals.length === 1, type + ': exactly one authoritative external_human terminal');
  const terminal = terminals[0];
  assertThat(relevant.filter(row => row.status === 'applying').length === 1, type + ': original CAS applying phase occurs once');
  assertThat(terminal.decisionResponse?.ok === true && terminal.decisionResponse.type === type, type + ': terminal owns the actual typed response');
  assertThat(terminal.interventionVersion === (iv.interventionVersion || 0) + 2, type + ': original two CAS versions');
  return terminal;
}
function assertStagedPage(state, publicItem, expected, previous) {
  // GET inbox deliberately projects away private remoteView/remoteCommand.
  // Observe the original isolated durable item, then bind it to the public
  // sent receipt and this exact callback request; it grants no action authority.
  const item = state.items.find(row => row.id === publicItem.id);
  assertThat(item && ['id', 'messageId', 'eventId', 'connectionId', 'platform', 'tenantId', 'conversationId', 'senderId', 'conversationType'].every(key => item[key] === publicItem[key]), 'original staged page public/durable item identity');
  assertThat(item.execution?.status === 'completed' && publicItem.execution?.status === 'completed'
    && ['serverInstanceId', 'finishedAt', 'replyText'].every(key => item.execution[key] === publicItem.execution[key]), 'original staged page execution identity');
  assertThat(item.delivery?.status === 'sent' && publicItem.delivery?.status === 'sent'
    && ['attemptId', 'messageId', 'updatedAt'].every(key => item.delivery[key] && item.delivery[key] === publicItem.delivery[key]), 'original staged page sent attempt identity');
  const command = item.remoteCommand, marker = item.remoteView;
  assertThat(command?.kind === 'pending' && command.handle === expected.handle && command.page === expected.page, 'original page callback handle/page identity');
  assertThat(marker?.handle === expected.handle && marker.page === expected.page && Number.isSafeInteger(marker.pages)
    && marker.page >= 1 && marker.page <= marker.pages && marker.pages <= 1024
    && /^[a-f0-9]{64}$/.test(marker.projectionHash) && /^[a-f0-9]{64}$/.test(marker.recipientHash), 'original staged page identity');
  if (previous) assertThat(['handle', 'pages', 'projectionHash', 'recipientHash'].every(key => marker[key] === previous[key]), 'all original view pages keep one projection/recipient identity');
  const complete = marker.page === marker.pages;
  assertThat(marker.offerId === (complete ? expected.handle : ''), 'only the complete original view has an offer');
  if (complete) {
    const offer = state.remoteActions.find(row => row.offerId === marker.offerId);
    assertThat(offer?.status === 'offered' && offer.claim === null && offer.announcementItemId === item.id
      && offer.binding?.sessionId === expected.sessionId && offer.binding.interventionId === expected.interventionId && offer.binding.type === expected.type
      && offer.binding.connectionId === item.connectionId && offer.binding.platform === item.platform
      && offer.binding.recipientFingerprint === marker.recipientHash, 'complete original offer binds this pending item and recipient');
  }
  return { item, marker };
}
module.exports = { TYPES, TERMINALS, assertThat, platformText, findView, actionCommand, inspectTerminal, assertStagedPage };
