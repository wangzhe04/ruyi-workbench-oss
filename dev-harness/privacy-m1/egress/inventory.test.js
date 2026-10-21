'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inventory = require('./inventory');
const policy = { privacyStatus: 'unknown', transport: 'unresolved', dataClasses: ['synthetic'], recipient: 'fixture', purpose: 'offline test', productionRelation: 'fixture only', evidence: 'synthetic source, never executed' };
function reviewed(scan) {
  return { schemaVersion: 1, sources: scan.sources, groups: { unknown: policy }, entries: scan.findings.map(f => ({ id: f.id, fingerprint: f.fingerprint, group: 'unknown' })) };
}
function fixture(t, code = 'function send() { return fetch(endpoint, {body: payload}); }') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-egress-'));
  const dir = path.join(root, 'ruyi-workbench/app/src'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.js'); fs.writeFileSync(file, code);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}
test('new actual fetch, WebSocket, alias chain and renamed import fail reviewed fixture gate', t => {
  const { root, file } = fixture(t); const before = inventory.scan(root), manifest = reviewed(before);
  assert.deepEqual(inventory.validate(before, manifest), []);
  fs.appendFileSync(file, '\nconst alias = fetch; const sendAgain = alias; sendAgain(url); const {request: transmit}=require("node:https"); transmit(url); new WebSocket(url);');
  const after = inventory.scan(root), errors = inventory.validate(after, manifest);
  assert(errors.some(e => e.startsWith('source-unreviewed:')));
  for (const callee of ['sendAgain', 'transmit', 'WebSocket']) {
    const f = after.findings.find(f => f.callee === callee); assert(f, callee); assert(errors.includes('unclassified:' + f.id));
  }
});
test('computed dispatch, bound fetch, runtime import and template interpolation enter explicit unknown review', t => {
  const { root, file } = fixture(t, 'const safe = 1;'); const manifest = reviewed(inventory.scan(root));
  fs.writeFileSync(file, 'const fn = globalThis[method]; globalThis[method](url); const bound=fetch.bind(globalThis); bound(url); import(moduleName); const s = `${fetch(url)}`;');
  const after = inventory.scan(root), errors = inventory.validate(after, manifest);
  for (const callee of ['<computed-call>', '<transport-reference>', 'import', '<template-code>']) assert(after.findings.some(f => f.callee === callee), callee);
  assert(after.findings.filter(f => f.category === 'dynamic').every(f => errors.includes('unclassified:' + f.id)));
});
test('module import unknown covers imported ESM alias not resolved by simple propagation', t => {
  const { root } = fixture(t, 'import {request as send} from "node:https"; send(url);');
  const after = inventory.scan(root); assert(after.findings.some(f => f.category === 'capability'));
  assert(inventory.validate(after, reviewed({ ...after, findings: [] })).some(e => e.startsWith('unclassified:')));
});
test('Python urllib opener, DNS, subprocess and renamed function import are inventoried without importing Python', t => {
  const { root } = fixture(t, ''); const dir = path.join(root, 'mcp/example/src'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'example.py'), 'from urllib.request import urlopen as send\nimport subprocess\nimport socket\ndef emit(\n    url,\n):\n    send(url)\n    opener.open(url)\n    socket.getaddrinfo(host, 443)\n    subprocess.Popen(argv)\n');
  const after = inventory.scan(root);
  for (const c of ['send', 'open', 'getaddrinfo', 'Popen']) assert(after.findings.some(f => f.callee === c && f.symbol === 'emit'), c);
  assert(after.findings.some(f => f.callee === '<python-transport-import>'));
});
test('independent workbench MCP stdout serializers and tool/resource/error/progress wrapper calls require review', t => {
  const { root, file } = fixture(t, 'const ready = true;'); const manifest = reviewed(inventory.scan(root));
  fs.writeFileSync(file, `function sendMcp(id,result,error){process.stdout.write(JSON.stringify({id,result,error}));}
function sendMcpNotification(method,params){process.stdout.write(JSON.stringify({method,params}));}
function toolResult(){sendMcp(id,{content:[{type:'text',text},{type:'image',data}]});}
function resourceResult(){sendMcp(id,{contents:[{uri,text}]});}
function failed(){sendMcp(id,null,error);}
function progress(){sendMcpNotification('notifications/progress',{progressToken,progress:1});}`);
  const scan = inventory.scan(root), errors = inventory.validate(scan, manifest);
  const stdout = scan.findings.filter(f => f.category === 'stdio-output');
  assert.deepEqual(stdout.map(f => f.symbol).sort(), ['sendMcp', 'sendMcpNotification']);
  for (const symbol of ['toolResult', 'resourceResult', 'failed', 'progress']) assert(scan.findings.some(f => f.symbol === symbol && f.category === 'wrapper'), symbol);
  assert(scan.findings.every(f => errors.includes('unclassified:' + f.id)));
});
test('model POST wrapper preserves business entry candidates separately from physical fetch', t => {
  const { root, file } = fixture(t, `async function providerModelPostOnce(args){return fetch(args.url);}
function providerPostJsonOnce(){return providerModelPostOnce(args);}
function probeProviderCompletion(){return providerModelPostOnce(args);}
function openAiStreamOnce(){const doFetch=b=>providerModelPostOnce(b);}
function singleSummaryCall(){return providerModelPostOnce(args);}`);
  const scan = inventory.scan(root), manifest = reviewed(scan);
  assert.equal(scan.findings.filter(f => f.callee === 'fetch').length, 1);
  const wrappers = scan.findings.filter(f => f.callee === 'providerModelPostOnce');
  assert.deepEqual(wrappers.map(f => f.symbol).sort(), ['openAiStreamOnce', 'probeProviderCompletion', 'providerPostJsonOnce', 'singleSummaryCall']);
  assert(wrappers.every(f => f.category === 'wrapper'));
  fs.appendFileSync(file, '\nfunction another(){return providerModelPostOnce(args);}');
  const after = inventory.scan(root), added = after.findings.find(f => f.symbol === 'another');
  assert(added); assert(inventory.validate(after, manifest).includes('unclassified:' + added.id));
});

test('removed endpoint, changed body, deleted file and removed classification cannot silently pass', t => {
  const { root, file } = fixture(t); const before = inventory.scan(root), manifest = reviewed(before);
  const removed = structuredClone(manifest); removed.entries = []; assert(inventory.validate(before, removed).some(e => e.startsWith('unclassified:')));
  const invalid = structuredClone(manifest); delete invalid.groups.unknown.recipient; assert(inventory.validate(before, invalid).some(e => e.startsWith('invalid-classification:')));
  fs.writeFileSync(file, 'function send() { return fetch(endpoint, {body: differentPayload}); }');
  assert(inventory.validate(inventory.scan(root), manifest).some(e => e.startsWith('changed-boundary:')));
  fs.writeFileSync(file, 'function send() { return null; }'); assert(inventory.validate(inventory.scan(root), manifest).some(e => e.startsWith('stale-classification:')));
  fs.unlinkSync(file); assert(inventory.validate(inventory.scan(root), manifest).some(e => e.startsWith('source-deleted:')));
});
test('a new unrecognized syntax shape still requests source review, without pretending to identify an endpoint', t => {
  const { root, file } = fixture(t, 'const values = [];'); const manifest = reviewed(inventory.scan(root));
  fs.appendFileSync(file, '\nconst opaqueTransport = factory(pluginName); opaqueTransport.dispatch(payload);');
  const after = inventory.scan(root); assert.equal(after.findings.length, 0);
  assert(inventory.validate(after, manifest).some(e => e.startsWith('source-unreviewed:')));
});
test('new declarative MCP connector configuration is an unknown capability', t => {
  const { root } = fixture(t, ''); const manifest = reviewed(inventory.scan(root));
  const dir = path.join(root, 'mcp/new-connector'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ruyi-mcp.json'), '{"mcp":{"transport":"http","url":"https://synthetic.invalid"}}');
  const after = inventory.scan(root); assert(after.findings.some(f => f.callee === '<configuration>'));
  assert(inventory.validate(after, manifest).some(e => e.startsWith('unclassified:')));
});
test('generated server and packaged/vendor/test copies do not duplicate first-party source candidates', t => {
  const { root } = fixture(t); const before = inventory.scan(root);
  for (const rel of ['ruyi-workbench/app/server.js', 'ruyi-workbench/app/public/vendor/copied.js', 'mcp/x/build_offline/runtime.js', 'mcp/x/tests/test.py']) {
    const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'fetch(endpoint);');
  }
  assert.deepEqual(inventory.scan(root), before);
  assert.equal(new Set(before.sources.map(s => s.file)).size, before.sources.length);
  assert.equal(before.findings.filter(f => f.callee === 'fetch').length, 1);
});
test('identical source bytes generate deterministic output without payload literals; comments request review without manufacturing sends', t => {
  const { root, file } = fixture(t, 'function send(){fetch("SYNTHETIC_PRIVATE_VALUE",{body:"OTHER_SYNTHETIC_SECRET"});}');
  const first = inventory.scan(root), manifest = reviewed(first), rendered = inventory.render(first, manifest);
  const second = inventory.scan(root); assert.deepEqual(second, first);
  assert.deepEqual(inventory.render(second, manifest), rendered);
  assert.equal(inventory.formatJson(rendered), inventory.formatJson(inventory.render(second, manifest)));
  assert.equal(inventory.markdown(rendered), inventory.markdown(inventory.render(second, manifest)));
  assert(!JSON.stringify(rendered).includes('SYNTHETIC_PRIVATE_VALUE')); assert(!JSON.stringify(rendered).includes('OTHER_SYNTHETIC_SECRET'));
  fs.writeFileSync(file, '// comment mentioning fetch(fake)\nfunction send() { /* spacing */ fetch( "SYNTHETIC_PRIVATE_VALUE", { body: "OTHER_SYNTHETIC_SECRET" } ); }');
  const comments = inventory.scan(root); assert.deepEqual(comments.findings, first.findings);
  assert(inventory.validate(comments, manifest).some(e => e.startsWith('source-unreviewed:')));
});
test('meaningful Python indentation, JS return newline and PowerShell continuation changes require source review', t => {
  const { root, file } = fixture(t, 'function f() { return payload; }');
  const py = path.join(root, 'ruyi-workbench/app/src/indent.py'), ps = path.join(root, 'ruyi-workbench/app/src/continuation.ps1');
  fs.writeFileSync(py, 'if allowed:\n    send(payload)\n'); fs.writeFileSync(ps, '$result = value\n');
  const manifest = reviewed(inventory.scan(root));
  fs.writeFileSync(file, 'function f() { return\npayload; }'); fs.writeFileSync(py, 'if allowed:\n  send(payload)\n'); fs.writeFileSync(ps, '$result = value`\n');
  const errors = inventory.validate(inventory.scan(root), manifest);
  for (const name of ['sample.js', 'indent.py', 'continuation.ps1']) assert(errors.some(e => e.startsWith('source-unreviewed:') && e.endsWith(name)), name);
});
test('classification edits invalidate generated review; duplicate entries and unsupported protection claims fail', t => {
  const { root } = fixture(t); const scan = inventory.scan(root), manifest = reviewed(scan);
  const before = inventory.render(scan, manifest); const edited = structuredClone(manifest); edited.groups.unknown.purpose = 'changed classification';
  assert.notEqual(inventory.render(scan, edited).manifestFingerprint, before.manifestFingerprint);
  const protectedClaim = structuredClone(manifest); protectedClaim.groups.unknown.privacyStatus = 'protected';
  assert(inventory.validate(scan, protectedClaim).some(e => e.startsWith('protected-without-runtime-evidence:')));
  const duplicates = structuredClone(manifest); duplicates.entries.push(duplicates.entries[0]); assert(inventory.validate(scan, duplicates).some(e => e.startsWith('duplicate-classification:')));
});
test('repository review retains one physical model POST and all four business entry classifications', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')), scan = inventory.scan();
  assert.deepEqual(inventory.validate(scan, manifest), []);
  const modelSends = scan.findings.filter(f => f.callee === 'fetch' && f.symbol === 'providerModelPostOnce');
  assert.equal(modelSends.length, 1);
  const modelEntries = scan.findings.filter(f => f.callee === 'providerModelPostOnce');
  assert.deepEqual(modelEntries.map(f => f.symbol).sort(), ['openAiStreamOnce', 'probeProviderCompletion', 'providerPostJsonOnce', 'singleSummaryCall']);
  assert(modelEntries.every(f => f.category === 'wrapper'));
  assert(!scan.findings.some(f => f.callee === 'fetch' && ['providerPostJsonOnce', 'probeProviderCompletion', 'openAiStreamOnce', 'singleSummaryCall'].includes(f.symbol)));
  const byId = new Map(manifest.entries.map(e => [e.id, e]));
  for (const f of [...modelSends, ...modelEntries]) assert.equal(manifest.groups[byId.get(f.id).group].privacyStatus, 'model-only');
  assert(!Object.values(manifest.groups).some(p => p.privacyStatus === 'protected'));
  const ownMcp = scan.findings.filter(f => f.file.endsWith('13-http-router.js') && f.category === 'stdio-output');
  assert.deepEqual(ownMcp.map(f => f.symbol).sort(), ['sendMcp', 'sendMcpNotification']);
  for (const f of ownMcp) assert.equal(byId.get(f.id).group, 'workbench-mcp-output');
  assert.notEqual(manifest.groups['workbench-mcp-output'], manifest.groups.mcp);
  assert.notEqual(manifest.groups['workbench-mcp-output'], manifest.groups['acc-server']);
  const audio = scan.findings.find(f => f.symbol === 'transcribeAudioViaProvider' && f.callee === 'fetch');
  assert.equal(manifest.groups[byId.get(audio.id).group].privacyStatus, 'unknown');
  assert.match(manifest.groups[byId.get(audio.id).group].evidence, /TOCTOU/);
});

test('clipboard writes, optional receivers and method aliases enter manual review without acquiring a protected classification', t => {
  const { root, file } = fixture(t, 'const ready = true;'); const manifest = reviewed(inventory.scan(root));
  fs.writeFileSync(file, `navigator.clipboard.writeText(text); navigator.clipboard?.write(items);
const copied=navigator.clipboard; const copy2=copied; copy2.write(items);
const send=navigator.clipboard.writeText; send(text);
const {write:sendItems}=navigator.clipboard; sendItems(items);`);
  const after = inventory.scan(root), errors = inventory.validate(after, manifest);
  for (const callee of ['writeText', 'write', 'send', 'sendItems']) {
    const candidates = after.findings.filter(row => row.callee === callee);
    assert(candidates.length > 0, callee);
    assert(candidates.every(row => row.category === 'delegated' && errors.includes('unclassified:' + row.id)));
  }
  assert(after.findings.filter(row => row.callee === 'write').length >= 2);
});
