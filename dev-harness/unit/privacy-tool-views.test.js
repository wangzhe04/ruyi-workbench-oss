'use strict';
// Real shared dispatch and proxy forwarding, isolated synthetic files; no server, browser,
// model endpoint or command/script execution. Real source views retain their original permissions.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-privacy-tool-views-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const off = { privacyModeV1: 'off', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: false,
  privacyPolicyRecoveryRequiredV1: false,
  providers: [], externalMcpServers: [], autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
  desktopMcp: { enabled: false, autodetect: false }, allowCommandTools: true, defaultWorkspace: work,
  stewardEnabledV1: false, schedulerEnabledV1: false, toolLoadingMode: 'auto' };
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(off));
const app = require('../lib/server-internals').loadServerInternals(['toolCall', 'TOOL_HANDLERS', 'NATIVE_COMMAND_TOOL_NAMES', 'PrivacyGateway', 'PrivacyCore', 'PrivacyLocalDriveProbe', 'mutateConfig', 'readConfig']);
const vault = require('../lib/privacy-test-fixture').fixture().vault;
for (const key of ['hydrateConfig', 'protectConfig', 'protectBackup', 'protectCorrupt', 'migrateBackups', 'stateStamp', 'sealLocal', 'openLocal']) app.PrivacyCore.configHooks[key] = vault[key];
const secret = 'SYNTHETIC-PRIVATE-PATIENT-FIELD', target = path.join(work, 'patient.json');
const original = JSON.stringify({ patientCode: secret, other: 'safe' }, null, 2);
fs.writeFileSync(target, original);
const views = ['file_search', 'docs_search', 'codebase_symbol_search', 'data_profile', 'project_snapshot',
  'git_diff', 'code_review_scan', 'frontend_audit', 'claude_md_audit', 'steward_file_read'];
const ctx = config => ({ config, workingDir: work, sessionId: 'sess_privacy_views', session: { id: 'sess_privacy_views', cwd: work } });
let serial = 0;
async function scoped(mode, fn) {
  const policy = { ...off, credentialEncryptionV1: true, privacyModeV1: mode, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] };
  await app.mutateConfig(current => Object.assign(current, policy));
  const live = await app.readConfig();
  app.PrivacyGateway.configure(live);
  return app.PrivacyGateway.run('unsupported-views-' + (++serial), live, () => fn(live));
}

after(() => {
  app.PrivacyLocalDriveProbe.stopSync();
  vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-privacy-tool-views-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});

test('all privacy modes retain native schemas and execute source views through the real dispatch', async () => {
  const names = [...views, ...app.NATIVE_COMMAND_TOOL_NAMES];
  for (const mode of ['basic', 'enhanced', 'strict']) await scoped(mode, async policy => {
    for (const name of names) {
      assert.ok(Object.hasOwn(app.TOOL_HANDLERS, name));
      const invalid = await app.toolCall(name, null, ctx(policy));
      assert.equal(invalid.code, 'invalid-arguments');
    }
    for (const [name, args] of [['file_search', { root: work, pattern: 'patientCode', context: 1 }], ['data_profile', { path: target }], ['project_snapshot', { root: work }]]) {
      const result = await app.PrivacyGateway.toolResult(await app.toolCall(name, args, ctx(policy)));
      assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes(secret), false);
    }
    for (const name of app.NATIVE_COMMAND_TOOL_NAMES) assert.equal((await app.toolCall(name, {}, ctx({ ...policy, allowCommandTools: false }))).code, 'tool-disabled');
  });
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('proxy dispatch preserves source proofs and cannot promote lower tiers or bypass command policy', async () => {
  await scoped('enhanced', async policy => {
    const args = { path: target, root: work, pattern: 'patientCode' };
    for (const tier of ['read', 'edit', 'exec']) {
      const result = await app.PrivacyGateway.toolResult(await app.toolCall('tool_invoke_' + tier, { name: 'file_search', arguments: args }, ctx(policy)));
      assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes(secret), false);
    }
    const lower = await app.toolCall('tool_invoke_read', { name: 'file_write', arguments: { path: 'forbidden.txt', content: 'must not write' } }, ctx(policy));
    assert.equal(lower.code, 'tier-mismatch'); assert.equal(fs.existsSync(path.join(work, 'forbidden.txt')), false);
    const disabled = await app.toolCall('tool_invoke_exec', { name: 'script_run', arguments: { language: 'node', code: 'throw Error("must not execute")' } }, ctx({ ...policy, allowCommandTools: false }));
    assert.equal(disabled.code, 'tool-disabled');
    const repaired = await app.PrivacyGateway.toolResult(await app.toolCall('tool_invoke_read', { arguments: { name: 'file_search', arguments: args } }, ctx(policy)));
    assert.equal(repaired.ok, true); assert.equal(JSON.stringify(repaired).includes(secret), false);
  });
});

test('off mode retains real search/profile results and ordinary command-disable policy', async () => {
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(off));
  app.PrivacyGateway.configure(off);
  const search = await app.toolCall('file_search', { root: work, pattern: 'patientCode', context: 1 }, ctx(off));
  assert.equal(search.ok, true); assert.ok(JSON.stringify(search).includes(secret), 'off-mode real search reproduces the source-fragment channel');
  const profile = await app.toolCall('data_profile', { path: target }, ctx(off));
  assert.equal(profile.ok, true); assert.ok(JSON.stringify(profile).includes(secret), 'off-mode profile keeps existing samples');
  const proxy = await app.toolCall('tool_invoke_read', { name: 'file_search', arguments: { root: work, pattern: 'patientCode' } }, ctx(off));
  assert.equal(proxy.ok, true); assert.ok(JSON.stringify(proxy).includes(secret));
  for (const name of app.NATIVE_COMMAND_TOOL_NAMES) {
    const result = await app.toolCall(name, {}, ctx({ ...off, allowCommandTools: false }));
    assert.equal(result.code, 'tool-disabled');
  }
});

test('supported native location/full-text tools stay available and unknown tools retain their errors', async () => {
  await scoped('enhanced', async policy => {
    const listed = await app.toolCall('file_list', { root: work }, ctx(policy));
    assert.equal(listed.ok, true); assert.ok(listed.files.length > 0);
    const read = await app.toolCall('file_read', { path: target }, ctx(policy));
    assert.equal(read.ok, true); assert.equal(read.content.includes(secret), false);
    const protectedRead = await app.PrivacyGateway.toolResult(read);
    assert.equal(JSON.stringify(protectedRead).includes(secret), false);
    const restored = await app.PrivacyGateway.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: 'copy.json', content: protectedRead.content }) }, ctx(policy));
    assert.equal(restored.privacyError, undefined); assert.equal(JSON.parse(restored.rawArgs).content, original);
    await assert.rejects(() => app.toolCall('file_searhc', {}, ctx(policy)), error => error.toolFailure?.code === 'unknown-tool' && /Unknown tool/.test(error.message));
    await assert.rejects(() => app.toolCall('constructor', {}, ctx(policy)), error => error.toolFailure?.code === 'unknown-tool');
  });
  app.PrivacyGateway.configure(off);
  await assert.rejects(() => app.toolCall('file_searhc', {}, ctx(off)), error => error.toolFailure?.code === 'unknown-tool');
});
