'use strict';

// Manual-browser fixture for Wave 54 narrative interactions. It starts an isolated workbench with a
// deterministic Claude stream that alternates long reasoning and tools, so scroll/fold/jump behavior can
// be inspected without real model or network access.
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const port = String(process.argv[2] || '8877');
process.env.RUYI_HOME = path.join(os.tmpdir(), `ruyi-process-ui-${process.pid}`);
process.env.WCW_FAKE_CLAUDE = path.join(ROOT, 'ruyi-workbench', 'tools', 'fake-claude.js');
process.env.WCW_FAKE_SCENARIO = path.join(__dirname, 'fixtures', 'fake-claude-long-process.jsonl');
process.env.WCW_FAKE_SLOW_MS = process.env.WCW_FAKE_SLOW_MS || '600';
process.env.WCW_FAKE_REPLAY_DELAY_MS = process.env.WCW_FAKE_REPLAY_DELAY_MS || '500';
const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', port], {
  cwd: path.join(ROOT, 'ruyi-workbench'),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', code => { process.exitCode = code == null ? 1 : code; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { child.kill(signal); } catch {} });
}
