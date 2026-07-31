// Wave 54: pure helpers for the ordered turn narrative.
// Keeping identity, signatures and scroll anchoring outside app.js lets static re-entry, locale refreshes
// and live mounting share the same rules without importing UI globals into this module.

export function normalizeTurnSegments(message) {
  return message && Array.isArray(message.segments)
    ? message.segments.filter(segment => segment && typeof segment.type === 'string')
    : [];
}

export function turnToolAnchorId(toolCallId, scope) {
  const prefix = String(scope || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const call = String(toolCallId || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
  return `turn-tool-${prefix ? prefix + '-' : ''}${call}`;
}

export function messageDomKey(message, index, sessionId) {
  const msg = message || {};
  const explicit = String(msg.id || '').trim();
  if (explicit) return `${sessionId || 'session'}:${explicit}`;
  return [
    sessionId || 'session',
    String(msg.turnSeq ?? ''),
    String(msg.role || 'message'),
    String(msg.createdAt || ''),
    String(index ?? ''),
  ].join(':');
}

const messageObjectIds = new WeakMap();
let messageObjectSeq = 0;
export function messageRenderSignature(message, locale) {
  // Persisted message objects are immutable in the UI. Identity therefore gives us an O(1) invalidation
  // key; a server reload creates fresh objects, while a locale change changes the prefix. Never stringify
  // tool results here—one result can be megabytes and would negate incremental rendering.
  if (!message || typeof message !== 'object') return `${locale || ''}:empty`;
  let id = messageObjectIds.get(message);
  if (!id) { id = ++messageObjectSeq; messageObjectIds.set(message, id); }
  return `${locale || ''}:${id}`;
}

// Long-history responsiveness: a window sized only by message count still freezes when a handful of
// messages contain giant tool payloads or answers. Estimate a bounded render weight without serializing
// whole objects (JSON.stringify on a multi-MB tool result would itself be the stall), then keep the fresh
// tail inside both a row cap and a content budget. Explicit "load earlier" still reaches every row.
export const MESSAGE_WINDOW_RENDER_BUDGET = 220_000;
export const MESSAGE_WINDOW_MIN_TAIL = 12;

function boundedValueWeight(value, remaining, depth = 0, seen = new WeakSet()) {
  if (remaining <= 0 || value == null) return 0;
  if (typeof value === 'string') return Math.min(remaining, value.length);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return Math.min(remaining, 16);
  if (typeof value !== 'object' || depth >= 5) return Math.min(remaining, 32);
  if (seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    const weight = boundedValueWeight(item, remaining - total, depth + 1, seen);
    total += weight;
    if (total >= remaining) break;
  }
  return total;
}

export function estimateMessageRenderWeight(message, cap = MESSAGE_WINDOW_RENDER_BUDGET + 1) {
  return boundedValueWeight(message, Math.max(1, Number(cap) || 1));
}

export function weightedMessageTailStart(messages, options = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const maxMessages = Math.max(1, Number(options.maxMessages) || 120);
  const minMessages = Math.min(maxMessages, Math.max(1, Number(options.minMessages) || MESSAGE_WINDOW_MIN_TAIL));
  const budget = Math.max(1, Number(options.budget) || MESSAGE_WINDOW_RENDER_BUDGET);
  const countFloor = Math.max(0, rows.length - maxMessages);
  let start = rows.length;
  let weight = 0;
  for (let index = rows.length - 1; index >= countFloor; index--) {
    const next = estimateMessageRenderWeight(rows[index], budget - weight + 1);
    const included = rows.length - index;
    if (included > minMessages && weight + next > budget) break;
    weight += next;
    start = index;
  }
  return Math.max(countFloor, start);
}

// Persisted steering is stored as a user row for compatibility and, in newer sessions, also embedded in
// the following assistant narrative. Both classic chat and Preview's raw lens consume this same filter so
// the second shell cannot drift into a duplicate-message interpretation.
export function visibleSessionMessageEntries(messages, start = 0, options = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const activeTurnSeq = Number(options.activeTurnSeq);
  const hasLiveTurn = options.hasLiveTurn === true;
  const turnsWithSteerSegment = new Set();
  for (const message of rows) {
    if (message && message.role === 'assistant' && Array.isArray(message.segments)
      && message.segments.some(segment => segment && segment.type === 'steer')) {
      const turnSeq = Number(message.turnSeq != null ? message.turnSeq : message.turnSummary && message.turnSummary.turnSeq);
      if (Number.isFinite(turnSeq)) turnsWithSteerSegment.add(turnSeq);
    }
  }
  const visible = [];
  for (let index = Math.max(0, Number(start) || 0); index < rows.length; index++) {
    const message = rows[index];
    if (message && message.steered) {
      const turnSeq = Number(message.turnSeq);
      if ((hasLiveTurn && Number.isFinite(activeTurnSeq) && turnSeq === activeTurnSeq)
        || (Number.isFinite(turnSeq) && turnsWithSteerSegment.has(turnSeq))) continue;
    }
    visible.push({ message, index });
  }
  return visible;
}

export function captureScrollAnchor(container) {
  if (!container) return null;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  if (atBottom) return { atBottom: true };
  const top = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll('[data-message-key]');
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom >= top) return { atBottom: false, key: row.dataset.messageKey || '', offset: rect.top - top };
  }
  return { atBottom: false, scrollTop: container.scrollTop };
}

export function restoreScrollAnchor(container, anchor) {
  if (!container || !anchor) return;
  if (anchor.atBottom) { container.scrollTop = container.scrollHeight; return; }
  if (anchor.key) {
    const row = Array.from(container.querySelectorAll('[data-message-key]'))
      .find(item => item.dataset.messageKey === anchor.key);
    if (row) {
      const top = container.getBoundingClientRect().top;
      container.scrollTop += row.getBoundingClientRect().top - top - Number(anchor.offset || 0);
      return;
    }
  }
  if (Number.isFinite(anchor.scrollTop)) container.scrollTop = anchor.scrollTop;
}
