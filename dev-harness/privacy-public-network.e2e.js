'use strict';
// Real main/child engines and native/adaptive proxy dispatch; synthetic model, vault and HTTP receiver.
// DeepSeek's admin-configured endpoint receives public query/fetch payloads without contacting the internet.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-public-network-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
const app = require('./lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyLocalDriveProbe', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'readConfig', 'mutateConfig'], { withEval: true });
const fixture = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
const control = app.__eval(`(() => {
  const state = { executions: [] }; detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {};
  const execute = toolCall;
  toolCall = async (name, args, context) => { state.executions.push({ name, args: structuredClone(args) }); return execute(name, args, context); };
  return state;
})()`);
const t = createRunner('PRIVACY PUBLIC NETWORK');
let active, previousAlias;
const hits = [];
const receiver = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  hits.push({ method: req.method, url: req.url, raw, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/tools/search') return res.end(JSON.stringify({ results: [{ title: 'Public result', url: 'https://8.8.8.8/public', snippet: 'Public fixture' }] }));
  if (req.url === '/v1/tools/fetch') return res.end(JSON.stringify({ title: 'Public page', content: 'Public page fixture 中文' }));
  res.end(JSON.stringify({ received: true }));
});
async function check(label, task) { try { await task(); t.ok(true, label); } catch (error) { t.ok(false, label + ': ' + error.stack); } }
(async () => {
  let fake;
  try {
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + receiver.address().port;
    fake = await startFakeProvider({ handler(ctx) {
      assert.ok(active); active.wire.push(ctx.raw);
      assert.equal(ctx.raw.includes(active.secret), false, 'original never reaches model receiver');
      const last = ctx.messages.filter(row => row.role === 'tool').at(-1);
      if (last) {
        const result = JSON.parse(last.content);
        assert.equal(ctx.messages.filter(row => row.role === 'tool' && row.tool_call_id === last.tool_call_id).length, 1);
        if (active.last === 'file_read') {
          active.alias = result.content.match(/\[\[RUYI_PVT:CREDENTIAL:[a-f0-9]{32}\]\]/)?.[0];
          assert.ok(active.alias); previousAlias = active.alias;
        } else if (active.private && active.mode !== 'off') {
          assert.equal(result.ok, false); assert.equal(result.code, 'privacy.disclosure_not_supported');
          assert.equal(hits.length, active.privateStart, 'private reference causes zero receiver hits'); active.denials++;
        } else assert.equal(result.ok, true, JSON.stringify(result));
      }
      const next = active.steps.shift();
      if (!next) return textFrames('Synthetic public network verification completed.');
      active.last = next.name; active.private = next.private === true;
      if (active.private && active.privateStart === undefined) active.privateStart = hits.length;
      const args = next.args();
      const name = active.proxy && next.name !== 'file_read' ? 'tool_invoke_exec' : next.name;
      return toolCallFrames(name, name === 'tool_invoke_exec' ? { name: next.name, arguments: args } : args, 'call-' + active.prefix + '-' + active.index++);
    } });
    for (const mode of ['basic', 'enhanced', 'strict', 'off']) for (const child of [false, true]) for (const proxy of [false, true]) {
      const prefix = mode + '-' + (child ? 'child' : 'main') + '-' + (proxy ? 'proxy' : 'direct');
      await check(prefix + ' preserves public bytes and never restores private references into network payloads', async () => {
        const secret = 'SYNTHETIC-NETWORK-CREDENTIAL-' + prefix + '-' + 'Z'.repeat(24);
        const source = path.join(work, prefix + '.json'); fs.writeFileSync(source, JSON.stringify({ password: secret }));
        await app.mutateConfig(config => Object.assign(config, {
          activeProvider: 'public-fixture', providers: [{ id: 'public-fixture', type: 'openai-compat', apiStyle: 'chat', model: 'synthetic-model', baseUrl: fake.url + '/v1', apiKey: 'SYNTHETIC-MODEL-KEY' }],
          searchBackendMigrated: true, searchBackend: { type: 'deepseek', baseUrl: endpoint, apiKey: 'SYNTHETIC-SEARCH-KEY' },
          privacyModeV1: mode, privacyTechnicalV1: true, privacyRulesV1: [], credentialEncryptionV1: true, defaultWorkspace: work, permissionMode: 'bypass', toolLoadingMode: 'full',
          importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, bridgeExternalToolsToProvider: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false },
          stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
          allowCommandTools: true, allowDesktopTools: false, openaiMaxToolIterations: 10,
        }));
        const session = await app.createSession({ cwd: work, title: 'Synthetic ' + prefix }), config = await app.readConfig();
        const query = 'public 中文 site:example.com ' + prefix, url = 'https://8.8.8.8/public?q=' + prefix + '&x=%E4%B8%AD';
        const postUrl = endpoint + '/post?case=' + prefix, body = 'public 中文 + literal@example.test & %20';
        active = { prefix, mode, proxy, secret, alias: previousAlias, wire: [], index: 0, denials: 0, steps: [] };
        if (mode !== 'off') active.steps.push({ name: 'file_read', args: () => ({ path: source }) });
        else assert.ok(previousAlias, 'off reuses an opaque reference issued by a prior protected scope');
        active.steps.push(
          { name: 'web_search', args: () => ({ query, maxResults: 3 }) },
          { name: 'web_fetch', args: () => ({ url }) },
          { name: 'http_request', args: () => ({ url: postUrl, method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body }) },
          { name: 'web_search', private: true, args: () => ({ query: 'private ' + active.alias, maxResults: 3 }) },
          { name: 'web_fetch', private: true, args: () => ({ url: 'https://8.8.8.8/private?q=' + active.alias }) },
          { name: 'http_request', private: true, args: () => ({ url: endpoint + '/private', method: 'POST', body: 'private ' + active.alias }) },
        );
        const beforeHits = hits.length, beforeExecutions = control.executions.length;
        if (child) {
          const result = await app.runSubAgentCore({ parentSession: session, provider: config.providers[0], config, task: 'Perform the synthetic network sequence once and finish.', agentKey: 'fixture', toolTier: 'exec', maxIters: 10, model: 'synthetic-model', onEvent() {}, subagentId: prefix, depth: 1, ctrl: new AbortController(), permModeOverride: 'bypass' });
          assert.equal(result.ok, true, JSON.stringify(result));
        } else {
          const events = []; await app.runSessionTurn({ sessionId: session.id, message: 'Perform the synthetic network sequence once and finish.', onEvent: event => events.push(event) });
          assert.equal(events.findLast(event => event.type === 'result')?.ok, true); assert.equal(events.some(event => event.type === 'error'), false);
          assert.equal(events.some(event => /permission.*(?:request|pending)/i.test(event.type)), false, 'ordinary public calls add no permission prompt');
        }
        assert.equal(active.steps.length, 0);
        const received = hits.slice(beforeHits);
        assert.equal(received.length, mode === 'off' ? 6 : 3, 'exact receiver count, no duplicate send');
        assert.deepEqual(received.slice(0, 3).map(row => ({ method: row.method, url: row.url, raw: row.raw })), [
          { method: 'POST', url: '/v1/tools/search', raw: JSON.stringify({ query, count: 3, need_content: false }) },
          { method: 'POST', url: '/v1/tools/fetch', raw: JSON.stringify({ url }) },
          { method: 'POST', url: '/post?case=' + prefix, raw: body },
        ]);
        assert.equal(received[0].auth, "Bearer " + "SYNTHETIC-SEARCH-KEY"); assert.equal(received[1].auth, "Bearer " + "SYNTHETIC-SEARCH-KEY");
        assert.equal(JSON.stringify(received).includes(secret), false);
        const executed = control.executions.slice(beforeExecutions);
        for (const name of ['web_search', 'web_fetch', 'http_request']) assert.equal(executed.filter(row => row.name === name).length, mode === 'off' ? 2 : 1, name + ' dispatch count');
        assert.equal(active.denials, mode === 'off' ? 0 : 3);
        if (mode === 'off') {
          assert.equal(JSON.parse(received[3].raw).query, 'private ' + active.alias);
          assert.equal(JSON.parse(received[4].raw).url, 'https://8.8.8.8/private?q=' + active.alias);
          assert.equal(received[5].raw, 'private ' + active.alias);
          assert.equal(received[5].url, '/private');
        }
      });
    }
    assert.equal(fake.errors.length, 0);
  } finally {
    if (fake) await fake.close(); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve));
    app.PrivacyLocalDriveProbe.stopSync(); fixture.vault.clear(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
