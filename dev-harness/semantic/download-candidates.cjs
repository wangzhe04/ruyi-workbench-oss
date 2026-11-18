'use strict';
// Maintainer-only supply-chain refresh. Explicit --update-lock records downloaded hashes.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { sha256 } = require('../../ruyi-workbench/semantic-runtime/verify.cjs');
async function main() {
  const root = path.resolve(process.argv[2] || 'output/semantic-runtime');
  const lockPath = path.resolve(__dirname, '../../ruyi-workbench/semantic-runtime/models.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const update = process.argv.includes('--update-lock');
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
  for (const model of lock.models) {
    const records = [];
    for (const file of files) {
      const target = path.join(root, 'models', model.id, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) {
        const sourceFile = model.sourceFiles?.[file] || file;
        const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${sourceFile}`;
        let downloaded = false;
        for (let attempt = 0; attempt < 3 && !downloaded; attempt++) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target + '.part'));
            fs.renameSync(target + '.part', target); downloaded = true;
          } catch (error) { if (attempt === 2) throw error; }
        }
      }
      const record = { path: file, bytes: fs.statSync(target).size, sha256: await sha256(target) };
      if (!update) {
        const pinned = model.files.find(item => item.path === file);
        if (!pinned || pinned.sha256 !== record.sha256 || pinned.bytes !== record.bytes) throw new Error('MODEL_INTEGRITY_FAILED');
      }
      records.push(record);
      console.log(`${model.id} ${file} ${record.bytes} ${record.sha256}`);
    }
    if (update) model.files = records;
  }
  if (update) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
