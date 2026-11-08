'use strict';
// Signed QQ/Feishu group callbacks may reach the original worker, but the
// production adapters do not prove continuous group membership. The same live
// intervention must be available through the supported direct-owner path.
require('./lib/self-isolate-home.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('./lib/harness.js');
const { createActualFixture } = require('./lib/external-bots-c2/actual-http-fixture.cjs');
const { nativePending } = require('./lib/external-bots-c2/run-journeys.cjs');

const t = createRunner('EXTERNAL BOTS GROUP DECISIONS');
const { ok } = t;

async function checkGroup(fx, platform) {
  await fx.configure(platform, true);
  const id = fx.nextId('group_pending');
  const outboundBefore = fx.outbound.length;
  const modelRequestsBefore = fx.model.requests.length;
  const response = await fx.callback(id, '/pending', platform, { group: true });
  assert.equal(response.status, 200, 'signed group callback accepted: ' + response.text);
  const settled = await fx.settledCallback(id, response);
  assert.equal(settled.kind, 'original-worker-terminal');
  const item = settled.item;
  const binding = fx.connection(platform, true);
  assert.deepEqual([item.platform, item.senderId, item.conversationId, item.conversationType],
    [platform, binding.ownerSenderId, binding.ownerConversationId, 'group']);
  assert.equal(item.control?.connectionId, binding.id, 'the signed sender is the bound control owner');
  assert.equal(fx.outbound.length, outboundBefore, 'no message sent to the group or any fallback audience');
  assert.equal(item.execution.status, 'failed');
  assert.equal(item.delivery.status, 'failed');
  assert.equal(item.delivery.errorCode, 'external_delivery.predispatch');
  assert.equal(fx.model.requests.length, modelRequestsBefore, 'no model fallback for the remote command');

  const ledger = fx.ledger();
  const stored = ledger.items.find(row => row.id === item.id);
  assert.equal(stored.remoteCommand?.kind, 'pending');
  assert.equal(stored.remoteView, undefined, 'no protected view staged for the group');
  assert.deepEqual(ledger.remoteActions, [], 'no decision offer persisted');
  assert.deepEqual(ledger.remoteActionReceipts, [], 'no action receipt persisted');
  ok(true, `${platform}: signed group owner reaches the worker and fails closed before message dispatch`);
}

async function main() {
  const temp = fs.realpathSync(os.tmpdir());
  const output = fs.mkdtempSync(path.join(temp, 'ruyi-bot-group-decisions-'));
  // The runner gives a case 120s. Reserve 30s for closure and 15s for the
  // final verdict instead of inheriting the multi-journey fixture budgets.
  const deadline = Date.now() + 75000;
  const cleanupDeadline = deadline + 30000;
  let fx, fixtureHome;
  try {
    fx = await createActualFixture({ output, deadline, cleanupDeadline });
    fixtureHome = fx.home;
    const pending = await nativePending(fx, 'permission', 'allow', 1);
    const journal = fs.readFileSync(fx.journalFile(pending.sid));
    for (const platform of ['qq', 'feishu']) await checkGroup(fx, platform);

    await fx.configure('qq');
    const offer = await fx.offer(pending.iv, 'permission', pending.title, 'qq');
    assert.match(offer.code, /^ra_[A-Za-z0-9_-]{22}$/);
    assert.equal((await fx.pending(pending.sid, 'permission')).id, pending.iv.id);
    assert.deepEqual(fs.readFileSync(fx.journalFile(pending.sid)), journal, 'no decision or version change');
    assert.equal(fs.existsSync(pending.target), false, 'the original write remains pending');
    assert.deepEqual(fx.model.errors, []);
    ok(true, 'the same original live permission is offerable to its direct owner and remains unapplied');
  } catch (error) {
    fixtureHome ||= error.c2Evidence?.isolationHome;
    t.fail(error.stack || String(error));
  } finally {
    if (fx) {
      try {
        assert.equal((await fx.close()).status, 'closed-held-actors-and-owned-listeners');
        if (!t.failures) {
          const roots = [[output, 'ruyi-bot-group-decisions-'], [fixtureHome, 'ruyi-e2e-home-']];
          for (const [root, prefix] of roots) {
            const resolved = fs.realpathSync(root);
            assert.equal(path.dirname(resolved), temp, 'cleanup root must be a direct child of TEMP');
            assert.equal(path.basename(resolved), path.basename(root), 'cleanup root identity changed');
            assert.ok(path.basename(resolved).startsWith(prefix));
          }
          for (const [root] of roots) fs.rmSync(root, { recursive: true });
        }
        ok(true, 'original fixture child and loopback listeners closed');
      } catch (error) {
        t.fail(error.stack || String(error));
      }
    }
    if (t.failures) console.log('Retained fixture roots:', [output, fixtureHome].filter(root => root && fs.existsSync(root)));
    t.done();
  }
}

main().catch(error => { t.fail(error.stack || String(error)); t.done(); });
