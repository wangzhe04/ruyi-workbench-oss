'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process'), a = require('node:assert/strict');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  v1: '68b249af0f0bd787ad7174cef28a0d3e7e1d8da87dea9deb093dd9ef4fafe242',
  v2: '6b444ac8f12e09ec5eb4705f36eb0126070d17f371254f32f8d0687924ee84fb'
};
const version = process.argv[2];
a.ok(Object.hasOwn(pins, version));
const dir = path.resolve('output/semantic-resident-os-alias-utf8-' + version);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
const f = read('freeze.json'), r = read('receipt.json'), o = read('outer-job-receipt.json');
a.equal(H(fs.readFileSync(path.join(dir, 'freeze.json'))), pins[version]);
a.equal(r.freezeSha256, pins[version]);
a.equal(r.bindingsStable, true);
for (const row of f.bindings) {
  const bytes = fs.readFileSync(row.file);
  a.equal(bytes.length, row.bytes); a.equal(H(bytes), row.sha256);
}
const identities = [{pid: o.controllerPid, creationFileTime: o.controllerCreationFileTime}];
if (version === 'v1') {
  a.equal(r.status, 'FAIL'); a.equal(r.primary.code, 'EINVAL');
  a.equal(r.failedInvocation.childPid, null); a.equal(r.failedInvocation.closeObserved, false);
  a.equal(o.controllerExitCode, 1); a.equal(o.terminationRequested, true);
  a.equal(o.afterTermination.active, 0); a.deepEqual(o.afterTermination.members, []);
} else {
  a.equal(r.status, 'PASS_OS_ALIAS_UTF8_PRIMITIVE_NOT_PORTABLE_QUALIFICATION');
  a.equal(r.cases.length, 3); a.ok(r.cases.every(row => row.status === 'PASS'));
  a.equal(o.controllerExitCode, 0); a.equal(o.terminationRequested, false);
  a.equal(o.beforeReclaim.active, 0); a.deepEqual(o.beforeReclaim.members, []);
  a.equal(o.accounting.active, 0); a.deepEqual(o.accounting.members, []);
  const m = r.probe.metadata;
  for (const invocation of [r.probe.invocation, r.postClose.invocation]) {
    a.equal(invocation.closeObserved, true); a.equal(invocation.exitCode, 0);
    a.equal(invocation.signal, null); a.equal(invocation.stderrBytes, 0);
    a.equal(invocation.stderrObservedBytes, 0); a.equal(invocation.stderrUtf8, '');
    const bytes = Buffer.from(invocation.stdoutUtf8, 'utf8');
    a.equal(bytes.length, invocation.stdoutBytes); a.equal(bytes.length, invocation.stdoutObservedBytes);
    a.equal(H(bytes), invocation.stdoutSha256);
  }
  a.deepEqual(JSON.parse(r.probe.invocation.stdoutUtf8), m);
  a.equal(m.publicText, 'Public UTF-8 中文 🌿 + 空格。\n'); a.equal(m.sampleText, m.publicText);
  a.equal(m.homePath, f.home); a.equal(m.runtimePath, f.runtime);
  a.equal(m.sampleFile, path.join(f.runtime, '公开 样本.txt'));
  a.equal(m.moduleAutoLoading, 'None');
  for (const key of ['nodeOptionsPresent', 'nodePathPresent', 'complusPresent', 'customPsModulePathPresent']) a.equal(m[key], false);
  a.equal(r.probe.sameOsFile, true); a.equal(r.probe.sameOsBytes, true);
  a.equal(m.canonicalSha256, f.descriptor.osInventory.exeSha256);
  a.equal(r.postClose.sameIdentityAbsent, true);
  const after = JSON.parse(r.postClose.invocation.stdoutUtf8);
  a.equal(after.target.pid, m.pid); a.deepEqual(after.target, r.postClose.target);
  identities.push({pid: m.pid, creationFileTime: m.creationFileTime}, r.postClose.observerIdentity);
}
const observations = [];
for (const id of identities) {
  a.ok(Number.isSafeInteger(id.pid) && id.pid > 0 && /^\d{10,20}$/.test(id.creationFileTime));
  const script = '$p=Get-Process -Id ' + id.pid + ' -ErrorAction SilentlyContinue;if($p){[string]$p.StartTime.ToUniversalTime().ToFileTimeUtc()}else{"ABSENT"}';
  const osImage = f.bindings.find(row => /powershell\.exe$/i.test(row.file));
  const command = fs.realpathSync.native(osImage.file);
  a.equal(H(fs.readFileSync(command)), osImage.sha256);
  const result = cp.spawnSync(command,
    ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, encoding: 'utf8', timeout: 10000});
  a.equal(result.status, 0); a.equal(result.stderr, '');
  const value = result.stdout.trim();
  a.ok(value === 'ABSENT' || /^\d+$/.test(value) && value !== id.creationFileTime);
  observations.push({...id, observed: value});
}
fs.mkdirSync(path.join(dir, 'root-source-snapshots'));
const snapshots = [], external = [];
for (const [i, row] of f.bindings.entries()) {
  if (/\.(exe|dll)$/i.test(row.file)) { external.push(row); continue; }
  const snapshot = path.join('root-source-snapshots', String(i + 1).padStart(3, '0') + '-' + path.basename(row.file));
  fs.writeFileSync(path.join(dir, snapshot), fs.readFileSync(row.file), {flag: 'wx'});
  snapshots.push({...row, snapshot});
}
const result = {
  schema: 1,
  status: version === 'v1' ? 'ROOT_FIXED_ALIAS_SPAWN_EINVAL_RETAINED_FAIL' : 'ROOT_OS_CANONICAL_UTF8_SCOPED_PASS',
  freezeSha256: pins[version], receiptSha256: H(fs.readFileSync(path.join(dir, 'receipt.json'))),
  outerSha256: H(fs.readFileSync(path.join(dir, 'outer-job-receipt.json'))),
  sourceSnapshots: snapshots, external, observations,
  actualFunctionalPass: version === 'v2',
  scope: 'Public synthetic OS bootstrap, UTF8/Chinese-space paths, clean environment and observed process identities on this machine.',
  limits: ['Not actual product lease integration, arbitrary Windows/WOW64 qualification or genuine model lifecycle.', 'OS installation and framework integrity is a platform premise. No universal PowerShell hash requirement.', 'Timeout or outer cleanup does not qualify normal functional cleanup. Original v1 failure remains failed.']
};
fs.writeFileSync(path.join(dir, 'root-review.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: result.status, sha256: H(fs.readFileSync(path.join(dir, 'root-review.json'))), snapshots: snapshots.length, identities: observations.length}));
