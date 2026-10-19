'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13v-external-channel-protocols.js'), 'utf8');
const protocols = vm.runInNewContext(source + '\nExternalChannelProtocols', { crypto, Buffer, TextDecoder });
const verify = protocols.verifyAndNormalize;
const NOW = 1725442341000;
const feishuConnection = { appId: 'cli_fixture', tenantId: 'tenant-fixture', botUserId: 'ou_bot', verificationToken: 'synthetic-token', encryptKey: 'synthetic-encrypt-key' };
const qqConnection = { appId: '11111111', botSecret: 'synthetic-qq-secret', botUserId: 'qq_bot' };
const errorCode = code => error => error.code === 'external_channel.' + code && Number.isInteger(error.statusCode);
function feishuEvent() {
  return { schema: '2.0', header: { event_id: 'event-f', event_type: 'im.message.receive_v1', app_id: 'cli_fixture', tenant_key: 'tenant-fixture', token: 'synthetic-token' },
    event: { sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user', tenant_key: 'tenant-fixture' }, message: {
      message_id: 'message-f', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好 https://example.invalid/no-download' }), create_time: String(NOW),
    } } };
}
function feishuWire(payload, { encrypted = true, signed = true, timestamp = String(NOW / 1000), key = feishuConnection.encryptKey } = {}) {
  let bytes = Buffer.from(JSON.stringify(payload));
  if (encrypted) {
    const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', crypto.createHash('sha256').update(key).digest(), iv);
    bytes = Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(bytes), cipher.final()]).toString('base64') }));
  }
  const headers = {};
  if (signed) {
    headers['X-Lark-Request-Timestamp'] = timestamp; headers['X-Lark-Request-Nonce'] = 'fixture-nonce';
    headers['X-Lark-Signature'] = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(timestamp + 'fixture-nonce' + key), bytes])).digest('hex');
  }
  return { bytes, headers };
}
function feishuRead(payload, options, connection = feishuConnection, now = NOW) {
  const wire = feishuWire(payload, options); return verify('feishu', connection, wire.headers, wire.bytes, now);
}
function qqEvent(group = false) {
  return { id: 'event-q', op: 0, t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d: {
    id: 'message-q', content: ' hello https://example.invalid/asset ', timestamp: new Date(NOW).toISOString(),
    author: group ? { member_openid: 'member-human' } : { user_openid: 'user-human' }, ...(group ? { group_openid: 'group-fixture' } : {}),
  } };
}
function qqKey(secret) {
  const seed = Buffer.from(secret.repeat(32)).subarray(0, 32);
  return crypto.createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]) });
}
function qqWire(payload, { signed = true, timestamp = String(NOW / 1000), connection = qqConnection } = {}) {
  const bytes = Buffer.from(JSON.stringify(payload)); const headers = { 'X-Bot-Appid': connection.appId };
  if (signed) {
    headers['X-Signature-Timestamp'] = timestamp;
    headers['X-Signature-Ed25519'] = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), bytes]), qqKey(connection.botSecret)).toString('hex');
  }
  return { bytes, headers };
}
function qqRead(payload, options, connection = qqConnection, now = NOW) {
  const wire = qqWire(payload, { ...options, connection }); return verify('qq', connection, wire.headers, wire.bytes, now);
}
test('Feishu authenticates/decrypts real CBC bytes, normalizes exact identities and leaves URLs as text', () => {
  const result = feishuRead(feishuEvent());
  assert.equal(result.kind, 'message');
  assert.equal(result.message.messageId, 'message-f'); assert.equal(result.message.eventId, 'event-f');
  assert.equal(result.message.senderId, 'ou_human'); assert.equal(result.message.conversationType, 'direct');
  assert.equal(result.message.text, '你好 https://example.invalid/no-download'); assert.equal(result.message.sentAt, new Date(NOW).toISOString());
  assert.equal(feishuRead(feishuEvent(), { encrypted: false }).kind, 'message', 'signed plaintext events still require the complete signature');
});
test('Feishu encrypted unsigned bootstrap verifies token and returns only the bounded challenge', () => {
  const challenge = { type: 'url_verification', token: 'synthetic-token', challenge: 'fixture-challenge' };
  assert.equal(feishuRead(challenge, { signed: false }).body.challenge, 'fixture-challenge');
  assert.equal(feishuRead(challenge).kind, 'challenge');
  assert.throws(() => feishuRead(challenge, { signed: false, encrypted: false }), errorCode('schema_invalid'));
  assert.throws(() => feishuRead({ ...challenge, event: feishuEvent().event }, { signed: false }), errorCode('bootstrap_invalid'));
  assert.throws(() => feishuRead({ ...challenge, token: 'wrong' }, { signed: false }), errorCode('bootstrap_invalid'));
  assert.throws(() => feishuRead({ ...challenge, challenge: 'x'.repeat(513) }, { signed: false }), errorCode('bootstrap_invalid'));
});
test('Feishu bootstrap cannot bypass a partial or bad signature; unsigned events cannot pose as bootstrap', () => {
  const p = { type: 'url_verification', token: 'synthetic-token', challenge: 'ok' };
  const w = feishuWire(p); delete w.headers['X-Lark-Request-Nonce'];
  assert.throws(() => verify('feishu', feishuConnection, w.headers, w.bytes, NOW), errorCode('signature_missing'));
  const bad = feishuWire(p); bad.headers['X-Lark-Signature'] = '00'.repeat(32);
  assert.throws(() => verify('feishu', feishuConnection, bad.headers, bad.bytes, NOW), errorCode('signature_invalid'));
  assert.throws(() => feishuRead(feishuEvent(), { signed: false }), errorCode('bootstrap_invalid'));
});
test('Feishu signed raw-byte tampering, wrong encryption key and invalid base64 fail closed', () => {
  const w = feishuWire(feishuEvent()); const changed = Buffer.concat([w.bytes, Buffer.from(' ')]);
  assert.throws(() => verify('feishu', feishuConnection, w.headers, changed, NOW), errorCode('signature_invalid'));
  assert.throws(() => feishuRead(feishuEvent(), { key: 'wrong' }), errorCode('signature_invalid'));
  assert.throws(() => verify('feishu', feishuConnection, {}, Buffer.from('{"encrypt":"!!!!"}'), NOW), errorCode('bootstrap_invalid'));
  const tampered = JSON.parse(w.bytes); const ciphertext = Buffer.from(tampered.encrypt, 'base64'); ciphertext[ciphertext.length - 1] ^= 255;
  assert.throws(() => verify('feishu', feishuConnection, {}, Buffer.from(JSON.stringify({ encrypt: ciphertext.toString('base64') })), NOW), errorCode('bootstrap_invalid'));
});
for (const field of ['app_id', 'tenant_key', 'token']) test('Feishu rejects a signed wrong ' + field, () => {
  const p = feishuEvent(); p.header[field] = 'wrong';
  assert.throws(() => feishuRead(p), errorCode(field === 'token' ? 'token_invalid' : 'identity_mismatch'));
});
test('Feishu rejects sender tenant mismatch and ignores app/bot senders', () => {
  const p = feishuEvent(); p.event.sender.tenant_key = 'foreign'; assert.throws(() => feishuRead(p), errorCode('identity_mismatch'));
  p.event.sender.tenant_key = 'tenant-fixture'; p.event.sender.sender_type = 'app'; assert.equal(feishuRead(p).reason, 'non_human_sender');
  p.event.sender.sender_type = 'user'; p.event.sender.sender_id.open_id = 'ou_bot'; assert.equal(feishuRead(p).reason, 'non_human_sender');
});
test('Feishu group must mention this bot, not just any participant; strips only its exact placeholder', () => {
  const p = feishuEvent(); p.event.message.chat_type = 'group';
  p.event.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' } }];
  assert.equal(feishuRead(p).reason, 'not_mentioned');
  p.event.message.mentions.push({ key: '@_user_2', id: { open_id: 'ou_bot' } });
  p.event.message.content = JSON.stringify({ text: '@_user_2 check @_user_1' });
  assert.equal(feishuRead(p).message.text, 'check @_user_1');
});
test('Feishu media and malformed text are not downgraded to partial text', () => {
  const p = feishuEvent(); p.event.message.message_type = 'post'; assert.equal(feishuRead(p).reason, 'unsupported_message_type');
  p.event.message.message_type = 'text'; p.event.message.content = JSON.stringify({ text: 'caption', image_key: 'media' });
  assert.throws(() => feishuRead(p), errorCode('schema_invalid'));
  p.event.message.content = JSON.stringify({ text: 42 }); assert.throws(() => feishuRead(p), errorCode('schema_invalid'));
});
test('QQ published key vector matches, while its displayed signature/body pair is explicitly inconsistent', () => {
  // Public protocol test data, not an account credential. The body spacing is part of the vector.
  const connection = { appId: '11111111', botSecret: 'naOC0ocQE3shWLAfffVLB1rhYPG7' };
  const raw = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
  const headers = { 'X-Bot-Appid': '11111111', 'X-Signature-Timestamp': '1725442341', 'X-Signature-Ed25519': '865ad13a61752ca65e26bde6676459cd36cf1be609375b37bd62af366e1dc25a8dc789ba7f14e017ada3d554c671a911bfdf075ba54835b23391d509579ed002' };
  // The sign.html body/timestamp/signature example does not verify even with its matching public key.
  // Keep this discrepancy explicit; never special-case the vector as an authenticated request.
  const publicBytes = crypto.createPublicKey(qqKey(connection.botSecret)).export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.deepEqual([...publicBytes], [215,195,98,254,120,174,248,31,242,50,135,180,147,98,139,93,176,42,60,79,227,11,33,94,77,25,96,155,93,118,103,58]);
  assert.equal(crypto.verify(null, Buffer.concat([Buffer.from('1725442341'), raw]), crypto.createPublicKey(qqKey(connection.botSecret)), Buffer.from(headers['X-Signature-Ed25519'], 'hex')), false);
  assert.throws(() => verify('qq', connection, headers, raw, NOW), errorCode('signature_invalid'));
  assert.throws(() => verify('qq', connection, headers, Buffer.concat([raw, Buffer.from('\n')]), NOW), errorCode('signature_invalid'));
});
test('QQ official unsigned op13 vector produces exactly the published challenge signature', () => {
  const connection = { appId: '11111111', botSecret: 'DG5g3B4j9X2KOErG' };
  const raw = Buffer.from('{"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13}');
  const result = verify('qq', connection, { 'X-Bot-Appid': '11111111' }, raw, NOW);
  assert.equal(result.kind, 'challenge'); assert.equal(result.body.plain_token, 'Arq0D5A61EgUu4OxUvOp');
  assert.equal(result.body.signature, '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706');
});
test('QQ independent Ed25519 fixture admits direct and group text with stable separate message/event ids', () => {
  const direct = qqRead(qqEvent()); assert.equal(direct.message.conversationId, 'user-human'); assert.equal(direct.message.conversationType, 'direct');
  const group = qqRead(qqEvent(true)); assert.equal(group.message.senderId, 'member-human'); assert.equal(group.message.conversationId, 'group-fixture');
  assert.equal(group.message.tenantId, qqConnection.appId); assert.equal(group.message.messageId, 'message-q'); assert.equal(group.message.eventId, 'event-q');
  assert.equal(group.message.text, 'hello https://example.invalid/asset');
  const retry = qqEvent(); retry.id = 'retry-event'; assert.equal(qqRead(retry).message.messageId, direct.message.messageId);
});
test('QQ bootstrap checks app, timestamp, fields and optional signatures, and cannot sign a callback JSON body', () => {
  const p = { op: 13, d: { plain_token: 'token-fixture', event_ts: String(NOW / 1000) } };
  const w = qqWire(p); w.headers['X-Signature-Ed25519'] = '00'.repeat(64);
  assert.throws(() => verify('qq', qqConnection, w.headers, w.bytes, NOW), errorCode('signature_invalid'));
  delete w.headers['X-Signature-Ed25519']; assert.throws(() => verify('qq', qqConnection, w.headers, w.bytes, NOW), errorCode('signature_missing'));
  assert.throws(() => qqRead({ ...p, t: 'C2C_MESSAGE_CREATE' }, { signed: false }), errorCode('schema_invalid'));
  assert.throws(() => qqRead({ op: 13, d: { ...p.d, plain_token: '{"op":0}' } }, { signed: false }), errorCode('schema_invalid'));
  assert.throws(() => qqRead({ op: 13, d: { ...p.d, event_ts: String(NOW / 1000 - 301) } }, { signed: false }), errorCode('timestamp_out_of_window'));
  const wrong = qqWire(p, { signed: false }); wrong.headers['X-Bot-Appid'] = 'other';
  assert.throws(() => verify('qq', qqConnection, wrong.headers, wrong.bytes, NOW), errorCode('identity_mismatch'));
});
test('QQ unsigned messages, tampering, bot messages, media and wrong identity never become text', () => {
  assert.throws(() => qqRead(qqEvent(), { signed: false }), errorCode('signature_missing'));
  const w = qqWire(qqEvent()); w.bytes[w.bytes.length - 2] ^= 1;
  assert.throws(() => verify('qq', qqConnection, w.headers, w.bytes, NOW));
  const p = qqEvent(); p.d.author.bot = true; assert.equal(qqRead(p).reason, 'non_human_sender');
  p.d.author.bot = false; p.d.attachments = [{ url: 'https://example.invalid/image' }]; assert.equal(qqRead(p).reason, 'unsupported_message_type');
  p.d.attachments = []; p.d.author.user_openid = 42; assert.throws(() => qqRead(p), errorCode('schema_invalid'));
});
for (const platform of ['qq', 'feishu']) test(platform + ' signed request timestamp boundaries are inclusive and reject stale/future/malformed/millisecond values', () => {
  const event = platform === 'qq' ? qqEvent() : feishuEvent(); const read = platform === 'qq' ? qqRead : feishuRead;
  for (const delta of [-300, 300]) assert.equal(read(event, { timestamp: String(NOW / 1000 + delta) }).kind, 'message');
  for (const delta of [-301, 301]) assert.throws(() => read(event, { timestamp: String(NOW / 1000 + delta) }), errorCode('timestamp_out_of_window'));
  for (const timestamp of ['1e9', '1725442341.0', ' 1725442341', String(NOW)]) assert.throws(() => read(event, { timestamp }), error => /^external_channel.timestamp_/.test(error.code));
});
test('strict identity/schema/input validation rejects truncation, lossy UTF8, duplicate headers and non-buffer bodies', () => {
  const p = feishuEvent(); p.event.message.message_id = 'x'.repeat(129); assert.throws(() => feishuRead(p), errorCode('schema_invalid'));
  const w = qqWire(qqEvent()); w.headers['x-signature-timestamp'] = w.headers['X-Signature-Timestamp'];
  assert.throws(() => verify('qq', qqConnection, w.headers, w.bytes, NOW), errorCode('schema_invalid'));
  assert.throws(() => verify('qq', qqConnection, {}, 'not bytes', NOW), errorCode('invalid_body'));
  assert.throws(() => verify('qq', qqConnection, {}, Buffer.alloc(65537), NOW), errorCode('invalid_body'));
  assert.throws(() => verify('qq', qqConnection, { 'X-Bot-Appid': qqConnection.appId }, Buffer.from([255]), NOW), errorCode('invalid_body'));
  assert.throws(() => verify('qq', { ...qqConnection, botSecret: '' }, {}, w.bytes, NOW), errorCode('invalid_config'));
});

test('Feishu mention ids never cross open_id/user_id/union_id namespaces', () => {
  const p = feishuEvent(); p.event.message.chat_type = 'group';
  for (const field of ['user_id', 'union_id']) {
    p.event.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other', [field]: 'ou_bot' } }];
    assert.equal(feishuRead(p).reason, 'not_mentioned');
  }
});
test('Feishu signed header tenant is authoritative when optional sender tenant is absent', () => {
  const p = feishuEvent(); delete p.event.sender.tenant_key;
  assert.equal(feishuRead(p).kind, 'message');
  p.header.tenant_key = 'foreign'; assert.throws(() => feishuRead(p), errorCode('identity_mismatch'));
});
test('QQ secret expansion repeats UTF8 bytes, including a multibyte boundary at byte32', () => {
  const connection = { ...qqConnection, botSecret: '中文secret' };
  assert.equal(qqRead(qqEvent(), undefined, connection).kind, 'message');
});
test('message content is bounded without truncation or control-character coercion', () => {
  for (const text of ['x'.repeat(8193), 'a\0b', '\ud800']) {
    const f = feishuEvent(); f.event.message.content = JSON.stringify({ text });
    assert.throws(() => feishuRead(f), errorCode('schema_invalid'));
    const q = qqEvent(); q.d.content = text; assert.throws(() => qqRead(q), errorCode('schema_invalid'));
  }
});

test('unsigned encrypted Feishu bootstrap exposes one error for padding, JSON, token, type and nested-event failures', () => {
  const challenge = { type: 'url_verification', token: 'synthetic-token', challenge: 'ok' };
  const variants = [{ encrypt: '!!!!' }, { encrypt: Buffer.alloc(32).toString('base64') }];
  for (const payload of [{ ...challenge, token: 'bad' }, { ...challenge, type: 'event_callback' }, { ...challenge, event: {} }, feishuEvent()]) {
    variants.push(JSON.parse(feishuWire(payload, { signed: false }).bytes));
  }
  // Valid CBC with invalid UTF8/JSON is indistinguishable from invalid padding.
  const iv = Buffer.alloc(16); const cipher = crypto.createCipheriv('aes-256-cbc', crypto.createHash('sha256').update(feishuConnection.encryptKey).digest(), iv);
  variants.push({ encrypt: Buffer.concat([iv, cipher.update(Buffer.from([255, 0])), cipher.final()]).toString('base64') });
  for (const outer of variants) {
    assert.throws(() => verify('feishu', feishuConnection, {}, Buffer.from(JSON.stringify(outer)), NOW), error => error.code === 'external_channel.bootstrap_invalid' && error.statusCode === 401);
  }
  assert.equal(feishuRead(challenge, { signed: false }).kind, 'challenge');
});
