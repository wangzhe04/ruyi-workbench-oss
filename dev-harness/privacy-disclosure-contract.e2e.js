'use strict';
// Actual native main/child engine, loopback model transport and user-file side effects.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-disclosure-e2e-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'PrivacyLocalDriveProbe', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'loadSession', 'mutateConfig', 'readConfig'], { withEval: true });
const fixture = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
const control = app.__eval(`(() => { const state = { executions: [] }; detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {}; const execute = toolCall; toolCall = async (name, args, context) => { state.executions.push(name); return execute(name, args, context); }; return state; })()`);
const t = createRunner('PRIVACY DISCLOSURE CONTRACT');
let active = null;
async function check(label, task) { try { await task(); t.ok(true, label); } catch (error) { t.ok(false, label + ': ' + error.stack); } }
(async () => {
  let fake;
  try {
    fake = await startFakeProvider({ handler(ctx) {
      assert.ok(active, 'fixture sequence active'); active.wire.push(ctx.raw);
      assert.equal(ctx.raw.includes(active.secret), false, 'original never reaches the actual model receiver');
      const results = ctx.messages.filter(row => row.role === 'tool');
      const previous = results.at(-1), value = previous ? JSON.parse(previous.content) : null;
      if (previous) {
        assert.equal(results.filter(row => row.tool_call_id === previous.tool_call_id).length, 1);
        if (active.last === 'file_read') {
          active.alias = value.content.match(/\[\[RUYI_PVT:CREDENTIAL:[a-f0-9]{32}\]\]/)?.[0]; assert.ok(active.alias, 'read source issued an opaque credential');
        }
        if (['file_write', 'file_edit'].includes(active.last)) { assert.equal(value.ok, true); active.pathAlias = value.path; }
        if (active.last === 'file_copy') { assert.equal(value.ok, true); active.copyAlias = value.to; }
        if (active.last === 'file_move') assert.equal(value.ok, true);
        if (active.last === 'powershell_run') { assert.equal(value.ok, false); assert.equal(value.code, 'privacy.disclosure_not_supported'); active.refused = true; }
      }
      const next = active.steps.shift();
      if (!next) return textFrames('The local operation finished; the unsupported script was refused without execution.');
      const args = next[1](); active.last = next[0];
      return toolCallFrames(next[0], args, 'call-' + active.prefix + '-' + active.index++);
    } });
    for (const mode of ['basic', 'enhanced', 'strict']) for (const child of [false, true]) {
      await check(mode + ' ' + (child ? 'child' : 'main') + ' restores only bound local file/session fields and never dispatches a registered script reference', async () => {
        const prefix = mode + (child ? '-child' : '-main');
        const source = path.join(work, prefix + '-source.json'), target = path.join(work, prefix + '-target.txt'), copy = path.join(work, prefix + '-copy.txt'), moved = path.join(work, prefix + '-moved.txt');
        const secret = 'SYNTHETIC-LOCAL-CREDENTIAL-' + prefix + '-' + 'A'.repeat(24); fs.writeFileSync(source, JSON.stringify({ password: secret }));
        await app.mutateConfig(config => Object.assign(config, { activeProvider: 'disclosure-fixture', providers: [{ id: 'disclosure-fixture', type: 'openai-compat', apiStyle: 'chat', model: 'synthetic-model', baseUrl: fake.url + '/v1', apiKey: 'SYNTHETIC-ENDPOINT-KEY' }],
          privacyModeV1: mode, privacyTechnicalV1: true, privacyRulesV1: [], credentialEncryptionV1: true, defaultWorkspace: work, permissionMode: 'bypass', toolLoadingMode: 'full',
          importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, bridgeExternalToolsToProvider: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false },
          stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
          allowCommandTools: true, allowDesktopTools: false, openaiMaxToolIterations: 12 }));
        const session = await app.createSession({ cwd: work, title: 'Synthetic disclosure ' + prefix }), config = await app.readConfig();
        active = { prefix, secret, alias: '', index: 0, wire: [], steps: [], refused: false };
        active.steps.push(['file_read', () => ({ path: source })]);
        if (!child) active.steps.push(['todo_write', () => ({ items: [{ text: 'Local note ' + active.alias, status: 'pending' }] })]);
        active.steps.push(['file_write', () => ({ path: target, content: 'copied ' + active.alias, lineEnding: 'preserve' })],
          ['file_edit', () => ({ path: active.pathAlias, oldText: 'copied ' + active.alias, newText: 'edited ' + active.alias })],
          ['file_copy', () => ({ from: active.pathAlias, to: copy, overwrite: true })],
          ['file_move', () => ({ from: active.copyAlias, to: moved, overwrite: true })],
          ['powershell_run', () => ({ command: 'Write-Output "' + active.alias + '"' })]);
        const before = control.executions.length;
        if (child) {
          const result = await app.runSubAgentCore({ parentSession: session, provider: config.providers[0], config, task: 'Perform the synthetic local file sequence once, refuse unsupported disclosure, then finish.', agentKey: 'fixture', toolTier: 'exec', maxIters: 12, model: 'synthetic-model', onEvent() {}, subagentId: prefix, depth: 1, ctrl: new AbortController(), permModeOverride: 'bypass' });
          assert.equal(result.ok, true, JSON.stringify(result));
        } else {
          const events = []; await app.runSessionTurn({ sessionId: session.id, message: 'Perform the synthetic local file sequence once, refuse unsupported disclosure, then finish.', onEvent: event => events.push(event) });
          assert.equal(events.findLast(event => event.type === 'result')?.ok, true); assert.equal(events.some(event => event.type === 'error'), false);
          assert.equal((await app.loadSession(session.id)).todos[0].text, 'Local note ' + secret);
        }
        assert.equal(active.steps.length, 0); assert.equal(active.refused, true);
        assert.equal(fs.readFileSync(target, 'utf8'), 'edited ' + secret); assert.equal(fs.readFileSync(moved, 'utf8'), 'edited ' + secret); assert.equal(fs.existsSync(copy), false);
        const executed = control.executions.slice(before);
        for (const name of ['file_read', 'file_write', 'file_edit', 'file_copy', 'file_move']) assert.equal(executed.filter(row => row === name).length, 1, name + ' executed once');
        assert.equal(executed.includes('powershell_run'), false); assert.equal(active.wire.length, child ? 7 : 8);
      });
    }
    assert.equal(fake.errors.length, 0);
  } finally { if (fake) await fake.close(); app.PrivacyLocalDriveProbe.stopSync(); fixture.vault.clear(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); }
  t.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
