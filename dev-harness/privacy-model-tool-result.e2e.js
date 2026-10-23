'use strict';
// Real main/child engine, real tools and real HTTP bytes; only the model and local vault protector are synthetic.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { createRunner } = require('./lib/harness');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-model-tool-result-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'loadSession', 'readConfig', 'mutateConfig'], { withEval: true });
const f = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const state = app.__eval(`(() => {
  const state = { executions: [] };
  detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {};
  const executeTool = toolCall;
  toolCall = async function(name, args, context) { state.executions.push({ name, args: structuredClone(args) }); return executeTool(name, args, context); };
  return state;
})()`);
const t = createRunner('PRIVACY MODEL TOOL RESULT');
let step = null;
async function check(label, work) { try { await work(); t.ok(true, label); } catch (error) { t.ok(false, label + ': ' + error.stack); } }
(async () => {
  let fake;
  try {
    fake = await startFakeProvider({ handler(ctx) {
      assert.ok(step, 'fake sequence is active');
      step.requests.push({ raw: ctx.raw, body: ctx.body });
      if (step.requests.length === 1) return toolCallFrames(step.name, step.args, step.id);
      assert.equal(step.requests.length, 2, 'no hidden model retry or replay');
      return textFrames('The synthetic operation is complete. Continue without repeating it.');
    } });
    await app.mutateConfig(config => { Object.assign(config, {
      activeProvider: 'tool-encoding-fixture', providers: [{ id: 'tool-encoding-fixture', type: 'openai-compat', apiStyle: 'chat', model: 'synthetic-model', baseUrl: fake.url + '/v1', apiKey: 'SYNTHETIC-ONLY-AUTH' }],
      privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, defaultWorkspace: work,
      permissionMode: 'bypass', toolLoadingMode: 'full', importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      bridgeExternalToolsToProvider: false, stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false,
      runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
      allowCommandTools: true, allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false }, openaiMaxToolIterations: 4,
    }); return {}; });
    for (const child of [false, true]) for (const withheld of [false, true]) {
      if (withheld && process.platform !== 'win32') { console.log('SKIP ' + (child ? 'child' : 'main') + ' durable PowerShell side effect requires Windows; source-proven file path still runs'); continue; }
      const label = (child ? 'child' : 'main') + (withheld ? ' typed unavailable result' : ' source-proven file result');
      await check(label + ' reaches actual next POST once with protected history and no duplicate operation', async () => {
        const index = (child ? 'child' : 'main') + (withheld ? '-withheld' : '-read');
        const secret = 'synthetic-' + index + '@example.test';
        const counter = path.join(work, index + '-counter.txt'), source = path.join(work, index + '-source.txt');
        const sourceJson = JSON.stringify({ password: null, email: secret });
        fs.writeFileSync(source, withheld ? sourceJson : 'Public Chinese fixture 中文\nContact ' + secret + '\n' + 'ordinary '.repeat(100));
        // Actual PowerShell appends a durable side effect before returning incompatible JSON.
        const command = "Add-Content -LiteralPath './" + path.basename(counter) + "' -Value '1'; Get-Content -Raw -LiteralPath './" + path.basename(source) + "'";
        step = { name: withheld ? 'powershell_run' : 'file_read', args: withheld ? { command } : { path: source }, id: 'call-' + index, requests: [] };
        const before = state.executions.length;
        const session = await app.createSession({ cwd: work, title: 'Synthetic ' + index });
        const config = await app.readConfig();
        if (child) {
          const result = await app.runSubAgentCore({ parentSession: session, provider: config.providers[0], config,
            task: 'Perform the one synthetic operation and finish without repeating it.', agentKey: 'encoding-fixture', toolTier: 'exec', maxIters: 4, model: 'synthetic-model',
            onEvent() {}, subagentId: index, depth: 1, ctrl: new AbortController(), permModeOverride: 'bypass' });
          assert.equal(result.ok, true);
        } else {
          const events = [];
          await app.runSessionTurn({ sessionId: session.id, message: 'Perform the one synthetic operation and finish without repeating it.', source: 'user', onEvent: event => events.push(event) });
          const terminal = events.findLast(event => event.type === 'result');
          assert.equal(terminal?.ok, true); assert.equal(terminal?.aborted, false);
          assert.equal(events.some(event => event.type === 'error'), false);
        }
        assert.equal(step.requests.length, 2);
        assert.equal(state.executions.slice(before).filter(row => row.name === step.name).length, 1, 'the actual tool executes once');
        const next = step.requests[1], results = next.body.messages.filter(row => row.role === 'tool' && row.tool_call_id === step.id);
        assert.equal(results.length, 1, 'exactly one history result retains the original tool call ID and role');
        const result = results[0];
        assert.equal(next.raw.includes(secret), false);
        if (withheld) {
          const receipt = JSON.parse(result.content);
          assert.equal(receipt.ok, false); assert.equal(receipt.reason, 'privacy.typed_sensitive');
          assert.equal(receipt.privacyFiltered, true); assert.equal(receipt.resultUnavailable, true); assert.equal(receipt.operationMayHaveExecuted, true);
          assert.equal(receipt.code, 'privacy.tool_result_withheld');
          assert.equal(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/).length, 1, 'durable side effect is not repeated after withholding');
        } else {
          assert.match(result.content, /RUYI_PVT:EMAIL:/);
          assert.equal(fs.readFileSync(source, 'utf8').includes(secret), true, 'local source remains original');
        }
      });
    }
    for (const child of [false, true]) {
      if (process.platform !== 'win32') { console.log('SKIP reserved source PowerShell output requires Windows'); continue; }
      await check((child ? 'child' : 'main') + ' reads privacy source markers once and continues with an explicit withheld result', async () => {
        const index = (child ? 'child' : 'main') + '-reserved-source';
        const counter = path.join(work, index + '-counter.txt'), source = path.join(work, index + '-source.js');
        const raw = 'const PREFIX = "[[RUYI_PVT:"; // PUBLIC-RESERVED-SOURCE-SENTINEL\n';
        fs.writeFileSync(source, raw);
        const command = "Add-Content -LiteralPath './" + path.basename(counter) + "' -Value '1'; Get-Content -Raw -LiteralPath './" + path.basename(source) + "'";
        step = { name: 'powershell_run', args: { command }, id: 'call-' + index, requests: [] };
        const before = state.executions.length, session = await app.createSession({ cwd: work, title: 'Synthetic ' + index });
        const config = await app.readConfig();
        if (child) {
          const result = await app.runSubAgentCore({ parentSession: session, provider: config.providers[0], config,
            task: 'Read the synthetic source once and finish without repeating the command.', agentKey: 'reserved-fixture', toolTier: 'exec', maxIters: 4, model: 'synthetic-model',
            onEvent() {}, subagentId: index, depth: 1, ctrl: new AbortController(), permModeOverride: 'bypass' });
          assert.equal(result.ok, true);
        } else {
          const events = [];
          await app.runSessionTurn({ sessionId: session.id, message: 'Read the synthetic source once and finish without repeating the command.', source: 'user', onEvent: event => events.push(event) });
          const terminal = events.findLast(event => event.type === 'result');
          assert.equal(terminal?.ok, true); assert.equal(terminal?.aborted, false);
          assert.equal(events.some(event => event.type === 'error'), false);
          assert.ok(JSON.stringify((await app.loadSession(session.id)).messages).includes('PUBLIC-RESERVED-SOURCE-SENTINEL'), 'local tool audit retains the original stdout');
        }
        assert.equal(step.requests.length, 2);
        assert.equal(state.executions.slice(before).filter(row => row.name === 'powershell_run').length, 1);
        assert.equal(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/).length, 1);
        assert.equal(fs.readFileSync(source, 'utf8'), raw);
        const next = step.requests[1], results = next.body.messages.filter(row => row.role === 'tool' && row.tool_call_id === step.id);
        assert.equal(results.length, 1);
        const receipt = JSON.parse(results[0].content);
        assert.equal(receipt.code, 'privacy.tool_result_withheld'); assert.equal(receipt.reason, 'privacy.reserved_literal');
        assert.equal(receipt.privacyFiltered, true); assert.equal(receipt.operationMayHaveExecuted, true); assert.equal(receipt.resultUnavailable, true);
        assert.ok(!next.raw.includes('PUBLIC-RESERVED-SOURCE-SENTINEL')); assert.ok(!next.raw.includes('const PREFIX'));
      });
    }
    assert.equal(fake.errors.length, 0);
  } finally {
    if (fake) await fake.close(); f.vault.clear(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
