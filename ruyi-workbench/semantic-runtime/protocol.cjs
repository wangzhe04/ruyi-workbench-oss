'use strict';
const crypto = require('node:crypto');
const LIMITS = Object.freeze({ maxBatch: 16, maxTextChars: 8192, maxTotalChars: 32768, maxLineBytes: 262144, maxQueue: 32, defaultDeadlineMs: 30000, maxDeadlineMs: 120000, concurrency: 1 });
function validateRequest(request, now = Date.now()) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'INVALID_REQUEST';
  if (typeof request.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(request.requestId)) return 'INVALID_REQUEST_ID';
  if (request.op !== 'encode' || !['query', 'document'].includes(request.role)) return 'INVALID_REQUEST';
  if (!Array.isArray(request.texts) || !request.texts.length || request.texts.length > LIMITS.maxBatch) return 'BATCH_LIMIT';
  if (request.texts.some(t => typeof t !== 'string' || !t.trim() || t.length > LIMITS.maxTextChars)) return 'TEXT_LIMIT';
  if (request.texts.reduce((n, t) => n + t.length, 0) > LIMITS.maxTotalChars) return 'TEXT_LIMIT';
  if (request.deadlineMs !== undefined && (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= now)) return 'DEADLINE_EXCEEDED';
  return null;
}
function modelFingerprint(model, packageLockHash, runtimeAssetsHash = '', implementationHash = '') {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ protocol: 1, packageLockHash, runtimeAssetsHash, implementationHash, model })).digest('hex');
}
module.exports = { LIMITS, validateRequest, modelFingerprint };
