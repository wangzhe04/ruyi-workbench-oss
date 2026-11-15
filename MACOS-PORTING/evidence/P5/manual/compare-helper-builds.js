'use strict';
// Compare complete thin Mach-O bodies, excluding only UUID payload and trailing code-signature bytes.
const fs = require('node:fs'), crypto = require('node:crypto'), cp = require('node:child_process');
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function inspect(file) {
  const original = fs.readFileSync(file), body = Buffer.from(original);
  if (body.length < 32 || body.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected thin little-endian Mach-O64');
  const count = body.readUInt32LE(16), end = 32 + body.readUInt32LE(20), excluded = [], segments = [];
  if (count > 256 || end > body.length) throw new Error('Invalid load-command bounds');
  let offset = 32;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error('Truncated load command');
    const command = body.readUInt32LE(offset), size = body.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid load-command size');
    if (command === 0x1b) {
      if (size !== 24) throw new Error('Invalid LC_UUID');
      excluded.push({ kind: 'LC_UUID payload', offset: offset + 8, bytes: 16 });
    }
    if (command === 0x19) {
      if (size < 72) throw new Error('Invalid LC_SEGMENT_64');
      segments.push({ name: body.toString('ascii', offset + 8, offset + 24).replace(/\0.*$/, ''),
        offset: Number(body.readBigUInt64LE(offset + 40)), bytes: Number(body.readBigUInt64LE(offset + 48)) });
    }
    if (command === 0x1d) {
      if (size !== 16) throw new Error('Invalid LC_CODE_SIGNATURE');
      excluded.push({ kind: 'LC_CODE_SIGNATURE blob', offset: body.readUInt32LE(offset + 8), bytes: body.readUInt32LE(offset + 12) });
    }
    offset += size;
  }
  if (offset !== end || excluded.length !== 2 || excluded.filter(row => row.kind === 'LC_UUID payload').length !== 1)
    throw new Error('Unexpected UUID/signature command count');
  const signature = excluded.find(row => row.kind === 'LC_CODE_SIGNATURE blob');
  if (!signature || signature.offset < end || signature.offset + signature.bytes !== body.length || signature.bytes < 12
      || body.readUInt32BE(signature.offset) !== 0xfade0cc0) throw new Error('Expected trailing Apple signature superblob');
  if (segments.some(row => row.name !== '__LINKEDIT' && row.offset + row.bytes > signature.offset))
    throw new Error('Signature overlaps executable or data segments');
  for (const row of excluded) body.fill(0, row.offset, row.offset + row.bytes);
  const signed = cp.spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file], { encoding: 'utf8', timeout: 10000 });
  return { file, bytes: original.length, sha256: sha(original), bodySha256ExcludingUUIDAndSignature: sha(body), excluded,
    codesign: { exitCode: signed.status, stdout: signed.stdout, stderr: signed.stderr } };
}
const artifacts = process.argv.slice(2).map(inspect);
const equivalent = artifacts.length >= 2 && artifacts.every(row => row.codesign.exitCode === 0
  && row.bytes === artifacts[0].bytes && row.bodySha256ExcludingUUIDAndSignature === artifacts[0].bodySha256ExcludingUUIDAndSignature);
console.log(JSON.stringify({ at: new Date().toISOString(), equivalent, artifacts,
  interpretation: 'Only the UUID payload and trailing code-signature blob are excluded. All remaining file bytes and load-command fields must match.' }, null, 2));
if (!equivalent) process.exitCode = 1;
