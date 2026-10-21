'use strict';
// Real source readers and dispatch handlers; isolated files/git only, no HTTP/model/browser.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-source-views-')), work = path.join(root, 'work'), data = path.join(root, 'data');
fs.mkdirSync(work); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'FILE_TOOL_HANDLERS', 'CODE_TOOL_HANDLERS', 'searchFileContent', 'stewardImplFileRead']);
const { fixture, syntheticComparisonPlan } = require('../lib/privacy-test-fixture');
const vault = fixture().vault;
// Restoration below compares source spelling only; no filesystem authority is granted.
app.PrivacyGateway.setHost({ planDisclosure: syntheticComparisonPlan });
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
let serial = 0;
const policy = (mode = 'enhanced') => ({ privacyModeV1: mode, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }], privacyTechnicalV1: false, providers: [], defaultWorkspace: work });
const ctx = config => ({ config, workingDir: work, sessionId: 'sess_source_views', session: { id: 'sess_source_views', cwd: work } });
const put = (name, raw) => { const target = path.join(work, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, raw); return target; };
const run = async (config, fn) => { app.PrivacyGateway.configure(config); return app.PrivacyGateway.run('source-' + (++serial), config, fn); };
const visible = value => JSON.stringify(value);
async function restore(text) {
  const call = (await app.PrivacyGateway.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ content: text }) }));
  assert.equal(call.privacyError, undefined); return JSON.parse(call.rawArgs).content;
}
after(() => { vault.clear(); fs.rmSync(root, { recursive: true, force: true }); });

test('actual search worker matches raw content, projects complete JSON before line/context clipping and preserves grouped proofs', async () => {
  const secret = 'P'.repeat(520) + '-SYNTHETIC-PATIENT', raw = '{\n  "patientCode": "' + secret + '",\n  "public": "needle"\n}\n';
  const target = put('search/contact.json', raw), config = policy();
  await run(config, async () => {
    for (const group of [false, true]) {
      const found = await app.FILE_TOOL_HANDLERS.file_search.handler({ root: path.dirname(target), pattern: 'patientCode', context: 1, group }, ctx(config));
      assert.equal(found.ok, true); assert.ok(found.matches.length > 0);
      const result = await app.PrivacyGateway.toolResult(found), wire = visible(result);
      assert.ok(!wire.includes(secret.slice(0, 100))); assert.match(wire, /RUYI_PVT:INTERNAL/);
      const row = group ? result.matches[0].matches[0] : result.matches[0];
      assert.equal(row.line, 2); assert.equal((await restore(row.text)), raw.split('\n')[1].slice(0, -1));
      assert.equal(row.context.length, 3);
    }
  });
});

test('docs and symbol readers project their actual full source before trimmed snippets', async () => {
  const secret = 'SYNTHETIC-CODE-PATIENT-' + 'Q'.repeat(540), raw = JSON.stringify({ patientCode: secret, public: 'needle' }, null, 2);
  put('docs/record.md', raw); put('code/record.js', raw);
  const config = policy();
  await run(config, async () => {
    const docs = await app.CODE_TOOL_HANDLERS.docs_search.handler({ root: path.join(work, 'docs'), query: 'patientCode' }, ctx(config));
    const symbols = await app.CODE_TOOL_HANDLERS.codebase_symbol_search.handler({ root: path.join(work, 'code'), symbol: 'patientCode' }, ctx(config));
    for (const result of [docs, symbols]) {
      assert.equal(result.ok, true); const protectedResult = await app.PrivacyGateway.toolResult(result);
      assert.ok(!visible(protectedResult).includes(secret.slice(0, 100))); assert.match(visible(protectedResult), /RUYI_PVT:INTERNAL/);
    }
  });
});

test('profile keeps original statistics and protects complete object samples before its 80-character display cap', async () => {
  const secret = 'SYNTHETIC-PROFILE-PATIENT-' + 'R'.repeat(160);
  const target = put('profile.json', JSON.stringify([{ patientCode: secret, age: 10, detail: { patientCode: secret } }, { patientCode: secret, age: 20, detail: { patientCode: secret } }]));
  const off = policy('off'); app.PrivacyGateway.configure(off);
  const ordinary = await app.CODE_TOOL_HANDLERS.data_profile.handler({ path: target }, ctx(off));
  const config = policy();
  await run(config, async () => {
    const result = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.data_profile.handler({ path: target }, ctx(config)));
    assert.equal(result.rowCount, ordinary.rowCount); assert.equal(result.colCount, ordinary.colCount);
    for (let i = 0; i < result.columns.length; i++) {
      for (const key of ['type', 'uniqueCount', 'nonNullCount', 'nullCount', 'min', 'max', 'mean']) assert.equal(result.columns[i][key], ordinary.columns[i][key]);
    }
    assert.ok(!visible(result).includes(secret.slice(0, 100))); assert.match(visible(result), /RUYI_PVT:INTERNAL/);
  });
});

test('six-field contact profiling protects numeric phone statistics through toolResult and the next actual model request shape', async () => {
  const values = { email: 'synthetic-profile@example.test', phone: '13800138000', staff: 'STAFF-123456abcdef', project: 'SYNTHETIC-PROJECT-SECRET', patientCode: 'SYNTHETIC-PROFILE-PATIENT', apiKey: 'sk-fixture-' + 'b'.repeat(40) };
  const target = put('profile-contact.json', JSON.stringify(values));
  const config = { ...policy(), privacyRulesV1: [...policy().privacyRulesV1,
    { id: 'staff', kind: 'regex', value: 'STAFF-[a-f0-9]{12}', category: 'INTERNAL' },
    { id: 'project', kind: 'literal', value: values.project, category: 'INTERNAL' }] };
  const off = { ...config, privacyModeV1: 'off' }; app.PrivacyGateway.configure(off);
  const ordinary = await app.CODE_TOOL_HANDLERS.data_profile.handler({ path: target }, ctx(off));
  assert.equal(ordinary.columns.find(row => row.name === 'phone').min, Number(values.phone));
  await run(config, async () => {
    const raw = await app.CODE_TOOL_HANDLERS.data_profile.handler({ path: target }, ctx(config));
    const protectedResult = await app.PrivacyGateway.toolResult(raw);
    const phone = raw.columns.find(row => row.name === 'phone');
    assert.equal(phone.type, 'numeric'); assert.equal(phone.uniqueCount, 1); assert.equal(phone.std, 0);
    for (const key of ['min', 'max', 'mean', 'median']) { assert.match(phone[key], /RUYI_PVT:/); assert.equal((await restore(phone[key])), values.phone); }
    const requests = [
      { input: [{ type: 'function_call_output', call_id: 'synthetic-profile', output: JSON.stringify(protectedResult) }] },
      { messages: [{ role: 'tool', tool_call_id: 'synthetic-profile', content: JSON.stringify(protectedResult) }] },
    ];
    for (const request of requests) {
      const modelView = await app.PrivacyGateway.beforeRequest(request);
      for (const secret of Object.values(values)) assert.ok(!visible(modelView).includes(secret));
    }
  });
});

test('audit snippets and extracted hosts retain source provenance and only displayed source files consume the projection budget', async () => {
  const auditRoot = path.join(work, 'audit'), host = 'synthetic-private-patient.example', privateValue = 'url(https://' + host + '/asset)';
  for (let i = 0; i < 135; i++) put('audit/quiet' + i + '.json', '{}\n');
  put('audit/finding.json', JSON.stringify({ patientCode: 'TODO SYNTHETIC-AUDIT-PRIVATE-' + 'A'.repeat(240) }));
  put('frontend/private.html', JSON.stringify({ patientCode: privateValue }));
  const config = policy();
  await run(config, async () => {
    const audit = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.code_review_scan.handler({ root: auditRoot, includeTests: true }, ctx(config)));
    assert.equal(audit.ok, true); assert.equal(audit.findings.length, 1); assert.equal(app.PrivacyGateway.active().sourceWork.files, 1);
    assert.match(audit.findings[0].text, /RUYI_PVT:INTERNAL/); assert.ok(!visible(audit).includes('SYNTHETIC-AUDIT-PRIVATE'));
    const frontend = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.frontend_audit.handler({ root: path.join(work, 'frontend') }, ctx(config)));
    assert.equal(frontend.ok, true); assert.ok(frontend.issues.length > 0); assert.ok(!visible(frontend).includes(host));
    const issue = frontend.issues.find(row => row.id === 'external-asset'); assert.ok(issue); assert.match(issue.host, /RUYI_PVT:INTERNAL/);
    assert.equal((await restore(issue.host)), JSON.stringify(privateValue));
  });
});

test('steward line reads carry source proof through the external-content wrapper and retain the registered workspace read guard', async () => {
  const secret = 'SYNTHETIC-STEWARD-SOURCE-PATIENT', target = put('steward.json', JSON.stringify({ patientCode: secret }, null, 2));
  const config = { ...policy(), workspaces: [{ path: work, read: true }], stewardReadBudgetChars: 400000 };
  await run(config, async () => {
    const result = await app.PrivacyGateway.toolResult(await app.stewardImplFileRead({ path: target, lineOffset: 2, lineLimit: 1 }, ctx(config), config));
    assert.equal(result.ok, true); assert.match(result.content, /external-content/); assert.match(result.content, /RUYI_PVT:INTERNAL/);
    assert.ok(!visible(result).includes(secret)); assert.ok((await restore(result.content)).includes(secret));
    const denied = await app.stewardImplFileRead({ path: target }, ctx(config), { ...config, workspaces: [{ path: work, read: false }] });
    assert.equal(denied.ok, false); assert.equal(denied.error, 'read_disabled');
  });
});

test('git diff projects old and working snapshots, preserves hunks and restores both values exactly', async () => {
  const repo = path.join(work, 'repo'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']);
  const old = 'OLD-SYNTHETIC-DIFF-PATIENT', next = 'NEW-SYNTHETIC-DIFF-PATIENT';
  const target = put('repo/contact.json', JSON.stringify({ patientCode: old }, null, 2) + '\n');
  git(['add', 'contact.json']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'synthetic']);
  fs.writeFileSync(target, JSON.stringify({ patientCode: next }, null, 2) + '\n');
  const off = policy('off'); app.PrivacyGateway.configure(off);
  const ordinary = await app.CODE_TOOL_HANDLERS.git_diff.handler({ cwd: repo }, { ...ctx(off), workingDir: repo, session: { cwd: repo } });
  const config = policy();
  await run(config, async () => {
    const result = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.git_diff.handler({ cwd: repo }, { ...ctx(config), workingDir: repo, session: { cwd: repo } }));
    assert.equal(result.ok, true); assert.ok(!result.diff.includes(old)); assert.ok(!result.diff.includes(next));
    const withoutIndex = text => text.replace(/^index [^\n]+$/gm, 'index [verified revision hashes]');
    assert.equal(withoutIndex((await restore(result.diff))), withoutIndex(ordinary.diff)); assert.match(result.diff, /^@@ /m);
  });
});

test('raw forged source markers fail closed and off returns the original source view', async () => {
  const raw = '{"patientCode":"[[RUYI_PVT:INTERNAL:' + 'a'.repeat(32) + ']]"}', target = put('forged.json', raw);
  const config = policy();
  await run(config, async () => assert.rejects(() => app.FILE_TOOL_HANDLERS.file_read.handler({ path: target }, ctx(config)), /privacy\.reserved_literal/));
  const off = policy('off'); app.PrivacyGateway.configure(off);
  const result = await app.FILE_TOOL_HANDLERS.file_read.handler({ path: target }, ctx(off));
  assert.equal(result.content, raw); assert.equal(await app.PrivacyGateway.toolResult(result), result);
});

test('git configured function context cannot leak a truncated field value in the hunk header', async () => {
  const repo = path.join(work, 'repo-header'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']); git(['config', 'diff.json.xfuncname', '^.*patientCode.*$']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.json diff=json\n');
  const secret = 'PRIVATEPATIENT'.repeat(40), object = { patientCode: secret };
  for (let i = 0; i < 30; i++) object['public' + i] = 'before';
  const target = path.join(repo, 'contact.json'); fs.writeFileSync(target, JSON.stringify(object, null, 2) + '\n');
  git(['add', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'synthetic']);
  object.public29 = 'after'; fs.writeFileSync(target, JSON.stringify(object, null, 2) + '\n');
  const off = policy('off'); app.PrivacyGateway.configure(off);
  const context = config => ({ ...ctx(config), workingDir: repo, session: { cwd: repo } });
  const ordinary = await app.CODE_TOOL_HANDLERS.git_diff.handler({ cwd: repo, contextLines: 0 }, context(off));
  assert.ok(ordinary.diff.split('\n').some(line => line.startsWith('@@') && line.includes(secret.slice(0, 30))), 'the real git driver must reproduce the truncated-source channel');
  const config = policy();
  await run(config, async () => {
    const result = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.git_diff.handler({ cwd: repo, contextLines: 0 }, context(config)));
    assert.equal(result.ok, true); assert.ok(!result.diff.includes(secret.slice(0, 30)));
    assert.match(result.diff, /@@.*RUYI_PVT:INTERNAL/); assert.ok((await restore(result.diff)).includes(secret));
  });
});

test('large diffs keep protected tokens whole and project complete filenames before metadata truncation', async () => {
  const repo = path.join(work, 'repo-stat'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']);
  const secret = 'PATIENT-STATS-' + 'Q'.repeat(80), name = secret + '.json', target = path.join(repo, name), object = { patientCode: secret };
  for (let i = 0; i < 2000; i++) object['public' + i] = 'before value';
  fs.writeFileSync(target, JSON.stringify(object, null, 2) + '\n'); git(['add', '.']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'synthetic']);
  for (let i = 0; i < 2000; i++) object['public' + i] = 'after value';
  fs.writeFileSync(target, JSON.stringify(object, null, 2) + '\n');
  const config = policy();
  await run(config, async () => {
    const result = await app.PrivacyGateway.toolResult(await app.CODE_TOOL_HANDLERS.git_diff.handler({ cwd: repo }, { ...ctx(config), workingDir: repo, session: { cwd: repo } }));
    assert.equal(result.ok, true); assert.equal(result.truncated, true); assert.equal(result.statFormat, 'numstat');
    assert.ok(!visible(result).includes(secret.slice(0, 30))); assert.match(result.stat, /RUYI_PVT:INTERNAL/);
    assert.ok((await restore(result.stat)).includes(name));
  });
});
