'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { bracedBlock, constBlock } = require('../lib/source-slice');

const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13u-migration-center.js'), 'utf8');
const native = vm.runInNewContext(constBlock(source, 'MIGRATION_SKILL_CAPSULE_NATIVE') + ';MIGRATION_SKILL_CAPSULE_NATIVE');
const block = marker => bracedBlock(native, marker);

test('preserved census opens child files and named streams from the held parent', () => {
  const walk = block('static void Walk(');
  assert.match(walk, /preserved \? OpenPreserved\(parent, name, path, false/);
  assert.match(walk, /preserved \? OpenPreserved\(parent, name \+ streamName, streamPath, true/);
  assert.match(walk, /Walk\(child, .*entries, capture, preserved, node.Handle, childName\)/);
  assert.match(block('static object CapturePreserved('), /Capture\(args,true\)/);
  assert.match(block('static object Capture('), /VerifyOriginalLayout\(\); Verify\(false, true\); return Snapshot;/);
  assert.match(block('static SafeFileHandle OpenPreservedHandle('), /if \(parent != null\) return OpenPreservedRelative/);
  const relative = block('static SafeFileHandle OpenPreservedRelative(');
  assert.match(relative, /RootDirectory = parent.DangerousGetHandle\(\)/);
  assert.match(relative, /NtCreateFile\(out handle, access \| 0x00100000u, .*share, 1, 0x00204020u,/);
});

test('held metadata and payload handles agree on identity and every Basic field', () => {
  const open = block('static SafeFileHandle OpenPreserved(');
  assert.match(open, /PreserveHandleTimes\(metadata\);\s+string expectedId = Id\(metadata\);\s+Basic before = BasicOf\(metadata\)/);
  assert.match(open, /PreserveHandleTimes\(actual\);\s+if \(Id\(actual\) != expectedId \|\| !SamePreservedBasic\(before, BasicOf\(actual\)\) \|\| !SamePreservedBasic\(before, BasicOf\(metadata\)\)/);
  assert.match(open, /Id\(parent\) != parentId \|\| !String.Equals\(PathOf\(parent\), parentPath/);
  assert.match(open, /!dataStream && !String.Equals\(PathOf\(actual\), path/);
  assert.doesNotMatch(open, /File.GetAttributes|RestoreBasic|FlushFileBuffers/);
  const same = block('static bool SamePreservedBasic(').match(/return ([^;]+);/)[1];
  const compare = vm.runInNewContext('(a, b) => ' + same);
  const basic = { Creation: 1, Access: 2, Write: 3, Change: 4, Attr: 16 };
  assert.equal(compare(basic, { ...basic }), true);
  for (const field of Object.keys(basic)) assert.equal(compare(basic, { ...basic, [field]: 5 }), false, field);
});

test('first census proves closure through the original owned handle', () => {
  const close = block('static void ClosePreservedTemporary(');
  assert.match(close, /if \(handle.IsInvalid \|\| handle.IsClosed\) Reject\("census_first_close_unverified"\)/);
  assert.match(close, /if \(!CloseHandle\(handle.DangerousGetHandle\(\)\)\) Reject\("census_first_close_unverified"\);\s+handle.SetHandleAsInvalid\(\);\s+if \(!handle.IsClosed\)/);
  assert.doesNotMatch(close, /GetHandleInformation/);
  assert.match(block('static void BoundaryClose('), /ClosePreservedTemporary\(BoundaryHandle\);BoundaryHandle=null;/);
  const census = block('static object CapturePreservedCensusFirst(');
  assert.match(census, /!addresses.Add\(handle.DangerousGetHandle\(\)\).*\r?\n\s+Close\(true\)/);
  assert.doesNotMatch(census, /GetHandleInformation/);
});

test('directory, readonly and named DATA streams retain exact access and sharing', () => {
  const open = block('static SafeFileHandle OpenPreserved(');
  const start = open.indexOf('bool directory = ');
  const end = open.indexOf('actual = OpenPreservedHandle(parent, name, path, access, share);', start);
  assert.ok(start >= 0 && end > start, 'classify the captured object and pass both masks to the real open');
  const declarations = open.slice(start, end)
    .replace(/\b(?:bool|uint) /g, 'let ')
    .replace(/(\b(?:0x[\da-f]+|\d+))u\b/gi, '$1');
  const masks = vm.compileFunction('let writable;\n' + declarations + '\nreturn [access, share];',
    ['before', 'CapturedDirectoryWrite', 'dataStream', 'RetiringPortableStage', 'RetiringCommittedSource']);

  for (const mode of ['capture', 'stage-retirement', 'committed-source-retirement']) {
    const stage = mode !== 'capture', committed = mode === 'committed-source-retirement';
    for (const directoryWrite of [false, true]) {
      for (const stream of [false, true]) {
        for (const attr of [0, 1, 16, 17]) {
          const directory = !stream && Boolean(attr & 16);
          const ordinaryAccess = directory ? (directoryWrite ? 0xC0010100 : 0x80010100)
            : (attr & 1) ? 0x80010100 : 0xC0010000;
          const expected = committed ? (stream ? [0x80000100, 5] : [0x80010100, 1])
            : [ordinaryAccess, stage ? 0 : directory ? 6 : 5];
          assert.deepEqual(masks({ Attr: attr }, directoryWrite, stream, stage, committed), expected,
            JSON.stringify({ mode, directoryWrite, stream, attr }));
        }
      }
    }
  }
});
