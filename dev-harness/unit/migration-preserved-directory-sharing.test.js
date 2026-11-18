'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { constBlock } = require('../lib/source-slice');

function nativeStudy(method) {
  const source = fs.readFileSync(process.env.RUYI_PORTABLE_STUDY_SOURCE
    || path.join(__dirname, '../../ruyi-workbench/app/src/13u-migration-center.js'), 'utf8');
  const native = vm.runInNewContext(constBlock(source, 'MIGRATION_SKILL_CAPSULE_NATIVE') + ';MIGRATION_SKILL_CAPSULE_NATIVE');
  const fixture = fs.readFileSync(path.join(__dirname, '../lib/preserved-directory-sharing.csfrag'), 'utf8');
  const boundary = '  static Dictionary<string,object> Dict';
  assert.equal(native.split(boundary).length, 2);

  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'ruyi-preserved-directory-sharing-'));
  const nativeFile = path.join(root, 'fixture.cs');
  const runner = path.join(root, 'run.ps1');
  fs.writeFileSync(nativeFile, native.replace(boundary, fixture + '\n' + boundary));
  fs.writeFileSync(runner, [
    'param([string] $Root)',
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition ([IO.File]::ReadAllText([IO.Path]::Combine($Root, 'fixture.cs'))) -ReferencedAssemblies System.Web.Extensions",
    `[RuyiSkillCapsule]::${method}($Root)`,
  ].join('\r\n'));
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Root', root], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(child.signal, null);
  const rows = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), temp);
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  fs.rmSync(root, { recursive: true, force: false });
  return rows;
}

test('native preserved census excludes directory readers and detects genuine changes', {
  skip: process.platform !== 'win32',
}, () => {
  const rows = nativeStudy('StudyDirectorySharing');
  assert.equal(rows.length, 50);
  for (const scenario of ['existing-reader', 'held-reader', 'external-access', 'external-name', 'repeat-ads']) {
    const samples = rows.filter(row => row.scenario === scenario);
    assert.deepEqual(samples.map(row => row.sample), Array.from({ length: 10 }, (_, sample) => sample));
    assert.ok(samples.every(row => ['proved', 'ambient_sharing_violation'].includes(row.result)));
    const proved = samples.filter(row => row.result === 'proved').length;
    console.log(`${scenario} ${proved}/10 proved, ${10 - proved}/10 refused with sharing violation`);
    assert.ok(proved > 0, scenario);
  }
});

test('owned portable creation publishes exact Basic metadata after the DATA and ADS writers close', {
  skip: process.platform !== 'win32',
}, () => {
  const rows = nativeStudy('StudyPortablePublish');
  assert.deepEqual(rows, Array.from({ length: 5 }, (_, sample) => ({ sample, result: 'proved' })));
});

test('owned portable metadata guard rejects rename and replacement before publication', {
  skip: process.platform !== 'win32',
}, () => {
  assert.deepEqual(nativeStudy('StudyPortableBasicRename'), [{ result: 'proved' }]);
});
