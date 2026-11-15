'use strict';
require('./lib/self-isolate-home');
// Opt-in actual root/provider/proxy/ACC/native receipt chain. Only wait and mouse-position
// reads; no input mutation, GUI, held state, CLI/subagent delivery or full P5 qualification.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS EXECUTION DISPATCH');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
  RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data };
for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
let server, provider, token, port, output = '';
const observations = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(read, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-4000));
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + await res.text());
  return res.json();
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env: { ...process.env, ...env }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      port = runtime.port; token = runtime.token;
      return (await api('/health')).ok;
    } catch { return false; }
  }, 'serve ready');
}
async function stop() {
  if (!server) return;
  const child = server, identity = snapshotProcessTable()?.find(row => row.pid === child.pid);
  if (!identity) throw new Error('Cannot establish owned service identity');
  killOwnTree(child);
  await until(() => {
    const rows = snapshotProcessTable();
    return rows && !rows.some(row => row.pid === identity.pid && row.created === identity.created);
  }, 'owned service exit');
  server = null;
}
async function turn(sessionId, message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId, message, cwd: work }),
    signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('turn HTTP ' + res.status);
  const events = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await api('/api/sessions/' + sessionId)).execution === null, 'driver finally');
  observations.push({ sessionId, message, events }); return events;
}
(async () => {
  const proof = [], resumeChecks = [], specs = [];
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const ledgerFile = path.join(data, 'desktop-executions-v1/state.json');
  function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after ' + label); }
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_EXECUTION_DISPATCH_REQUIRED !== '1') { console.log('SKIP opt-in actual Mac root execution dispatch'); return; }
    const helper = process.env.RUYI_EXECUTION_CONTEXT_HELPER, python = process.env.RUYI_ACC_PYTHON;
    if (!helper || !python) throw new Error('Explicit candidate helper and Python required');
    const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
    provider = await startFakeProvider({ handler(req) {
      const text = JSON.stringify(req.messages.filter(row => row.role === 'user').at(-1)?.content);
      const spec = specs.find(row => text.includes(row.label));
      if (!spec) return textFrames('metadata fixture');
      const toolRows = req.messages.filter(row => row.role === 'tool');
      const responses = toolRows.filter(row => spec.calls.some(call => call.id === row.tool_call_id));
      if (responses.length === spec.calls.length) {
        const saved = JSON.parse(fs.readFileSync(ledgerFile));
        const rows = saved.entries.filter(row => row.sessionId === spec.sessionId);
        resumeChecks.push({ label: spec.label, rows, requests: req.messages });
        return textFrames('DISPATCH_VERIFIED_COMPLETE');
      }
      if (spec.direct && !req.tools.some(tool => tool.function?.name === spec.calls[0].name)) {
        if (toolRows.some(row => row.tool_call_id === 'load_' + spec.label)) throw new Error('Direct tool still absent after tool_load');
        return toolCallFrames('tool_load', { tools: [...new Set(spec.calls.map(row => row.name))] }, 'load_' + spec.label);
      }
      return toolCallFrames(spec.calls);
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'bypass', defaultWorkspace: work,
      providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic-key', model: 'fake-model' }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      allowDesktopTools: true, allowCommandTools: true, desktopMcp: { enabled: false, autodetect: false }, bridgeExternalToolsToProvider: true,
      externalMcpServers: [{ id: 'ai-computer-control', enabled: true, command: python,
        args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: acc, startupTimeoutMs: 20000,
        env: { ...env, PYTHONPATH: path.join(acc, 'src'), PYTHONDONTWRITEBYTECODE: '1', WCW_DATA_DIR: path.join(root, 'acc-data'),
          RUYI_EXECUTION_CONTEXT_REQUIRED: '0', ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } }] }));
    env.RUYI_DESKTOP_EXECUTION_RECEIPTS = '1';
    await start();
    const readiness = await api('/api/capabilities?force=1'); proof.push({ readiness });
    check(readiness.desktopMcp?.present === true && readiness.desktopMcp.optional.uia === true && readiness.desktopMcp.optional.ocr === true,
      'actual root readiness uses fixed receipt control while required-mode diagnostics stays refused');
    for (const direct of [true, false]) {
      const spec = { label: direct ? 'DISPATCH_DIRECT' : 'DISPATCH_PROXY', direct,
        calls: [
          { name: direct ? 'ai_computer_control__wait' : 'tool_invoke_read', args: direct ? { seconds: 0 } : { name: 'ai_computer_control__wait', arguments: { seconds: 0 } }, id: 'call_wait' },
          { name: direct ? 'ai_computer_control__get_mouse_position' : 'tool_invoke_read', args: direct ? {} : { name: 'ai_computer_control__get_mouse_position', arguments: {} }, id: 'call_position' }] };
      spec.sessionId = (await api('/api/sessions', { title: spec.label, cwd: work })).session.id; specs.push(spec);
      const events = await turn(spec.sessionId, spec.label);
      proof.push({ spec, events });
      check(!events.some(event => event.type === 'error') && JSON.stringify(events).includes('DISPATCH_VERIFIED_COMPLETE'),
        spec.label + ' normal actual provider turn completes wait and native read');
      const rows = JSON.parse(fs.readFileSync(ledgerFile)).entries.filter(row => row.sessionId === spec.sessionId);
      check(rows.length === 2 && rows.every(row => row.phase === 'returned' && typeof row.deliverySha256 === 'string' && row.observed?.receipt),
        spec.label + ' two actual invocations have independently verified receipts and durable deliveries');
      const resume = resumeChecks.find(row => row.label === spec.label);
      check(resume?.rows.length === 2 && resume.rows.every(row => row.deliverySha256 && row.phase === 'returned'),
        spec.label + ' durable delivery barrier completes before provider continuation');
      const history = fs.readFileSync(path.join(data, 'sessions', spec.sessionId + '.provider.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
      for (const row of rows) {
        const trace = path.join(root, 'acc-data/logs/execution-receipts', row.invocationId);
        const records = fs.readFileSync(path.join(trace, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
        const marker = JSON.parse(fs.readFileSync(path.join(trace, 'commit.json'))), bytes = fs.readFileSync(path.join(trace, 'events.ndjson'));
        check(marker.bytes === bytes.length && marker.sha256 === hash(bytes) && marker.sequence === records.length,
          spec.label + ' exact actual committed receipt prefix: ' + row.toolName);
        const accepted = records[0];
        check(accepted.stage === 'acc_request_accepted' && accepted.session_id === spec.sessionId && accepted.call_id_hash === row.callIdHash
          && accepted.caller_args_sha256 === row.argsSha256 && accepted.acc_worker_id === row.accWorkerId && accepted.acc_pid === row.accPid,
          spec.label + ' ledger binds actual SDK worker/tool/turn/argument receipt: ' + row.toolName);
        const expectedCall = row.toolName === 'wait' ? 'call_wait' : 'call_position';
        const index = history.findIndex(message => message.role === 'tool' && message.tool_call_id === expectedCall);
        check(index >= 0 && history.some((_message, end) => end >= index && hash(JSON.stringify(history.slice(0, end + 1))) === row.deliverySha256),
          spec.label + ' delivery digest matches actual saved provider-history prefix: ' + row.toolName);
        if (row.toolName === 'get_mouse_position') check(records.some(record => record.stage === 'native_entered') && records.some(record => record.stage === 'native_terminal' && record.ok),
          spec.label + ' actual native entry/terminal read occurs under same invocation');
        proof.push({ invocationId: row.invocationId, row, records, marker });
      }
    }
    const rows = JSON.parse(fs.readFileSync(ledgerFile)).entries;
    check(rows.length === 4 && rows.every(row => row.accWorkerId === rows[0].accWorkerId && row.accPid === rows[0].accPid),
      'ordinary direct and proxy paths share actual required-context owned ACC incarnation');
    await stop(); await start();
    const before = JSON.parse(fs.readFileSync(ledgerFile)).entries;
    check(before.length === 4 && before.every(row => row.phase === 'returned' && row.deliverySha256), 'real service restart retains acknowledged results without replay');
    check(JSON.stringify(before.map(row => row.invocationId)) === JSON.stringify(rows.map(row => row.invocationId)), 'restart never invents new desktop invocation identities');
    await stop();
    const configPath = path.join(data, 'config.json'), aliasConfig = JSON.parse(fs.readFileSync(configPath));
    aliasConfig.externalMcpServers[0].id = 'alias-acc'; fs.writeFileSync(configPath, JSON.stringify(aliasConfig));
    const alias = { label: 'DISPATCH_ALIAS', direct: false, calls: [{ name: 'tool_invoke_read', args: { name: 'alias_acc__wait', arguments: { seconds: 0 } }, id: 'alias_wait' }] };
    await start(); alias.sessionId = (await api('/api/sessions', { title: alias.label, cwd: work })).session.id; specs.push(alias);
    const aliasEvents = await turn(alias.sessionId, alias.label);
    const aliasRows = JSON.parse(fs.readFileSync(ledgerFile)).entries.filter(row => row.sessionId === alias.sessionId);
    check(!aliasEvents.some(event => event.type === 'error') && aliasRows.length === 1 && aliasRows[0].phase === 'returned' && aliasRows[0].deliverySha256,
      'recognized ACC connector alias is forced through required-context and actual receipt/delivery path');
    proof.push({ spec: alias, events: aliasEvents, rows: aliasRows });
    await stop();
    aliasConfig.externalMcpServers[0].id = 'ai-computer-control'; fs.writeFileSync(configPath, JSON.stringify(aliasConfig));
    const faultTarget = path.join(work, 'must-not-exist.txt'), preload = path.join(root, 'result-fault.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs');const original=fs.promises.rename;let fired=false;\nfs.promises.rename=async function(from,to){if(!fired&&to===${JSON.stringify(ledgerFile)}){const value=JSON.parse(fs.readFileSync(from));const row=value.entries.at(-1);if(row?.phase==='returned'&&row.deliverySha256===null){fired=true;fs.writeFileSync(${JSON.stringify(path.join(root, 'fault-hit.json'))},JSON.stringify({invocationId:row.invocationId,phase:row.phase,committedBeforeFailure:JSON.parse(fs.readFileSync(to)).entries.find(entry=>entry.invocationId===row.invocationId)}));throw Object.assign(new Error('isolated fixture rejects actual result commit'),{code:'EIO'});}}return original.call(this,from,to);};\n`);
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + preload;
    const fault = { label: 'DISPATCH_RESULT_FAULT', direct: false, calls: [
      { name: 'tool_invoke_read', args: { name: 'ai_computer_control__wait', arguments: { seconds: 0 } }, id: 'fault_wait' },
      { name: 'file_write', args: { path: faultTarget, content: 'must never dispatch' }, id: 'fault_next_local_write' }] };
    await start(); fault.sessionId = (await api('/api/sessions', { title: fault.label, cwd: work })).session.id; specs.push(fault);
    const faultEvents = await turn(fault.sessionId, fault.label), faultRows = JSON.parse(fs.readFileSync(ledgerFile)).entries.filter(row => row.sessionId === fault.sessionId);
    proof.push({ spec: fault, events: faultEvents, rows: faultRows });
    const faultCapture = JSON.parse(fs.readFileSync(path.join(root, 'fault-hit.json')));
    check(faultRows.length === 1 && faultCapture.committedBeforeFailure.phase === 'dispatching'
      && faultCapture.committedBeforeFailure.observed === null && faultCapture.committedBeforeFailure.deliverySha256 === null,
      'actual ACC wait returns but isolated Node observation commit failure retains the original durable unresolved dispatch intent');
    check(faultRows[0].phase === 'unknown' && faultRows[0].holdReason === 'host_call_incomplete'
      && faultRows[0].observed === null && faultRows[0].deliverySha256 === null,
      'same root durably records uncertainty after observation failure without inventing returned output');
    check(!fs.existsSync(faultTarget) && !faultEvents.some(event => event.type === 'tool_use' && event.id === 'fault_next_local_write'),
      'unknown first ACC result prevents later same-batch local file_write dispatch');
    check(!resumeChecks.some(row => row.label === fault.label), 'unknown result stops provider continuation rather than feeding ordinary retry advice');
    check(faultEvents.some(event => event.type === 'error' || event.type === 'result' && event.ok === false), 'unknown execution produces an explicit failed turn result');
    const trace = path.join(root, 'acc-data/logs/execution-receipts', faultRows[0].invocationId);
    const records = fs.readFileSync(path.join(trace, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    check(records.some(row => row.stage === 'tool_terminal' && row.tool === 'wait') && records.at(-1).stage === 'acc_request_terminal',
      'fault scope distinguishes actual completed ACC wait from missing Node result persistence');
    proof.push({ spec: fault, events: faultEvents, rows: faultRows, records, fault: JSON.parse(fs.readFileSync(path.join(root, 'fault-hit.json'))) });
    await stop();
    delete env.NODE_OPTIONS;
    await start();
    const held = await turn(fault.sessionId, 'new request after result fault');
    check(held.some(row => row.type === 'error') && JSON.parse(fs.readFileSync(ledgerFile)).entries.find(row => row.sessionId === fault.sessionId)?.phase === 'unknown'
      && !fs.existsSync(faultTarget), 'actual restart converts abandoned intent to hold and never replays either same-batch tool');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    try { await stop(); } catch (error) { t.fail('cleanup ' + error.message); }
    if (provider) await provider.close();
    if (process.env.RUYI_EXECUTION_DISPATCH_EVIDENCE) fs.writeFileSync(process.env.RUYI_EXECUTION_DISPATCH_EVIDENCE,
      JSON.stringify({ scope: 'actual normal root/provider/direct/proxy wait and mouse-position chain; no input mutation, GUI, held faults, subagent/CLI delivery or full P5', root, proof, observations, resumeChecks, output }, null, 2));
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
