'use strict';
// Real file_read handler and gateway, with synthetic files and an in-memory vault protector.
// No HTTP listener, model request, browser, CLI or DPAPI subprocess is started.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-privacy-file-read-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ privacyModeV1: 'off', credentialEncryptionV1: true, providers: [], defaultWorkspace: work, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, schedulerEnabledV1: false }));
const app = require('../lib/server-internals').loadServerInternals(['FILE_TOOL_HANDLERS', 'PrivacyGateway', 'PrivacyCore', 'execResultCacheBySession', 'mutateConfig', 'readConfig', 'toolCall', 'PrivacyLocalDriveProbe']);
const { fixture } = require('../lib/privacy-test-fixture');
const vault = fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = vault.openLocal;
for (const key of ['hydrateConfig', 'protectConfig', 'protectBackup', 'protectCorrupt', 'migrateBackups', 'stateStamp']) app.PrivacyCore.configHooks[key] = vault[key];
let serial = 0;
const config = (mode = 'enhanced', rules = []) => ({ credentialEncryptionV1: true, privacyPolicyRecoveryRequiredV1: false, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, schedulerEnabledV1: false, privacyModeV1: mode, privacyRulesV1: rules, privacyTechnicalV1: false,
  providers: [], defaultWorkspace: work, runtimeExecResultCacheV1: true, execResultCacheMaxEntriesV1: 20 });
const context = policy => ({ config: policy, workingDir: work, sessionId: 'sess_privacy_file_read', session: { cwd: work } });
const file = (name, content) => { const target = path.join(work, name); fs.writeFileSync(target, content); return target; };
const rawRead = (target, args, policy) => app.FILE_TOOL_HANDLERS.file_read.handler({ path: target, ...args }, context(policy));
async function scoped(policy, fn) {
  await app.mutateConfig(current => Object.assign(current, policy));
  Object.assign(policy, await app.readConfig());
  app.PrivacyGateway.configure(policy);
  return app.PrivacyGateway.run('file-read-test-' + (++serial), policy, fn);
}
function refused(value, originals = []) {
  assert.equal(value.ok, false);
  assert.equal(value.code, 'privacy.file_read_view_unsupported');
  assert.equal(typeof value.hint, 'string');
  assert.match(value.hint, /complete character read/i);
  assert.equal('content' in value, false); assert.equal('path' in value, false); assert.equal('non_ascii' in value, false);
  for (const secret of originals) assert.equal(JSON.stringify(value).includes(secret), false);
}
after(() => {
  app.PrivacyLocalDriveProbe.stopSync(); app.execResultCacheBySession.clear(); vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-privacy-file-read-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});

test('all privacy modes project line offset annotated and truncated views before presentation', async () => {
  const secret = 'SYNTHETIC-PRIVATE-FIELD-' + 'X'.repeat(90), original = JSON.stringify({ patientCode: secret, diagnosis: 'synthetic confidential diagnosis' }, null, 2);
  const target = file('partial.json', original);
  for (const mode of ['basic', 'enhanced', 'strict']) {
    const policy = config(mode, [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
    await scoped(policy, async () => {
      for (const args of [{ lineOffset: 2, lineLimit: 1 }, { offset: original.indexOf(secret) + 10, limit: 12 }, { annotate_non_ascii: true }, { limit: 12 }]) {
        const result = await app.PrivacyGateway.toolResult(await rawRead(target, args, policy));
        assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes(secret.slice(0, 30)), false);
        if (args.offset) { assert.match(result.content, /RUYI_PVT:INTERNAL/); assert.ok(result.offset <= original.indexOf(secret)); assert.ok(result.nextOffset >= original.indexOf(secret) + secret.length); }
      }
    });
  }
});

test('a default read safely paginates and an expanded sensitive span remains whole', async () => {
  const secret = 'SYNTHETIC-AFTER-WINDOW', target = file('large.json', JSON.stringify({ padding: 'x'.repeat(51000), patientCode: secret }));
  const policy = config('basic', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  await scoped(policy, async () => {
    const first = await app.PrivacyGateway.toolResult(await rawRead(target, {}, policy));
    assert.equal(first.ok, true); assert.equal(first.truncated, true); assert.ok(first.nextOffset > 0);
    const next = await app.PrivacyGateway.toolResult(await rawRead(target, { offset: first.nextOffset, limit: 50000 }, policy));
    assert.equal(next.ok, true); assert.match(next.content, /RUYI_PVT:INTERNAL/); assert.ok(!JSON.stringify(next).includes(secret));
  });
});

test('supported views retain ordinary missing-file and file guards and empty reads', async () => {
  const policy = config('enhanced');
  await scoped(policy, async () => {
    const missing = await rawRead(path.join(work, 'missing-private.json'), { lineOffset: 1 }, policy);
    assert.equal(missing.ok, false); assert.notEqual(missing.code, 'privacy.file_read_view_unsupported');
    const denied = await rawRead(path.join(data, 'config.json'), { offset: 1 }, policy); assert.equal(denied.ok, false);
    const empty = file('empty.txt', ''), value = await rawRead(empty, { offset: 0 }, policy);
    assert.equal(value.ok, true); assert.equal(value.content, ''); assert.equal(value.truncated, false);
  });
});

test('complete JSON reads retain lexical source for field protection and suppress non-ASCII source copies', async () => {
  const secret = 'C\u00a0PAT', original = '{\n  "n":900719925474099312345, "dup":1,"dup":2, "patientCode":' + JSON.stringify(secret) + '\n}\n';
  const target = file('full.json', original);
  const policy = config('enhanced', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  await scoped(policy, async () => {
    const raw = await rawRead(target, { offset: 0, limit: 50000 }, policy);
    assert.equal(raw.ok, true); assert.notEqual(raw.content, original); assert.equal(raw.content.includes(secret), false); assert.equal('non_ascii' in raw, false);
    for (const args of [{ offset: -1 }, { offset: NaN }, { annotate_non_ascii: false }]) {
      const allowed = await rawRead(target, args, policy);
      assert.equal(allowed.ok, true); assert.equal(allowed.content.includes(secret), false); assert.equal('non_ascii' in allowed, false);
    }
    const result = await app.PrivacyGateway.toolResult(raw);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(result.content, /\[\[RUYI_PVT:INTERNAL:/);
    const call = await app.PrivacyGateway.prepareExecution({ name: 'file_edit', rawArgs: JSON.stringify({ path: target, oldText: result.content, newText: '{}' }) }, context(policy));
    assert.equal(call.privacyError, undefined); assert.equal(JSON.parse(call.rawArgs).oldText, original);
  });
});

test('builtin personal fields also protect complete reads without leaking non-ASCII diagnostic contexts', async () => {
  const secret = 'D\u00a0PRIVATE', target = file('diagnosis.json', JSON.stringify({ diagnosis: secret }));
  const policy = config('enhanced');
  await scoped(policy, async () => {
    const raw = await rawRead(target, {}, policy);
    assert.equal(raw.ok, true); assert.equal('non_ascii' in raw, false);
    const result = await app.PrivacyGateway.toolResult(raw);
    assert.equal(JSON.stringify(result).includes(secret), false); assert.match(result.content, /\[\[RUYI_PVT:/);
  });
});

test('an actual read-write-read verification loop keeps a learned field private after it becomes unlabelled prose', async () => {
  const secret = 'CUSTOM-PATIENT-READ-WRITE-READ', source = file('source-contact.json', JSON.stringify({ patientCode: secret }));
  const destination = path.join(work, 'verified-contact.txt');
  const policy = config('enhanced', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  await scoped(policy, async () => {
    const protectedSource = await app.PrivacyGateway.toolResult(await rawRead(source, {}, policy));
    const reference = JSON.parse(protectedSource.content).patientCode;
    const prepared = await app.PrivacyGateway.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: destination, content: reference + '\n' }) }, context(policy));
    assert.equal(prepared.privacyError, undefined);
    const write = await app.toolCall('file_write', app.PrivacyGateway.executionArgs(prepared), { ...context(policy), turnSeq: 2 });
    assert.equal(write.ok, true); assert.equal(fs.readFileSync(destination, 'utf8'), secret + '\n');
    const verified = await app.PrivacyGateway.toolResult(await rawRead(destination, {}, policy));
    assert.equal(verified.content, reference + '\n'); assert.equal(JSON.stringify(verified).includes(secret), false);
  });
});

test('cache entries created with privacy off cannot bypass the protected view gate or revive source diagnostics', async () => {
  const secret = 'C\u00a0PAT', target = file('cached.json', JSON.stringify({ patientCode: secret }));
  const off = config('off'); app.PrivacyGateway.configure(off);
  const views = [{}, { lineOffset: 1 }, { offset: 2 }, { limit: 10 }, { annotate_non_ascii: true }];
  for (const args of views) {
    const first = await rawRead(target, args, off), cached = await rawRead(target, args, off);
    assert.equal(first.ok, true); assert.ok(cached.cacheHit, 'the real production cache must be warm');
    if (args.limit === undefined) assert.ok(first.non_ascii?.samples.length > 0, 'off mode still reports suspicious source characters');
  }
  assert.ok(app.execResultCacheBySession.size > 0);
  const policy = config('enhanced', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  await scoped(policy, async () => {
    for (const args of views.slice(1)) { const view = await app.PrivacyGateway.toolResult(await rawRead(target, args, policy)); assert.equal(view.ok, true); assert.equal(JSON.stringify(view).includes(secret), false); assert.equal('cacheHit' in view, false); }
    const raw = await rawRead(target, {}, policy);
    assert.equal(raw.ok, true); assert.equal('non_ascii' in raw, false); assert.equal('cacheHit' in raw, false);
    const protectedResult = await app.PrivacyGateway.toolResult(raw);
    assert.equal(JSON.stringify(protectedResult).includes(secret), false);
  });
  app.PrivacyGateway.configure(off);
  const unchanged = await rawRead(target, {}, off);
  assert.ok(unchanged.cacheHit && unchanged.non_ascii, 'off mode retains its ordinary cached view');
});

test('privacy refuses linked image warnings that would copy a structured field value into metadata', async () => {
  const secret = 'SYNTHETIC-FIELD-ONLY', original = JSON.stringify({ patientCode: '![x](' + secret + ')' });
  const target = file('contact.md', original), off = config('off'); app.PrivacyGateway.configure(off);
  const ordinary = await rawRead(target, { includeImages: true }, off);
  assert.equal(ordinary.ok, true);
  assert.ok(ordinary.imageWarnings.some(row => row.source === secret), 'the real off-mode image warning reproduces the source-copy channel');
  const policy = config('enhanced', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  await scoped(policy, async () => { const result = await app.PrivacyGateway.toolResult(await rawRead(target, { includeImages: true }, policy)); assert.equal(result.ok, true); assert.equal('imageWarnings' in result, false); assert.equal(JSON.stringify(result).includes(secret), false); });
});

test('privacy refuses document extraction and images before any external parser, including text-only requests', async () => {
  const cp = require('node:child_process'), originalExec = cp.execFile;
  let parserCalls = 0;
  cp.execFile = (_exe, _args, _options, callback) => {
    parserCalls++;
    queueMicrotask(() => callback(null, '{"ok":true,"content":"SYNTHETIC-DOCUMENT-SOURCE"}'));
  };
  try {
    const sources = ['private.docx', 'private.pdf', 'private.png'].map(name => file(name, 'SYNTHETIC-DOCUMENT-SOURCE'));
    const renamed = path.join(work, 'renamed.dat');
    fs.writeFileSync(renamed, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    sources.push(renamed);
    for (const mode of ['basic', 'enhanced', 'strict']) {
      const policy = config(mode);
      await scoped(policy, async () => {
        for (const target of sources) for (const args of [{}, { as: 'text' }, { includeImages: false }, { as: 'text', includeImages: false }]) {
          const result = await rawRead(target, args, policy);
          assert.deepEqual(result, { ok: false, code: 'privacy.media_not_supported' });
          assert.equal(JSON.stringify(result).includes(target), false);
        }
      });
    }
    assert.equal(parserCalls, 0, 'no Python/document parser is invoked by text-only or ordinary media reads');
  } finally { cp.execFile = originalExec; }
});

test('privacy edit misses project source diagnostics while exact edits and off-mode diagnostics remain available', async () => {
  const secret = 'SYNTHETIC-PATIENT-CONTENT', original = JSON.stringify({ patientCode: secret }, null, 2);
  const target = file('edit-miss.json', original), off = config('off'); app.PrivacyGateway.configure(off);
  const args = { path: target, oldText: 'patientCode missing anchor', newText: 'replacement' };
  const ordinary = await app.FILE_TOOL_HANDLERS.file_edit.handler(args, context(off));
  assert.equal(ordinary.ok, false); assert.ok(JSON.stringify(ordinary).includes(secret), 'off-mode miss diagnostics reproduce the source-copy channel');
  for (const mode of ['basic', 'enhanced', 'strict']) {
    const policy = config(mode, [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
    await scoped(policy, async () => {
      const result = await app.FILE_TOOL_HANDLERS.file_edit.handler(args, context(policy));
      assert.equal(result.ok, false); assert.equal(result.code, 'not_found');
      assert.ok(result.closest); await app.PrivacyGateway.toolResult(result);
      assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(fs.readFileSync(target, 'utf8'), original);
    });
  }
  const policy = config('enhanced');
  await scoped(policy, async () => {
    const edited = await app.FILE_TOOL_HANDLERS.file_edit.handler({ path: target, oldText: original, newText: '{}' }, { ...context(policy), turnSeq: 1 });
    assert.equal(edited.ok, true); assert.equal(edited.replacements, 1); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  });
});
