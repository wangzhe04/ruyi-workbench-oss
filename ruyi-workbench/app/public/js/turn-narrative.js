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
