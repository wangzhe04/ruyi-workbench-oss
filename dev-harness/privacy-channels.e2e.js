'use strict';
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const { EventEmitter } = require('node:events');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-channels-')), data = path.join(root, 'data'), work = path.join(root, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
const app = loadServerInternals(['readConfig', 'mutateConfig', 'McpStdioClient', 'handleApi', 'RUNTIME', 'recordSessionExecutionOwner', 'registerSessionExecutionChild', 'activeChildren', 'turnSettlers', 'InternalMcpRelay', 'audioStreamUpstream', 'handleAudioStreamOpen', 'handleAudioStreamSession', 'maybeOcrImageAttachment', 'maybeCompressImageAttachment', 'runSessionTurn', 'runStewardTurn', 'createSession', 'saveSession', 'loadSession', 'stewardImplThreadRead', 'stewardPrerouteIndexRows', 'runAgentExternalCompact', 'compactHistoryFromSession', 'AgentLoopHooks', 'PrivacyGateway', 'createKimiAcpRpc', 'writeToChild'], { withEval: true });
const t = createRunner('PRIVACY CHANNELS');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (check()) return true; await sleep(50); } return false; }
const policy = mode => app.mutateConfig(current => { current.privacyModeV1 = mode; return {}; });
const refused = async work => { try { await work(); return false; } catch (error) { return /privacy\.(?:engine|media)_not_supported/.test(error.code || error.message); } };

async function main() {
  let mcp, audioServer, summaryServer, foreignProvider, mcpSession, mcpOwner, mcpReg, mcpSettle, mcpHost, mcpRuntimeBefore, mcpClosed=false;
  async function closeMcp() {
    try {
      const child=mcp?.child;if(child&&!mcpClosed){const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Privacy CLI child close deadline')),5000);child.once('close',()=>{clearTimeout(timer);resolve();});});closed.catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await killOwnTree(child);await closed;}
    }
    finally {
      if(mcpSession&&app.activeChildren.get(mcpSession.id)===mcpReg)app.activeChildren.delete(mcpSession.id);
      if(mcpSession&&app.turnSettlers.get(mcpSession.id)===mcpOwner)app.turnSettlers.delete(mcpSession.id);
      mcpSettle?.();mcp=null;
      try {
        if(mcpHost){const host=mcpHost;mcpHost=null;host.closeAllConnections();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Privacy CLI host close deadline')),5000);host.close(error=>{clearTimeout(timer);if(error)reject(error);else resolve();});});}
      } finally {if(mcpRuntimeBefore){Object.assign(app.RUNTIME,mcpRuntimeBefore);mcpRuntimeBefore=null;}}
    }
  }
  try {
    if (process.platform !== 'win32') { console.log('SKIP production channel persistence requires Windows DPAPI'); return; }
    await app.mutateConfig(current => { Object.assign(current, { credentialEncryptionV1: true, privacyModeV1: 'off', privacyRulesV1: [], defaultWorkspace: work, activeProvider: '', permissionMode: 'acceptEdits', providers: [],
      stewardEnabledV1: false, schedulerEnabledV1: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, bridgeExternalToolsToProvider: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false }); return {}; });
    const sentinel = 'channel-private@example.test';
    const delayed = path.join(work, 'delayed.txt'), delayedError = path.join(work, 'delayed-error.txt'), started = path.join(root, 'tool-started'), release = path.join(root, 'tool-release');
    fs.writeFileSync(delayed, sentinel);
    fs.writeFileSync(delayedError, sentinel);
    // A real registered CLI wrapper owns the MCP child under the current host.
    // Keep the actual file_read and its completed-result delay unchanged.
    mcpHost=http.createServer((req,res)=>{void app.handleApi(req,res,new URL(req.url,'http://local').pathname).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{}');});});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Privacy CLI host listen deadline')),5000);mcpHost.once('error',error=>{clearTimeout(timer);reject(error);});mcpHost.listen(0,'127.0.0.1',()=>{clearTimeout(timer);resolve();});});
    mcpRuntimeBefore={host:app.RUNTIME.host,port:app.RUNTIME.port,token:app.RUNTIME.token};
    Object.assign(app.RUNTIME,{host:'127.0.0.1',port:mcpHost.address().port,token:'e'.repeat(32)});
    mcpSession=await app.createSession({title:'Synthetic privacy CLI owner',cwd:work,engineRoute:{engine:'claude',agentCliType:'claude'}});
    const script = path.join(root, 'delayed-mcp.cjs');
    const internalsPath = path.resolve(__dirname, 'lib/server-internals.js');
    const delayHook = `const original = toolCall; toolCall = async (name, args, ctx) => { const result = await original(name, args, ctx); if (name === 'file_read' && ${JSON.stringify([delayed, delayedError])}.includes(args.path)) { fs.writeFileSync(${JSON.stringify(started)}, 'ready'); const until = Date.now() + 12000; while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30)); if (args.path === ${JSON.stringify(delayedError)}) throw new Error(${JSON.stringify('fixture error: ' + sentinel)}); } return result; };`;
    app.__eval(delayHook); // Tool work now belongs to the serve owner; preserve the same completed-result pause there.
    fs.writeFileSync(script, `const app = require(${JSON.stringify(internalsPath)}).loadServerInternals(['startMcp']); app.startMcp();`);
    const wrapper=path.join(root,'owned-delayed-cli.cjs');
    fs.writeFileSync(wrapper,[
      "const cp=require('node:child_process');",
      "const child=cp.spawn(process.execPath,["+JSON.stringify(script)+"],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});",
      "child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});",
      "process.stdout.on('error',()=>process.exit(1));process.stderr.on('error',()=>process.exit(1));child.once('error',()=>process.exit(1));",
      "child.once('close',(code,signal)=>{process.stdin.unpipe(child.stdin);process.stdin.pause();const timer=setTimeout(()=>process.exit(1),5000);process.stdout.write('',()=>process.stderr.write('',()=>{clearTimeout(timer);process.exit(signal||!Number.isInteger(code)?1:code);}));});"
    ].join('\n'));
    mcpOwner={promise:new Promise(resolve=>{mcpSettle=resolve;}),source:'fixture-cli',driverRunId:'privacy-channel-cli',phase:'starting',cancelRequested:false,cancel(){this.cancelRequested=true;}};
    app.recordSessionExecutionOwner(mcpSession.id,mcpOwner);
    const grant=app.InternalMcpRelay.create({session:mcpSession,executionOwner:mcpOwner,config:await app.readConfig()});
    mcp = new app.McpStdioClient({id:'privacy-fixture',command:process.execPath,args:[wrapper],cwd:work,startupTimeoutMs:20000,
      env:{WCW_HOST:'127.0.0.1',WCW_PORT:String(app.RUNTIME.port),WCW_TOKEN:app.RUNTIME.token,WCW_SESSION_ID:mcpSession.id,...app.InternalMcpRelay.launchEnv(grant)}});
    // start synchronously creates the real wrapper; register it before the host
    // can process the descendant's actual initialize verification request.
    const starting=mcp.start();starting.catch(()=>{});
    mcpClosed=false;mcp.child?.once('close',()=>{mcpClosed=true;});
    if(!mcp.child?.pid)throw Error('Actual CLI wrapper did not start');
    mcpReg={child:mcp.child,pid:mcp.child.pid,kind:'kimi-acp',state:'running',exited:false,session:mcpSession};
    app.registerSessionExecutionChild(mcpSession.id,mcpReg,mcpOwner);app.InternalMcpRelay.bind(grant,mcpReg,mcpOwner);
    await starting;
    const listed = await mcp._rpc('resources/list', {}); const uri = listed.resources?.[0]?.uri;
    t.ok(!!uri, 'M1 off mode retains the ordinary registered CLI MCP config resource');
    const pending = mcp._rpc('tools/call', { name: 'file_read', arguments: { path: delayed } }, 20000).then(value => ({ value }), error => ({ error: error.message }));
    t.ok(await waitFor(() => fs.existsSync(started)), 'M2 actual MCP file read reaches its delayed result');
    await policy('enhanced'); fs.writeFileSync(release, 'continue');
    const result = await pending;
    t.ok(result.error?.includes('privacy.engine_not_supported') && !JSON.stringify(result).includes(sentinel), 'M3 a tool started while off cannot return plaintext after privacy is enabled');
    const hidden = await mcp._rpc('resources/list', {}).then(value=>({value}),error=>({error:error.message}));
    t.ok(hidden.error==='privacy.engine_not_supported'&&!JSON.stringify(hidden).includes(data), 'M4 an already-running registered CLI MCP rejects resource listing with its exact privacy code and exposes no resource paths after policy change');
    t.ok(await refused(() => mcp._rpc('resources/read', { uri })), 'M5 a previously issued config URI cannot bypass privacy');
    t.ok(await refused(() => mcp._rpc('tools/call', { name: 'file_read', arguments: { path: delayed } })), 'M6 registered CLI MCP tools are blocked after enabling privacy');
    const hiddenTools = await mcp._rpc('tools/list', {}).then(value=>({value}),error=>({error:error.message}));
    t.ok(hiddenTools.error==='privacy.engine_not_supported', 'M6b unsupported registered CLI MCP rejects tool listing with its exact privacy code instead of advertising usable tools');
    await policy('off'); fs.unlinkSync(started); fs.unlinkSync(release);
    const throwing = mcp._rpc('tools/call', { name: 'file_read', arguments: { path: delayedError } }, 20000).then(value => ({ value }), error => ({ error: error.message }));
    t.ok(await waitFor(() => fs.existsSync(started)), 'M7 delayed throwing tool started while protection was off');
    await policy('enhanced'); fs.writeFileSync(release, 'continue');
    const thrown = await throwing;
    t.ok(thrown.error?.includes('privacy.engine_not_supported') && !JSON.stringify(thrown).includes(sentinel), 'M8 exception paths also recheck policy and hide private error text');
    await closeMcp();

    const audioCalls = [];
    audioServer = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); audioCalls.push({ method: req.method, bytes: Buffer.concat(chunks).length }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'b'.repeat(32), sampleRate: 16000 })); });
    await new Promise(resolve => audioServer.listen(0, '127.0.0.1', resolve));
    const audioSession = { upstream: 'http://127.0.0.1:' + audioServer.address().port, upstreamId: 'b'.repeat(32), providerId: 'fixture', at: Date.now() };
    await policy('off'); await app.audioStreamUpstream(audioSession, 'POST', '', JSON.stringify({ hotwords: ['fixture-person'] }));
    await policy('enhanced');
    t.ok(await refused(() => app.audioStreamUpstream(audioSession, 'POST', '/audio', Buffer.from('private PCM'))), 'A1 an old streaming speech session cannot forward further PCM after enabling privacy');
    t.ok(await refused(() => app.handleAudioStreamOpen({}, {})), 'A2 live speech fails before reading hotwords or spawning a provider');
    const audioId = 'a'.repeat(32);
    app.__eval(`audioStreamSessions.set(${JSON.stringify(audioId)}, ${JSON.stringify(audioSession)});`);
    t.ok(await refused(() => app.handleAudioStreamSession({ method: 'POST', headers: {} }, {}, '/api/audio/stream/sessions/' + audioId + '/finish')), 'A3 old speech finish also rechecks persisted policy');
    const response = { writeHead() {}, end() {} };
    await app.handleAudioStreamSession({ method: 'DELETE' }, response, '/api/audio/stream/sessions/' + audioId);
    t.ok(audioCalls.length === 2 && audioCalls[1].method === 'DELETE' && audioCalls[1].bytes === 0, 'A4 cleanup DELETE remains available and sends no private body');
    const image = { kind: 'image', path: path.join(work, 'private.png'), size: 6 * 1024 * 1024 };
    app.__eval('bridgedToolClient = async () => { throw new Error("fixture media egress must not run"); };');
    await app.maybeOcrImageAttachment(image); await app.maybeCompressImageAttachment(image);
    t.ok(image.ocrError === 'privacy.media_not_supported' && image.compressError === 'privacy.media_not_supported', 'A5 image OCR and compression stop before any MCP connection or file transfer');

    // Actual CLI launch gets a stale off snapshot; a hook enables privacy after prompt preparation.
    await policy('off');
    const marker = path.join(root, 'cli-launched'), fakeCli = path.join(root, 'fake-cli.cjs');
    fs.writeFileSync(fakeCli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched'); process.exit(0);`);
    process.env.WCW_FAKE_CLAUDE = fakeCli;
    let hookRan = false;
    app.AgentLoopHooks.registerAgentLoopHook({ id: 'privacy-launch-race', timeoutMs: 2000, beforeModelCall: async () => { hookRan = true; await policy('enhanced'); } });
    const session = await app.createSession({ title: 'CLI privacy race', cwd: work, engineRoute: { engine: 'claude', agentCliType: 'claude' } });
    const events = []; let cliError = '';
    try { await app.runSessionTurn({ sessionId: session.id, message: 'Summarize fixture facts.', onEvent: event => events.push(event) }); } catch (error) { cliError = error.code || error.message; }
    app.AgentLoopHooks.unregisterAgentLoopHook('privacy-launch-race'); delete process.env.WCW_FAKE_CLAUDE;
    t.ok(hookRan && !fs.existsSync(marker) && (cliError.includes('privacy.engine_not_supported') || JSON.stringify(events).includes('privacy.engine_not_supported')), 'C1 policy is rechecked after asynchronous hooks and before the real CLI spawn');
    let written = 0;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr = new EventEmitter();
    child.stdin = { writable: true, destroyed: false, writableEnded: false, on() {}, write() { written++; } };
    app.__eval(`activeChildren.set('privacy-write', { child: { stdin: { writable: true, write() { throw new Error('unexpected write'); } } } });`);
    t.ok(app.writeToChild('privacy-write', { type: 'user', message: sentinel }) === false, 'C2 generic CLI input blocks late steering and tool replies');
    const rpc = app.createKimiAcpRpc(child); let acpBlocked = false;
    try { await rpc.request('session/prompt', { prompt: sentinel }, 1000); } catch (error) { acpBlocked = /privacy.engine_not_supported/.test(error.message); }
    rpc.close?.();
    app.__eval("activeChildren.delete('privacy-write');");
    t.ok(acpBlocked && written === 0, 'C3 Kimi ACP refuses old-process prompt writes before bytes reach stdin');

    const summaryCalls = [], summaryText = '## Goal\nSynthetic task\n## Decisions\nNone\n## Open\nNone\n## Current Status\nDone: checked\nIn progress: none\nBlocked: none\nNext step: continue\n## Files\nNone';
    summaryServer = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST') { summaryCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.end(JSON.stringify({ choices: [{ message: { content: summaryText } }], usage: { prompt_tokens: 12, completion_tokens: 12 } })); }
      else res.end(JSON.stringify({ data: [{ id: 'fixture-summary', context_length: 8000 }] }));
    });
    await new Promise(resolve => summaryServer.listen(0, '127.0.0.1', resolve));
    await app.mutateConfig(current => { Object.assign(current, { privacyModeV1: 'basic', compactProviderId: 'compact-fixture', compactModel: 'fixture-summary',
      providers: [{ id: 'compact-fixture', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + summaryServer.address().port + '/v1', model: 'fixture-summary', contextWindow: 8000, apiKey: '' }],
      privacyRulesV1: [{ id: 'compact-field', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] }); return {}; });
    const currentPolicy = await app.readConfig(), staleOffPolicy = { ...currentPolicy, privacyModeV1: 'off' };
    const privateKey = 'sk-SYNTHETIC-EXTERNAL-COMPACT-' + 'K'.repeat(32), fieldValue = 'SYNTHETIC-ROOT-FIELD-COMPACT';
    const compactFixture = async messages => {
      const session = await app.createSession({ title: 'Synthetic external compact', cwd: work, engineRoute: { engine: 'claude', agentCliType: 'claude' } });
      session.messages = messages; await app.saveSession(session);
      return session;
    };
    const runCompact = async session => {
      const before = summaryCalls.length, original = JSON.stringify((await app.loadSession(session.id)).messages.filter(row => ['user', 'assistant'].includes(row.role)));
      const result = await app.runAgentExternalCompact(session.id, staleOffPolicy, 'manual');
      const unchanged = JSON.stringify((await app.loadSession(session.id)).messages.filter(row => ['user', 'assistant'].includes(row.role))) === original;
      return { result, unchanged, calls: summaryCalls.slice(before), wire: JSON.stringify(summaryCalls.slice(before)) };
    };
    const evidence = { turnSummary: { public: 'unchanged' }, toolCalls: [{ name: 'file_write', input: { padding: '', apiKey: privateKey } }] };
    evidence.toolCalls[0].input.padding = 'p'.repeat(11992 - JSON.stringify(evidence).indexOf(privateKey));
    const capSession = await compactFixture([{ role: 'user', content: JSON.stringify({ patientCode: fieldValue }) },
      { role: 'assistant', content: 'Synthetic complete source.', toolCalls: evidence.toolCalls, turnSummary: evidence.turnSummary }]);
    const rawCap = JSON.stringify(app.compactHistoryFromSession(capSession));
    t.ok(rawCap.includes(privateKey.slice(0, 8)) && !rawCap.includes(privateKey), 'S0 real display-session evidence truncates the synthetic key at the 12000 character boundary before protection');
    const capped = await runCompact(capSession);
    t.ok(capped.result.ok && capped.calls.length > 0 && !capped.wire.includes(privateKey.slice(0, 8)) && !capped.wire.includes(fieldValue) && /RUYI_PVT:INTERNAL:/.test(capped.wire), 'S1 actual external compact entry protects complete credentials and root field rules before evidence caps despite stale off caller config');
    t.ok(capped.unchanged, 'S2 successful compaction keeps the complete original user and assistant transcripts unchanged');

    const longSession = await compactFixture([{ role: 'user', content: Array.from({ length: 24 }, (_, index) => 'public' + index + ' '.repeat(17) + '界'.repeat(650) + ' ' + privateKey + '\n').join('') }]);
    const split = await runCompact(longSession);
    const aliasPattern = /\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g;
    t.ok(split.result.ok && split.calls.length > 1 && !split.wire.includes(privateKey.slice(0, 8)) && !split.wire.replace(aliasPattern, '').includes('[[RUYI_PVT:'), 'S3 actual map reduce requests protect full sources and preserve complete reference markers at every fragment boundary');
    t.ok(split.unchanged, 'S4 map reduce compaction does not replace originals with its protected copies');

    const refsSession = await compactFixture([{ role: 'user', content: 'Synthetic historical values.' }]);
    let validReference;
    await app.PrivacyGateway.run(refsSession.id, currentPolicy, async () => { validReference = app.PrivacyGateway.active().scope.protectValue('valid-compact@example.test', 'EMAIL'); await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: validReference }] }); });
    refsSession.messages = [{ role: 'user', content: 'Valid ' + validReference }, { role: 'assistant', content: 'Unavailable [[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]',
      toolCalls: [{ name: 'file_write', input: { patientCode: fieldValue } }] }]; await app.saveSession(refsSession);
    const firstRefs = await runCompact(refsSession), secondRefs = await runCompact(refsSession);
    t.ok(firstRefs.result.ok && secondRefs.result.ok && firstRefs.wire.includes(validReference) && !firstRefs.wire.includes('f'.repeat(32)) && !firstRefs.wire.includes(fieldValue), 'S5 valid same-session references survive, unavailable history is quarantined, and neither poisons the next actual compact request');
    t.ok(firstRefs.unchanged && secondRefs.unchanged, 'S6 reference recovery affects only model copies of the local transcript');
    for (const attachments of [{ path: 'not-an-array' }, 'not-an-array']) {
      const malformedSession = await compactFixture([{ role: 'user', content: 'Synthetic malformed historical attachment metadata.', attachments }]);
      const recovered = await runCompact(malformedSession);
      t.ok(recovered.result.ok && recovered.unchanged && !recovered.wire.includes('not-an-array'), 'S6b malformed non-array historical attachments preserve the existing ignored-metadata contract');
    }

    await policy('off');
    const offSession = await compactFixture([{ role: 'user', content: 'Public task' }, { role: 'assistant', content: 'Synthetic off source.', toolCalls: evidence.toolCalls }]);
    const off = await runCompact(offSession);
    t.ok(off.result.ok && off.unchanged && off.wire.includes(privateKey.slice(0, 8)) && !off.wire.includes(privateKey) && !off.wire.includes('RUYI_PVT:'), 'S7 privacy off keeps the original evidence cap and ordinary external compact behavior');

    let foreignPhase = 'source', sourceStep = 0, stewardStep = 0;
    const sourceThreads = [], sourceAliases = [], sourceEmails = ['source-a@example.test', 'source-b@example.test'];
    const say = JSON.stringify({ say: '已核对线程和通知，原记录保留。', why: '', acts: [], actions: [] });
    foreignProvider = await startFakeProvider({ handler(request) {
      if (foreignPhase === 'source') {
        const reference = JSON.stringify(request.body.messages).match(/\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]/)?.[0];
        if (!reference) throw Error('source_request_missing_alias');
        sourceAliases.push(reference); return textFrames('p'.repeat(sourceStep++ === 0 ? 73 : 138) + reference + ' Public source finding.');
      }
      if (foreignPhase === 'steward') {
        const calls = [
          ['steward_thread_read', { sessionId: sourceThreads[0].id, tail: 1, maxChars: 600 }],
          ['steward_thread_status', { sessionId: sourceThreads[1].id }],
          ['steward_threads_search', { q: 'foreign', includeClosed: true }],
          ['steward_inbox_read', { limit: 4 }],
        ];
        const call = calls[stewardStep++]; if (call) return toolCallFrames(call[0], call[1], 'foreign-read-' + stewardStep);
      }
      return textFrames(say);
    } });
    await app.mutateConfig(current => { Object.assign(current, { privacyModeV1: 'enhanced', privacyRulesV1: [], activeProvider: 'foreign-fixture', stewardProviderId: 'foreign-fixture', stewardEnabledV1: false,
      providers: [{ id: 'foreign-fixture', type: 'openai-compat', apiStyle: 'chat', baseUrl: foreignProvider.url + '/v1', model: 'fixture-model', apiKey: '', contextWindow: 128000 }],
      stewardThreadBriefV1: false, schedulerEnabledV1: false, memoryAutoProposeEnabled: false, openaiMaxToolIterations: 12 }); return {}; });
    for (let index = 0; index < 2; index++) {
      const session = await app.createSession({ title: 'foreign source ' + index, cwd: work, engineRoute: { engine: 'openai', providerId: 'foreign-fixture' } });
      const result = await app.runSessionTurn({ sessionId: session.id, message: 'Source contact ' + sourceEmails[index] + ' ' + 'public '.repeat(40), onEvent() {} });
      t.ok(result.ok === true, 'F0 real same-directory source thread completes a protected model turn');
      sourceThreads.push(await app.loadSession(session.id));
    }
    t.ok(sourceThreads[0].summary.includes(sourceAliases[0]) && sourceThreads[1].summary.includes('[[RUYI_PVT:') && !sourceThreads[1].summary.includes(sourceAliases[1]), 'F1 real settled thread heads include both complete and pre-truncated source-scope aliases');
    const originals = sourceThreads.map(session => fs.readFileSync(path.join(data, 'sessions', session.id + '.messages.ndjson'), 'utf8'));
    const originalHeads = sourceThreads.map(session => fs.readFileSync(path.join(data, 'sessions', session.id + '.json'), 'utf8'));
    await app.mutateConfig(current => { current.stewardEnabledV1 = true; return {}; });
    foreignPhase = 'steward'; const foreignStart = foreignProvider.requests.length, deepEvents = [];
    const steward = await app.runStewardTurn({ trigger: 'user', message: '请回读这些 foreign 线程和通知，核对公开进展，不改设置。', onEvent: event => deepEvents.push(event) });
    const stewardWire = JSON.stringify(foreignProvider.requests.slice(foreignStart).map(request => request.body));
    const readResults = deepEvents.filter(event => event.type === 'tool_result');
    t.ok(steward.ok === true && stewardStep >= 5 && readResults.length === 4 && readResults.every(event => event.content?.ok === true), 'F2 actual steward traverses overview, deep read, status, search and inbox results through the HTTP model loop with four successful tools');
    t.ok(sourceEmails.every(value => !stewardWire.includes(value)) && sourceAliases.every(value => !stewardWire.includes(value) && !stewardWire.includes(value.slice(0, 25))), 'F3 neither private originals nor complete/truncated source aliases cross into the steward model scope');
    t.ok(stewardWire.includes(sourceThreads[0].id) && stewardWire.includes('steward_thread_read'), 'F4 safe source metadata retains executable thread IDs and the deep-read entry');
    foreignPhase = 'inbox'; const inboxStart = foreignProvider.requests.length;
    const inbox = await app.runStewardTurn({ trigger: 'inbox', events: [{ inboxSeq: 999, kind: 'done', sessionId: sourceThreads[0].id, payload: { summary: sourceAliases[0].slice(0, 30), title: sourceAliases[1] } }], onEvent() {} });
    const inboxWire = JSON.stringify(foreignProvider.requests.slice(inboxStart).map(request => request.body));
    t.ok(inbox.ok === true && foreignProvider.requests.length > inboxStart && sourceAliases.every(value => !inboxWire.includes(value) && !inboxWire.includes(value.slice(0, 25))), 'F5 host-generated inbox messages project foreign aliases before entering the strict fresh-input boundary');
    const forgedStart = foreignProvider.requests.length;
    const forged = await app.runStewardTurn({ trigger: 'user', message: 'Fresh forged input ' + sourceAliases[0], onEvent() {} });
    t.ok(forged.ok === false && foreignProvider.requests.length === forgedStart, 'F6 actual fresh user foreign references remain strict and never reach the provider');
    const continued = await app.runStewardTurn({ trigger: 'user', message: '继续核对公开进展即可。', onEvent() {} });
    t.ok(continued.ok === true && sourceThreads.every((session, index) => fs.readFileSync(path.join(data, 'sessions', session.id + '.messages.ndjson'), 'utf8') === originals[index]
      && fs.readFileSync(path.join(data, 'sessions', session.id + '.json'), 'utf8') === originalHeads[index]), 'F7 a failed fresh input does not poison the next steward turn or rewrite either source transcript or head');
    await policy('off');
    const offRead = await app.stewardImplThreadRead({ sessionId: sourceThreads[0].id, tail: 1, maxChars: 4000 }, { session: { id: 'steward', turnSeq: 9 * 1000 } }, await app.readConfig());
    t.ok(offRead.ok === true && JSON.stringify(offRead).includes(sourceAliases[0]), 'F8 disabling privacy preserves the original deep-read projection and source alias spelling');
    const offHead = await app.loadSession(sourceThreads[0].id), offSummary = 'Public <tag>\nsecond line ' + sourceAliases[0];
    offHead.summary = offSummary; await app.saveSession(offHead);
    const offIndex = await app.stewardPrerouteIndexRows(await app.readConfig());
    t.ok(offIndex.find(row => row.sessionId === offHead.id)?.summary === offSummary, 'F9 disabled privacy preserves exact newlines, angle brackets and alias spelling in the actual preroute index');
    // Hold the real projection snapshot stable: unrelated index rebuilds must not
    // accidentally hide a missing privacy component in the preroute cache key.
    const restoreIndex = await app.__eval('(async () => { const original = getPretenderProjectionIndex, snapshot = await original(); getPretenderProjectionIndex = async () => snapshot; return () => { getPretenderProjectionIndex = original; }; })()');
    try {
      const cachedOff = await app.stewardPrerouteIndexRows(await app.readConfig());
      await policy('enhanced');
      const onIndex = await app.stewardPrerouteIndexRows(await app.readConfig());
      await policy('off');
      const offAgain = await app.stewardPrerouteIndexRows(await app.readConfig());
      t.ok(cachedOff.find(row => row.sessionId === offHead.id)?.summary === offSummary && !onIndex.find(row => row.sessionId === offHead.id)?.summary.includes('[[RUYI_PVT:')
        && offAgain.find(row => row.sessionId === offHead.id)?.summary === offSummary, 'F10 cached preroute rows follow both privacy transitions with a stable real index and unchanged source head');
    } finally { restoreIndex(); }
  } catch (error) { t.fail('fixture failure: ' + String(error.stack || error.code || error.message).slice(0, 600)); }
  finally {
    await closeMcp();
    if (audioServer) await new Promise(resolve => audioServer.close(resolve));
    if (summaryServer) await new Promise(resolve => summaryServer.close(resolve));
    if (foreignProvider) await foreignProvider.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-privacy-channels-')) throw Error('cleanup scope');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* owned open log handles are released on exit */ }
    t.done({ exit: true });
  }
}
main();
