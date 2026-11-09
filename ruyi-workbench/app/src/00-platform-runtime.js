#!/usr/bin/env node
'use strict';

// Platform launch policy. Keep these helpers free of application state so boot can call them
// before the remaining concatenated modules initialize. No login shell or profile is evaluated.
function platformRuntimeEnvironment(env, platform = process.platform, nodeExecutable = process.execPath) {
  if (platform !== 'darwin') return { ...env };
  const pathModule = require('path');
  const directories = [
    pathModule.dirname(nodeExecutable),
    ...String(env.PATH || '').split(':'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const absolute = directories.filter(dir => pathModule.posix.isAbsolute(dir));
  return { ...env, PATH: [...new Set(absolute)].join(':') };
}

function platformOpenSpawn(target, mode = 'open', platform = process.platform) {
  const value = String(target || '');
  if (platform === 'darwin') {
    // LaunchServices treats application/workflow bundles as executable even though they are directories.
    const bundle = !/^[a-z][a-z0-9+.-]*:/i.test(value)
      && /\.(?:app|workflow|scptd|bundle|plugin|prefpane|saver|xpc|appex)\/*$/i.test(value);
    const selected = mode === 'select' || bundle;
    return { command: '/usr/bin/open', args: [...(selected ? ['-R'] : []), '--', value], mode: selected ? 'select' : mode };
  }
  if (mode === 'browser') return { command: 'cmd.exe', args: ['/c', 'start', '', value] };
  // Keep the existing Windows/Linux fallback contract until other desktop backends are implemented.
  return { command: 'explorer.exe', args: [mode === 'select' ? '/select,' + value : value] };
}

// Non-interactive bash still reads BASH_ENV and imports exported functions/options.
function platformShellEnvironment(env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (/^BASH_/.test(name) || ['ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE', 'PROMPT_COMMAND', 'PS4'].includes(name)) delete clean[name];
  }
  return clean;
}
