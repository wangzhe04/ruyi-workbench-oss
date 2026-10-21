'use strict';
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');
const { loadServerInternals } = require('./lib/server-internals');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-protocols-')), data = path.join(root, 'data'), work = path.join(root, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
const app = loadServerInternals(['runSessionTurn', 'createSession', 'loadSession', 'readConfig', 'mutateConfig', 'PrivacyGateway', 'PrivacyCore', 'providerRawCompletion', 'runSubAgentCore', 'guardFileToolPath', 'toolCall', 'mcpClients', 'mcpStartingClients', 'killAllMcpClients']);
const t = createRunner('PRIVACY PROTOCOLS'), email = 'protocol-contact@example.test', secret = 'fixture-private-key-123456789';
const idPrefix = '11010120000101001', weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
const identity = idPrefix + '10X98765432'[weights.reduce((sum, n, i) => sum + n * Number(idPrefix[i]), 0) % 11];
const badIdentity = identity.slice(0, -1) + (identity.endsWith('0') ? '1' : '0');
const groupedIdentity = badIdentity.slice(0, 6) + ' ' + badIdentity.slice(6, 14) + '-' + badIdentity.slice(14);
const wideIdentity = badIdentity.replace(/\d/g, value => String.fromCharCode(value.charCodeAt(0) + 0xfee0));
const internal = 'SYNTHETIC-PROTOCOL-INTERNAL', technical = '10.71.82.93', publicValue = 'PUBLIC-ORDER-20261020';
const cnCredentials = { API密钥: 'SYNTHETIC-CN-API-CREDENTIAL', 访问令牌: 'SYNTHETIC-CN-ACCESS-CREDENTIAL', 刷新令牌: 'SYNTHETIC-CN-REFRESH-CREDENTIAL' };
const commonPersonal = ['139 0000 0088', '139-0000-0088', '合成甲', "O'Brien"];
const containsDecoded = (value, needle, depth = 0) => {
  if (depth > 40) return true;
  if (typeof value === 'string') { if (value.includes(needle)) return true; try { return containsDecoded(JSON.parse(value), needle, depth + 1); } catch { return false; } }
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, row]) => containsDecoded(key, needle, depth + 1) || containsDecoded(row, needle, depth + 1));
};
const paired = (events, name, predicate = () => true) => events.some(event => event.type === 'tool_use' && event.name === name && predicate(event) && typeof event.id === 'string' && event.id && events.some(result => result.type === 'tool_result' && result.id === event.id && result.isError === false && result.content?.ok === true));
const historyRows = body => body.input ? body.input.filter(row => row.type === 'function_call_output').map(row => row.output)
  : (body.messages || []).flatMap(row => row.role === 'tool' ? [row.content] : Array.isArray(row.content) ? row.content.filter(block => block.type === 'tool_result').map(block => JSON.stringify(block.content)) : []);
const historyResults = body => historyRows(body).join(' ');
async function stopMcp() {
  for (const client of new Set([...app.mcpClients.values(), ...app.mcpStartingClients.values()])) {
    const child = client.child; if (!child) continue;
    if (child.exitCode === null && child.signalCode === null) {
      let timer; const closed = new Promise(resolve => child.once('close', resolve));
      killOwnTree(child);
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned_mcp_cleanup_timeout')), 8000); })]); }
      finally { clearTimeout(timer); }
    }
    client.pid = 0;
  }
  app.killAllMcpClients();
}
async function main() {
  const endpoints = [];
  try {
    if (process.platform !== 'win32') { console.log('SKIP production privacy fixture requires Windows DPAPI; portable gateway behavior is covered by unit tests'); return; }
    fs.writeFileSync(path.join(work, 'contact.txt'), JSON.stringify({ email, idCard: identity, apiKey: secret }, null, 2));
    const mcpScript = path.join(root, 'synthetic-contact-mcp.cjs'), called = path.join(root, 'mcp-called');
    fs.writeFileSync(mcpScript, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic-contact',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'read_contact',description:'Read synthetic contact with no arguments.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};else if(m.method==='tools/call'&&m.params?.name==='read_contact'){fs.writeFileSync(process.argv[3],'called');result={content:[{type:'text',text:fs.readFileSync(process.argv[2],'utf8')}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    for (const style of ['chat', 'responses', 'anthropic']) {
      if (fs.existsSync(called)) fs.unlinkSync(called);
      let step = 0, retried = false, scenario = 'main', output = 'out-' + style + '.txt'; const captured = [], events = [];
      const command = "Write-Output '" + JSON.stringify({ email, idCard: identity, apiKey: secret }) + "'";
      const script = body => {
        captured.push(body);
        if (!body.stream) return { final: true };
        if (!retried) { retried = true; return { retry: true }; }
        step++;
        const plan = ['history', 'off-history'].includes(scenario) ? ['file_write'] : scenario === 'child'
          ? ['file_read', 'file_write', 'file_search', 'file_write', 'contact__read_contact', 'file_write']
          : ['file_read', 'file_write', 'line', 'file_write', 'file_search', 'file_write', 'powershell_run', 'file_write', 'contact__read_contact', 'file_write'];
        const tool = plan[step - 1];
        if (tool === 'file_read') return { name: tool, args: { path: 'contact.txt' } };
        if (tool === 'line') return { name: 'file_read', args: { path: 'contact.txt', lineOffset: 2, lineLimit: 2 } };
        if (tool === 'file_search') return { name: tool, args: { root: work, glob: 'contact.txt', pattern: 'idCard', context: 1 } };
        if (tool === 'powershell_run') return { name: tool, args: { command, cwd: work } };
        if (tool === 'contact__read_contact') return { name: tool, args: {} };
        if (tool === 'file_write') {
          const results = ['history', 'off-history'].includes(scenario) ? historyResults(body) : historyRows(body).at(-1) || '';
          if (scenario === 'off-history') return { name: tool, args: { path: output,
            content: (results.match(/protocol-contact@example\.test/)?.[0] || 'MISSING_EMAIL') + '\n' + (results.match(/(?<!\d)[1-9]\d{16}[\dX](?!\d)/)?.[0] || 'MISSING_IDENTITY') } };
          const ref = category => results.match(new RegExp('\\[\\[RUYI_PVT:' + category + ':[a-f0-9]{32}\\]\\]'))?.[0] || 'MISSING_' + category;
          t.ok(results.includes('[[RUYI_PVT:EMAIL:') && results.includes('[[RUYI_PVT:IDENTITY:') && ![email, identity, secret].some(value => containsDecoded(results, value)),
            style + '/' + scenario + '/step=' + step + ': selected source history is protected before the next model action');
          return { name: tool, args: { path: step === plan.length ? output : output + '.stage-' + step, content: ref('EMAIL') + '\n' + ref('IDENTITY') } };
        }
        return { final: true };
      };
      let fake;
      if (style === 'anthropic') fake = await startFakeAnthropic({ handler: req => {
        const action = script(req.body);
        if (action.retry) return { status: 503, json: { error: { message: 'fixture temporary unavailable' } } };
        return messageEvents(action.final ? { text: 'fixture complete' } : { toolUses: [{ id: 'call_' + style + '_' + scenario + '_' + step, name: action.name, input: action.args }] });
      } });
      else fake = await startFakeProvider({ handler: req => {
        const action = script(req.body);
        if (action.retry) return { status: 503, json: { error: { message: 'fixture temporary unavailable' } } };
        return action.final ? textFrames('fixture complete') : toolCallFrames(action.name, action.args, 'call_' + style + '_' + scenario + '_' + step);
      }, fallback: async (req, res) => {
        if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        let raw = ''; for await (const part of req) raw += part;
        const body = JSON.parse(raw); const action = script(body);
        if (body.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete' }] }], usage: { input_tokens: 12, output_tokens: 2 } })); return; }
        if (action.retry) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'fixture temporary unavailable' } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let sequence_number = 0; const emit = value => res.write('data: ' + JSON.stringify({ ...value, sequence_number: sequence_number++ }) + '\n\n');
        emit({ type: 'response.created', response: { id: 'response_fixture', status: 'in_progress', output: [] } });
        if (action.final) emit({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_fixture', delta: 'fixture complete' });
        else {
          const item = { type: 'function_call', id: 'fc_' + style + '_' + scenario + '_' + step, call_id: 'call_' + style + '_' + scenario + '_' + step, name: action.name, arguments: '' };
          emit({ type: 'response.output_item.added', output_index: 0, item });
          emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: JSON.stringify(action.args) });
          emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: JSON.stringify(action.args) } });
        }
        emit({ type: 'response.completed', response: { id: 'response_fixture', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 5 } } }); res.end();
      } });
      endpoints.push(fake);
      const provider = { id: style, label: style, type: 'openai-compat', baseUrl: fake.url, apiStyle: style, apiKey: 'fixture-auth-token', model: 'fixture-model', serverWebSearch: false, anthropicThinking: 'off' };
      await app.mutateConfig(current => { Object.assign(current, { credentialEncryptionV1: true, providers: [provider], activeProvider: style, privacyModeV1: 'enhanced', privacyRulesV1: [], defaultWorkspace: work,
        permissionMode: 'bypass', allowCommandTools: true, toolLoadingMode: 'full', bridgeExternalToolsToProvider: true,
        externalMcpServers: [{ id: 'contact', enabled: true, command: process.execPath, args: [mcpScript, path.join(work, 'contact.txt'), called], cwd: work }], bridgedToolTiers: { read_contact: 'read' },
        includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, stewardEnabledV1: false, schedulerEnabledV1: false,
        desktopMcp: { enabled: false, autodetect: false }, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, openaiMaxToolIterations: 14 }); return {}; });
      for (const mode of ['off', 'basic', 'enhanced', 'strict']) for (const hideTechnical of [false, true]) {
        await app.mutateConfig(current => { current.privacyModeV1 = mode; current.privacyTechnicalV1 = hideTechnical; return {}; });
        const before = captured.length;
        const text = [email, identity, '身份证号：' + badIdentity, '居民身份证号是' + groupedIdentity, '身份证号码：' + wideIdentity,
          JSON.stringify({ 身份证号: badIdentity }), JSON.stringify(cnCredentials), '手机号：' + commonPersonal[0], '手机号是' + commonPersonal[1],
          '姓名是' + commonPersonal[2], '联系人为' + commonPersonal[3], 'apiKey=' + secret, '内部项目：' + internal, technical, publicValue].join('\n');
        // A fresh scope tests the selected catalog tier, rather than confidential
        // values already learned under a previous stronger mode in auxiliary scope.
        const tierConfig = await app.readConfig();
        const result = await app.PrivacyGateway.run('protocol-tier-' + style + '-' + mode + '-' + hideTechnical, tierConfig,
          () => app.providerRawCompletion(provider, [{ role: 'user', content: text }, { role: 'assistant', content: text }, { role: 'user', content: 'Reply DONE.' }]));
        const requests = captured.slice(before);
        t.ok(result.ok && requests.length > 0, style + '/' + mode + '/technical=' + hideTechnical + ': actual auxiliary HTTP request succeeds');
        for (const [value, hidden] of [[secret, mode !== 'off'], [email, ['enhanced', 'strict'].includes(mode)], [identity, ['enhanced', 'strict'].includes(mode)],
          ...[badIdentity, groupedIdentity, wideIdentity].map(value => [value, ['enhanced', 'strict'].includes(mode)]),
          ...Object.values(cnCredentials).map(value => [value, mode !== 'off']), ...commonPersonal.map(value => [value, ['enhanced', 'strict'].includes(mode)]),
          [internal, mode === 'strict'], [technical, mode !== 'off' && hideTechnical], [publicValue, false]]) {
          t.ok(requests.every(body => containsDecoded(body, value) === !hidden), style + '/' + mode + '/technical=' + hideTechnical + ': actual recursive wire obeys the selected tier boundary');
        }
      }
      await app.mutateConfig(current => { current.privacyModeV1 = 'enhanced'; current.privacyTechnicalV1 = false; return {}; });
      captured.length = 0;
      const session = await app.createSession({ cwd: work, title: 'privacy ' + style });
      await app.runSessionTurn({ sessionId: session.id, message: 'Read contact.txt and copy its contact email into a local text file. User is user-input@example.test.', onEvent: event => events.push(event) });
      const file = path.join(work, 'out-' + style + '.txt');
      t.ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === email + '\n' + identity, style + ': real full/line/search/command/MCP results feed restored email and ID to actual file execution');
      t.ok(['file_read', 'file_search', 'powershell_run', 'contact__read_contact', 'file_write'].every(name => paired(events, name)) && fs.existsSync(called), style + ': every representative real tool has an exact successful call/result pair');
      const writes = events.filter(event => event.type === 'tool_use' && event.name === 'file_write');
      t.ok(writes.length === 5 && writes.every(event => paired(events, 'file_write', candidate => candidate.id === event.id) && event.input?.content === email + '\n' + identity && fs.readFileSync(path.resolve(work, event.input.path), 'utf8') === email + '\n' + identity),
        style + ': full, line, search, command and MCP each independently round-trip their latest result to a real output');
      t.ok(events.findLast(event => event.type === 'result')?.ok === true, style + ': main production loop emits success');
      const wire = JSON.stringify(captured);
      t.ok(captured.length >= 12 && ![email, identity, secret, 'user-input@example.test', 'fixture-auth-token'].some(value => containsDecoded(captured, value)), style + ': initial request, transient retry and tool continuation all conceal recursively decoded private values');
      t.ok(wire.includes('[[RUYI_PVT:EMAIL:') && wire.includes('[[RUYI_PVT:CREDENTIAL:'), style + ': typed references survive the actual wire encoder');
      t.ok(!events.some(event => event.type === 'error'), style + ': no turn-level errors');
      const cfg = await app.readConfig();
      const beforeDraft = captured.length;
      const draft = await app.providerRawCompletion(provider, [{ role: 'user', content: 'Draft about extra-user@example.test' }]);
      t.ok(draft.ok && captured.length > beforeDraft && !JSON.stringify(captured).includes('extra-user@example.test'), style + ': non-streaming auxiliary completion uses the same privacy boundary');
      scenario = 'history'; step = 0; output = 'history-' + style + '.txt'; const historyEvents = [];
      await app.runSessionTurn({ sessionId: session.id, message: 'Use only the contact from previous history. Write it again without reading anything.', onEvent: event => historyEvents.push(event) });
      t.ok(paired(historyEvents, 'file_write') && !historyEvents.some(event => event.type === 'tool_use' && event.name !== 'file_write') && fs.readFileSync(path.join(work, output), 'utf8') === email + '\n' + identity,
        style + ': existing protected history alone supplies exact restored values on the next real turn');
      app.PrivacyGateway.configure({ privacyModeV1: 'off' });
      let standaloneDenied = false; try { await app.toolCall('file_read', { path: path.join(work, 'contact.txt') }); } catch (error) { standaloneDenied = error.code === 'privacy.engine_not_supported'; }
      t.ok(standaloneDenied, style + ': an unscoped MCP call rechecks persisted privacy settings even when its process policy was stale');
      app.PrivacyGateway.configure(cfg);
      scenario = 'child'; step = 0; output = 'child-' + style + '.txt'; const childEvents = [];
      const child = await app.runSubAgentCore({ parentSession: session, provider, config: cfg, task: 'Read contact.txt and copy its email. Child user: child-user@example.test.', agentKey: 'fixture', toolTier: 'edit', maxIters: 9, model: provider.model, onEvent: event => childEvents.push(event), subagentId: 'privacy-child', depth: 1, ctrl: new AbortController(), permModeOverride: 'acceptEdits' });
      const childWrites = childEvents.filter(event => event.type === 'tool_use' && event.name === 'file_write');
      t.ok(child.ok && child.toolCalls >= 6 && childWrites.length === 3 && childWrites.every(event => paired(childEvents, 'file_write', candidate => candidate.id === event.id) && event.input?.content === email + '\n' + identity && fs.readFileSync(path.resolve(work, event.input.path), 'utf8') === email + '\n' + identity)
        && ['file_read', 'file_search', 'contact__read_contact', 'file_write'].every(name => paired(childEvents, name)) && !containsDecoded(captured, 'child-user@example.test'), style + ': real subagent input and file/search/MCP tool loop restore exact values independently');
      await app.PrivacyGateway.run('permission-check-' + style, cfg, async () => {
        const value = await app.PrivacyGateway.toolResult({ content: 'denied-person@example.test' });
        const prepared = await app.PrivacyGateway.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: '../outside-' + value.content + '.txt', content: 'x' }) }, { session, config: cfg, workingDir: work, effectivePermissionMode: 'acceptEdits' });
        t.ok(prepared.privacyError && !prepared.rawArgs.includes('denied-person@example.test'), style + ': recipient planning rejects an outside path before releasing its original');
        const guard = await app.guardFileToolPath(path.resolve(work, '../outside-denied-person@example.test.txt'), { session: { cwd: work }, config: { ...cfg, permissionMode: 'acceptEdits', allowOutsideWorkspace: false } }, { write: true, tool: 'file_write' }); const denied = guard.ok === false;
        t.ok(denied, style + ': restoring a reference never authorizes a path outside the workspace');
      });
      await stopMcp();
      t.ok(!containsDecoded(captured, email) && !containsDecoded(captured, identity) && !containsDecoded(captured, secret), style + ': all main, history, auxiliary and child continuations remain private on the actual wire');
      await app.mutateConfig(current => { current.privacyModeV1 = 'off'; return {}; });
      const offStart = captured.length; scenario = 'off-history'; step = 0; output = 'off-history-' + style + '.txt'; const offEvents = [];
      await app.runSessionTurn({ sessionId: session.id, message: 'Copy the old contact again without reading any tools.', onEvent: event => offEvents.push(event) });
      const offRequests = captured.slice(offStart), continued = await app.loadSession(session.id);
      t.ok(paired(offEvents, 'file_write') && !offEvents.some(event => event.type === 'tool_use' && event.name !== 'file_write')
        && fs.readFileSync(path.join(work, output), 'utf8') === email + '\n' + identity && continued.privacyHistoryV1 === false,
      style + ': disabling privacy migrates the real saved session before a successful history-only file write');
      t.ok(offRequests.length > 0 && offRequests.every(body => containsDecoded(body, email) && containsDecoded(body, identity)) && !JSON.stringify(offRequests).includes('[[RUYI_PVT:'),
        style + ': explicit off uses restored real history and does not silently reactivate the translator');
      await stopMcp();
    }
  } catch (error) { t.fail('fixture failure: ' + String(error.code || error.message || 'unknown').slice(0, 180)); }
  finally { try { await stopMcp(); } finally { for (const endpoint of endpoints) await endpoint.close(); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-privacy-protocols-')) throw Error('cleanup_scope'); fs.rmSync(root, { recursive: true, force: true }); t.done({ exit: true }); } }
}
main();
