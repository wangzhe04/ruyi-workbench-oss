'use strict';
// Keep Windows command contracts while executing the same fixture effect on POSIX.
const windows = process.platform === 'win32';
const shellTool = windows ? 'powershell_run' : 'shell_run';
const quote = value => "'" + String(value).replace(/'/g, windows ? "''" : "'\\''") + "'";
const echo = value => windows ? 'Write-Output ' + quote(value) : "printf '%s\\n' " + quote(value);
const delay = (seconds, value) => (windows ? 'Start-Sleep -Seconds ' : 'sleep ') + seconds
  + (value === undefined ? '' : '; ' + echo(value));
const writeFile = (file, value = 'ran') => windows
  ? 'Set-Content -LiteralPath ' + quote(file) + ' -Value ' + quote(value)
  : "printf '%s\\n' " + quote(value) + ' > ' + quote(file);
const cwdCommand = windows ? '(Get-Location).Path' : 'pwd -P';
module.exports = { windows, shellTool, quote, echo, delay, writeFile, cwdCommand };
