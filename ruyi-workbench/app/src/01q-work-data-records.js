// M3-2c: frozen per-record format for append-only NDJSON bodies (messages / provider history).
//
// One record per line, each independently authenticated, so a reordered, copied or middle-deleted
// copied line fails instead of being read as content from another position or another session. The
// binding is (purpose=session, instance, sessionId=scopeId, kind:ordinal=recordId, ordinal=seq): the
// ordinal is what makes "line 3 moved to line 5" detectable. The session body is wired through
// 02-session-store's per-line decode (legacy plaintext lines may coexist during migration); decodeBody
// is the STRICT whole-body checker (all records, no plaintext lines) for tests and migration tooling,
// so do not use it where a mixed body is legal.
const WorkDataRecords = (() => {
  const FORMAT = 2;
  const KINDS = Object.freeze(['messages', 'provider']);
  const fail = suffix => { throw Object.assign(new Error('work_data_record.' + suffix), { code: 'work_data_record.' + suffix, apiCode: 'work_data_record.' + suffix }); };
  const ordinalOf = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail('ordinal_invalid');
    return value;
  };
  const kindOf = value => {
    if (!KINDS.includes(value)) fail('kind_invalid');
    return value;
  };
  const bindingOf = (context, ordinal) => ({
    purpose: 'session', instanceId: context.instanceId, schema: FORMAT, scopeId: context.sessionId,
    recordId: kindOf(context.kind) + ':' + ordinalOf(ordinal), seq: ordinal,   // ':' is inside the frozen identity charset
  });
  function isEncodedLine(line) {
    const trimmed = String(line == null ? '' : line).trim();
    if (!trimmed.startsWith('{')) return false;
    try { const parsed = JSON.parse(trimmed); return !!parsed && typeof parsed === 'object' && parsed.w === FORMAT && Object.hasOwn(parsed, 'e'); }
    catch { return false; }
  }
  function encodeLine(plainLine, key, context) {
    if (typeof plainLine !== 'string' || !plainLine) fail('text_required');
    const ordinal = ordinalOf(context && context.ordinal);
    const container = WorkDataCrypto.seal(plainLine, key, bindingOf(context, ordinal));
    return JSON.stringify({ w: FORMAT, e: container });
  }
  function decodeLine(line, key, context) {
    let parsed;
    try { parsed = JSON.parse(String(line == null ? '' : line)); } catch { fail('corrupt'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'e,w') fail('corrupt');
    if (parsed.w !== FORMAT) fail('format_unsupported');
    const ordinal = ordinalOf(context && context.ordinal);
    const envelope = parsed.e;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('corrupt');
    if (envelope.seq !== ordinal) fail('ordinal_mismatch');
    let plainLine;
    try { plainLine = WorkDataCrypto.open(envelope, key, bindingOf(context, ordinal)); }
    catch { fail('authenticate_failed'); }
    if (typeof plainLine !== 'string' || !plainLine) fail('corrupt');
    return plainLine;
  }
  // Whole body: every line must be a valid record at its own ordinal. This only accepts a full block
  // starting at ordinal 0: a tail-truncated block still decodes (the AAD carries no total count), so
  // truncation stays a caller-side concern. Returns the plaintext body with
  // the same trailing-newline shape, so callers keep their existing line splitting.
  function decodeBody(bodyText, key, context) {   // not 	ext: that identifier collides with 00-boot's symbol
    const raw = String(bodyText == null ? '' : bodyText);
    if (!raw) return '';
    const lines = raw.split('\n');
    const trailing = lines.length > 0 && lines[lines.length - 1] === '';
    const body = trailing ? lines.slice(0, -1) : lines;
    const plain = [];
    for (let index = 0; index < body.length; index++) {
      if (!body[index]) fail('corrupt');   // an interior blank line is not a record
      plain.push(decodeLine(body[index], key, { ...context, ordinal: index }));
    }
    return plain.join('\n') + (trailing ? '\n' : '');
  }
  return Object.freeze({ FORMAT, KINDS, isEncodedLine, encodeLine, decodeLine, decodeBody });
})();
