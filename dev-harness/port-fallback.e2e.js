// E2E: start workbench A on a port, then B on the SAME port. B must kill stale A and take over.
// 第36波(v1.7) Phase 2: 无辜旁观者防护 —— 一个【非工作台】的普通 node HTTP 服务占着端口时,
// 新 boot 的工作台不得 taskkill 它(旧 image:node 分支会误杀任何 node.exe,违背 "never clobber
// someone else's app" 契约);旁观者进程必须始终存活、端口继续为它服务。
//
// 【118c 重钉,2026-09-04】本段第三条断言原本是「工作台放弃接管后【报错退出】」—— 那不是契约本身,
// 只是当年那条死路的副作用。118c 的产品口径是「端口被别人占着不该让用户看见一个死掉的启动器」,
// 所以工作台现在改为自动往后试 port+1..port+9 并在界面顶部条说明改用了哪个端口。
// 契约里真正要守的两条(不误杀旁观者 / 原端口继续服务旁观者)一字未改,仍在下面逐条断言;
// 第三条按新口径翻转为「工作台还活着,并且在 port+1 上正常服务」。相关行为面另见
// dev-harness/start-error-surface.e2e.js。
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  }

  // ─── Phase 2 (第36波): 无辜旁观者 —— 非工作台的普通 node 服务占口,工作台不得误杀,必须放弃接管 ───
  const PORT2 = 9154;
  const INNOCENT_SRC = path.join(os.tmpdir(), 'wcw-innocent-bystander.js');
  fs.writeFileSync(INNOCENT_SRC, `require('http').createServer((q,s)=>{s.end('hello');}).listen(${PORT2},'127.0.0.1');setInterval(()=>{},1000);\n`);
  let C = null, innocent = null;
  try {
    innocent = cp.spawn(process.execPath, [INNOCENT_SRC], { windowsHide: true });
    // 等旁观者开始监听(探测任意响应 —— 它不回 JSON,probeHealth 视角即"非工作台")
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await sleep(150);
      up = await new Promise(res => { const r = http.get({ host: '127.0.0.1', port: PORT2, timeout: 600 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
    }
    ok(up, 'P2: innocent node service listening on :' + PORT2);

    // 全新 HOME2(无 runtime.json):杜绝"B 的 pid 被 OS 回收发给旁观者"时 ourPid 误配的偶发 —
    // 本段要验的只有命令行取证一条路。
    const HOME2 = path.join(process.env.TEMP, 'wcw-porttest-p2');
    C = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT2)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2 }, windowsHide: true });
    C.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[C] ' + l.trim())));
    C.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[C!] ' + l.trim())));
    // 118c 重钉:C 不再自行退出,而是放弃接管【原】端口后改用 PORT2+1。给足取证(netstat+tasklist+CIM)时间。
    const PORT2_FALLBACK = PORT2 + 1;
    let cMoved = null;
    for (let i = 0; i < 80 && !cMoved; i++) {
      await sleep(250);
      cMoved = await new Promise(res => {
        const r = http.get({ host: '127.0.0.1', port: PORT2_FALLBACK, path: '/health', timeout: 600 }, resp => {
          let b = ''; resp.on('data', c2 => b += c2); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
        });
        r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
      });
    }
    ok(!!cMoved && cMoved.ok === true,
      'P2: workbench C refused to kill the occupant and moved to :' + PORT2_FALLBACK + ' (118c: no dead end)');
    ok(alive(C.pid), 'P2: workbench C is still running (118c 重钉:原断言要求它退出,那条死路已被产品口径否掉)');
    ok(alive(innocent.pid), 'P2: innocent bystander (pid ' + innocent.pid + ') is STILL ALIVE (old image:node branch would have taskkill\'d it)');
    // 端口仍服务旁观者
    const still = await new Promise(res => { const r = http.get({ host: '127.0.0.1', port: PORT2, timeout: 800 }, resp => { let b = ''; resp.on('data', c2 => b += c2); resp.on('end', () => res(b === 'hello')); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
    ok(still, 'P2: :' + PORT2 + ' still serves the innocent service');
  } catch (e) { console.log('ERROR(P2) ' + e.message); fail++; }
  finally {
    for (const c of [C, innocent]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
    try { fs.rmSync(INNOCENT_SRC, { force: true }); } catch {}
    try { fs.rmSync(HOME2, { recursive: true, force: true }); } catch {}
    await sleep(300);
    console.log(`\nPORT-FALLBACK E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})();
