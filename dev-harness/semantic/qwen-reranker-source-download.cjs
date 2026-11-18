'use strict';
// Exactly one approved official checkpoint, sequential ranged transfer.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream'), { pipeline } = require('node:stream/promises');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const revision = 'e61197ed45024b0ed8a2d74b80b4d909f1255473', bytes = 1191588280;
const expected = '27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b';
const owner = JSON.parse(fs.readFileSync(path.join(root, 'OWNER.json')));
if (owner.owner !== 'sol_semantic_runtime' || owner.modelRevision !== revision) throw Error('Research owner mismatch.');
const target = path.join(root, 'source/Qwen3-Reranker-0.6B/model.safetensors'), partial = target + '.part';
const receiptPath = path.join(root, 'download-receipt.json');
const url = `https://huggingface.co/Qwen/Qwen3-Reranker-0.6B/resolve/${revision}/model.safetensors`;
async function digest(file, range) {
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file, range)) hash.update(chunk); return hash.digest('hex');
}
const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath)) : {
  schemaVersion: 1, url, revision, expectedBytes: bytes, expectedSha256: expected, method: 'Sequential 16MiB HTTP ranges, streaming chunks, complete final SHA256 required', ranges: [], failures: [], status: 'DOWNLOADING' };
if (receipt.url !== url || receipt.expectedBytes !== bytes || receipt.expectedSha256 !== expected) throw Error('Existing receipt mismatch.');
function save() { fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); }
(async () => {
  if (fs.existsSync(target)) {
    if (fs.statSync(target).size !== bytes || await digest(target) !== expected) throw Error('Existing final source is damaged.');
    console.log('Official checkpoint already verified.'); return;
  }
  let next = 0;
  for (const range of receipt.ranges) {
    if (range.start !== next || range.end < range.start || range.end >= bytes || await digest(partial, { start: range.start, end: range.end }) !== range.sha256) throw Error('Resume prefix integrity mismatch.');
    next = range.end + 1;
  }
  if (fs.existsSync(partial) ? fs.statSync(partial).size !== next : next !== 0) throw Error('Resume size mismatch.');
  if (!fs.existsSync(partial)) fs.writeFileSync(partial, '', { flag: 'wx' });
  const chunkSize = 16 * 1024 * 1024;
  while (next < bytes) {
    const start = next, end = Math.min(bytes - 1, start + chunkSize - 1); let complete = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const chunkPath = partial + `.range-${start}-try-${attempt}`;
      if (fs.existsSync(chunkPath)) throw Error('Preserve prior failed transfer; do not overwrite its evidence.');
      try {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120000) });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${bytes}`) {
          await response.body?.cancel(); throw Error('Unexpected range response.');
        }
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(chunkPath, { flags: 'wx' }));
        if (fs.statSync(chunkPath).size !== end - start + 1) throw Error('Incomplete range.');
        const sha256 = await digest(chunkPath);
        await pipeline(fs.createReadStream(chunkPath), fs.createWriteStream(partial, { flags: 'a' }));
        receipt.ranges.push({ start, end, sha256 }); next = end + 1; save(); fs.unlinkSync(chunkPath);
        console.log(`SOURCE ${next}/${bytes}`); complete = true; break;
      } catch (error) {
        receipt.failures.push({ start, end, attempt, at: new Date().toISOString(), error: String(error.message) }); save();
        if (attempt === 3) throw error;
      }
    }
    if (!complete) throw Error('Range did not finish.');
  }
  const actual = await digest(partial);
  if (fs.statSync(partial).size !== bytes || actual !== expected) throw Error('Complete official checkpoint SHA256 mismatch.');
  fs.renameSync(partial, target); receipt.status = 'VERIFIED'; receipt.actualSha256 = actual;
  receipt.finishedAt = new Date().toISOString(); receipt.scriptSha256 = await digest(__filename); save();
  console.log(JSON.stringify({ status: receipt.status, bytes, sha256: actual, ranges: receipt.ranges.length, failures: receipt.failures.length }));
})().catch(error => { receipt.status = 'FAILED'; receipt.error = String(error.stack || error); save(); console.error(error); process.exitCode = 1; });
