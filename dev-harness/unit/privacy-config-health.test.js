'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Readable } = require('node:stream');
const { loadServerInternals } = require('../lib/server-internals');
function setup(t, initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-health-'));
  process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
  const file = path.join(root, 'config.json');
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  const app = loadServerInternals(['readConfig', 'mutateConfig', 'PrivacyGateway', 'PrivacyCore'], { withEval: true });
  t.after(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-privacy-health-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, app };
}
const off = { privacyModeV1: 'off', credentialEncryptionV1: false, stewardEnabledV1: false, schedulerEnabledV1: false };
async function blocked(app) {
  await assert.rejects(() => app.PrivacyGateway.beforeRequest({ messages: [{ content: 'health-private@example.test' }] }), /privacy.policy_unavailable/);
  assert.throws(() => app.PrivacyGateway.assertSupported(off, 'cli'), /privacy.policy_unavailable/);
  assert.throws(() => app.PrivacyGateway.assertToolChannel(), /privacy.policy_unavailable/);
  assert.throws(() => app.PrivacyGateway.assertMediaAllowed(off), /privacy.policy_unavailable/);
  assert.equal(app.PrivacyGateway.prepareCall({ name: 'file_read', rawArgs: '{"path":"x"}' }).privacyError.code, 'privacy.policy_unavailable');
}
test('cold corrupt config never turns privacy off for model, tool, media or CLI traffic', async t => {
  const { file, app } = setup(t, '{"broken":');
  const config = await app.readConfig(); assert.equal(config.privacyPolicyRecoveryRequiredV1, true);
  await blocked(app); assert.equal(fs.readFileSync(file, 'utf8'), '{"broken":');
});
test('last-good fallback stays unavailable until an explicit privacy settings save confirms policy', async t => {
  const { file, app } = setup(t, off); await app.readConfig();
  fs.writeFileSync(file, '{"broken":'); fs.rmSync(file + '.prev', { force: true });
  const config = await app.readConfig(); assert.equal(config.privacyPolicyRecoveryRequiredV1, true); await blocked(app);
  await app.mutateConfig(current => { current.locale = 'en-US'; }); await blocked(app);
  const req = Readable.from([Buffer.from(JSON.stringify({ mode: 'off', technical: false, rules: [] }))]); req.method = 'POST'; req.headers = {};
  let status, body; const res = { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
  await app.PrivacyCore.configHooks.handleApiRoutes(req, res, '/api/privacy/settings');
  assert.equal(status, 200); assert.equal(body.ok, true); assert.equal(app.PrivacyGateway.recoveryRequired(), false);
  const input = { messages: [] }; assert.equal(await app.PrivacyGateway.beforeRequest(input), input);
});
test('restoring an older off backup persists an unconfirmed policy across process restarts', async t => {
  const { root, file, app } = setup(t, { ...off, privacyModeV1: 'enhanced' }); await app.readConfig();
  fs.writeFileSync(file + '.prev', JSON.stringify(off)); fs.writeFileSync(file, '{"broken":');
  const recovered = await app.readConfig(); assert.equal(recovered.privacyModeV1, 'off'); assert.equal(recovered.privacyPolicyRecoveryRequiredV1, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacyPolicyRecoveryRequiredV1, true); await blocked(app);
  process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
  const restart = loadServerInternals(['readConfig', 'PrivacyGateway']); await restart.readConfig(); assert.equal(restart.PrivacyGateway.recoveryRequired(), true);
});
test('lost config in a used installation is distinct from a fresh installation', async t => {
  const used = setup(t); fs.mkdirSync(path.join(used.root, 'privacy-scopes'));
  const config = await used.app.readConfig(); assert.equal(config.permissionMode, 'default'); assert.equal(config.privacyPolicyRecoveryRequiredV1, true); await blocked(used.app);
  const fresh = setup(t); const clean = await fresh.app.readConfig(); assert.equal(clean.privacyPolicyRecoveryRequiredV1, false);
  assert.equal(fresh.app.PrivacyGateway.recoveryRequired(), false);
});
test('credential hydration and normalization failures mark policy unavailable without hiding the original error', async t => {
  const bad = setup(t, { ...off, credentialRefsV1: { version: 1, slots: [{ pointer: '/modelsApiKey', id: 'missing' }] } });
  await assert.rejects(() => bad.app.readConfig(), /credential_vault/); await blocked(bad.app);
  const invalid = setup(t, { ...off, privacyRulesV1: [{ id: 'bad', kind: 'unknown', value: 'x', category: 'INTERNAL' }] });
  await assert.rejects(() => invalid.app.readConfig(), /privacy.rule_kind/); await blocked(invalid.app);
});

test('invalid privacy fields and JSON roots cannot silently normalize into a healthy off policy', async t => {
  for (const patch of [{ privacyModeV1: 'enhancd' }, { privacyTechnicalV1: 'true' }, { privacyRulesV1: {} }]) {
    const invalid = setup(t, { ...off, ...patch });
    const config = await invalid.app.readConfig(); assert.equal(config.privacyPolicyRecoveryRequiredV1, true); await blocked(invalid.app);
  }
  for (const rootValue of ['[]', '"config"', '42', 'false']) {
    const invalid = setup(t, rootValue); await invalid.app.readConfig(); await blocked(invalid.app);
  }
});
test('valid cached config recovers transient health; failed recovery-marker persistence cannot permit traffic', async t => {
  const healthy = setup(t, off); await healthy.app.readConfig();
  fs.utimesSync(healthy.file, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  await healthy.app.readConfig(); healthy.app.PrivacyGateway.markUnavailable(); await healthy.app.readConfig();
  assert.equal(healthy.app.PrivacyGateway.recoveryRequired(), false);
  const failed = setup(t, '{"broken":'); fs.writeFileSync(failed.file + '.prev', JSON.stringify(off));
  failed.app.__eval('writeConfigAtomic = async () => { throw Object.assign(new Error("fixture disk failure"), { code: "EIO" }); };');
  await assert.rejects(() => failed.app.readConfig(), /fixture disk failure/); await blocked(failed.app);
});
