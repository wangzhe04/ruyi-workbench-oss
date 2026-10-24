// 81-P1: Shared bounded Windows DPAPI helper. Secrets travel only over stdin/stdout.
const LocalSecretCrypto = (() => {
  const childProcess = require('node:child_process'), nodePath = require('node:path');   // local alias must not collide with 00-boot's path symbol (spurious graph edge)
  const LIMIT = Object.freeze({ processMs: 15000, outputBytes: 131072, cipherBytes: 65536 });
  let helperUncertain = false;
  const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
  const base64 = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max * 2 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').length <= max && Buffer.from(value, 'base64').toString('base64') === value;
  const DPAPI_SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$PSModuleAutoLoadingPreference='None'
try {
  [void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $op = [Console]::In.ReadLine()
  $bytes = [Convert]::FromBase64String([Console]::In.ReadLine())
  $entropy = [Convert]::FromBase64String([Console]::In.ReadLine())
  if ($op -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($op -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { throw 'operation' }
  [Console]::Out.Write('{"ok":true,"value":"'+[Convert]::ToBase64String($result)+'"}')
  [Array]::Clear($bytes,0,$bytes.Length)
  [Array]::Clear($result,0,$result.Length)
  exit 0
} catch { [Console]::Out.Write('{"ok":false}'); exit 1 }`;
  function run(op, value, entropy) {
    if (!['protect', 'unprotect'].includes(op) || !Buffer.isBuffer(value) || !value.length || value.length > LIMIT.cipherBytes || !Buffer.isBuffer(entropy) || entropy.length > 4096) return Promise.reject(Object.assign(new Error('local_crypto.input_invalid'), { code: 'local_crypto.input_invalid' }));
    if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('local_crypto.unsupported'), { code: 'local_crypto.unsupported', apiCode: 'local_crypto.unsupported', statusCode: 501 }));
    return new Promise((resolve, reject) => {
      let child, complete = false, outputSize = 0, stopReason = null, settleTimer = null;
      const output = [];
      const finish = (suffix, result, uncertain = false) => {
        if (complete) return;
        complete = true; clearTimeout(timer); clearTimeout(settleTimer);
        for (const chunk of output) chunk.fill(0);
        output.length = 0;
        if (suffix) reject(Object.assign(new Error('local_crypto.' + suffix), { code: 'local_crypto.' + suffix, apiCode: 'local_crypto.' + suffix, statusCode: 503,
          ...(uncertain ? { helperMayStillRun: true } : {}) }));
        else resolve(result);
      };
      const stop = suffix => {
        if (complete || stopReason) return;
        stopReason = suffix; clearTimeout(timer);
        for (const chunk of output) chunk.fill(0); output.length = 0;
        if (!child) { finish(suffix); return; }
        // A successful kill request is not an observed exit. Keep the caller's
        // exclusion until actual close, or report a permanently uncertain helper.
        settleTimer = setTimeout(() => { helperUncertain = true; finish(suffix, null, true); }, 2000);
        try { child.kill(); } catch { /* Wait for close or the bounded uncertainty receipt. */ }
      };
      const timer = setTimeout(() => stop('process_timeout'), LIMIT.processMs);
      const environment = {};
      // Do not inherit RUYI_BOT_* or provider credentials into the helper environment.
      for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (typeof process.env[key] === 'string') environment[key] = process.env[key];
      const executable = nodePath.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Only Windows' built-in modules are needed. Without an explicit path PowerShell discovers
      // third-party modules installed machine-wide, even with -NoProfile and a sanitized environment.
      environment.PSModulePath = nodePath.join(nodePath.dirname(executable), 'Modules');
      try {
        child = childProcess.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: environment });
        child.on('error', () => stop('process_failed'));
        child.stdout.on('data', chunk => {
          if (complete || stopReason) { chunk.fill(0); return; }
          outputSize += chunk.length;
          if (outputSize > LIMIT.outputBytes) { chunk.fill(0); stop('process_capacity'); return; }
          output.push(chunk);
        });
        child.stdout.on('error', () => stop('process_failed'));
        child.stdin.on('error', () => stop('process_failed'));
        child.on('close', code => {
          if (complete) return;
          if (stopReason) { finish(stopReason); return; }
          let response;
          const bytes = Buffer.concat(output);
          try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { finish('process_failed'); return; }
          finally { bytes.fill(0); }
          if (code !== 0 || !exact(response, ['ok', 'value']) || response.ok !== true || !base64(response.value, LIMIT.cipherBytes)) { finish(op === 'unprotect' ? 'decrypt_failed' : 'process_failed'); return; }
          finish(null, Buffer.from(response.value, 'base64'));
        });
        // Three ASCII lines need neither pipe EOF nor cmdlet/module discovery (Add-Type/JSON).
        child.stdin.end([op, value.toString('base64'), entropy.toString('base64'), ''].join('\n'));
      } catch { stop('process_failed'); }
    });
  }
  return Object.freeze({ run, supported: () => process.platform === 'win32', helperMayStillRun: () => helperUncertain });
})();
