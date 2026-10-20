'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const policy = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };

test('legacy privacy diagnostics become local guidance at every SSE split without exposing internal English markers', async t => {
  const { api, io } = await setup(t);
  const markers = [
    '[Local privacy validation refused an unavailable reference in an earlier model message. No value was recovered; inspect the original local transcript and tool error before retrying.]',
    '[RUYI_LOCAL_DATA_WITHHELD]',
  ];
  for (const mode of ['enhanced', 'off']) {
    api.configure({ ...policy, locale: 'zh-CN', privacyModeV1: mode });
    for (const marker of markers) {
      const expected = await api.displayText('sess_diagnostic', marker); assert.match(expected, /本机隐私保护/); assert.ok(!expected.includes(marker));
      for (let split = 1; split < marker.length; split++) {
        const out = [], stream = api.createDisplayStream('sess_diagnostic', e => out.push(e));
        await stream.write({ type: 'assistant_delta', text: '前 ' + marker.slice(0, split) });
        await stream.write({ type: 'raw_line', data: marker });
        await stream.write({ type: 'assistant_delta', text: marker.slice(split) + ' 后' });
        await stream.flush(); stream.close();
        assert.equal(out.filter(e => e.type === 'assistant_delta').map(e => e.text).join(''), '前 ' + expected + ' 后', mode + ':' + split);
        assert.equal(out.find(e => e.type === 'raw_line').data, marker);
      }
      const out = [], stream = api.createDisplayStream('sess_diagnostic', e => out.push(e));
      for (const text of marker) { await stream.write({ type: 'assistant_delta', text }); await stream.write({ type: 'usage', input: 1 }); }
      await stream.flush(); stream.close(); assert.equal(out.filter(e => e.type === 'assistant_delta').map(e => e.text).join(''), expected);
    }
  }
  assert.deepEqual(io, { opens: 0, seals: 0 });
});

test('ordinary bracket endings and incomplete diagnostic phrases remain exact on stream completion', async t => {
  const { api } = await setup(t);
  for (const mode of ['enhanced', 'off']) {
    api.configure({ ...policy, privacyModeV1: mode });
    for (const ending of ['[', '[[', '[Local', '[Local privacy validation', '[A historical input', '[RUYI_LOCAL_']) {
      const out = [], stream = api.createDisplayStream('sess_plain_bracket', event => out.push(event));
      await stream.write({ type: 'assistant_delta', text: '普通文档 ' + ending });
      await stream.write({ type: 'assistant_end' }); await stream.flush(); stream.close();
      assert.equal(out.filter(event => event.type === 'assistant_delta').map(event => event.text).join(''), '普通文档 ' + ending, mode + ':' + ending);
    }
  }
});
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-display-unit-'));
  t.after(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-display-unit-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });
  const base = fixture(), io = { opens: 0, seals: 0 };
  const f = { ...base, vault: { ...base.vault, openLocal: (...args) => { io.opens++; return base.vault.openLocal(...args); }, sealLocal: (...args) => { io.seals++; return base.vault.sealLocal(...args); } } };
  const api = gateway(root, f); api.configure(policy);
  async function issue(value = 'display.synthetic@example.test', id = 'sess_display_unit', category = 'EMAIL') {
    let token, scope;
    await api.run(id, policy, async () => { scope = api.active().scope; token = scope.protectValue(value, category); await api.beforeRequest({ messages: [{ role: 'user', content: token }] }); });
    return { token, scope, id, value };
  }
  return { root, api, f, io, issue };
}
test('display restores registered references for the local user without altering canonical messages or model history', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const canonical = { session: { id: x.id, messages: [{ role: 'user', content: 'original local input' }, { role: 'assistant', content: 'Echo ' + x.token, thinking: x.token, segments: [{ type: 'text', text: x.token }, { type: 'tool', rawArgs: x.token }] }], providerHistory: [{ role: 'assistant', content: x.token }] }, liveTail: { full: x.token }, liveTurn: { segments: [{ type: 'thinking', text: x.token }] } };
  const original = JSON.stringify(canonical), shown = await api.displayEnvelope(x.id, canonical);
  assert.equal(shown.session.messages[1].content, 'Echo ' + x.value);
  assert.equal(shown.session.messages[1].thinking, x.value);
  assert.equal(shown.session.messages[1].segments[0].text, x.value);
  assert.equal(shown.session.messages[1].segments[1].rawArgs, x.token);
  assert.equal(shown.liveTail.full, x.value); assert.equal(shown.liveTurn.segments[0].text, x.value);
  assert.equal(shown.session.providerHistory, canonical.session.providerHistory);
  assert.equal(JSON.stringify(canonical), original);
  await api.run(x.id, policy, async () => {
    const wire = await api.beforeRequest({ messages: [{ role: 'assistant', content: x.token }, { role: 'user', content: 'again' }] });
    assert.equal(JSON.stringify(wire).includes(x.value), false);
  });
});
test('all reference split points and per-character SSE/debug metadata round trip without emitting marker fragments', async t => {
  const { api, issue } = await setup(t), x = await issue();
  for (let split = 1; split < x.token.length; split++) {
    const events = [], stream = api.createDisplayStream(x.id, event => events.push(event));
    await stream.write({ type: 'assistant_delta', text: '前 ' + x.token.slice(0, split) });
    await stream.write({ type: 'raw_line', data: x.token });
    await stream.write({ type: 'context_estimate', tokens: 5 });
    await stream.write({ type: 'assistant_delta', text: x.token.slice(split) + ' 后' });
    await stream.flush(); stream.close();
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    assert.equal(text, '前 ' + x.value + ' 后', 'split ' + split);
    assert.equal(events.find(e => e.type === 'raw_line').data, x.token);
  }
  const events = [], stream = api.createDisplayStream(x.id, e => events.push(e));
  for (const char of x.token + '🙂' + x.token) { await stream.write({ type: 'raw_line', data: char }); await stream.write({ type: 'usage', input: 1 }); await stream.write({ type: 'assistant_delta', text: char }); }
  await stream.flush(); stream.close();
  assert.equal(events.filter(e => e.type === 'assistant_delta').map(e => e.text).join(''), x.value + '🙂' + x.value);
});
test('thinking and assistant channels keep independent buffers; terminal boundaries never join two half references', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const out = [], stream = api.createDisplayStream(x.id, e => out.push(e));
  await stream.write({ type: 'assistant_delta', text: x.token.slice(0, 20) });
  await stream.write({ type: 'thinking_delta', text: x.token });
  await stream.write({ type: 'assistant_delta', text: x.token.slice(20) });
  await stream.write({ type: 'assistant_delta', text: x.token.slice(0, 20) });
  await stream.write({ type: 'tool_use', id: 'tool-fixture', rawArgs: x.token });
  await stream.write({ type: 'assistant_delta', text: x.token.slice(20) });
  await stream.flush(); stream.close();
  assert.equal(out.filter(e => e.type === 'thinking_delta').map(e => e.text).join(''), x.value);
  assert.equal(out.filter(e => e.type === 'assistant_delta').map(e => e.text).join('').split(x.value).length - 1, 1);
  assert.equal(out.find(e => e.type === 'tool_use').rawArgs, x.token);
  assert.equal(out.filter(e => e.text).some(e => e.text.includes('[[RUYI')), false);
});
test('background child tool boundaries cannot terminate another channel privacy reference', async t => {
  const { api, issue } = await setup(t), x = await issue(), out = [], stream = api.createDisplayStream(x.id, e => out.push(e));
  await stream.write({ type: 'assistant_delta', text: x.token.slice(0, 30) });
  await stream.write({ type: 'tool_use', subagentId: 'synthetic-child', id: 'synthetic-tool' });
  await stream.write({ type: 'tool_result', subagentId: 'synthetic-child', id: 'synthetic-tool' });
  await stream.write({ type: 'assistant_delta', text: x.token.slice(30) });
  await stream.flush(); stream.close();
  assert.equal(out.filter(e => e.type === 'assistant_delta').map(e => e.text).join(''), x.value);
});
test('unknown, cross-session, category-forged, expired and revoked references disclose no original value', async t => {
  const { api, issue } = await setup(t), x = await issue();
  for (const [id, token] of [['sess_other', x.token], [x.id, x.token.replace('EMAIL', 'PHONE')], [x.id, '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]']]) {
    const shown = await api.displayText(id, token); assert.match(shown, /private reference unavailable/); assert.equal(shown.includes(x.value), false);
  }
  const snapshot = x.scope.exportState(); snapshot.entries[0].expiresAt = 1; x.scope.importState(snapshot);
  assert.match(await api.displayText(x.id, x.token), /unavailable/);
  const fresh = await issue('revoked.display@example.test'); fresh.scope.revoke(fresh.token);
  assert.match(await api.displayText(fresh.id, fresh.token), /unavailable/);
});
test('JSON display preserves escaping, public bytes and keys while supporting escaped and nested reference values', async t => {
  const { api, issue } = await setup(t), x = await issue('quoted"line\n\\<synthetic>', 'sess_display_json', 'INTERNAL');
  const source = '{ "say" : ' + JSON.stringify(x.token) + ', "n":9007199254740993123, "' + x.token + '": "key unchanged" }';
  const shown = await api.displayText(x.id, source, { json: true });
  assert.equal(JSON.parse(shown).say, x.value); assert.ok(shown.includes('9007199254740993123')); assert.ok(shown.includes('"' + x.token + '":'));
  const escaped = JSON.stringify({ say: x.token }).replace('RUYI', '\\u0052UYI');
  assert.equal(JSON.parse(await api.displayText(x.id, escaped, { json: true })).say, x.value);
  const nested = JSON.stringify({ nested: JSON.stringify({ say: x.token }) });
  assert.equal(JSON.parse(JSON.parse(await api.displayText(x.id, nested, { json: true })).nested).say, x.value);
});
test('restart and privacy off can display existing mappings read-only without creating maps or rewriting ciphertext', async t => {
  const { api, issue, root, f, io } = await setup(t), x = await issue();
  const file = path.join(root, 'privacy-scopes', require('node:crypto').createHash('sha256').update(x.id).digest('hex') + '.json');
  const before = fs.readFileSync(file), seals = io.seals;
  const restarted = gateway(root, f); restarted.configure({ ...policy, privacyModeV1: 'off' });
  assert.equal(await restarted.displayText(x.id, x.token), x.value); assert.ok(io.opens > 0); assert.equal(io.seals, seals);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(await restarted.displayCacheKey(x.id), 'private');
  const missing = await restarted.displayText('sess_missing', x.token); assert.equal(missing, x.token, 'fresh off without any map preserves literal reference documentation');
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});
test('fresh off and ordinary Unicode JSON are identity with zero vault operations or mapping creation', async t => {
  const { api, root, io } = await setup(t); api.configure({ ...policy, privacyModeV1: 'off' });
  const messages = [{ role: 'assistant', content: '{"note":"\\u4e2d\\u6587"}' }], envelope = { session: { messages, providerHistory: [] } };
  assert.equal(await api.displayEnvelope('sess_off', envelope), envelope);
  assert.equal(await api.displayText('sess_off', '普通说明'), '普通说明');
  const out = [], stream = api.createDisplayStream('sess_off', e => out.push(e)); const event = { type: 'assistant_delta', text: '普通说明' };
  await stream.write(event); await stream.flush(); stream.close(); assert.equal(out[0], event);
  assert.equal(await api.displayCacheKey('sess_off'), ''); assert.deepEqual(io, { opens: 0, seals: 0 }); assert.deepEqual(fs.readdirSync(root), []);
});
test('malformed or partial aliases are bounded and fail closed on cancellation and final flush', async t => {
  const { api } = await setup(t), out = [], stream = api.createDisplayStream('sess_unknown', e => out.push(e));
  await stream.write({ type: 'assistant_delta', text: 'visible [[RUYI_PVT:EMAIL:' + 'a'.repeat(400) });
  await stream.write({ type: 'assistant_delta', text: ' [[RUYI_PVT:PHONE:abc' });
  await stream.flush(); stream.close();
  const text = out.map(e => e.text || '').join(''); assert.ok(text.startsWith('visible ')); assert.equal(text.includes('[[RUYI'), false); assert.match(text, /unavailable/);
});
test('fresh privacy off preserves literal reference documentation and its original events without opening a vault', async t => {
  const { api, io, root } = await setup(t); api.configure({ ...policy, privacyModeV1: 'off' });
  const literal = 'Documentation [[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']] and [[RUYI_PVT: unfinished';
  assert.equal(await api.displayText('sess_off_documentation', literal), literal);
  const event = { type: 'assistant_delta', text: literal }, out = [], stream = api.createDisplayStream('sess_off_documentation', e => out.push(e));
  await stream.write(event); await stream.flush(); stream.close(); assert.equal(out[0], event);
  assert.deepEqual(io, { opens: 0, seals: 0 }); assert.deepEqual(fs.readdirSync(root), []);
});
test('repeated references have bounded expansion across the entire stream and do not export a mapping table', async t => {
  const { api, issue } = await setup(t), x = await issue('x'.repeat(900000), 'sess_display_budget', 'INTERNAL');
  const out = [], stream = api.createDisplayStream(x.id, e => out.push(e));
  for (let n = 0; n < 20; n++) await stream.write({ type: 'assistant_delta', text: x.token });
  await stream.flush(); stream.close();
  const shown = out.map(e => e.text || '').join(''); assert.ok(Buffer.byteLength(shown) < 9 * 1024 * 1024); assert.match(shown, /private display limit/); assert.equal(shown.includes(x.token), false);
});
test('steward final display restores say and why only; action execution structure remains canonical', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const action = { kind: 'write', args: { content: x.token } }, original = { type: 'steward_reply', say: x.token, why: 'Echo ' + x.token, acts: [action], actions: [action], parsed: { say: x.token } };
  const out = [], stream = api.createDisplayStream(x.id, e => out.push(e)); await stream.write(original); await stream.flush(); stream.close();
  assert.equal(out[0].say, x.value); assert.equal(out[0].why, 'Echo ' + x.value); assert.equal(out[0].acts, original.acts); assert.equal(out[0].parsed, original.parsed); assert.equal(original.say, x.token);
});
test('queued session display uses stable message snapshots while providerHistory is never cloned or restored', async t => {
  const { api, issue } = await setup(t), x = await issue(), messages = [{ role: 'assistant', content: x.token }], providerHistory = [{ role: 'assistant', content: x.token }];
  const out = [], stream = api.createDisplayStream(x.id, e => out.push(e)); const pending = stream.write({ type: 'session', session: { id: x.id, messages, providerHistory } });
  messages[0].content = 'later mutation'; messages.push({ role: 'assistant', content: 'later push' }); await pending; await stream.flush(); stream.close();
  assert.equal(out[0].session.messages.length, 1); assert.equal(out[0].session.messages[0].content, x.value); assert.equal(out[0].session.providerHistory, providerHistory);
});
test('enabled model guidance describes host tool and UI restoration under all three encoders and is absent when off', async t => {
  const { api } = await setup(t);
  for (const body of [{ messages: [{ role: 'user', content: 'public' }] }, { system: 'original', messages: [{ role: 'user', content: 'public' }] }, { instructions: 'original', input: [{ role: 'user', content: 'public' }] }]) {
    await api.run('sess_prompt', policy, async () => { const wire = JSON.stringify(await api.beforeRequest(body)); assert.match(wire, /local interface restores valid references/); assert.match(wire, /ordinary tool permissions/); assert.match(wire, /Never decode|never decode/); });
  }
  api.configure({ ...policy, privacyModeV1: 'off' }); const body = { messages: [{ role: 'user', content: 'public' }] }; assert.equal(await api.beforeRequest(body), body);
});
test('learned short credentials inside opaque reference IDs do not upgrade personal aliases or weaken password fields', async t => {
  const { api, issue } = await setup(t), x = await issue();
  const state = x.scope.exportState(), token = '[[RUYI_PVT:EMAIL:' + '5910'.repeat(8) + ']]';
  state.entries[0].token = token; x.scope.importState(state); x.scope.protectValue('591', 'CREDENTIAL');
  await api.run(x.id, policy, async () => {
    const request = await api.beforeRequest({ messages: [{ role: 'user', content: 'Echo ' + token }] });
    assert.equal(request.messages.at(-1).content, 'Echo ' + token);
    await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: JSON.stringify({ password: token }) }] }), /credential_context/);
  });
});
