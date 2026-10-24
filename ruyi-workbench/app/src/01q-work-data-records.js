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
  const KINDS = Object.freeze(['messages', 'provider', 'interventions', 'changes']);
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
  // A bounded lexical probe, not a JSON validator or an authentication decision.
  // Feed one physical row in arbitrary byte fragments. It remembers whether a
  // top-level object key decodes to "w", even when that key comes after a giant
  // value or uses Unicode escapes. No key/value/string/row buffer is retained.
  // Once reserved, the result is sticky; callers still decode/validate the row.
  function lineProbe() {
    let started = false, objectRoot = false, done = false, depth = 0;
    let quoted = false, keyString = false, expectKey = false, escaped = false;
    let unicodeLeft = 0, unicodeValue = 0, unicodeValid = true;
    let keyUnits = 0, keyIsW = false, found = false;
    let leadingLeft = 0, leadingValue = 0, leadingMin = 0;
    const trimSpace = code => code === 32 || code >= 9 && code <= 13 || code === 0xa0 || code === 0x1680
      || code >= 0x2000 && code <= 0x200a || code === 0x2028 || code === 0x2029 || code === 0x202f
      || code === 0x205f || code === 0x3000 || code === 0xfeff;
    const keyUnit = code => {
      if (!keyString) return;
      keyUnits = Math.min(2, keyUnits + 1);
      keyIsW = keyUnits === 1 && code === 119;
    };
    const feed = bytes => {
      if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || typeof bytes.length !== 'number') fail('probe_input');
      if (found || done) return;
      for (let offset = 0; offset < bytes.length; offset++) {
        const code = bytes[offset] & 255;
        if (!started) {
          // isEncodedLine trims JS whitespace before classifying a row. Also
          // observe those noncanonical prefixes here, split safely at any UTF8
          // byte. The actual JSON decoder still rejects unsupported whitespace.
          if (leadingLeft) {
            if (code < 128 || code > 191) { done = true; return; }
            leadingValue = (leadingValue << 6) | (code & 63);
            if (--leadingLeft === 0 && (leadingValue < leadingMin || leadingValue > 0x10ffff
              || leadingValue >= 0xd800 && leadingValue <= 0xdfff || !trimSpace(leadingValue))) { done = true; return; }
            continue;
          }
          if (code >= 128) {
            if (code >= 194 && code <= 223) { leadingLeft = 1; leadingMin = 0x80; leadingValue = code & 31; }
            else if (code >= 224 && code <= 239) { leadingLeft = 2; leadingMin = 0x800; leadingValue = code & 15; }
            else if (code >= 240 && code <= 244) { leadingLeft = 3; leadingMin = 0x10000; leadingValue = code & 7; }
            else done = true;
            if (done) return;
            continue;
          }
          if (trimSpace(code)) continue;
          started = true; objectRoot = code === 123;
          if (!objectRoot) { done = true; return; }
          depth = 1; expectKey = true; continue;
        }
        if (quoted) {
          if (unicodeLeft) {
            const digit = code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
            if (digit < 0) unicodeValid = false;
            unicodeValue = (unicodeValue << 4) | Math.max(0, digit);
            if (--unicodeLeft === 0) keyUnit(unicodeValid ? unicodeValue : -1);
            continue;
          }
          if (escaped) {
            escaped = false;
            if (code === 117) { unicodeLeft = 4; unicodeValue = 0; unicodeValid = true; }
            else keyUnit(code === 34 || code === 47 || code === 92 ? code : -1);
            continue;
          }
          if (code === 92) { escaped = true; continue; }
          if (code === 34) {
            quoted = false;
            if (keyString && keyUnits === 1 && keyIsW) { found = true; return; }
            keyString = false; continue;
          }
          keyUnit(code); continue;
        }
        if (code === 34) {
          quoted = true; keyString = depth === 1 && expectKey;
          keyUnits = 0; keyIsW = false; escaped = false; unicodeLeft = 0;
        } else if (code === 123 || code === 91) depth++;
        else if (code === 125 || code === 93) { if (--depth <= 0) { done = true; return; } }
        else if (depth === 1 && code === 44) expectKey = true;
        else if (depth === 1 && code === 58) expectKey = false;
      }
    };
    return Object.freeze({ feed, reserved: () => found });
  }
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
  // Auxiliary journals have fixed purposes independent of their payload. The
  // original four session kinds and their v2 AAD remain unchanged above.
  const JOURNAL_KINDS = Object.freeze(['steward-inbox', 'steward-decisions', 'agent-run-events', 'scheduler-fires', 'audit-log']);
  function journalBinding(context, schema) {
    if (!context || !JOURNAL_KINDS.includes(context.kind)) fail('kind_invalid');
    const ordinal = ordinalOf(context.ordinal), kind = context.kind;
    let recordId = kind + ':' + ordinal;
    if (kind === 'agent-run-events') {
      if (typeof context.runId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(context.runId)) fail('run_invalid');
      recordId = kind + ':' + context.runId + ':' + ordinal;
    }
    return { purpose: kind === 'audit-log' ? 'audit' : kind === 'agent-run-events' || kind === 'scheduler-fires' ? 'task' : 'queue', instanceId: context.instanceId,
      schema, scopeId: context.sessionId, recordId, seq: ordinal };
  }
  // One physical NDJSON row, including for a chunked record. No plaintext stage.
  function encodeRecordFactory(plainLine, key, context, maxPlaintextBytes) {
    if (typeof plainLine !== 'string' || !plainLine) fail('text_required');
    const binding = journalBinding(context, FORMAT);
    if (Buffer.byteLength(plainLine, 'utf8') <= WorkDataCrypto.MAX_PLAINTEXT) {
      const encoded = JSON.stringify({ w: FORMAT, e: WorkDataCrypto.seal(plainLine, key, binding) }) + '\n';
      let disposed = false;
      const factory = async function* () { if (disposed) fail('key_released'); yield encoded; };
      factory.dispose = () => { disposed = true; };
      return factory;
    }
    const chunks = WorkDataChunks.sealFactory(plainLine, key, { ...binding, schema: 3 }, maxPlaintextBytes);
    const factory = async function* () {
      let first = true, block = false;
      for await (const line of chunks()) {
        const encoded = line.slice(0, -1);
        if (first) { yield '{"w":3,"h":' + encoded + ',"b":['; first = false; }
        else { yield (block ? ',' : '') + encoded; block = true; }
      }
      yield ']}\n';
    };
    factory.dispose = () => chunks.dispose();
    return factory;
  }
  async function decodeRecordLine(line, key, context, maxPlaintextBytes) {
    let row;
    try { row = JSON.parse(String(line == null ? '' : line)); } catch { fail('corrupt'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('corrupt');
    if (row.w === FORMAT) {
      if (Object.keys(row).sort().join(',') !== 'e,w' || !row.e || typeof row.e !== 'object' || Array.isArray(row.e)) fail('corrupt');
      const binding = journalBinding(context, FORMAT);
      if (row.e.seq !== binding.seq) fail('ordinal_mismatch');
      let plain;
      try { plain = WorkDataCrypto.open(row.e, key, binding); } catch { fail('authenticate_failed'); }
      if (typeof plain !== 'string' || !plain) fail('corrupt');
      return plain;
    }
    if (row.w !== 3) fail('format_unsupported');
    if (Object.keys(row).sort().join(',') !== 'b,h,w' || !row.h || typeof row.h !== 'object' || Array.isArray(row.h)
      || !Array.isArray(row.b) || row.b.length > WorkDataChunks.MAX_CHUNKS) fail('corrupt');
    const binding = journalBinding(context, 3);
    if (row.h.seq !== binding.seq) fail('ordinal_mismatch');
    return WorkDataChunks.openLines((async function* () {
      yield JSON.stringify(row.h);
      for (const block of row.b) yield JSON.stringify(block);
    })(), key, binding, maxPlaintextBytes);
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
  return Object.freeze({ FORMAT, KINDS, JOURNAL_KINDS, lineProbe, isEncodedLine, encodeLine, decodeLine, decodeBody, encodeRecordFactory, decodeRecordLine });
})();
