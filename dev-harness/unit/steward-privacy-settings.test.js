'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
const { fixture } = require('../lib/privacy-test-fixture');
function setup(preflight = async () => {}) {
  const f = fixture(), turns = new Map(), decisions = [];
  let config = { privacyModeV1: 'off', privacyTechnicalV1: false, privacyRulesV1: [], credentialEncryptionV1: false }, writes = 0;
  const version = c => crypto.createHash('sha256').update(JSON.stringify([c.privacyModeV1, c.privacyTechnicalV1, c.privacyRulesV1])).digest('hex').slice(0, 16);
  const core = { ...f.PrivacyCore, configHooks: { isBusy: () => turns.size > 0 } };
  const preview = async (c, sample) => {
    const rule = c.privacyRulesV1[0]; let matches;
    if (rule.kind === 'regex') matches = (await f.PrivacyRegex.scan([rule], [sample])).get(sample);
    else {
      const detector = core.createDetector({ rules: [rule] }); matches = [];
      const walk = (value, pointer) => {
        if (typeof value === 'string') matches.push(...detector.detect(value, { pointer }));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'));
      };
      if (rule.kind === 'field') walk(JSON.parse(sample), ''); else matches = detector.detect(sample);
    }
    return { matches };
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13ab-privacy-api.js'), 'utf8');
  const api = vm.runInNewContext(constBlock(source, 'PrivacySettings') + '\nPrivacySettings', { PrivacyCore: core, PrivacyRegex: f.PrivacyRegex,
    PrivacyGateway: { ruleVersion: version, preview }, structuredClone, Buffer, process: { platform: 'win32' }, turnSettlers: turns,
    readConfig: async () => structuredClone(config), mutateConfig: async fn => { const next = structuredClone(config); fn(next); config = next; writes++; },
    StewardHooks: {preflightDecision: preflight}, stewardAppendDecision: row => decisions.push(structuredClone(row)) });
  const current = () => structuredClone(config), request = extras => ({ op: 'update', expectedRuleVersion: version(config), ...extras });
  const owner = { sessionId: 'steward', turnSeq: 1 };
  return { api, turns, decisions, current, request, owner, writes: () => writes, mutate: fn => fn(config) };
}
const rule = { id: 'company-employee', kind: 'regex', value: '\\bEMP-\\d{5}\\b', category: 'INTERNAL' };
const tests = [{ ruleId: rule.id, sample: 'EMP-12345', match: true }, { ruleId: rule.id, sample: 'order 12345', match: false }];

test('steward inspection never sends literal private-rule values to the model, including when privacy is off', async () => {
  const f = setup();
  f.mutate(config => { config.privacyRulesV1 = [{ id: 'private-literal', kind: 'literal', category: 'CREDENTIAL', value: 'SYNTHETIC-PRIVATE-LITERAL-ONLY' }, rule]; });
  const result = await f.api.administer({ op: 'inspect' }, f.owner);
  assert.equal(result.privacy.mode, 'off'); assert.equal(result.privacy.rules[0].valueConfigured, true);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE-LITERAL-ONLY'));
  assert.equal(result.privacy.rules[0].id, 'private-literal'); assert.equal(result.privacy.rules[1].value, rule.value);
  assert.equal(f.current().privacyRulesV1[0].value, 'SYNTHETIC-PRIVATE-LITERAL-ONLY');
});
test('steward privacy preview, deferred atomic commit and disabling retain encryption', async () => {
  const f = setup(); f.turns.set('steward', {});
  const args = f.request({ upsert: [rule], tests, mode: 'enhanced' });
  const preview = await f.api.administer({ ...args, op: 'preview' }, f.owner);
  assert.equal(preview.saved, false); assert.equal(preview.checks.length, 2); assert.equal(f.writes(), 0);
  const queued = await f.api.administer(args, f.owner);
  assert.equal(queued.status, 'pending'); assert.equal(f.writes(), 0); assert.equal(f.current().privacyModeV1, 'off');
  await assert.rejects(f.api.administer(args, f.owner), /update_pending/);
  f.turns.clear(); const applied = await f.api.settle('steward', 1, true);
  assert.equal(applied.saved, true); assert.equal(f.current().privacyRulesV1[0].id, rule.id); assert.equal(f.current().credentialEncryptionV1, true);
  assert.equal(await f.api.settle('steward', 1, true), null); assert.equal(f.writes(), 1);
  assert.ok(!JSON.stringify(f.decisions).includes('EMP-'), 'audit stores no pattern or sample');
  f.turns.set('steward', {}); await f.api.administer(f.request({ mode: 'off' }), f.owner); f.turns.clear();
  assert.equal((await f.api.settle('steward', 1, true)).saved, true);
  assert.equal(f.current().privacyModeV1, 'off'); assert.equal(f.current().credentialEncryptionV1, true);
});
test('bad, broad, invalid or untested rules never save; existing builtins cannot satisfy custom tests', async () => {
  const f = setup(); f.turns.set('steward', {});
  for (const value of [
    { upsert: [rule], tests: [] },
    { upsert: [rule], tests: [...tests, { ruleId: rule.id, sample: 'EMP-99999', match: false }] },
    { upsert: [{ ...rule, value: '(?:)' }], tests },
    { upsert: [{ ...rule, value: '[invalid' }], tests },
    { upsert: [{ ...rule, value: 'never-match-custom' }], tests: [{ ruleId: rule.id, sample: 'email: synthetic@example.test', match: true }, tests[1]] },
    { upsert: [rule, rule], tests }, { remove: ['not-present'] }, { mode: 'bogus' }, { technical: 'yes' },
  ]) {
    let result; try { result = await f.api.administer(f.request(value), f.owner); } catch { result = { ok: false }; }
    assert.equal(result.ok, false); assert.equal(f.writes(), 0);
  }
});
test('cancel, busy and concurrent settings conflicts discard drafts without overwriting newer state', async () => {
  for (const kind of ['cancel', 'busy', 'conflict', 'encryption-conflict']) {
    const f = setup(); f.turns.set('steward', {}); await f.api.administer(f.request({ mode: 'strict' }), f.owner); f.turns.clear();
    if (kind === 'busy') f.turns.set('other', {});
    if (kind === 'conflict') f.mutate(c => { c.privacyTechnicalV1 = true; });
    if (kind === 'encryption-conflict') f.mutate(c => { c.credentialEncryptionV1 = true; });
    const result = await f.api.settle('steward', 1, kind !== 'cancel');
    assert.equal(result.saved, false, kind); assert.equal(f.writes(), 0, kind);
    assert.equal(await f.api.settle('steward', 1, true), null, 'no latent retry');
  }
});
test('literal and complete JSON pointer rules test independently and upsert preserves unrelated rules', async () => {
  const f = setup(); f.turns.set('steward', {});
  const rows = [{ id: 'project-name', kind: 'literal', value: 'SYNTHETIC-PROJECT-ALPHA', category: 'INTERNAL' }, { id: 'employee-field', kind: 'field', value: '/employee/id', category: 'IDENTITY' }];
  const cases = [{ ruleId: rows[0].id, sample: rows[0].value, match: true }, { ruleId: rows[0].id, sample: 'public project', match: false },
    { ruleId: rows[1].id, sample: '{"employee":{"id":"sample-person"}}', match: true }, { ruleId: rows[1].id, sample: '{"order":{"id":"sample-order"}}', match: false }];
  assert.equal((await f.api.administer(f.request({ upsert: rows, tests: cases }), f.owner)).status, 'pending');
  f.turns.clear(); assert.equal((await f.api.settle('steward', 1, true)).saved, true);
  f.turns.set('steward', {}); await f.api.administer(f.request({ remove: [rows[0].id] }), f.owner); f.turns.clear(); await f.api.settle('steward', 1, true);
  assert.equal(f.current().privacyRulesV1.length, 1); assert.equal(f.current().privacyRulesV1[0].id, rows[1].id);
});

test('deferred privacy settlement authenticates the real decision owner before applying settings', async () => {
  const { loadWorkDataJournals } = require('../lib/work-data-journals-fixture');
  const journal = loadWorkDataJournals().WorkDataJournals.create({
    file: path.join(require('node:os').tmpdir(), 'ruyi-privacy-no-write-' + crypto.randomUUID(), 'decisions.ndjson'),
    context: { kind: 'steward-decisions', sessionId: 'steward' }, enabled: async () => true,
    keys: { snapshot: async () => { throw Object.assign(Error('synthetic private detail'), { code: 'work_data_key.absent' }); } },
  });
  const f = setup(() => journal.preflight()); f.turns.set('steward', {});
  await f.api.administer(f.request({ mode: 'off' }), f.owner); f.turns.clear();
  const result = await f.api.settle('steward', 1, true);
  assert.equal(result.saved, false); assert.equal(result.error, 'work_data_key.absent'); assert.equal(f.writes(), 0);
  assert.equal(await f.api.settle('steward', 1, true), null, 'no deferred replay after authority failure');
  assert.equal(JSON.stringify(f.decisions).includes('synthetic private detail'), false);
});
