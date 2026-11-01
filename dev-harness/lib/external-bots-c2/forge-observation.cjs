'use strict';
// Test oracle only. The caller owns a fresh session and a single-use exact logical
// message. Host capability/time/memory layers are preserved on the received wire.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const START = 'C2_MODEL_FORGE ', END = '\nC2_MODEL_FORGE_END ';
function createExpectation({ sessionId, cwd, forged, firstRequest, nonce = crypto.randomBytes(16).toString('hex') }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || typeof cwd !== 'string' || !cwd
    || !Number.isSafeInteger(firstRequest) || firstRequest < 0 || !/^[a-f0-9]{32}$/.test(nonce)) throw Error('invalid forge expectation');
  const payload = JSON.stringify(forged), message = START + payload + END + nonce;
  return Object.freeze({ sessionId, cwd, firstRequest, nonce, payload, message, messageSha256: hash(message) });
}
function locateCurrentUser(body, expected) {
  const rows = body?.messages;
  if (!Array.isArray(rows)) return null;
  // The fresh text-only first turn has exactly one user, at the final position.
  // System/assistant/tool/history occurrences can never substitute for reception.
  const users = rows.map((row, index) => ({ row, index })).filter(entry => entry.row?.role === 'user');
  if (users.length !== 1 || users[0].index !== rows.length - 1 || typeof users[0].row.content !== 'string') return null;
  const content = users[0].row.content, at = content.indexOf(expected.message);
  if (at < 0 || content.indexOf(START) !== at || content.indexOf(START, at + START.length) !== -1) return null;
  const prefix = content.slice(0, at), suffix = content.slice(at + expected.message.length);
  // Default front layout starts with the original capability line and inserts
  // exactly two newlines before the current logical user. Tail layout has none.
  // Capability prose can mention fence names literally, so it is not XML.
  // The single-use whole message, current role, time receipt and suffix boundary
  // locate this turn; a fence-looking substring cannot redefine that boundary.
  if (prefix && (!/^(?:当前能力：|Current capabilities: )/.test(prefix) || !prefix.endsWith('\n\n')
    || /C2_MODEL_FORGE/.test(prefix))) return null;
  // The original provider history appends its time receipt immediately after the
  // logical message. Remaining blocks must be original closed workbench fences,
  // or the capability layer appended by the explicit alternate tail layout.
  const time = /^\n\n\[(?:本条消息发送于 [^\]\r\n]+|Message sent [^\]\r\n]+)\]/.exec(suffix);
  if (!time) return null;
  let tail = suffix.slice(time[0].length);
  if (tail) {
    if (!tail.startsWith('\n\n')) return null;
    tail = tail.slice(2);
    if (/^(?:当前能力：|Current capabilities: )/.test(tail)) {
      if (/C2_MODEL_FORGE/.test(tail)) return null;
    } else {
      while (tail) {
        const fence = /^<(workbench-[a-z-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/.exec(tail);
        if (!fence || /C2_MODEL_FORGE/.test(fence[0])) return null;
        tail = tail.slice(fence[0].length);
        if (tail.startsWith('\n\n')) tail = tail.slice(2);
        else if (tail.startsWith('\n<workbench-')) tail = tail.slice(1);
        else if (tail) return null;
      }
    }
  }
  return { userIndex: users[0].index, offset: at, end: at + expected.message.length,
    currentUserSha256: hash(content), prefixSha256: hash(prefix), suffixSha256: hash(suffix), messageSha256: expected.messageSha256 };
}
function observeReceived(record, expected) {
  if (!record || !Number.isSafeInteger(record.index) || record.index < expected.firstRequest
    || record.expected?.sessionId !== expected.sessionId || record.expected.cwd !== expected.cwd
    || record.expected.messageSha256 !== expected.messageSha256 || record.captureError || !record.captureFile
    || typeof record.rawAvailable !== 'boolean') return null;
  if (record.rawAvailable) {
    try { if (typeof record.raw !== 'string' || JSON.stringify(JSON.parse(record.raw)) !== JSON.stringify(record.body)) return null; }
    catch { return null; }
  }
  return locateCurrentUser(record.body, expected);
}
module.exports = { createExpectation, locateCurrentUser, observeReceived, hash };
