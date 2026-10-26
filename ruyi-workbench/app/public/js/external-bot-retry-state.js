'use strict';
const requests = new Map(); // One module owner survives panel and DOM recreation.
const ID = /^[A-Za-z0-9_-]{1,50}$/, REQUEST = /^[A-Za-z0-9_-]{16,64}$/;
const date = value => typeof value === 'string' && value.length <= 64 && Boolean(value) && Number.isFinite(Date.parse(value));
export function validReplyRetryHistory(item) {
  if (item.replyHistory === undefined) return true;
  const rows = item.replyHistory;
  if (!Array.isArray(rows) || rows.length > 128) return false;
  const seen = new Set(), attempts = new Set();
  return rows.every((row, index) => {
    const old = row?.attempt;
    if (!row || Object.keys(row).sort().join(',') !== 'attempt,nextAttemptId,requestedAt,retryRequestId'
      || typeof row.retryRequestId !== 'string' || !REQUEST.test(row.retryRequestId) || seen.has(row.retryRequestId) || typeof row.nextAttemptId !== 'string' || !ID.test(row.nextAttemptId) || !date(row.requestedAt)
      || !old || Object.keys(old).sort().join(',') !== 'attemptId,errorCode,messageId,status,updatedAt'
      || typeof old.attemptId !== 'string' || !ID.test(old.attemptId) || attempts.has(old.attemptId) || old.status !== 'failed' || old.messageId !== ''
      || typeof old.errorCode !== 'string' || old.errorCode.length > 128 || !date(old.updatedAt)
      || row.nextAttemptId !== (rows[index + 1]?.attempt?.attemptId || item.delivery?.attemptId)) return false;
    seen.add(row.retryRequestId); attempts.add(old.attemptId); return true;
  }) && !attempts.has(item.delivery?.attemptId);
}
function ownPending(item, record) {
  const latest = item.replyHistory?.at(-1);
  return item.delivery?.status === 'pending' && latest && latest.nextAttemptId === item.delivery.attemptId
    && latest.retryRequestId === record.body.retryRequestId && latest.attempt.attemptId === record.body.expectedAttemptId;
}
export function createReplyRetryState({ store = requests, random = bytes => globalThis.crypto.getRandomValues(bytes) } = {}) {
  function available(item) {
    if (!validReplyRetryHistory(item)) return null;
    let record = store.get(item.id);
    const latest = item.replyHistory?.at(-1);
    if (!record && item.delivery?.status === 'pending' && latest?.nextAttemptId === item.delivery.attemptId) {
      if (store.size >= 1000) return null;
      record = { body: Object.freeze({ id:item.id, expectedAttemptId:latest.attempt.attemptId, retryRequestId:latest.retryRequestId }), phase:'confirmed' };
      store.set(item.id, record);
    }
    if (record?.phase === 'inflight') return { record, mode:'waiting' };
    if (record && (record.phase === 'uncertain' || ownPending(item, record))) return { record, mode:'resume' };
    return item.retryAvailable === true && item.delivery?.status === 'failed' ? { record:null, mode:'new' } : null;
  }
  function begin(item) {
    const choice = available(item); if (!choice || choice.mode === 'waiting') return null;
    let record = choice.record;
    if (!record) {
      if (!store.has(item.id) && store.size >= 1000) return null;
      const bytes = new Uint8Array(16); random(bytes);
      record = { body:Object.freeze({ id:item.id, expectedAttemptId:item.delivery.attemptId,
        retryRequestId:'retry_' + Array.from(bytes, value=>value.toString(16).padStart(2,'0')).join('') }), phase:'confirmed' };
      store.set(item.id, record);
    }
    record.phase='inflight'; return record;
  }
  function confirm(record, result) {
    const receipt=result?.receipt, item=result?.item, body=record.body;
    const history=item?.replyHistory?.find(row=>row.retryRequestId===body.retryRequestId);
    if (result?.ok !== true || typeof result.alreadyRetried !== 'boolean' || item?.id !== body.id || !validReplyRetryHistory(item)
      || !receipt || Object.keys(receipt).sort().join(',') !== 'attemptId,itemId,previousAttemptId,requestedAt,retryRequestId'
      || receipt.itemId!==body.id || receipt.previousAttemptId!==body.expectedAttemptId || receipt.retryRequestId!==body.retryRequestId
      || typeof receipt.attemptId !== 'string' || !ID.test(receipt.attemptId) || receipt.attemptId===body.expectedAttemptId || !date(receipt.requestedAt)
      || history?.attempt.attemptId!==body.expectedAttemptId || history.nextAttemptId!==receipt.attemptId || history.requestedAt!==receipt.requestedAt)
      throw new Error('write_unconfirmed');
    if(store.get(body.id)===record) record.phase='confirmed';
    return receipt;
  }
  function uncertain(record) { if(store.get(record.body.id)===record) record.phase='uncertain'; }
  function rejected(record) { if(store.get(record.body.id)===record) record.phase='rejected'; }
  return Object.freeze({available,begin,confirm,uncertain,rejected,snapshot:()=>Array.from(store.values(),record=>({body:{...record.body},phase:record.phase}))});
}
