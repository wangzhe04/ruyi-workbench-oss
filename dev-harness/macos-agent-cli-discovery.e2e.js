'use strict';
require('./lib/self-isolate-home');
// Native user installations must be discoverable with a Finder-style PATH, without reading profiles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS AGENT CLI DISCOVERY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-discovery-'));
const saved = { PATH: process.env.PATH, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH, KIMI_CLI_PATH: process.env.KIMI_CLI_PATH };
process.env.RUYI_HOME = path.join(root, 'data');
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native Mac CLI discovery requires macOS'); return; }
    process.env.PATH = '/usr/bin:/bin';
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.KIMI_CLI_PATH;
    const bin = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const calls = path.join(root, 'calls.jsonl');
    const makeCli = file => fs.writeFileSync(file, '#!' + process.execPath + '\n'
      + `require('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify({file:__filename,args:process.argv.slice(2)})+'\\n');console.log('fixture 1.0.0');`, { mode: 0o700 });
    for (const name of ['claude', 'kimi']) makeCli(path.join(bin, name));
    const S = loadServerInternals(['detectClaudePath', 'detectClaudePathUncachedAsync', 'detectKimiPath',
      'detectAgentCliPathUncachedAsync', 'invalidateAgentCliPathCaches', 'prepareAgentCliSpawn', 'DesktopShell', 'claudeProbeCandidates', 'agentCliInstallCandidates']);
    S.invalidateAgentCliPathCaches();
    t.ok(S.detectClaudePath() === path.join(bin, 'claude') && await S.detectClaudePathUncachedAsync() === path.join(bin, 'claude'),
      'sync and async discovery find the native Claude user install outside PATH');
    t.ok(S.detectKimiPath() === path.join(bin, 'kimi') && await S.detectAgentCliPathUncachedAsync('kimi') === path.join(bin, 'kimi'),
      'sync and async discovery find the native Kimi user install outside PATH');
    const candidates = [...S.claudeProbeCandidates().map(row => row.command), ...S.agentCliInstallCandidates('kimi')];
    t.ok(!candidates.some(file => /\.(?:cmd|exe|bat)$/.test(file) || file.includes('AppData')), 'Mac discovery does not probe Windows launchers');
    const custom = path.join(root, '自选 CLI 😀'); makeCli(custom);
    process.env.CLAUDE_CLI_PATH = custom; process.env.KIMI_CLI_PATH = custom;
    S.invalidateAgentCliPathCaches();
    t.ok(S.detectClaudePath() === custom && S.detectKimiPath() === custom, 'explicit launcher overrides user installations, including Unicode and spaces');
    for (const type of ['claude', 'kimi']) {
      const launch = S.prepareAgentCliSpawn(type, custom, ['--fixture', '中文 空格😀']);
      const result = await S.DesktopShell.runProcess(launch.command, launch.args, { ...launch.opts, cwd: root, timeoutMs: 4000 });
      const seen = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
      t.ok(result.ok && !result.cleanupIncomplete && fs.realpathSync(seen.file) === fs.realpathSync(custom) && JSON.stringify(seen.args) === JSON.stringify(['--fixture', '中文 空格😀']),
        type + ' launch preserves the native executable and literal argument boundaries');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
