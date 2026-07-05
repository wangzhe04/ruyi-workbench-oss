// E2E: start workbench A on a port, then B on the SAME port. B must kill stale A and take over.
const cp = require('child_process');
const http = require('http');
const path = require('path');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const PORT = 8792;
const HOME = path.join(process.env.TEMP, 'wcw-porttest');
const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME };

function health() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => b += c); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function spawnWb(tag) {
  const c = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env, windowsHide: true });
  c.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log(`[${tag}] ${l.trim()}`)));
  c.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log(`[${tag}!] ${l.trim()}`)));
  return c;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

(async () => {
  let A, B, fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    A = spawnWb('A');
    // wait for A to listen
    let hA = null;
    for (let i = 0; i < 40 && !hA; i++) { await sleep(150); hA = await health(); }
    ok(!!hA, 'A is listening on :' + PORT);
    const idA = hA && hA.overlayId;
    console.log('  A overlayId=' + idA + ' pid=' + A.pid);

    // now start B on the SAME port
    B = spawnWb('B');
    // wait for takeover: /health overlayId changes to something != idA
    let hB = null, took = false;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      hB = await health();
      if (hB && hB.overlayId && hB.overlayId !== idA) { took = true; break; }
    }
    ok(took, 'B took over :' + PORT + ' (overlayId changed ' + idA + ' -> ' + (hB && hB.overlayId) + ')');
    await sleep(400);
    ok(!alive(A.pid), 'stale A (pid ' + A.pid + ') was killed');
    ok(B && alive(B.pid), 'B (pid ' + (B && B.pid) + ') is running');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    for (const c of [A, B]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
    await sleep(300);
    console.log(`\nPORT-FALLBACK E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})();
