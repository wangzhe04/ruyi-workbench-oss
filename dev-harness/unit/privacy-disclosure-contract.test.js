'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-disclosure-contract-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'PrivacyLocalDriveProbe', 'PrivacyRecipientHooks', 'toolCall', 'mutateConfig', 'readConfig', 'createSession', 'FileTextIo', 'privacyQueryDrives'], { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const api = app.PrivacyGateway;
let serial = 0;
async function scoped(workFn, mode = 'enhanced') {
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1: mode, privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, defaultWorkspace: work, workspaces: [], recentWorkspaces: [], activeProvider: '', providers: [], permissionMode: 'acceptEdits', desktopMcp: { enabled: false, autodetect: false }, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, externalMcpServers: [], stewardEnabledV1: false, schedulerEnabledV1: false }));
  const config = await app.readConfig(), session = await app.createSession({ cwd: work, title: 'Synthetic disclosure ' + (++serial) });
  session.turnSeq = 1;
  const ctx = { session, sessionId: session.id, turnSeq: 1, config, workingDir: work, mainTurn: true, signal: new AbortController().signal };
  return api.run(session.id, config, () => workFn(ctx));
}
after(() => { app.PrivacyLocalDriveProbe.stopSync(); f.vault.clear(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); });
async function prepare(name, args, ctx) { return api.prepareExecution({ id: 'call-fixture', name, rawArgs: JSON.stringify(args) }, ctx); }

test('authorized native file content restores embedded credentials and writes exact bytes without new permissions', async () => {
  await scoped(async ctx => {
    const source = 'sk-SYNTHETIC-DISCLOSURE-' + 'A'.repeat(30), protectedValue = await api.toolResult({ password: source });
    const call = await prepare('file_write', { path: 'created.txt', content: 'prefix ' + protectedValue.password + '\n中文' }, ctx);
    assert.equal(call.privacyError, undefined);
    const result = await app.toolCall(call.name, api.executionArgs(call), ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(work, 'created.txt'), 'utf8'), 'prefix ' + source + '\n中文');
  });
});


test('three modes deny registered scripts, HTTP, arbitrary MCP and native-name bridge collisions before any drive/path probe', async () => {
  for (const mode of ['basic', 'enhanced', 'strict']) await scoped(async ctx => {
    const alias = api.active().scope.protectValue('synthetic-private-original', 'INTERNAL');
    const original = app.PrivacyRecipientHooks.queryDrives; let probes = 0;
    app.PrivacyRecipientHooks.queryDrives = async () => { probes++; throw Error('unsupported tools must not plan paths'); };
    try {
      for (const name of ['powershell_run', 'script_run', 'http_request', 'fixture__custom', 'constructor', 'toString', '__proto__']) {
        const call = await prepare(name, { content: alias, command: alias, url: alias, recipient: 'local', registered: true }, { ...ctx, isRegisteredTool: () => true });
        assert.equal(call.privacyError.code, 'privacy.disclosure_not_supported'); assert.equal(call.rawArgs.includes('synthetic-private-original'), false);
      }
      const collision = await prepare('file_write', { path: 'collision.txt', content: alias }, { ...ctx, resolveBridge: () => ({ serverId: 'tenant-1', toolName: 'write' }) });
      assert.equal(collision.privacyError.code, 'privacy.disclosure_not_supported');
      const proxy = await prepare('tool_invoke_exec', { name: 'fixture__custom', arguments: { content: alias } }, ctx);
      assert.equal(proxy.privacyError.code, 'privacy.disclosure_not_supported');
      assert.equal(probes, 0); assert.equal(fs.existsSync(path.join(work, 'collision.txt')), false);
    } finally { app.PrivacyRecipientHooks.queryDrives = original; }
  }, mode);
});

test('UNC and mapped Network/Unknown drives are denied before target filesystem calls or full payload restoration', async () => {
  await scoped(async ctx => {
    const payload = api.active().scope.protectValue('synthetic-payload-not-released', 'INTERNAL');
    let probes = 0; const original = app.PrivacyRecipientHooks.queryDrives;
    app.PrivacyRecipientHooks.queryDrives = async roots => { probes++; return new Map(roots.map(root => [root, 'Network'])); };
    try {
      const unc = await prepare('file_write', { path: String.fromCharCode(92).repeat(2) + 'fixture.invalid/share/out.txt', content: payload }, ctx);
      assert.equal(unc.privacyError.code, 'privacy.recipient_denied'); assert.equal(probes, 0);
      if (process.platform === 'win32') {
        const mapped = await prepare('file_write', { path: 'Z:/synthetic-never-touch/out.txt', content: payload }, ctx);
        assert.equal(mapped.privacyError.code, 'privacy.recipient_denied'); assert.equal(probes, 1);
      }
    } finally { app.PrivacyRecipientHooks.queryDrives = original; }
  });
});

test('native file read/write/edit/copy/move/delete and batch operations retain original bytes, aliases and ordinary control fields', async () => {
  await scoped(async ctx => {
    const secret = 'local-file-fixture@example.test', alias = (await api.toolResult({ email: secret })).email;
    const execute = async (name, args) => {
      const call = await prepare(name, args, ctx); assert.equal(call.privacyError, undefined, JSON.stringify(call.privacyError));
      const result = await app.toolCall(name, api.executionArgs(call), ctx); assert.equal(result.ok, true, JSON.stringify(result)); return result;
    };
    await execute('file_write', { path: 'local-a.txt', content: alias + '\n中文', lineEnding: 'preserve' });
    await execute('file_edit', { path: 'local-a.txt', oldText: alias, newText: 'edited ' + alias });
    await execute('file_copy', { from: 'local-a.txt', to: 'local-b.txt', overwrite: true });
    await execute('file_move', { from: 'local-b.txt', to: 'local-c.txt', overwrite: true });
    assert.equal(fs.readFileSync(path.join(work, 'local-c.txt'), 'utf8'), 'edited ' + secret + '\n中文');
    const pathAlias = api.active().scope.protectValue('local-c.txt', 'INTERNAL');
    const read = await execute('file_read', { path: pathAlias }); assert.equal(read.ok, true);
    await execute('file_copy', { items: [{ from: 'local-a.txt', to: 'batch-a.txt' }, { from: pathAlias, to: 'batch-b.txt' }], overwrite: true });
    assert.equal(fs.readFileSync(path.join(work, 'batch-a.txt'), 'utf8'), fs.readFileSync(path.join(work, 'batch-b.txt'), 'utf8'));
    const a = api.active().scope.protectValue('batch-a.txt', 'INTERNAL'), b = api.active().scope.protectValue('batch-b.txt', 'INTERNAL');
    await execute('file_delete', { paths: [a, b] }); assert.equal(fs.existsSync(path.join(work, 'batch-a.txt')), false); assert.equal(fs.existsSync(path.join(work, 'batch-b.txt')), false);
  });
});

test('field authorization rejects control slots, retains payload collision checks and does not treat tool registration as a capability', async () => {
  await scoped(async ctx => {
    const alias = api.active().scope.protectValue('sensitive-field-value', 'INTERNAL');
    const bad = await prepare('file_write', { path: 'bad-control.txt', content: 'public', encoding: alias }, ctx);
    assert.equal(bad.privacyError.code, 'privacy.disclosure_not_supported');
    const collision = await prepare('file_write', { path: 'bad-key.txt', content: { [alias]: 1, 'sensitive-field-value': 2 } }, ctx);
    assert.equal(collision.privacyError.code, 'privacy.key_collision');
    const unknown = '[[RUYI_PVT:INTERNAL:' + 'f'.repeat(32) + ']]';
    assert.equal((await prepare('file_write', { path: 'unknown.txt', content: unknown }, ctx)).privacyError.code, 'privacy.reference_unknown');
    assert.equal(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: alias }) }, { isRegisteredTool: () => true }).privacyError.code, 'privacy.disclosure_requires_planning');
  });
});

test('scope, policy, live authorization config, bridge route, adapter and cancellation changes block the final dispatch', async () => {
  for (const change of ['policy', 'config', 'bridge', 'adapter', 'cancel']) await scoped(async ctx => {
    const alias = api.active().scope.protectValue('late-' + change + '@example.test', 'EMAIL');
    let route = null; const ctrl = new AbortController(); ctx.signal = ctrl.signal; ctx.resolveBridge = () => route;
    const call = await prepare('file_write', { path: 'late-' + change + '.txt', content: alias }, ctx); assert.equal(call.privacyError, undefined);
    if (change === 'policy') api.configure({ ...ctx.config, privacyTechnicalV1: true });
    if (change === 'config') await app.mutateConfig(config => { config.allowOutsideWorkspace = !config.allowOutsideWorkspace; });
    if (change === 'bridge') route = { serverId: 'changed-tenant', toolName: 'file_write' };
    if (change === 'cancel') ctrl.abort();
    const restore = change === 'adapter' ? app.__eval('planPrivacyToolDisclosure') : null;
    if (change === 'adapter') api.setHost({ planDisclosure: async () => { throw Error('must not use a replacement adapter'); } });
    try { await assert.rejects(api.revalidateExecution('file_write', api.executionArgs(call), ctx), error => /^privacy\./.test(error.code)); }
    finally { if (restore) api.setHost({ planDisclosure: restore }); }
    assert.equal(fs.existsSync(path.join(work, 'late-' + change + '.txt')), false);
  });
});

test('permission edits replan changed local destinations and cannot launder new secrets into a previously reference-free script', async () => {
  await scoped(async ctx => {
    const alias = api.active().scope.protectValue('edited-private@example.test', 'EMAIL');
    const call = await prepare('file_write', { path: 'edited-original.txt', content: alias }, ctx);
    const edited = api.updateExecutionInput(api.executionArgs(call), { path: 'edited-local.txt', content: 'edited-private@example.test' }, 'file_write', ctx);
    const checked = await api.revalidateExecution('file_write', edited, ctx);
    assert.equal((await app.toolCall('file_write', checked, ctx)).ok, true);
    assert.equal(fs.existsSync(path.join(work, 'edited-original.txt')), false); assert.equal(fs.readFileSync(path.join(work, 'edited-local.txt'), 'utf8'), 'edited-private@example.test');
    const changed = api.updateExecutionInput({ command: 'public' }, { command: 'Write-Output "new-private@example.test"' }, 'powershell_run', ctx);
    await assert.rejects(api.revalidateExecution('powershell_run', changed, ctx), error => error.code === 'privacy.disclosure_not_supported');
  });
});

test('current-session text adapters preserve private todo/title/question text, deny control IDs and retain binding across proxy normalization', async () => {
  await scoped(async ctx => {
    const alias = api.active().scope.protectValue('session-private@example.test', 'EMAIL');
    for (const [name, args] of [['todo_write', { items: [alias, { text: alias, status: 'pending' }] }], ['thread_title_update', { title: alias, gist: 'note ' + alias }], ['scratchpad_write', { op: 'set', key: 'fixture', content: alias }], ['request_user_input', { questions: [{ id: 'choice', header: 'Contact', question: alias, options: [{ label: alias, description: alias }] }] }]]) {
      const call = await prepare(name, args, ctx); assert.equal(call.privacyError, undefined, name + JSON.stringify(call.privacyError));
      assert.equal(JSON.stringify(api.executionArgs(call)).includes('session-private@example.test'), true);
      await api.revalidateExecution(name, api.executionArgs(call), ctx);
    }
    const bad = await prepare('todo_write', { items: [{ id: alias, text: 'public' }] }, ctx); assert.equal(bad.privacyError.code, 'privacy.disclosure_not_supported');
    const proxy = await prepare('tool_invoke_edit', { name: 'todo_write', arguments: { items: [{ text: alias }] } }, ctx);
    const unwrapped = app.__eval('unwrapProxiedControlCall')(proxy), args = api.executionArgs(unwrapped);
    assert.equal(args.items[0].text, 'session-private@example.test');
    await assert.rejects(api.revalidateExecution('todo_write', args, { ...ctx, session: { ...ctx.session, id: 'sess_other' } }), error => error.code === 'privacy.recipient_changed');
  });
});

test('OFF keeps identity and never parses getters, invokes adapters or starts DriveType probing', async () => {
  await scoped(async ctx => {
    const call = { name: 'unknown', get rawArgs() { throw Error('OFF parsed arguments'); } };
    assert.equal(api.prepareCall(call), call); assert.equal(await api.prepareExecution(call, ctx), call);
    const args = {}; Object.defineProperty(args, 'value', { get() { throw Error('OFF scanned arguments'); } });
    assert.equal(await api.revalidateExecution('unknown', args, ctx), args);
  }, 'off');
});


test('last synchronous dispatch assertion refuses a revoked alias queued after async session revalidation', async () => {
  await scoped(async ctx => {
    const alias = api.active().scope.protectValue('revoked-session@example.test', 'EMAIL');
    const call = await prepare('todo_write', { items: [{ text: alias }] }, ctx); assert.equal(call.privacyError, undefined);
    let commits = 0;
    const pending = api.revalidateExecution('todo_write', api.executionArgs(call), ctx).then(args => {
      queueMicrotask(() => api.active().scope.revoke(alias)); return args;
    });
    const args = await pending;
    assert.throws(() => { api.assertExecution('todo_write', args, ctx); commits++; }, error => error.code === 'privacy.reference_unknown');
    assert.equal(commits, 0);
  });
});

test('policy change during checkpoint persistence prevents atomic temp/fallback writes and retains the original target', async () => {
  await scoped(async ctx => {
    const target = path.join(work, 'checkpoint-race.txt'); fs.writeFileSync(target, 'ORIGINAL');
    const alias = api.active().scope.protectValue('checkpoint-private@example.test', 'EMAIL');
    const call = await prepare('file_write', { path: target, content: alias }, ctx); assert.equal(call.privacyError, undefined);
    const control = app.__eval(`(() => { const original = journalRecord; const control = { after: null, restore: () => { journalRecord = original; } }; journalRecord = async (...args) => { const result = await original(...args); control.after?.(); return result; }; return control; })()`);
    control.after = () => api.configure({ ...ctx.config, privacyTechnicalV1: true });
    try { await assert.rejects(app.toolCall('file_write', api.executionArgs(call), ctx), error => error.code === 'privacy.policy_changed'); }
    finally { control.restore(); }
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
    assert.equal(fs.readdirSync(work).some(name => name.startsWith('.checkpoint-race.txt.') && name.endsWith('.tmp')), false);
  });
});

test('local junction paths remain usable, while a junction redirected to UNC is rejected before probing its target', async t => {
  await scoped(async ctx => {
    const dest = path.join(work, 'junction-local'), link = path.join(work, 'junction-link'); fs.mkdirSync(dest);
    try { fs.symlinkSync(dest, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('local symlink creation unavailable'); return; } throw error; }
    const alias = api.active().scope.protectValue('junction-private@example.test', 'EMAIL');
    const call = await prepare('file_write', { path: path.join(link, 'target.txt'), content: alias }, ctx); assert.equal(call.privacyError, undefined, JSON.stringify(call.privacyError));
    assert.equal((await app.toolCall('file_write', api.executionArgs(call), ctx)).ok, true);
    assert.equal(fs.readFileSync(path.join(dest, 'target.txt'), 'utf8'), 'junction-private@example.test');
    if (process.platform !== 'win32') return;
    const fresh = await prepare('file_write', { path: path.join(link, 'negative.txt'), content: alias }, ctx); assert.equal(fresh.privacyError, undefined);
    const originalRead = fs.promises.readlink, originalStat = fs.promises.lstat; let remoteStats = 0;
    fs.promises.readlink = async (...args) => path.resolve(String(args[0])) === path.resolve(link)
      ? String.fromCharCode(92).repeat(2) + 'fixture.invalid/share/private' : originalRead(...args);
    fs.promises.lstat = async (...args) => { if (String(args[0]).startsWith(String.fromCharCode(92).repeat(2))) { remoteStats++; throw Error('remote target must never be probed'); } return originalStat(...args); };
    try { await assert.rejects(app.toolCall('file_write', api.executionArgs(fresh), ctx), error => error.code === 'privacy.recipient_denied'); assert.equal(remoteStats, 0); }
    finally { fs.promises.readlink = originalRead; fs.promises.lstat = originalStat; }
    assert.equal(fs.existsSync(path.join(dest, 'negative.txt')), false);
  });
});


test('atomic rename authorization failure cleans the owned plaintext temp and never falls back to in-place writing', async () => {
  const target = path.join(work, 'atomic-owned-temp.txt'); fs.writeFileSync(target, 'ORIGINAL');
  const failure = Object.assign(new Error('synthetic final authorization changed'), { code: 'privacy.policy_changed' });
  let writes = 0;
  await assert.rejects(app.FileTextIo.writeFileAtomic(target, Buffer.from('PRIVATE-NEW-BYTES'), {
    io: async (paths, write, operation) => { if (Array.isArray(paths)) throw failure; if (write) writes++; return operation(); },
  }), error => error === failure);
  assert.equal(writes, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.equal(fs.readdirSync(work).some(name => name.startsWith('.atomic-owned-temp.txt.') && name.endsWith('.tmp')), false);
});

test('canonical junction roots with a private search pattern still traverse real local files and produce source-proven results', async t => {
  await scoped(async ctx => {
    const dest = path.join(work, 'search-canonical'), link = path.join(work, 'search-junction'); fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'contact.txt'), 'search-junction@example.test');
    try { fs.symlinkSync(dest, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('local symlink creation unavailable'); return; } throw error; }
    const alias = api.active().scope.protectValue('search-junction@example.test', 'EMAIL');
    const prepared = await prepare('file_search', { root: link, pattern: alias }, ctx); assert.equal(prepared.privacyError, undefined);
    const result = await app.toolCall('file_search', api.executionArgs(prepared), ctx);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.matches.length > 0, 'privacy refusal must not be swallowed as an empty successful search');
    assert.equal(JSON.stringify(result).includes('search-junction@example.test'), false);
  });
});

test('case-only move revocation rolls its owned intermediate name back instead of losing the source', { skip: process.platform !== 'win32' }, async () => {
  await scoped(async ctx => {
    const from = path.join(work, 'CaseOriginal.TXT'), to = path.join(work, 'caseoriginal.txt'); fs.writeFileSync(from, 'MOVE-ORIGINAL');
    const alias = api.active().scope.protectValue(from, 'INTERNAL');
    const prepared = await prepare('file_move', { from: alias, to, overwrite: true }, ctx); assert.equal(prepared.privacyError, undefined);
    const original = fs.promises.rename; let renamedToIntermediate = 0;
    fs.promises.rename = async (...args) => {
      const result = await original(...args);
      if (path.resolve(String(args[0])) === path.resolve(from) && String(args[1]).endsWith('.rn')) { renamedToIntermediate++; api.configure({ ...ctx.config, privacyTechnicalV1: true }); }
      return result;
    };
    try { const result = await app.toolCall('file_move', api.executionArgs(prepared), ctx); assert.equal(result.ok, false); }
    finally { fs.promises.rename = original; }
    assert.equal(renamedToIntermediate, 1); assert.equal(fs.readFileSync(from, 'utf8'), 'MOVE-ORIGINAL');
    assert.equal(fs.readdirSync(work).some(name => name.startsWith('.CaseOriginal.TXT.') && name.endsWith('.rn')), false);
  });
});


test('nine parallel protected preparations and nine workspace roots stay within host drive admission', async () => {
  await scoped(async ctx => {
    const roots = Array.from({ length: 9 }, (_, index) => path.join(root, 'parallel-root-' + index));
    roots.forEach(directory => fs.mkdirSync(directory, { recursive: true }));
    await app.mutateConfig(config => { config.workspaces = roots.map(directory => ({ path: directory })); return {}; });
    ctx.config = await app.readConfig();
    const calls = await Promise.all(roots.map(async (directory, index) => {
      const file = path.join(directory, 'read-' + index + '.txt'); fs.writeFileSync(file, 'parallel-' + index);
      return prepare('file_read', { path: api.active().scope.protectValue(file, 'INTERNAL') }, ctx);
    }));
    for (const [index, call] of calls.entries()) {
      assert.equal(call.privacyError, undefined, JSON.stringify(call.privacyError));
      const result = await app.toolCall(call.name, api.executionArgs(call), ctx);
      assert.equal(result.content, 'parallel-' + index);
    }
    const unc = String.fromCharCode(92).repeat(2) + 'fixture.invalid/share';
    await app.mutateConfig(config => { config.allowOutsideWorkspace = true; config.workspaces.push({ path: unc }); return {}; });
    ctx.config = await app.readConfig();
    const originalRealpath = fs.promises.realpath; let unrelatedProbes = 0;
    fs.promises.realpath = async (...args) => {
      if (String(args[0]).startsWith(String.fromCharCode(92).repeat(2))) { unrelatedProbes++; throw Error('unrelated network root must not be probed for logging'); }
      return originalRealpath(...args);
    };
    try {
      const secret = 'SYNTHETIC_LOCAL_WIDE_WRITE';
      const call = await prepare('file_write', { path: path.join(work, 'wide-local.txt'), content: api.active().scope.protectValue(secret, 'INTERNAL') }, ctx);
      assert.equal(call.privacyError, undefined, JSON.stringify(call.privacyError));
      const result = await app.toolCall(call.name, api.executionArgs(call), ctx);
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(unrelatedProbes, 0);
      assert.equal(fs.readFileSync(path.join(work, 'wide-local.txt'), 'utf8'), secret);
    } finally { fs.promises.realpath = originalRealpath; }
  });
});

test('queued drive admission cancellation never dispatches that request and limits concurrent host queries', async () => {
  const original = app.PrivacyRecipientHooks.queryDrives, releases = [];
  let active = 0, peak = 0, sent = 0;
  app.PrivacyRecipientHooks.queryDrives = async roots => {
    sent++; peak = Math.max(peak, ++active);
    await new Promise(resolve => releases.push(resolve)); active--;
    return new Map(roots.map(root => [root, 'Fixed']));
  };
  try {
    const first = Array.from({ length: 4 }, () => app.privacyQueryDrives(['C:\\']));
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const queued = app.privacyQueryDrives(['D:\\'], controller.signal);
    controller.abort();
    await assert.rejects(queued, error => error.code === 'privacy.drive_probe_cancelled');
    releases.forEach(resolve => resolve()); await Promise.all(first);
    assert.equal(sent, 4); assert.equal(peak, 4);
  } finally { app.PrivacyRecipientHooks.queryDrives = original; }
});
