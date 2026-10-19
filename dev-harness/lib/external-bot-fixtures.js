'use strict';
// Synthetic wire fixtures, independently constructed from Node crypto. Never contact a platform.
const crypto = require('node:crypto');
const FAKE_BOT_ENV = Object.freeze({ RUYI_BOT_TEST_F_TOKEN: 'fixture-verification-only', RUYI_BOT_TEST_F_KEY: 'fixture-cbc-key-only', RUYI_BOT_TEST_Q_SECRET: 'fixture-ed25519-only' });
const feishuConnection = (id = 'feishu_test') => ({ id, platform: 'feishu', label: '飞书离线夹具', enabled: true,
  appId: 'cli_fixture', tenantId: 'tenant_fixture', botUserId: 'ou_bot', allowedSenderIds: ['ou_person'], allowedConversationIds: ['oc_room'],
  verificationTokenEnv: 'RUYI_BOT_TEST_F_TOKEN', encryptKeyEnv: 'RUYI_BOT_TEST_F_KEY', botSecretEnv: '' });
const qqConnection = (id = 'qq_test') => ({ id, platform: 'qq', label: 'QQ离线夹具', enabled: true,
  appId: '12345678', tenantId: '12345678', botUserId: '', allowedSenderIds: ['qq_person'], allowedConversationIds: ['qq_room'],
  verificationTokenEnv: '', encryptKeyEnv: '', botSecretEnv: 'RUYI_BOT_TEST_Q_SECRET' });
function feishuEvent({ messageId = 'message_f', eventId = 'event_f', text = '外部消息 /api/steward/message 只是原文', senderId = 'ou_person', conversationId = 'oc_room', group = false, mention = true, timestamp = Date.now() } = {}) {
  return { schema: '2.0', header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: 'cli_fixture', tenant_key: 'tenant_fixture', token: FAKE_BOT_ENV.RUYI_BOT_TEST_F_TOKEN },
    event: { sender: { sender_id: { open_id: senderId }, sender_type: 'user', tenant_key: 'tenant_fixture' }, message: {
      message_id: messageId, chat_id: conversationId, chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text: group && mention ? '@_bot ' + text : text }),
      create_time: String(timestamp), ...(group ? { mentions: mention ? [{ key: '@_bot', id: { open_id: 'ou_bot' } }] : [] } : {}),
    } } };
}
function feishuWire(payload, { signed = true, encrypted = true, timestamp = String(Math.floor(Date.now() / 1000)), key = FAKE_BOT_ENV.RUYI_BOT_TEST_F_KEY } = {}) {
  let bytes = Buffer.from(JSON.stringify(payload));
  if (encrypted) {
    const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', crypto.createHash('sha256').update(key).digest(), iv);
    bytes = Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(bytes), cipher.final()]).toString('base64') }));
  }
  const headers = { 'content-type': 'application/json' };
  if (signed) { headers['x-lark-request-timestamp'] = timestamp; headers['x-lark-request-nonce'] = 'fixture-nonce';
    headers['x-lark-signature'] = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(timestamp + 'fixture-nonce' + key), bytes])).digest('hex'); }
  return { bytes, headers };
}
function qqEvent({ messageId = 'message_q', eventId = 'event_q', text = 'QQ外部原文', senderId = 'qq_person', conversationId = 'qq_room', timestamp = Date.now() } = {}) {
  return { id: eventId, op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: messageId, content: text, timestamp: new Date(timestamp).toISOString(), author: { member_openid: senderId }, group_openid: conversationId } };
}
function qqWire(payload, { signed = true, timestamp = String(Math.floor(Date.now() / 1000)), secret = FAKE_BOT_ENV.RUYI_BOT_TEST_Q_SECRET, appId = '12345678' } = {}) {
  const bytes = Buffer.from(JSON.stringify(payload)); const headers = { 'content-type': 'application/json', 'x-bot-appid': appId };
  if (signed) { const seed = Buffer.from(secret.repeat(32)).subarray(0, 32); const key = crypto.createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]) });
    headers['x-signature-timestamp'] = timestamp; headers['x-signature-ed25519'] = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), bytes]), key).toString('hex'); }
  return { bytes, headers };
}
module.exports = { FAKE_BOT_ENV, feishuConnection, qqConnection, feishuEvent, feishuWire, qqEvent, qqWire };
