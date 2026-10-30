'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred } = require('../lib/composer-race-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const reply of ['success', 'failure', 'no-live', 'network']) {
  for (const back of [false, true]) {
    test(`steer ${reply}: A→B${back ? '→A' : ''} keeps new draft and never paints/retries old request`, async () => {
      const fx = fixture();
      const pending = fx.send('A original');
      await tick(); // The image-preparation boundary completes before the steer request.
      fx.choose('B'); if (back) fx.choose('A');
      fx.nodes.promptInput.value = 'new draft';
      if (reply === 'network') fx.response.reject(new TypeError('Failed to fetch'));
      else fx.response.resolve(reply === 'success' ? { ok: true, queued: 1 } : { ok: false, error: { code: reply === 'no-live' ? 'steer.no_live_turn' : 'steer.queue_full' } });
      await pending;
      assert.equal(fx.calls[0].body.sessionId, 'A');
      assert.equal(fx.nodes.promptInput.value, 'new draft');
      assert.equal(fx.nodes.promptInput.events.length, 0);
      assert.equal(fx.rows.length, 0);
      assert.equal(fx.streams.length, 0);
      assert.equal(fx.toasts.length, 0);
      assert.equal(fx.runtime.steerPendingList.length, 0);
    });
  }
}

test('same-session steer success preserves edits and their saved draft', async () => {
  const fx = fixture();
  const pending = fx.send('  original  ');
  fx.nodes.promptInput.value = 'new draft'; fx.store.set('wcw.draft', 'new draft');
  fx.response.resolve({ ok: true, queued: 1 }); await pending;
  assert.equal(fx.nodes.promptInput.value, 'new draft');
  assert.equal(fx.store.get('wcw.draft'), 'new draft');
  assert.equal(fx.rows[0].content, 'original');
  assert.deepEqual(fx.nodes.promptInput.events, [{ type: 'ruyi:composer-sent', text: 'original', before: 'new draft', bubbles: true }]);
});

for (const network of [false, true]) {
  test(`same-session ${network ? 'network' : 'business'} failure preserves edits without emitting a sent event`, async () => {
    const fx = fixture(); const pending = fx.send('original');
    fx.nodes.promptInput.value = 'edited';
    if (network) fx.response.reject(new TypeError('Failed to fetch'));
    else fx.response.resolve({ ok: false, error: { code: 'steer.queue_full' } });
    await pending;
    assert.equal(fx.nodes.promptInput.value, 'edited');
    assert.equal(fx.nodes.promptInput.events.length, 0);
    assert.equal(fx.toasts.length, 1);
    assert.equal(fx.streams.length, 0);
  });
}

for (const changed of [false, true]) {
  test(`no_live_turn retries captured text, ${changed ? 'preserving edited' : 'consuming unchanged'} draft`, async () => {
    const fx = fixture();
    void fx.send('original');
    if (changed) { fx.nodes.promptInput.value = 'new draft'; fx.store.set('wcw.draft', 'new draft'); }
    fx.response.resolve({ ok: false, error: { code: 'steer.no_live_turn' } });
    await tick();
    assert.equal(fx.streams.length, 1);
    assert.equal(fx.streams[0].body.sessionId, 'A');
    assert.equal(fx.streams[0].body.message, 'original');
    assert.equal(fx.nodes.promptInput.value, changed ? 'new draft' : '');
    assert.equal(fx.nodes.promptInput.events.length, 1);
    assert.equal(fx.nodes.promptInput.events[0].text, 'original');
    if (changed) assert.equal(fx.store.get('wcw.draft'), 'new draft');
  });
}

test('successful unchanged steer fires the voice-learning event before clearing', async () => {
  const fx = fixture(); const pending = fx.send('original');
  fx.response.resolve({ ok: true, queued: 1 }); await pending;
  assert.deepEqual(fx.nodes.promptInput.events, [{ type: 'ruyi:composer-sent', text: 'original', before: 'original', bubbles: true }]);
  assert.equal(fx.nodes.promptInput.value, '');
  assert.equal(fx.store.has('wcw.draft'), false);
});

test('override steer does not consume or learn the composer draft', async () => {
  const fx = fixture(); fx.nodes.promptInput.value = 'draft';
  const pending = fx.runtime.sendPrompt('override'); fx.response.resolve({ ok: true }); await pending;
  assert.equal(fx.nodes.promptInput.value, 'draft'); assert.equal(fx.nodes.promptInput.events.length, 0);
});

test('steer fallback consumes the normal composer team preference; override turns leave it for the next send', async () => {
  const normal = fixture(); normal.state.config.subagentMaxPerTurn = 1; normal.runtime.toggleAgentTeamTurn();
  void normal.send('original'); normal.response.resolve({ ok: false, error: { code: 'steer.no_live_turn' } });
  await tick(); assert.equal(normal.streams[0].body.agentTeam, true);

  const override = fixture(); override.state.config.subagentMaxPerTurn = 1; override.runtime.toggleAgentTeamTurn(); override.state.sessionRelay = null;
  void override.runtime.sendPrompt('/compact'); await tick();
  assert.equal(override.streams[0].body.agentTeam, false);
  override.runtime.activeTurns.clear(); override.state.streaming = false;
  void override.send('normal next'); await tick();
  assert.equal(override.streams[1].body.agentTeam, true);
});

test('clearAll always cancels original session and leaves the new session queue intact', async () => {
  const fx = fixture(); fx.runtime.steerPendingList.push({ text: 'one' }, { text: 'same' });
  const pending = fx.win.cancelSteer('', true);
  fx.choose('B'); const newItem = { text: 'same' }; fx.runtime.steerPendingList.push(newItem);
  fx.response.resolve({ ok: true }); await pending;
  assert.deepEqual(fx.calls.map(call => [call.body.sessionId, call.body.text]), [['A', 'one'], ['A', 'same']]);
  assert.equal(fx.runtime.steerPendingList.length, 1); assert.equal(fx.runtime.steerPendingList[0], newItem);
});

test('single cancellation removes its captured item, not a new equal-text item', async () => {
  const fx = fixture(); fx.runtime.steerPendingList.push({ text: 'same' });
  const pending = fx.win.cancelSteer('same'); fx.choose('B'); fx.choose('A');
  const newItem = { text: 'same' }; fx.runtime.steerPendingList.push(newItem);
  fx.response.resolve({ ok: true }); await pending;
  assert.equal(fx.runtime.steerPendingList[0], newItem);
});

test('normal send preflight also recognizes A→B→A and a selection from empty state', async () => {
  for (const initial of ['A', null]) {
    const fx = fixture(); fx.choose(initial); fx.preflight = deferred();
    const pending = fx.send('original'); fx.choose('B'); if (initial) fx.choose('A');
    fx.preflight.resolve(); await pending;
    assert.equal(fx.streams.length, 0); assert.equal(fx.nodes.promptInput.value, 'original');
  }
});

test('automatic creation superseded by a selection does not send into that selection', async () => {
  const fx = fixture(); fx.choose(null); fx.creation = deferred();
  const pending = fx.send('original'); await tick(); fx.choose('B');
  fx.creation.resolve(null); await pending;
  assert.equal(fx.streams.length, 0); assert.equal(fx.nodes.promptInput.value, 'original');
});

test('a protected image being edited blocks steer without consuming the draft', async () => {
  const fx = fixture();
  fx.state.config.privacyModeV1 = 'basic';
  fx.state.attachments = [{ id: 'image1', name: 'picture.png', imageEditing: true }];
  await fx.send('keep this draft');
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.streams.length, 0);
  assert.equal(fx.nodes.promptInput.value, 'keep this draft');
  assert.equal(fx.state.attachments.length, 1);
  assert.equal(fx.toasts.length, 1);
});

test('selection change during real image preparation prevents the steer request', async () => {
  const imageReply = deferred(), requested = deferred();
  const fx = fixture({ imageApi: () => { requested.resolve(); return imageReply.promise; } });
  fx.state.config.privacyModeV1 = 'basic';
  fx.state.attachments = [{ id: 'image1', name: 'picture.png' }];
  const pending = fx.send('keep this draft');
  await requested.promise;
  fx.choose('B');
  imageReply.resolve({});
  await pending;
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.streams.length, 0);
  assert.equal(fx.nodes.promptInput.value, 'keep this draft');
});
