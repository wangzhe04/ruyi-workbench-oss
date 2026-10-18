'use strict';
const fs = require('fs'), path = require('path');

// A release probe must not inherit paths that redirect it to a real installation or another server.
function releaseEnvironment(home, data, inherited = process.env) {
  const local = path.join(home, 'AppData', 'Local'), roaming = path.join(home, 'AppData', 'Roaming'), temp = path.join(home, 'Temp');
  for (const dir of [home, local, roaming, temp]) fs.mkdirSync(dir, { recursive: true });
  const env = { ...inherited };
  const clear = new Set(['WCW_PORT', 'WCW_TOKEN', 'RUYI_TEST_SERVER_JS', 'RUYI_BUNDLED_PYTHON', 'PYTHONHOME', 'PYTHONPATH', 'NODE_OPTIONS']);
  // Windows environment names are case-insensitive; remove aliases before applying the canonical keys.
  const replacements = { USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: roaming, TEMP: temp, TMP: temp,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]+$/, ''), HOMEPATH: path.sep + path.relative(path.parse(home).root, home),
    RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    WCW_TEST_LOCAL_PROVIDER_ANCHOR: '1', ACC_INSTALL_DIR: path.join(local, 'ai-computer-control'),
    WCW_DATA_DIR: path.join(local, 'acc-data'), KIMI_CODE_HOME: path.join(home, '.kimi-code'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    RUYI_TOOLBOX_HOME: path.join(home, '.ruyi-toolbox'), WCW_CLAUDE_PROJECTS_DIR: path.join(home, '.claude', 'projects') };
  for (const key of Object.keys(env)) if (clear.has(key.toUpperCase()) || Object.hasOwn(replacements, key.toUpperCase())) delete env[key];
  return { ...env, ...replacements };
}

// A populated stage is not evidence that its packager succeeded or produced a usable ZIP.
function packageAndCheck({ invoke, stage, zip, keys, listArchive }) {
  invoke(); // Nonzero exit must propagate, even when all stage files already exist.
  const missing = keys.filter(file => !fs.existsSync(path.join(stage, file)));
  if (missing.length) throw new Error('Missing staged paths: ' + missing.join(', '));
  if (!fs.existsSync(zip) || fs.statSync(zip).size === 0) throw new Error('Missing or empty ZIP: ' + path.basename(zip));
  const entries = listArchive(zip).split(/\r?\n/).filter(Boolean);
  if (entries.length <= 10) throw new Error('ZIP listing is incomplete: ' + entries.length);
  for (const file of keys) {
    const directory = fs.statSync(path.join(stage, file)).isDirectory();
    if (!entries.some(entry => {
      const name = entry.replace(/\\/g, '/').replace(/^\.\//, '');
      return directory ? name.startsWith(file + '/') && !name.endsWith('/') : name === file;
    })) throw new Error('Missing ZIP entry: ' + file);
  }
  return { entries: entries.length, files: keys.length };
}
module.exports = { releaseEnvironment, packageAndCheck };
