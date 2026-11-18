'use strict';
// Stage a new handoff root with the production Windows takeover spawn mode.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./resident-home-cold-pipe-diagnostic.cjs');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'output');
const baselinePin = '687abe8bb441aed260048ece3f6c00dab6f57514b5d92d5175699d5aef263d06';
const fixturePin = 'd5daae82ef71347856ead6a56970650de5a849de1cd98634b261de4a7f55fa00';
const bind = (file, bytes) => ({ file, bytes: bytes.length, sha256: hash(bytes) });
const write = (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx' });
const json = v => Buffer.from(JSON.stringify(v, null, 2) + '\n');

function fixture(bytes) {
  assert.equal(hash(bytes), fixturePin);
  const source = bytes.toString('utf8');
  const anchor = "cwd:root,env,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']";
  assert.equal(source.split(anchor).length, 2);
  // Skip only the old Node's Windows libuv Job. The child still inherits the
  // product and independent outer kernel Jobs and must register in the former.
  return Buffer.from(source.replace(anchor, "cwd:root,env,windowsHide:true,detached:process.platform==='win32',stdio:['ignore','inherit','inherit','ipc']"));
}

function stage(name) {
  assert.equal(process.platform, 'win32');
  assert.match(name, /^home-handoff-replay-job-[a-z0-9-]+$/);
  assert.equal(fs.realpathSync.native(output), output);
  const prior = path.join(output, 'home-handoff-replay-cold-pipe-sol-r4');
  const baseline = path.join(prior, 'freeze.json');
  const baseBytes = fs.readFileSync(baseline);
  assert.equal(hash(baseBytes), baselinePin);
  const old = JSON.parse(baseBytes);
  assert.equal(old.scene, 'handoff');
  assert.equal(old.directory, prior);
  const directory = path.join(output, name);
  assert.ok(!fs.existsSync(directory));
  const relocate = value => {
    if (typeof value === 'string') return value === prior || value.startsWith(prior + path.sep)
      ? directory + value.slice(prior.length) : value;
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,relocate(v)]));
    return value;
  };
  const check = row => {
    const bytes = fs.readFileSync(row.file);
    assert.deepEqual(bind(row.file, bytes), {file:row.file,bytes:row.bytes,sha256:row.sha256});
    return bytes;
  };
  const result = relocate(old);
  const fixtureOld = path.join(old.base, 'app', 'server.js');
  const config = path.join(old.base, 'app', 'scene-lock.json');
  const fixtureSource = path.join(prior, 'server-cold-pipe.cjs');
  const newFixture = fixture(check(old.bindings.find(row => row.file === fixtureOld)));
  const newFixtureRow = bind(relocate(fixtureOld), newFixture);
  fs.mkdirSync(directory);
  result.bindings = old.bindings.map(row => {
    const original = check(row), file = relocate(row.file);
    if (file === row.file) return row;
    let bytes = original;
    if (row.file === fixtureOld || row.file === fixtureSource) bytes = newFixture;
    if (row.file === config) {
      const cfg = relocate(JSON.parse(original));
      Object.assign(cfg.bindings.find(r => r.file === newFixtureRow.file), newFixtureRow);
      bytes = json(cfg);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    write(file, bytes);
    return bind(file, bytes);
  });
  Object.assign(result.copies.find(r => r.target === newFixtureRow.file), newFixtureRow);
  for (const home of [result.actorHome, result.observerHome])
    for (const sub of ['tmp','local','roaming']) fs.mkdirSync(path.join(home, sub), { recursive: true });
  fs.mkdirSync(result.output);
  fs.mkdirSync(result.workData);
  result.fixtureJobReplay = { baselineSha256: baselinePin, launchMode: 'production-windows-detached-with-inherited-kernel-jobs' };
  result.bindings.push(bind(baseline, baseBytes), bind(__filename, fs.readFileSync(__filename)));
  result.bindings.forEach(check);
  JSON.parse(fs.readFileSync(relocate(config))).bindings.forEach(check);
  const file = path.join(directory, 'freeze.json');
  const freeze = json(result);
  write(file, freeze);
  const script = result.executionLayout.externalTestController.file;
  return { file, sha256: hash(freeze), bindings: result.bindings.length, nativeExecutionApproved: false,
    rootReviewCommand: { executable: result.bindings.find(r => path.basename(r.file).toLowerCase() === 'powershell.exe').file,
      arguments: ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',result.keeper,'-Root',directory,
        '-Node',result.node,'-Script',script,'-ControllerSha256',result.bindings.find(r=>r.file===script).sha256,
        '-Contract',file,'-ContractSha256',hash(freeze)] } };
}
if (require.main === module) console.log(json(stage(process.argv[2])).toString());
module.exports = { fixture };
