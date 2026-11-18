'use strict';
// Explicit maintainer task: fetch license texts from fixed, first-party revisions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sources = [
  { file: 'bge-MIT.txt', repository: 'FlagOpen/FlagEmbedding', revision: 'c086741f5e117b7b8ce1745ea00b6c262f281a01', spdx: 'MIT' },
  { file: 'e5-MIT.txt', repository: 'microsoft/unilm', revision: '0e31c7c09737df491e7ff74ded19614b884c52b4', spdx: 'MIT' },
  { file: 'minilm-Apache-2.0.txt', repository: 'UKPLab/sentence-transformers', revision: '8df3ee50155394062734fde687fb1936e8396966', spdx: 'Apache-2.0' },
  { file: 'transformers-js-Apache-2.0.txt', repository: 'huggingface/transformers.js', revision: '9665c1e2f046782a61d34ce399c16682f96c7b0a', spdx: 'Apache-2.0' },
];
const models = [
  { repository: 'BAAI/bge-small-zh-v1.5', revision: '7999e1d3359715c523056ef9478215996d62a620', spdx: 'MIT' },
  { repository: 'intfloat/multilingual-e5-small', revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3', spdx: 'MIT' },
  { repository: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', revision: 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42', spdx: 'Apache-2.0' },
  ...require('../../ruyi-workbench/semantic-runtime/models.lock.json').models.filter(m => m.repository.startsWith('Xenova/')).map(m => ({ repository: m.repository, revision: m.revision, spdx: m.license, upstream: m.upstream })),
];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error('HTTP_' + response.status); return Buffer.from(await response.arrayBuffer()); }
    catch (error) { if (attempt === 2) throw error; }
  }
}
async function main() {
  if (!process.argv.includes('--refresh')) throw new Error('Explicit --refresh required; normal builds never update provenance.');
  const dir = path.resolve(__dirname, '../../ruyi-workbench/semantic-runtime/licenses'); fs.mkdirSync(dir, { recursive: true });
  const records = await Promise.all(sources.map(async source => {
    const url = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/LICENSE`;
    const bytes = await download(url); fs.writeFileSync(path.join(dir, source.file), bytes);
    return { ...source, url, bytes: bytes.length, sha256: digest(bytes) };
  }));
  const declarations = await Promise.all(models.map(async model => {
    const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/README.md`;
    const bytes = await download(url), text = bytes.toString('utf8');
    const declared = /^license:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (declared && declared.toLowerCase() !== model.spdx.toLowerCase() || !declared && !model.upstream) throw new Error('LICENSE_DECLARATION_MISMATCH ' + model.repository + ': ' + declared + ' expected ' + model.spdx);
    return { ...model, url, declaredLicense: declared || null, ...(declared ? {} : { licenseBasis: 'Original model declares this SPDX; conversion card identifies its base model but supplies no separate license declaration.' }), modelCardSha256: digest(bytes) };
  }));
  fs.writeFileSync(path.join(dir, 'provenance.lock.json'), JSON.stringify({ schemaVersion: 1, licenses: records, modelDeclarations: declarations }, null, 2) + '\n', 'utf8');
  console.log('Pinned license texts: ' + records.length + '; model declarations: ' + declarations.length);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
