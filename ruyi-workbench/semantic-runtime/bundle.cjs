'use strict';
// Build a Windows CPU-only directory; never mutate an npm installation in place.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./verify.cjs');
const { transform } = require('./text-only.cjs');
function selected(relative) {
  const name = relative.replaceAll('\\', '/');
  if (name.startsWith('sharp/') || name.startsWith('@img/')) return false;
  if (name.startsWith('@types/') || name.startsWith('undici-types/') || /\.d\.(?:ts|mts|cts)$/.test(name)) return false;
  if (name.startsWith('onnxruntime-web/')) return false; // Node entry bundles this import as ignored.
  if (name.startsWith('@huggingface/transformers/')) return /^@huggingface\/transformers\/(package.json|LICENSE|README.md|dist\/transformers.node.mjs)$/.test(name);
  if (name.startsWith('onnxruntime-node/bin/')) return name.startsWith('onnxruntime-node/bin/napi-v3/win32/x64/');
  return !name.endsWith('.map');
}
function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED');
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('NONREGULAR_FILE');
  }
  return files.sort();
}
async function bundle(sourceRoot, outputRoot, modelIds, refreshInventory = false) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_ONLY');
  const source = path.resolve(sourceRoot), out = path.resolve(outputRoot);
  if (source === out || out.startsWith(source + path.sep) || fs.existsSync(out)) throw new Error('OUTPUT_MUST_BE_NEW_SIBLING');
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.lock.json'), 'utf8'));
  const chosen = modelIds?.length ? modelIds : [lock.defaultModel];
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(__dirname, name), path.join(out, name));
  const files = listFiles(path.join(source, 'node_modules')).filter(selected);
  const records = [];
  for (const file of files) {
    const absolute = path.join(source, 'node_modules', file), target = path.join(out, 'node_modules', file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, transform(file, fs.readFileSync(absolute)));
    records.push({ path: file, bytes: fs.statSync(target).size, sha256: await sha256(target) });
  }
  const inventory = { schemaVersion: 1, platform: 'win32', arch: 'x64', files: records };
  const inventoryPath = path.join(__dirname, 'runtime-assets.win32-x64.lock.json');
  if (refreshInventory) fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
  else if (JSON.stringify(inventory) !== JSON.stringify(JSON.parse(fs.readFileSync(inventoryPath, 'utf8')))) throw new Error('RUNTIME_INVENTORY_MISMATCH');
  for (const id of chosen) {
    const model = lock.models.find(m => m.id === id); if (!model || !model.files.length) throw new Error('UNKNOWN_MODEL');
    for (const file of model.files) { const target = path.join(out, 'models', id, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, 'models', id, file.path), target); }
  }
  return { root: out, runtimeBytes: records.reduce((n, f) => n + f.bytes, 0), runtimeFiles: records.length, modelIds: chosen };
}
if (require.main === module) bundle(process.argv[2], process.argv[3], process.argv[4] === '--all' ? require('./models.lock.json').models.map(m => m.id) : process.argv[4] && !process.argv[4].startsWith('--') ? [process.argv[4]] : undefined, process.argv.includes('--refresh-inventory')).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { bundle, listFiles, selected };
