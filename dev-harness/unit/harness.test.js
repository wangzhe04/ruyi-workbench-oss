#!/usr/bin/env node
// lib/harness.js 的单测:打印口径必须是 run-all.js 解析的那一套(PASS/FAIL 行、判定行、退出码)。
// 真起子进程跑 —— done() 会动 process.exitCode / process.exit,不能在 node --test 的进程里直调。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'harness.js');

it('desktop export proof binds the durable receipt, physical package and authenticated download', async t => {
  const fs = require('node:fs'), http = require('node:http'), os = require('node:os');
  const { read } = require('../lib/work-data-production-upload-core');
  const { verifyExportPackage } = require('../lib/desktop-handoff-export.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-export-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'a'.repeat(48), authority = { generation: 0, id: null, mode: 'plain', sha256: null };
  const file = path.join(dir, 'ruyi-work-data-' + id + '.ruyi-backup');
  const bytes = Buffer.from('synthetic package');
  fs.writeFileSync(file, bytes);
  const disk = read(file).row;
  const saved = { id, operation: 'export', state: 'verified', authority, sourceAuthority: authority,
    backup: { path: file, sha256: disk.sha256, bytes: disk.bytes, identity: { dev: disk.dev, ino: disk.ino } } };
  fs.mkdirSync(path.join(dir, '.work-data'));
  const resultFile = path.join(dir, '.work-data', 'maintenance-result-v1.json');
  fs.writeFileSync(resultFile, JSON.stringify(saved));
  const durable = read(resultFile).row;
  const record = { ...saved, backupState: 'present', proof: {
    sha256: durable.sha256, identity: { dev: durable.dev, ino: durable.ino } } };
  let body = bytes;
  const server = http.createServer((req, res) => {
    const matched = req.url === '/api/work-data/results/' + id + '/package' && req.headers['x-wcw-token'] === 'fixture';
    res.writeHead(matched ? 200 : 403, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const input = { url: 'http://127.0.0.1:' + server.address().port, token: 'fixture', id, backups: dir, data: dir,
    sourceAuthority: authority, record };
  assert.deepEqual(await verifyExportPackage(input), { bytes: bytes.length, sha256: disk.sha256, recordSha256: durable.sha256 });
  for (const invalid of [undefined, null, {}]) {
    const matching = { ...record, sourceAuthority: invalid, authority: invalid };
    await assert.rejects(verifyExportPackage({ ...input, sourceAuthority: invalid, record: matching }), /fresh plaintext authority/);
  }
  body = Buffer.from(bytes);
  body[body.length - 1] ^= 1;
  await assert.rejects(verifyExportPackage(input), /downloaded export differs/);
  body = bytes;
  fs.writeFileSync(resultFile, JSON.stringify({ ...saved, id: 'b'.repeat(48) }));
  await assert.rejects(verifyExportPackage(input), /durable result/);
});

it('lifetime status requests reject a slow response even while JSON chunks keep arriving', async t => {
  const http = require('node:http');
  const { requestJson } = require('../lib/lifetime-loopback-json.cjs');
  const server = http.createServer((_req, res) => {
    res.write('{"ready":');
    let chunks = 0;
    const timer = setInterval(() => {
      if (++chunks === 30) res.end('true}');
      else res.write(' ');
    }, 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestJson('http://127.0.0.1:' + server.address().port, 'fixture', '/status', undefined, 250),
    { message: '/status timeout' });
});

function runScript(body) {
  const src = `const { createRunner } = require(${JSON.stringify(LIB)});\n${body}`;
  const r = cp.spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: String(r.stdout).split(/\r?\n/) };
}

describe('lib/harness createRunner', () => {
  it('all-pass: PASS lines, ALL PASS verdict, exit 0', () => {
    const r = runScript(`const t = createRunner('DEMO'); const { ok } = t; ok(true, 'A1 一'); ok(1, 'A2 二'); t.done();`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.filter(l => /^(PASS|FAIL)\b/.test(l)), ['PASS A1 一', 'PASS A2 二']);
    assert.equal(r.lines.filter(Boolean).pop(), 'DEMO E2E: ALL PASS');
    assert.equal(r.stderr, '');
  });

  it('failures: FAIL lines on stdout, FAIL (n) verdict, exit 1; fail() with/without label', () => {
    const r = runScript(`const t = createRunner('DEMO X'); const { ok } = t;
      const a = ok(false, 'B1 坏'); const b = ok(true, 'B2 好');
      t.fail('fatal: boom'); t.fail();
      console.log('failures=' + t.failures + ' a=' + a + ' b=' + b);
      t.done();`);
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines.filter(l => /^(PASS|FAIL)\b/.test(l)), ['FAIL B1 坏', 'PASS B2 好', 'FAIL fatal: boom']);
    assert.ok(r.lines.includes('failures=3 a=false b=true'));
    assert.equal(r.lines.filter(Boolean).pop(), 'DEMO X E2E: FAIL (3)');
    // run-all.js failLines() 的判据:/^\s*FAIL\b/ —— 判定行本身不能被当成一条断言
    const runAllFailLines = r.lines.filter(l => /^\s*FAIL\b/.test(l));
    assert.equal(runAllFailLines.length, 2);
  });

  it('done({ exit: true }) exits immediately with the verdict code even with pending handles', () => {
    const r = runScript(`const t = createRunner('HARD'); t.ok(false, 'C1'); setInterval(() => {}, 1000); t.done({ exit: true });`);
    assert.equal(r.status, 1);
    assert.equal(r.lines.filter(Boolean).pop(), 'HARD E2E: FAIL (1)');
  });

  it('verdict() and a bad name', () => {
    const { createRunner } = require(LIB);
    const t = createRunner('V');
    assert.equal(t.verdict(), 'V E2E: ALL PASS');
    assert.throws(() => createRunner(''), TypeError);
  });
});

describe('engine brief permanent entry shutdown', () => {
  const fs=require('node:fs'),vm=require('node:vm'),{functionBlock}=require('../lib/source-slice');
  const source=fs.readFileSync(path.join(__dirname,'../engine-env-brief.static.e2e.js'),'utf8');
  it('real binary capability call disables live network and MCP without replacing binary probes',async()=>{
    const processModel={env:{}},calls=[];
    const run=vm.runInNewContext(functionBlock(source,'probeEngineBriefBinaries')+';probeEngineBriefBinaries',{
      process:processModel,srv:{getCapabilities(config,force){calls.push({config,force});return Promise.resolve({binaries:{rg:true}});}}
    });
    assert.equal((await run()).binaries.rg,true);assert.equal(processModel.env.WCW_TEST_NO_NET_ANCHORS,'1');assert.equal(calls.length,1);
    assert.equal(calls[0].force,true);assert.equal(calls[0].config.providers.length,0);assert.equal(calls[0].config.externalMcpServers.length,0);
    assert.equal(calls[0].config.desktopMcp.enabled,false);assert.equal(calls[0].config.bridgeExternalToolsToProvider,false);
  });
  it('verdict waits for actual log drain and never calls process.exit',async()=>{
    let drained;const pending=new Promise(resolve=>{drained=resolve;}),lines=[],processModel={exit(){assert.fail('hard exit');}};
    const finish=vm.runInNewContext(functionBlock(source,'finishEngineEnvBrief')+';finishEngineEnvBrief',{
      process:processModel,console:{log:line=>lines.push(line)},flushWorkbenchLogs:()=>pending
    });
    const work=finish(0);await Promise.resolve();assert.deepEqual(lines,[]);assert.equal(processModel.exitCode,undefined);
    drained();await work;assert.equal(lines.at(-1),'ENGINE ENV BRIEF STATIC E2E: ALL PASS');assert.equal(processModel.exitCode,0);
    await finish(2);assert.equal(lines.at(-1),'ENGINE ENV BRIEF STATIC E2E: 2 FAILURE(S)');assert.equal(processModel.exitCode,1);
  });
  it('failed log drain cannot print ALL PASS or conceal the original error',async()=>{
    const primary=Error('synthetic drain failure'),lines=[];
    const finish=vm.runInNewContext(functionBlock(source,'finishEngineEnvBrief')+';finishEngineEnvBrief',{
      process:{exit(){assert.fail('hard exit');}},console:{log:line=>lines.push(line)},flushWorkbenchLogs:async()=>{throw primary;}
    });
    await assert.rejects(finish(0),error=>error===primary);assert.deepEqual(lines,[]);
  });
  it('whole permanent entry uses one real server module with the private drain and public binary exports',()=>{
    const os=require('node:os'),{fixtureChildEnv}=require('../lib/fixture-home');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-engine-brief-unit-')),{env,home}=fixtureChildEnv({perTest:true});
    Object.assign(env,{TEMP:root,TMP:root,RUYI_HOME:path.join(home,'data')});
    const result=cp.spawnSync(process.execPath,['--require',path.join(__dirname,'../lib/fixture-home-guard.js'),path.join(__dirname,'../engine-env-brief.static.e2e.js')],
      {cwd:path.resolve(__dirname,'../..'),env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
    assert.equal(result.status,0,String(result.error||'')+String(result.stderr));assert.equal(result.signal,null);assert.equal(result.stderr,'');
    assert.equal(result.stdout.trimEnd().split(/\r?\n/).at(-1),'ENGINE ENV BRIEF STATIC E2E: ALL PASS');
    assert.equal(/^FAIL /m.test(result.stdout),false);assert.match(result.stdout,/PASS A0 /);assert.match(result.stdout,/PASS G5 /);
    // These two exact fresh roots were created above and contain only this case.
    for(const directory of [root,home]){assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.equal(fs.lstatSync(directory).isSymbolicLink(),false);fs.rmSync(directory,{recursive:true,force:false});}
  });
});
