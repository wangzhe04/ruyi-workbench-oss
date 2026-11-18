'use strict';
// Compile-only cold-pipe diagnostic. Host changes are restricted to exception metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { hash, host, probe } = require('./resident-home-cold-pipe-diagnostic.cjs');
const repo = path.resolve(__dirname, '../..');
const source = path.join(repo, 'output/semantic-resident-home-service-candidate-v2');
const planFile = path.join(source, 'compile-plan.json');
const check = ({ file, bytes, sha256 }) => {
  const data = fs.readFileSync(file);
  assert.equal(data.length, bytes, file);
  assert.equal(hash(data), sha256, file);
  return data;
};
const bind = file => {
  const data = fs.readFileSync(file);
  return { file, bytes: data.length, sha256: hash(data) };
};
function compile(name) {
  assert.match(name, /^home-cold-pipe-build-[a-z0-9-]+$/);
  const out = path.join(repo, 'output', name);
  assert.equal(fs.realpathSync.native(path.dirname(out)), path.dirname(out));
  assert.ok(!fs.existsSync(out), 'Build directory must be new');
  const raw = fs.readFileSync(planFile);
  assert.equal(hash(raw), 'd232cfdba4ae90a03cf514c17cf0dac23c8fbb9deb758b275af0e9dc65836c04');
  const plan = JSON.parse(raw);
  const original = [...plan.sources, ...plan.references, plan.compiler, bind(planFile)];
  original.forEach(check);
  assert.equal(path.basename(plan.sources[3].file), 'DesktopLifecycleProbe.cs');
  fs.mkdirSync(out);
  const hostFile = path.join(out, 'DesktopLifetimeHost.cs');
  fs.writeFileSync(hostFile, host(check(plan.sources[1])), { flag: 'wx' });
  const changed = path.join(out, 'DesktopLifecycleProbe.cs');
  fs.writeFileSync(changed, probe(check(plan.sources[3])), { flag: 'wx' });
  const home = path.join(out, 'home');
  for (const d of ['tmp', 'local', 'roaming']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const windows = path.resolve(path.dirname(plan.compiler.file), '../../..');
  const exe = path.join(out, 'DesktopLifecycleProbe.exe');
  const temp = path.join(home, 'tmp');
  const env = { SystemRoot: windows, WINDIR: windows, SystemDrive: path.parse(windows).root.replace(/[\\/]+$/, ''),
    PATH: path.join(windows, 'System32'), HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local') };
  const result = cp.spawnSync(plan.compiler.file, [...plan.arguments, '/out:' + exe,
    ...plan.references.map(row => '/reference:' + row.file), plan.sources[0].file, hostFile, plan.sources[2].file, changed],
  { cwd: out, env, windowsHide: true, timeout: 60000 });
  const log = path.join(out, 'compiler.log');
  fs.writeFileSync(log, Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)]), { flag: 'wx' });
  assert.equal(result.status, 0, result.error?.message || fs.readFileSync(log, 'utf8'));
  original.forEach(check);
  const receipt = { status: 'COMPILE_ONLY_COLD_PIPE_DIAGNOSTIC', host: bind(hostFile), source: bind(changed), output: bind(exe),
    sourcePlan: bind(planFile), original, log: bind(log), compiledOutputExecuted: false };
  const file = path.join(out, 'compile-receipt.json');
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return bind(file);
}
if (require.main === module) console.log(JSON.stringify(compile(process.argv[2])));
