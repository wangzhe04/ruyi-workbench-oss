'use strict';
require('./lib/self-isolate-home');
// Real MCP stdio/SDK/tool wrappers/native journal chain using host-generated transport metadata.
// No provider workflow or Node prepared/restart/replay ledger yet. Only wait/mouse-position queries.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { loadServerInternals } = require('./lib/server-internals');
const { McpStdioClient, ProcessRuntime, executionArgumentsDigest, probeDesktopExecutionReceipts } = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'executionArgumentsDigest', 'probeDesktopExecutionReceipts']);
const t = createRunner('MACOS EXECUTION CONTEXT');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-execution-context-'));
const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
const reports = [], cleanup = [];
const META = 'org.ruyi.workbench/execution-v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let client, child, retained = false;
function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after ' + label); }
function metadata(args, tool = 'macro_run', id = crypto.randomBytes(16).toString('hex')) {
  return { [META]: { schema: 1, invocation_id: id, session_id: 'sess_transport_fixture', turn_seq: 1,
    call_id_hash: hash('fixture_call_' + id), args_sha256: hash(JSON.stringify(args)), args_codec: 'javascript-json-utf8-v1', args_semantic_sha256: executionArgumentsDigest(args), args_semantic_codec: 'ruyi-sdk-json-v1', tool_name: tool } };
}
async function call(name, args, meta) {
  const result = await client.callTool(name, args, undefined, meta ? { meta } : {});
  reports.push({ name, args, meta, result });
  return result;
}
async function receipt(meta) { return call('execution_receipt', { invocation_id: meta[META].invocation_id }); }
function blob(meta, row) { return JSON.parse(fs.readFileSync(path.join(root, 'acc-data/logs/execution-receipts', meta[META].invocation_id, row.args_ref), 'utf8')); }
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_EXECUTION_CONTEXT_REQUIRED !== '1') { console.log('SKIP opt-in real Mac execution context'); return; }
    const helper = process.env.RUYI_EXECUTION_CONTEXT_HELPER;
    const python = process.env.RUYI_ACC_PYTHON;
    if (!helper || !python) throw new Error('Explicit candidate helper and Python are required');
    const env = { ...fixtureChildEnv(), HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'),
      APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l'), TMPDIR: root,
      WCW_DATA_DIR: path.join(root, 'acc-data'), PYTHONPATH: path.join(acc, 'src'), PYTHONDONTWRITEBYTECODE: '1',
      ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper,
      RUYI_EXECUTION_CONTEXT_REQUIRED: '1',
      DYLD_FRAMEWORK_PATH: process.env.DYLD_FRAMEWORK_PATH, DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH };
    for (const dir of [env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
    client = new McpStdioClient({ id: 'ai-computer-control', command: python, args: ['-X', 'utf8', '-m', 'ai_computer_control.server'],
      cwd: acc, env, startupTimeoutMs: 20000, toolTimeoutMs: 10000 });
    await client.start(); child = client.child;
    check(client.listTools().some(tool => tool.name === 'execution_receipt'), 'actual SDK registry advertises the independent evidence reader');
    const probe = await probeDesktopExecutionReceipts({ callTool: async (...params) => {
      const result = await client.callTool(...params); reports.push({ probe: true, params, result }); return result;
    } });
    reports.push({ probeResult: probe });
    check(probe.ok === true, 'safe actual SDK roundtrip acknowledges metadata nonce, numeric categories and worker identity');
    check(fs.readdirSync(path.join(root, 'acc-data/logs/execution-receipts')).length === 0,
      'safe metadata probe creates no execution traces or native actions');
    const unmarkedProbe = await call('execution_receipt', { invocation_id: '0'.repeat(32), probe_values: { schema: 1, nonce: 'a'.repeat(32) } });
    check(!Object.hasOwn(unmarkedProbe, 'metadata_probe'), 'model probe arguments cannot fabricate transport acknowledgement');
    for (const [name, args] of [['wait', { seconds: 0 }], ['macro_run', { steps: [{ tool: 'wait', args: { seconds: 0 } }] }],
      ['get_mouse_position', {}]]) {
      const missing = await call(name, args);
      check(missing.ok === false && missing.code === 'execution_metadata_required' && missing.action_sent === false
        && missing.outcome === 'not_dispatched', 'required-context owned ACC refuses metadata loss before body: ' + name);
    }
    check(fs.readdirSync(path.join(root, 'acc-data/logs/execution-receipts')).length === 0,
      'contextless refusals create no false invocation evidence');
    const args = { steps: [{ tool: 'wait', args: { seconds: 0 } }, { tool: 'get_mouse_position', args: {} }], delay_ms: 0 };
    const meta = metadata(args);
    const result = await call('macro_run', args, meta);
    check(result.ok === true && result.completed === 2, 'real metadata call completes wait plus read-only native query');
    const records = await receipt(meta);
    check(records.ok === true && records.metadata_transport_supported === true && records.request_terminal_observed === true && records.incomplete === false,
      'separate MCP read observes the committed request terminal');
    check(records.semantic_validation?.semantic_version === 1 && records.semantic_validation.lifecycle_unknown === false
      && records.semantic_validation.reported_unknown_operation_ids.length === 0,
      'product reader validates complete causal graph and every actual private argument/native frame blob');
    const rows = records.records, accepted = rows.find(row => row.stage === 'acc_request_accepted');
    check(accepted?.session_id === meta[META].session_id && accepted.call_id_hash === meta[META].call_id_hash
      && accepted.caller_args_sha256 === hash(JSON.stringify(args)) && accepted.acc_worker_id === probe.accWorkerId
      && accepted.acc_pid === probe.accPid, 'accepted metadata remains distinct from actual typed entry and binds the probed worker');
    const macro = rows.find(row => row.stage === 'tool_entered' && row.tool === 'macro_run');
    const children = rows.filter(row => row.stage === 'tool_entered' && row.parent_operation_id === macro?.operation_id);
    check(children.length === 2 && children[0].batch_step === 0 && children[1].batch_step === 1,
      'actual batch wrappers preserve parent operation and both returned step identities');
    const bound = blob(meta, macro);
    check(bound.on_error === 'stop' && bound.recording === null && bound.target === null, 'actual wrapper entry snapshots applied defaults');
    const entry = rows.find(row => row.stage === 'native_entered'), terminal = rows.find(row => row.stage === 'native_terminal');
    check(entry?.parent_operation_id === children[1].operation_id && terminal?.operation_id === entry.operation_id && terminal.ok === true,
      'actual SDK child operation links to verified native body and terminal');
    check(rows.some(row => row.stage === 'native_continue_intent') && rows.some(row => row.stage === 'native_continue_sent'),
      'product journal records continue intent and completed write');
    const typedArgs = { seconds: '0' }, typedMeta = metadata(typedArgs, 'wait');
    const typed = await call('wait', typedArgs, typedMeta); check(typed.ok === true, 'real SDK accepts its supported numeric coercion');
    const typedRows = (await receipt(typedMeta)).records;
    check(blob(typedMeta, typedRows.find(row => row.stage === 'acc_request_accepted')).seconds === '0'
      && blob(typedMeta, typedRows.find(row => row.stage === 'tool_entered')).seconds === 0,
      'received JSON arguments and actually typed tool arguments have separate exact snapshots');
    const before = JSON.stringify((await receipt(meta)).records);
    const duplicate = await call('macro_run', args, meta);
    check(duplicate.ok === false && duplicate.outcome === 'not_dispatched' && JSON.stringify((await receipt(meta)).records) === before,
      'duplicate invocation identity refuses before executing or overwriting evidence');
    const invalid = metadata(args); invalid[META].schema = true;
    const invalidResult = await call('macro_run', args, invalid);
    check(invalidResult.ok === false && invalidResult.code === 'execution_metadata_invalid'
      && !fs.existsSync(path.join(root, 'acc-data/logs/execution-receipts', invalid[META].invocation_id)),
      'invalid reserved metadata is rejected before any journal or tool execution');
    const changed = metadata(args);
    const changedResult = await call('macro_run', { ...args, delay_ms: 1 }, changed);
    check(changedResult.ok === false && changedResult.code === 'execution_arguments_mismatch'
      && !fs.existsSync(path.join(root, 'acc-data/logs/execution-receipts', changed[META].invocation_id)),
      'changed actual arguments are refused before a tool body or receipt journal');
    for (const number of [9007199254740992, 1000000000000000100, 1e20, 1e21, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const numericArgs = { seconds: 0, numeric_probe: number }, numericMeta = metadata(numericArgs, 'wait');
      const numericResult = await call('wait', numericArgs, numericMeta);
      const numericRows = (await receipt(numericMeta)).records;
      check(numericResult.ok === true && numericRows.some(row => row.stage === 'acc_request_accepted'),
        'legitimate JSON.stringify numeric token accepted without safe-integer restriction: ' + JSON.stringify(number));
    }
    for (const [prepared, changedWire] of [[9007199254740992, '9007199254740993'], [1000000000000000100, '1000000000000000128']]) {
      const numericArgs = { seconds: 0, numeric_probe: prepared }, numericMeta = metadata(numericArgs, 'wait');
      // JSON.rawJSON exercises the actual SDK with digits Node Number cannot represent exactly.
      const numericResult = await call('wait', { seconds: 0, numeric_probe: JSON.rawJSON(changedWire) }, numericMeta);
      check(numericResult.ok === false && numericResult.code === 'execution_arguments_mismatch'
        && !fs.existsSync(path.join(root, 'acc-data/logs/execution-receipts', numericMeta[META].invocation_id)),
        'distinct actual SDK integer rejected before journal/body despite binary64 collision: ' + changedWire);
    }
    const wrongTool = metadata({ seconds: 0 }, 'wait');
    const wrongToolResult = await call('get_mouse_position', { seconds: 0 }, wrongTool);
    check(wrongToolResult.ok === false && wrongToolResult.code === 'execution_arguments_mismatch',
      'host prepared tool name is bound independently of argument identity');
    const countBefore = fs.readdirSync(path.join(root, 'acc-data/logs/execution-receipts')).length;
    const modelMetaOnly = await call('get_mouse_position', { _meta: metadata({}) });
    check(modelMetaOnly.code === 'execution_metadata_required', 'model argument metadata cannot satisfy required transport context');
    check(fs.readdirSync(path.join(root, 'acc-data/logs/execution-receipts')).length === countBefore,
      'model arguments cannot activate the reserved transport context');
    const failedArgs = { steps: [{ tool: 'wait', args: { seconds: 0 } }, { tool: 'missing_fixture_tool' }], delay_ms: 0 };
    const failedMeta = metadata(failedArgs), failed = await call('macro_run', failedArgs, failedMeta);
    const failedRows = (await receipt(failedMeta)).records;
    check(failed.ok === false && failedRows.find(row => row.stage === 'tool_terminal' && row.tool === 'macro_run')?.ok === false
      && failedRows.find(row => row.stage === 'acc_request_terminal')?.ok === true,
      'SDK transport completion does not convert failed tool outcome into success');
    check(failedRows.filter(row => row.stage === 'tool_entered').length === 2,
      'prevalidation refusal has no fabricated child execution entry');
    const failedAccepted = failedRows.find(row => row.stage === 'acc_request_accepted');
    const failedBlob = path.join(root, 'acc-data/logs/execution-receipts', failedMeta[META].invocation_id, failedAccepted.args_ref);
    const changedBlob = fs.readFileSync(failedBlob); changedBlob[0] = changedBlob[0] === 123 ? 91 : 123;
    fs.writeFileSync(failedBlob, changedBlob);
    const corruptReceipt = await receipt(failedMeta);
    check(corruptReceipt.ok === false && corruptReceipt.code === 'execution_receipt_semantics' && corruptReceipt.outcome === 'unknown'
      && corruptReceipt.request_terminal_observed === false && corruptReceipt.incomplete === true,
      'actual SDK reader refuses a committed terminal when its private argument evidence was corrupted');
    check(fs.readFileSync(failedBlob).equals(changedBlob), 'failed evidence validation preserves the original corrupt trace without resetting it');
    const traceDir = path.join(root, 'acc-data/logs/execution-receipts', meta[META].invocation_id);
    const eventsFile = path.join(traceDir, 'events.ndjson'), markerFile = path.join(traceDir, 'commit.json');
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n');
    lines[lines.length - 2] = lines[lines.length - 2].replace('"ok":true', '"ok":false,"ok":true');
    const ambiguous = lines.join('\n'), marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    fs.writeFileSync(eventsFile, ambiguous); marker.bytes = Buffer.byteLength(ambiguous); marker.sha256 = hash(ambiguous);
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    const ambiguousReceipt = await receipt(meta);
    check(ambiguousReceipt.incomplete === true && ambiguousReceipt.request_terminal_observed === false
      && ambiguousReceipt.semantic_validation?.lifecycle_unknown === true,
      'actual SDK reader rejects ambiguous terminal keys even when the committed byte hash matches');


  } catch (error) { retained = true; t.fail(error.stack || String(error)); }
  finally {
    if (client) {
      const target = child || client.child;
      const result = client.kill(); cleanup.push(result);
      if (target) {
        const confirmed = await ProcessRuntime.waitForCleanup(target); cleanup.push(confirmed);
        t.ok(confirmed?.incomplete === false, 'owned ACC and native process cleanup is confirmed');
        if (confirmed?.incomplete !== false) retained = true;
      }
    }
    const evidence = process.env.RUYI_EXECUTION_CONTEXT_EVIDENCE;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ reports, cleanup, retained, retainedRoot: retained ? root : null }, null, 2) + '\n'); }
    if (!retained) fs.rmSync(root, { recursive: true, force: true });
    else console.log('Retained execution context fixture: ' + root);
    t.done();
  }
})();
