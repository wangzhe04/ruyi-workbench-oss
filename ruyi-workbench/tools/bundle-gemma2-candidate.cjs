'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validate} = require('../semantic-runtime/gemma2-profile-validation.cjs');

async function bundle(stage, profile) {
  const lock = JSON.parse(fs.readFileSync(path.join(profile, 'asset-lock.json'), 'utf8'));
  await validate(lock).verify(lock);
  const prefix = 'resources/gemma2-candidate';
  const destination = path.join(stage, prefix);
  fs.mkdirSync(destination);
  function copy(source, relative) {
    const target = path.join(stage, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return relative;
  }
  function copyFrom(base, relative, folder) {
    if (path.isAbsolute(relative) || !path.resolve(base, relative).startsWith(path.resolve(base) + path.sep))
      throw Error('Candidate member outside source');
    return copy(path.join(base, relative), prefix + '/' + folder + '/' + relative.replaceAll('\\', '/'));
  }
  for (const asset of lock.assets) copyFrom(lock.assetsRoot, asset.path, 'model');
  for (const entry of lock.runtimeInventory) copyFrom(lock.runtimeRoot, 'node_modules/' + entry.path, 'runtime');
  copyFrom(lock.runtimeRoot, 'package-lock.json', 'runtime');
  // Node's loader uses the package manifest as a module resolution anchor.
  copyFrom(lock.runtimeRoot, 'package.json', 'runtime');
  for (const binding of lock.licenseBindings) {
    const isModel = binding.file.startsWith(lock.assetsRoot + path.sep);
    const base = isModel ? lock.assetsRoot : lock.runtimeRoot;
    binding.file = copyFrom(base, path.relative(base, binding.file), isModel ? 'model' : 'runtime');
  }
  for (const binding of lock.sourceBindings)
    binding.file = copy(binding.file, prefix + '/' + path.basename(binding.file));
  lock.workerFile = prefix + '/' + path.basename(lock.workerFile);
  lock.assetsRoot = prefix + '/model';
  lock.runtimeRoot = prefix + '/runtime';
  lock.node.file = 'runtime/node/node.exe';
  const node = fs.readFileSync(path.join(stage, lock.node.file));
  if (crypto.createHash('sha256').update(node).digest('hex') !== lock.node.sha256) throw Error('Candidate Node mismatch');
  fs.writeFileSync(path.join(destination, 'portable-lock.json'), JSON.stringify(lock), {flag: 'wx'});
  copy(path.join(__dirname, 'gemma2-candidate-preload.cjs'), prefix + '/preload.cjs');
  fs.writeFileSync(path.join(stage, 'Start-EmbeddingGemma-Candidate.cmd'), [
    '@echo off', 'setlocal',
    '"%~dp0runtime\\node\\node.exe" --require "%~dp0resources\\gemma2-candidate\\preload.cjs" "%~dp0app\\server.js" serve --open',
    'exit /b %ERRORLEVEL%', '',
  ].join('\r\n'), {flag: 'wx'});
}
bundle(...process.argv.slice(2).map(p => path.resolve(p))).catch(error => { console.error(error); process.exitCode = 1; });
