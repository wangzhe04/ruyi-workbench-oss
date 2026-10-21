'use strict';
// Render-time DOM capabilities only. The host independently reads and verifies every source.
const sources = new WeakMap();
export function bindDisclosureSource(node, locator, document) {
  if (!node || !locator || typeof document !== 'string') return null;
  const { messageSnapshot, ...publicLocator } = locator;
  const record = Object.freeze({ node, document, messageSnapshot, locator: Object.freeze({ ...publicLocator,
    messageIdentity: Object.freeze({ ...locator.messageIdentity }) }) });
  sources.set(node, record); return record;
}
export function disclosureSourceFor(node, documentOnly = false) {
  for (let current = node; current; current = current.parentElement || current.parentNode) {
    const record = sources.get(current);
    if (record && (!documentOnly || ['content', 'segment-text', 'segment-markdown'].includes(record.locator.slot))) return record;
  }
  return null;
}
export function assertDisclosureSource(record) {
  if (!record || sources.get(record.node) !== record || record.node.isConnected === false) throw new Error('privacy.export_source_changed');
}
// Reserve browser activation synchronously; resolve bytes only after validation.
export function beginClipboardWrite() {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.write || typeof globalThis.ClipboardItem !== 'function') throw new Error('privacy.export_clipboard_unavailable');
  let resolve, reject;
  const data = new Promise((yes, no) => { resolve = yes; reject = no; });
  const pending = clipboard.write([new globalThis.ClipboardItem({ 'text/plain': data })]);
  pending.catch(() => {}); data.catch(() => {});
  return { resolve, reject, pending };
}
