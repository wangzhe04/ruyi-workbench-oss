// Decisive diagnosis: does a MINIMAL FastMCP serve tools over stdio here, and does the REAL
// ai-computer-control v1.3 serve its 83 over stdio? Raw MCP JSON-RPC, newline-delimited.
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const REPO = [path.resolve(__dirname, '..', 'ai-computer-control'), path.resolve(__dirname, '..', 'mcp', 'ai-computer-control')]
  .find(p => fs.existsSync(p)) || path.resolve(__dirname, '..', 'mcp', 'ai-computer-control');
const HERE = __dirname;

function probe(label, command, args, cwd, extraEnv) {
  return new Promise(resolve => {
    const env = { ...process.env, ...extraEnv };
    const child = cp.spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; const pending = new Map(); let idc = 1; const stderr = [];
    let serverInfo = null, count = null, first = '', err = null;
    child.on('error', e => { err = e.message; });
    child.stderr.on('data', d => stderr.push(String(d)));
    child.stdout.on('data', d => {
      buf += d.toString('utf8'); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      }
    });
    const rpc = (method, params) => new Promise((res, rej) => {
      const id = idc++;
      const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, 12000);
      pending.set(id, m => { clearTimeout(t); res(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    (async () => {
      try {
        const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
        serverInfo = init.result && init.result.serverInfo;
        notify('notifications/initialized', {});
        await new Promise(r => setTimeout(r, 250));
        const tl = await rpc('tools/list', {});
        const tools = (tl.result && tl.result.tools) || [];
        count = tools.length; first = tools.slice(0, 6).map(t => t.name).join(', ');
      } catch (e) { err = (err ? err + '; ' : '') + e.message; }
      finally {
        try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
        console.log(`\n[${label}]`);
        console.log('  serverInfo:', JSON.stringify(serverInfo));
        console.log('  TOOL COUNT:', count);
        if (first) console.log('  first:', first);
        if (err) console.log('  err:', err);
        if ((count === 0 || count === null) && stderr.length) console.log('  stderr:', stderr.join('').replace(/\s+/g, ' ').slice(0, 600));
        resolve();
      }
    })();
  });
}
(async () => {
  await probe('MINIMAL FastMCP (baseline: does stdio serve tools at all here?)', 'python', ['-X', 'utf8', path.join(HERE, 'min_fastmcp.py')], HERE, { PYTHONUTF8: '1' });
  await probe('REAL ai-computer-control v1.3 over stdio', 'python', ['-X', 'utf8', '-m', 'ai_computer_control.server'], REPO, { PYTHONUTF8: '1', PYTHONPATH: path.join(REPO, 'src') });
  process.exit(0);
})();
