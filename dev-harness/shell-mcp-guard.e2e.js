// E2E (v0.8-S2): the MCP-child guard. The Claude CLI engine runs workbench tools in a one-shot
// `node app/server.js mcp` subprocess; a shell session's state cannot survive there, so the 5 shell_*
// tools must (a) still be LISTED (so the CLI-side model can see them + their guiding description) but
// (b) return a guiding error with isError:true when actually called. Drives the child over stdio
// JSON-RPC (same handshake as the real MCP client), no HTTP server involved. Offline.
const cp = require('child_process'), path = require('path'), os = require('os'), fs = require('fs');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-shell-mcp-guard-e2e');

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });

  const child = cp.spawn(process.execPath, [SERVER, 'mcp'], { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[mcp!] ' + l.trim())));
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', d => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore non-JSON */ }
    }
  });
  let idc = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++idc;
    const t = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, 10000);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
    ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'win-claude-workbench', 'initialize handshake ok');

    const list = await rpc('tools/list', {});
    const names = ((list.result && list.result.tools) || []).map(t => t.name);
    const shellNames = ['shell_start', 'shell_send', 'shell_poll', 'shell_kill', 'shell_list'];
    ok(shellNames.every(n => names.includes(n)), 'tools/list exposes all 5 shell_* tools (so CLI-side model sees them + guidance)');

    // Calling shell_start in the child must NOT start a session — it returns the guiding error.
    const call = await rpc('tools/call', { name: 'shell_start', arguments: { shellId: 'x1' } });
    ok(call.result && call.result.isError === true, 'shell_start in MCP child → isError:true');
    const textPart = call.result && call.result.content && call.result.content[0] && call.result.content[0].text || '';
    ok(textPart.includes('仅在原生 provider 引擎可用'), 'guiding error text mentions 仅在原生 provider 引擎可用 (got: ' + textPart.slice(0, 120) + ')');

    // Spot-check another shell tool (shell_send) also guards.
    const call2 = await rpc('tools/call', { name: 'shell_send', arguments: { shellId: 'x1', input: 'echo hi' } });
    ok(call2.result && call2.result.isError === true, 'shell_send in MCP child → isError:true');

    // Sanity: a normal one-shot tool (powershell_run) still works in the child (guard is shell-specific).
    const ps = await rpc('tools/call', { name: 'powershell_run', arguments: { command: 'Write-Output OK123', timeoutMs: 8000 } });
    const psOut = (ps.result && ps.result.content && ps.result.content[0] && ps.result.content[0].text) || '';
    ok(ps.result && ps.result.isError === false && psOut.includes('OK123'), 'powershell_run still works in MCP child (guard is shell-specific)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    try { if (child.pid) cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSHELL-MCP-GUARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    setTimeout(() => process.exit(fail ? 1 : 0), 300);
  }
})();
