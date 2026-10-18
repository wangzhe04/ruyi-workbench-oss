'use strict';

const KEY = 'ruyi.steward.handoffs.v1';
// Tab-local recovery only. Never discard an unresolved request to make room for another.
export function createHandoffRecoveryStore(storage) {
  const target = () => storage || globalThis.sessionStorage;
  const read = () => {
    const rows = JSON.parse(target().getItem(KEY) || '[]');
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.attemptId !== 'string' || !/^[\w-]{8,64}$/.test(r.attemptId) || typeof r.sessionId !== 'string' || !r.sessionId || typeof r.text !== 'string' || !r.text || !Array.isArray(r.attachments))) throw new Error('invalid handoff recovery cache');
    return rows;
  };
  const write = rows => {
    const raw = JSON.stringify(rows);
    if (rows.length > 20 || raw.length > 256000) throw new Error('handoff recovery cache full');
    target().setItem(KEY, raw);
  };
  return {
    list: read,
    put(row) { const rows = read().filter(r => r.attemptId !== row.attemptId); rows.push(row); write(rows); },
    remove(id) { write(read().filter(r => r.attemptId !== id)); },
  };
}
