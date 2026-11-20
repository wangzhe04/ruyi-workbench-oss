'use strict';
// 150 号文 §4 P5/P7/P11/P16/P17 (3.1 phase 4): a badly written reference costs only its own fragment, in
// local display, in the model's history view and in plaintext exports; own-thread values in a user copy
// are named by category; a paused policy says why values are hidden; variant spellings still display.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const policy = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
const DISPLAY_UNAVAILABLE = '[隐私引用不可用 / private reference unavailable]';
const HISTORY_REFUSED = '[Local privacy validation refused an unavailable reference in an earlier model message. No value was recovered; inspect the original local transcript and tool error before retrying.]';

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-fragment-unit-'));
  t.after(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-fragment-unit-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });
  const f = fixture(), api = gateway(root, f); api.configure(policy);
  async function issue(value = 'fragment.synthetic@example.test', id = 'sess_fragment_unit', category = 'EMAIL') {
    let token;
    await api.run(id, policy, async () => { token = api.active().scope.protectValue(value, category); await api.beforeRequest({ messages: [{ role: 'user', content: token }] }); });
    return { token, id, value };
  }
  return { root, api, f, issue };
}
const streamText = async (api, id, chunks) => {
  const out = [], stream = api.createDisplayStream(id, event => out.push(event));
  for (const text of chunks) await stream.write({ type: 'assistant_delta', text });
  await stream.write({ type: 'assistant_end' }); await stream.flush(); stream.close();
  return out.filter(event => event.type === 'assistant_delta').map(event => event.text).join('');
};

test('P5 display: a reference missing a bracket is repaired; a cut one is replaced alone and the following text stays', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const tail = '，请在周五前把报价单发过去，谢谢！后面还有一大段说明文字。'.repeat(3);
  const oneBracket = x.token.slice(0, -1), noBracket = x.token.slice(0, -2), cut = x.token.slice(0, 30);
  assert.equal(await api.displayText(x.id, '发给 ' + oneBracket + tail), '发给 ' + x.value + tail);
  assert.equal(await api.displayText(x.id, '发给 ' + noBracket + tail), '发给 ' + x.value + tail);
  assert.equal(await api.displayText(x.id, '发给 ' + cut + tail), '发给 ' + DISPLAY_UNAVAILABLE + tail);
  // A hex run longer than an id is not a reference with a missing bracket.
  assert.equal(await api.displayText(x.id, noBracket + 'abcd 后文'), DISPLAY_UNAVAILABLE + 'abcd 后文');
  // Streaming: split at every position of the broken reference, the visible text and the value are the same.
  for (const broken of [oneBracket, noBracket, cut]) {
    const source = '发给 ' + broken + tail, expected = await api.displayText(x.id, source);
    for (let split = 1; split < source.length; split += 7) assert.equal(await streamText(api, x.id, [source.slice(0, split), source.slice(split)]), expected, split);
  }
  // A stream that ends right after the id (brackets never arrived) still shows the value.
  assert.equal(await streamText(api, x.id, ['末尾 ', noBracket]), '末尾 ' + x.value);
});

test('P17 display: lower-case, markdown-escaped and full-width spellings of a real reference display its value', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const id = x.token.slice(-34, -2), category = x.token.slice(11, x.token.length - 35);
  for (const variant of ['[[ruyi_pvt:' + category.toLowerCase() + ':' + id + ']]', '\\[\\[RUYI_PVT:' + category + ':' + id + '\\]\\]',
    '［［RUYI_PVT：' + category + '：' + id + '］］', '[[RUYI_PVT:' + category + ':' + id.toUpperCase() + ']]']) {
    assert.equal(await api.displayText(x.id, '值：' + variant + ' 完'), '值：' + x.value + ' 完', variant);
  }
  // Unknown ids in a variant spelling never resolve and never show the raw marker as if it were a value.
  assert.equal(await api.displayText(x.id, '[[ruyi_pvt:email:' + 'e'.repeat(32) + ']]'), DISPLAY_UNAVAILABLE);
  // With privacy off and no mapping, documentation stays literal.
  api.configure({ ...policy, privacyModeV1: 'off' });
  const literal = '格式示例 [[ruyi_pvt:email:' + 'a'.repeat(32) + ']]';
  assert.equal(await api.displayText('sess_never_mapped', literal), literal);
});

test('P5 history: earlier model narration keeps its text and valid references; only the bad fragment is omitted', async t => {
  const { api, issue } = await setup(t), x = await issue('history.fragment@example.test', 'sess_fragment_history');
  await api.run(x.id, policy, async () => {
    const unknown = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    const history = [
      { role: 'user', content: '请给 ' + x.token + ' 写信' },
      { role: 'assistant', content: '好的，我会写给 ' + x.token.slice(0, -1) + '，并附上会议纪要。另一个地址 ' + x.token.slice(0, 25) + ' 不完整。' },
      { role: 'assistant', content: [{ type: 'text', text: '旧地址 ' + unknown + ' 已失效，新地址是 ' + x.token }] },
      { role: 'assistant', content: '{"note":"' + unknown + '"}' },
    ];
    const frozen = JSON.stringify(history), owner = {}; api.bindHostHistory(owner, history);
    const view = api.projectHostHistory(owner, history);
    assert.equal(view[1].content, '好的，我会写给 ' + x.token + '，并附上会议纪要。另一个地址 [unavailable local privacy reference omitted] 不完整。');
    assert.equal(view[2].content[0].text, '旧地址 [unavailable local privacy reference omitted] 已失效，新地址是 ' + x.token);
    assert.equal(view[3].content, HISTORY_REFUSED, 'JSON narration keeps whole-slot refusal');
    assert.equal(JSON.stringify(history), frozen, 'canonical history is untouched');
    const request = await api.beforeRequest({ messages: view });
    assert.ok(!JSON.stringify(request).includes('history.fragment@example.test'), 'the value never reaches the model');
    assert.ok(JSON.stringify(request).includes('并附上会议纪要'), 'the rest of the answer does');
    // Restoring the projection gives back the canonical rows.
    assert.deepEqual(api.restoreHostHistoryProjection(owner, view), history);
  });
});

test('P5 history: a repaired reference in a credential context of another category is still refused whole', async t => {
  const { api, issue } = await setup(t), x = await issue('ctx.fragment@example.test', 'sess_fragment_ctx');
  await api.run(x.id, policy, async () => {
    const history = [{ role: 'assistant', content: 'Password=' + x.token.slice(0, -1) + ' 已更新' }], owner = {};
    api.bindHostHistory(owner, history);
    assert.equal(api.projectHostHistory(owner, history)[0].content, HISTORY_REFUSED);
  });
});

test('P7 plaintext restore: degrade replaces only unusable fragments and reports them; the strict path is unchanged', async t => {
  const { api, issue } = await setup(t), x = await issue('export.fragment@example.test', 'sess_fragment_export');
  const source = { messages: [{ role: 'assistant', content: '发给 ' + x.token.slice(0, -1) + ' 和 ' + x.token.slice(0, 30) + ' 两处，正文保留。' }] };
  await assert.rejects(api.restoreHistory(x.id, source), /privacy.reference_malformed/);
  let withheld = 0;
  const restored = await api.restoreHistory(x.id, source, false, { degrade: true, onWithheld: () => { withheld++; } });
  assert.equal(restored.messages[0].content, '发给 export.fragment@example.test 和 ' + DISPLAY_UNAVAILABLE + ' 两处，正文保留。');
  assert.equal(withheld, 1);
  // A scope without any mapping file degrades every reference instead of failing the copy.
  const none = await api.restoreHistory('sess_without_mapping', { text: '值 ' + x.token }, false, { degrade: true, onWithheld: () => { withheld++; } });
  assert.equal(none.text, '值 ' + DISPLAY_UNAVAILABLE); assert.equal(withheld, 2);
});

test('P11 user copies name the copied thread\'s own values by category; other threads keep the foreign placeholder', async t => {
  const { api, issue } = await setup(t), own = await issue('own.thread@example.test', 'sess_fragment_own');
  const other = await issue('other.thread@example.test', 'sess_fragment_other');
  const value = { text: '本线程 ' + own.token + '，别的线程 ' + other.token + '，新写的 phone 13800138000，坏的 ' + own.token.slice(0, 20) + ' 结束' };
  const binding = { recipient: 'user-file-copy', purpose: 'unit-own-labels', sourceHash: 'unit' };
  const labelled = await api.prepareMultiSourceDisclosure(value, [own.id], binding, { ownLabels: true });
  assert.equal(labelled.value.text, '本线程 〔邮箱〕，别的线程 [其他线程的隐私内容已省略]，新写的 phone 〔手机号〕，坏的 [其他线程的隐私内容已省略] 结束');
  for (const secret of ['own.thread@example.test', 'other.thread@example.test', '13800138000', 'RUYI_PVT']) assert.ok(!labelled.value.text.includes(secret), secret);
  labelled.assert();
  // Without the option (model and search consumers) every reference stays the foreign placeholder, and a
  // malformed one no longer swallows the rest of its line.
  const plain = await api.prepareMultiSourceDisclosure(value, [own.id], binding);
  assert.ok(plain.value.text.startsWith('本线程 [其他线程的隐私内容已省略]，别的线程 [其他线程的隐私内容已省略]'));
  assert.ok(plain.value.text.endsWith('坏的 [其他线程的隐私内容已省略] 结束'));
  assert.equal(api.foreignView('a ' + own.token.slice(0, 18) + ' tail\nnext'), 'a [其他线程的隐私内容已省略] tail\nnext');
  // 4B review v2: an over-long category is still one fragment; no ":<id>]]" tail stays visible.
  assert.equal(api.foreignView('b [[RUYI_PVT:ABCDEFGHIJKLMNOPQRS:' + 'c'.repeat(32) + ']] end'), 'b [其他线程的隐私内容已省略] end');
});

test('P16 a paused policy marks hidden values as waiting for confirmation, not as broken references', async t => {
  const { api, issue } = await setup(t), x = await issue('paused.fragment@example.test', 'sess_fragment_paused');
  api.markUnavailable();
  const shown = await api.displayText(x.id, '值 ' + x.token);
  assert.match(shown, /隐私设置待确认/); assert.ok(!shown.includes('paused.fragment@example.test')); assert.ok(!shown.includes(DISPLAY_UNAVAILABLE));
  assert.match(await streamText(api, x.id, ['值 ', x.token]), /private value hidden until privacy settings are confirmed/);
});
