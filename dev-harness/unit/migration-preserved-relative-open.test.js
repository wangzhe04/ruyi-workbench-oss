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
  const classification = open.match(/bool directory = ([^;]+);\s+writable = ([^;]+);/);
  const expression = name => open.match(new RegExp('uint ' + name + ' = ([^;]+);'))[1].replace(/(\b(?:0x[\da-f]+|\d+))u\b/gi, '$1');
  const access = expression('access');
  const share = expression('share');
  for (const CapturedDirectoryWrite of [false, true]) {
    for (const dataStream of [false, true]) {
      for (const Attr of [0, 1, 16, 17]) {
        const actual = vm.runInNewContext(
          'const directory = ' + classification[1].replace(/(\b(?:0x[\da-f]+|\d+))u\b/gi, '$1')
            + '; const writable = ' + classification[2] + '; [' + access + ', ' + share + ']',
          { before: { Attr }, CapturedDirectoryWrite, dataStream, RetiringPortableStage: false }
        );
        const directory = !dataStream && (Attr & 16) !== 0;
        const expectedAccess = directory ? (CapturedDirectoryWrite ? 0xC0010100 : 0x80010100)
          : (Attr & 1) !== 0 ? 0x80010100 : 0xC0010000;
        assert.deepEqual(Array.from(actual), [expectedAccess, directory ? 6 : 5]);
      }
    }
  }
  assert.equal(vm.runInNewContext(share, { RetiringPortableStage: true }), 0);
});
