// Prepare once at the final host dispatch boundary. Reject values whose implicit JSON conversion
// could change approved data; copy property descriptors without invoking getters or toJSON hooks.
// The returned bytes, decoded-value fingerprint and frozen outgoing object describe the same JSON.
function prepareDesktopExecutionArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be a JSON object');
  const snapshot = copyOrdinaryJsonData(value);
  const semanticSha256 = executionArgumentsDigest(snapshot);
  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > 8 * 1024 * 1024) throw new Error('execution argument snapshot exceeds capacity');
  return Object.freeze(Object.assign(Object.create(null), { snapshot, json, bytes, sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    codec: 'javascript-json-utf8-v1', semanticSha256, semanticCodec: 'ruyi-sdk-json-v1' }));
}
