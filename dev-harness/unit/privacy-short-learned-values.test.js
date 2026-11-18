'use strict';
// 150 号文 §4 P4 / 151 阶段 1:短学习值。`token: on`、`密码：a` 不再让 on / a 成为全局凭据;短值的学习匹配要词边界;
// 协议键名不参与学习匹配;已落盘的短映射在加载 scope 时撤出学习集(条目仍可解析,旧代号不变成未知引用)。
// Synthetic values only; real PrivacyCore/PrivacyGateway source, synthetic vault protector, no listener.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const f = fixture(), core = f.PrivacyCore;
const TOKEN = /\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g;
const config = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
const restore = (scope, scopeId, text) => scope.restoreForTool(text, { scopeId, tool: 'synthetic_contract', pointer: '/text',
  destination: 'synthetic-local', purpose: 'unit', authorize: () => true, allowCredentialEmbedding: true });

test('bare label rules skip placeholder values only; short real values are protected in place but never learned', () => {
  const detector = core.createDetector({ personal: true });
  for (const sample of ['auth:\n  token: on', 'token: off', 'passwd=TRUE', 'secret: null', 'api_key=none', 'pwd: 0', 'token: 1',
    '密码：空', '令牌：暂无', '密码是 Undefined', 'token: ***', 'password: xxxx', 'secret: TODO']) {
    assert.deepEqual(JSON.parse(JSON.stringify(detector.detect(sample))), [], sample);
  }
  // Below the learning threshold (and type names): still protected where they appear, exactly as v5 did,
  // but the value does not become a scope-wide pattern.
  const scopeId = 'short-in-place', scope = core.createScope({ scopeId, detector });
  try {
    for (const [sample, secret] of [['password: ab1', 'ab1'], ['token: abc', 'abc'], ['secret=xyz', 'xyz'], ['api_key: q9z', 'q9z'],
      ['密码：王', '王'], ['密码:12', '12'], ['口令 是 芝', '芝'], ['密码：a', 'a'], ['password: string;', 'string'], ['token: user', 'user'],
      ['token: abcd', 'abcd'], ['密码：合成', '合成'], ['password=8x!Q', '8x!Q'], ['密码：123', '123'], ['token: onion', 'onion']]) {
      const found = detector.detect(sample), at = sample.indexOf(secret);
      assert.ok(found.some(match => match.start <= at && match.end >= at + secret.length), sample);
      const result = scope.protectRaw(sample);
      assert.equal(result.text.replace(TOKEN, '').includes(secret), false, 'protected in place: ' + sample);
    }
    const prose = 'ab1 abc xyz q9z 王府井 12 芝麻 a string user {"role":"user","type":"string"}';
    assert.equal(scope.protectRaw(prose).text, prose, 'short and type-name values were not learned');
    assert.equal(scope.protectRaw('later abcd and onion and 合成').text.replace(TOKEN, '').match(/abcd|onion|合成/g), null, 'learnable values were learned');
  } finally { scope.clear(); }
});

test('type declarations and protocol enum values do not refuse requests that carry tools', async t => {
  const { api } = await setup(t);
  await api.run('type-name-values', config, async () => {
    for (const user of ['interface U { password: string; token: string }', 'secret = function', 'api_key: object', 'token: user']) {
      const body = await api.beforeModelRequest({ model: 'synthetic', tools, stream: true, messages: [{ role: 'user', content: user }] });
      assert.deepEqual(plain(body.tools), tools, user);
      assert.equal(users(body).length, 1, user);
      const again = await api.beforeModelRequest({ model: 'synthetic', stream: true, messages: [{ role: 'user', content: user }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }] });
      assert.deepEqual(plain(again.messages.filter(row => row.role !== 'system').map(row => row.role)), ['user', 'assistant', 'user'], user);
    }
  });
});

// 1B1 复审：学到的短值（token: read）不得让工具名（file_read）所在的控制字段整轮 control_field_sensitive。
test('a learned short value never refuses a request whose tool name contains it', async t => {
  const { api } = await setup(t);
  const fileTools = [{ type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  await api.run('tool-name-identifier', config, async () => {
    const body = await api.beforeModelRequest({ model: 'synthetic', tools: fileTools, stream: true, messages: [{ role: 'user', content: 'token: read' }] });
    assert.deepEqual(plain(body.tools), fileTools, 'tool name and schema reach the provider unchanged');
    assert.equal(users(body).length, 1);
    const again = await api.beforeModelRequest({ model: 'synthetic', tools: fileTools, stream: true, messages: [{ role: 'user', content: 'token: read' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }] });
    assert.deepEqual(plain(again.tools), fileTools);
  });
});

test('short and trivial values are never global learned patterns, yet their references stay resolvable', () => {
  const scopeId = 'short-learned-scope', scope = core.createScope({ scopeId, detector: core.createDetector({ personal: true }) });
  try {
    const tokens = ['on', 'a', 'true', '王', 'abc'].map(value => [value, scope.protectValue(value, value === '王' ? 'INTERNAL' : 'CREDENTIAL')]);
    const prose = '{"type":"function","content":"data on a true 王府井 abc"} function content data onion banana';
    assert.equal(scope.protectRaw(prose).text, prose, 'no substring of an ordinary word or protocol key is rewritten');
    for (const [value, token] of tokens) assert.equal(restore(scope, scopeId, token), value, 'issued reference still restores: ' + value);
    // Long-enough values stay learned everywhere, including without their original label.
    const learned = scope.protectValue('SyntheticLearned-0042', 'CREDENTIAL');
    const text = scope.protectRaw('later: SyntheticLearned-0042 and xSyntheticLearned-0042y').text;
    assert.equal(text.replace(TOKEN, '').includes('SyntheticLearned-0042'), false);
    assert.equal(text.split(learned).length, 3);
  } finally { scope.clear(); }
});

test('short learned values only match on ASCII alphanumeric word boundaries', () => {
  const scopeId = 'short-boundary-scope', scope = core.createScope({ scopeId, detector: core.createDetector() });
  try {
    const token = scope.protectValue('Qz7k', 'CREDENTIAL');
    const result = scope.protectRaw('xQz7k Qz7k Qz7ky (Qz7k) Qz7k_1 Qz7k.');
    assert.equal(result.text, 'xQz7k ' + token + ' Qz7ky (' + token + ') ' + token + '_1 ' + token + '.');
    // CVV-style three-digit numbers keep the existing numeric boundary guard and stay learned.
    const cvv = scope.protectValue('808', 'CREDENTIAL');
    assert.equal(scope.protectRaw('later the code 808 again; order 808123 stays').text, 'later the code ' + cvv + ' again; order 808123 stays');
  } finally { scope.clear(); }
});

test('legacy mappings below the threshold are withdrawn from learning on load, without becoming unknown references', () => {
  const scopeId = 'short-legacy-scope';
  const legacyScope = core.createScope({ scopeId, detector: { detect: () => [] }, ttlMs: 365 * 86400000 });
  const on = legacyScope.protectValue('on', 'CREDENTIAL'), a = legacyScope.protectValue('a', 'CREDENTIAL');
  const long = legacyScope.protectValue('Legacy-Synthetic-Secret-7', 'CREDENTIAL');
  const revoked = legacyScope.protectValue('no', 'CREDENTIAL'); legacyScope.revoke(revoked);
  const state = legacyScope.exportState(); legacyScope.clear();
  const scope = core.createScope({ scopeId, detector: core.createDetector({ personal: true }), ttlMs: 365 * 86400000 });
  try {
    scope.importState(state);
    const prose = 'messages content function data: on a no';
    assert.equal(scope.protectRaw(prose).text, prose, 'a revoked or short legacy value no longer poisons every substring');
    assert.equal(restore(scope, scopeId, on + a), 'ona');
    assert.equal(scope.validateProtected('history ' + on), 'history ' + on);
    assert.equal(scope.protectRaw('again Legacy-Synthetic-Secret-7').text, 'again ' + long);
    assert.deepEqual(JSON.parse(JSON.stringify(scope.exportState().entries.map(entry => entry.value).sort())), ['Legacy-Synthetic-Secret-7', 'a', 'on'], 'user-visible history references are not deleted');
  } finally { scope.clear(); }
});

test('learned matching can be skipped for protocol keys while detector rules still apply', () => {
  const scopeId = 'protocol-key-scope', scope = core.createScope({ scopeId, detector: core.createDetector() });
  try {
    scope.protectValue('properties', 'CREDENTIAL');
    assert.equal(scope.detect('properties').length, 1);
    assert.equal(scope.detect('properties', { learnedMatching: false }).length, 0);
    const key = 'sk-' + 'SYNTHETICPROTOCOLKEY'.repeat(2);
    assert.equal(scope.detect(key, { learnedMatching: false }).length, 1, 'built-in detection is not skipped');
  } finally { scope.clear(); }
});

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-short-learned-'));
  t.after(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-short-learned-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });
  const api = gateway(root, f); api.configure(config); return { root, api };
}
const tools = [{ type: 'function', function: { name: 'synthetic_lookup', description: 'Look up data on a record',
  parameters: { type: 'object', properties: { data: { type: 'string' }, content: { type: 'string' }, function: { type: 'string' }, on: { type: 'boolean' } } } } }];
const visible = value => JSON.stringify(value).replace(TOKEN, '');
const plain = value => JSON.parse(JSON.stringify(value));
const users = body => plain(body.messages.filter(row => row.role === 'user').map(row => row.content));

test('auth token: on reaches the request body in the first turn and after continue', async t => {
  const { api } = await setup(t);
  const user = 'auth:\n  token: on\n请看看这段配置';
  await api.run('short-token-on', config, async () => {
    const first = await api.beforeModelRequest({ model: 'synthetic', messages: [{ role: 'user', content: user }], tools, stream: true });
    assert.deepEqual(users(first), [user]);
    assert.deepEqual(plain(first.tools), tools, 'tool parameter names data/content/function stay intact');
    const second = await api.beforeModelRequest({ model: 'synthetic', tools, stream: true, messages: [{ role: 'user', content: user },
      { role: 'assistant', content: '收到，token 设置为 on。', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'synthetic_lookup', arguments: '{"data":"on","content":"function"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true,"content":"data on function"}' }, { role: 'user', content: '继续' }] });
    assert.deepEqual(users(second), [user, '继续']);
    assert.ok(visible(second).includes('data on function'));
    assert.equal(api.active().scope.exportState().entries.some(entry => entry.value === 'on'), false, 'on was never issued');
  });
});

test('a learned value equal to a protocol key protects prose but never refuses the request keys', async t => {
  const { api } = await setup(t);
  await api.run('learned-protocol-key', config, async () => {
    const token = api.active().scope.protectValue('properties', 'CREDENTIAL');
    const body = await api.beforeModelRequest({ model: 'synthetic', tools, stream: true, messages: [{ role: 'user', content: 'my password is properties' }] });
    assert.deepEqual(users(body), ['my password is ' + token], 'the learned value is still protected in user text');
    assert.deepEqual(plain(body.tools), tools, 'schema key "properties" is protocol spelling');
    // Keys of structured data (tool-call arguments) still learn and are rewritten, not refused.
    const call = await api.beforeModelRequest({ model: 'synthetic', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-k', type: 'function',
      function: { name: 'synthetic_lookup', arguments: JSON.stringify({ note: 'properties' }) } }] }, { role: 'tool', tool_call_id: 'call-k', content: '{"ok":true}' }] });
    assert.equal(JSON.parse(call.messages.find(row => row.role === 'assistant').tool_calls[0].function.arguments).note, token);
  });
});

test('a restarted gateway recovers a thread whose persisted mapping learned "on" and "a"', async t => {
  const { root, api } = await setup(t), scopeId = 'short-legacy-thread';
  let onToken;
  await api.run(scopeId, config, async () => {
    // What an older build persisted after `token: on` / `密码：a`.
    onToken = api.active().scope.protectValue('on', 'CREDENTIAL'); api.active().scope.protectValue('a', 'CREDENTIAL');
    await api.beforeModelRequest({ model: 'synthetic', messages: [{ role: 'user', content: 'Synthetic-Persist-Trigger sk-' + 'SYNTHETICPERSIST'.repeat(2) }] });
  });
  assert.ok(fs.readdirSync(path.join(root, 'privacy-scopes')).length > 0, 'legacy mapping is on disk');
  const restarted = gateway(root, f); restarted.configure(config);
  await restarted.run(scopeId, config, async () => {
    const body = await restarted.beforeModelRequest({ model: 'synthetic', tools, stream: true, messages: [{ role: 'user', content: 'auth:\n  token: on' },
      { role: 'assistant', content: '已记录 ' + onToken }, { role: 'user', content: '继续，看看 data 和 content' }] });
    assert.deepEqual(plain(body.messages.filter(row => row.role !== 'system').map(row => row.content)),
      ['auth:\n  token: on', '已记录 ' + onToken, '继续，看看 data 和 content'], 'the old reference is still valid history');
    assert.deepEqual(plain(body.tools), tools);
  });
});
