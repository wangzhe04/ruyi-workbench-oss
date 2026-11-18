'use strict';
// Provisioning is explicit. The worker never invokes this script or downloads assets.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { sha256, verify } = require('./verify.cjs');
const { bundle } = require('./bundle.cjs');
async function install(sourceRoot, outputRoot, modelId, offline) {
  const source = path.resolve(sourceRoot), out = path.resolve(outputRoot);
  if (source === path.parse(source).root || source === path.resolve(__dirname) || fs.existsSync(out)) throw new Error('USE_NEW_OUTPUT_DIRECTORIES');
  if (fs.existsSync(source) && fs.readdirSync(source).length && !fs.existsSync(path.join(source, '.ruyi-semantic-install-root'))) throw new Error('INSTALL_ROOT_MUST_BE_EMPTY_OR_OWNED');
  const lock = require('./models.lock.json'); const model = lock.models.find(m => m.id === (modelId || lock.defaultModel));
  if (!model || !model.files.length) throw new Error('UNKNOWN_MODEL');
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, '.ruyi-semantic-install-root'), '1\n');
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(__dirname, name), path.join(source, name));
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('NPM_CLI_NOT_FOUND');
  const result = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], { cwd: source, windowsHide: true, stdio: 'inherit', env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' } });
  if (result.error || result.status !== 0) throw new Error('DEPENDENCY_INSTALL_FAILED');
  for (const file of model.files) {
    const target = path.join(source, 'models', model.id, file.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || fs.statSync(target).size !== file.bytes || await sha256(target) !== file.sha256) {
      if (offline) throw new Error('OFFLINE_MODEL_MISSING');
      const sourceFile = model.sourceFiles?.[file.path] || file.path;
      const response = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${sourceFile}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('MODEL_DOWNLOAD_FAILED');
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target + '.part'));
      if (fs.statSync(target + '.part').size !== file.bytes || await sha256(target + '.part') !== file.sha256) throw new Error('MODEL_INTEGRITY_FAILED');
      fs.renameSync(target + '.part', target);
    }
  }
  const receipt = await bundle(source, out, [model.id]);
  const verified = await verify(out, model.id);
  return { ...receipt, modelFingerprint: verified.modelFingerprint, offline };
}
if (require.main === module) {
  const args = process.argv.slice(2); const at = flag => args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
  const source = at('--source'), out = at('--out');
  if (!source || !out) { console.error('Usage: node install.cjs --source <new-staging-root> --out <new-bundle-root> [--model <id>] [--offline]'); process.exitCode = 1; }
  else install(source, out, at('--model'), args.includes('--offline')).then(receipt => console.log(JSON.stringify(receipt))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { install };
