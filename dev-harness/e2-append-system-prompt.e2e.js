// E2E (E2): appendSystemPrompt must flow through EXACTLY ONE channel — the --append-system-prompt CLI flag.
// The old code ALSO wrote a non-standard top-level `appendSystemPrompt` key into ~/.claude/settings.json, which
// the official Claude Code settings schema does not define (dead config at best, double injection at worst).
// This test isolates ~/.claude via USERPROFILE and asserts:
//   (a) startup sync writes settings.json WITHOUT an appendSystemPrompt key, but WITH the supported keys;
//   (b) a pre-existing stale appendSystemPrompt key is stripped while unrelated keys are preserved;
//   (c) the --append-system-prompt flag IS still passed to the (fake) Claude spawn with the configured value.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const WB_PORT = 9049;
const HOME = path.join(os.tmpdir(), 'wcw-e2-append-e2e');   // doubles as isolated ~ (USERPROFILE) AND data home
const CLAUDE_DIR = path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const ARGV_CAP = path.join(HOME, 'argv.json');
const MARKER = 'E2_APPEND_MARKER_XYZ';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
// (b) seed a stale settings.json with the non-standard key AND an unrelated key that must survive.
fs.writeFileSync(SETTINGS, JSON.stringify({ appendSystemPrompt: 'STALE_VALUE', statusLine: { type: 'command', command: 'keep-me' } }, null, 2));
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'default', engineMode: 'print',
  activeProvider: '', appendSystemPrompt: MARKER,
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  // USERPROFILE + HOME redirect os.homedir() so ~/.claude resolves INSIDE our temp dir (never touch the real ~).
  const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // (a) + (b): startup ran syncClaudeCliSettings against the on-disk config.
    const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    ok(!Object.prototype.hasOwnProperty.call(settings, 'appendSystemPrompt'), 'settings.json has NO appendSystemPrompt key (stale key stripped) — keys: ' + JSON.stringify(Object.keys(settings)));
    ok(settings.permissions && settings.permissions.defaultMode === 'default', 'settings.json still carries permissions.defaultMode (supported key written) — got ' + JSON.stringify(settings.permissions));
    ok(settings.statusLine && settings.statusLine.command === 'keep-me', 'unrelated pre-existing settings key preserved (we only stripped appendSystemPrompt)');

    // (c): run a Claude turn; the fake captures the exact argv the workbench spawned it with.
    await postStream(WB_PORT, { message: 'hello claude', cwd: HOME });
    let argv = [];
    for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
    const flagIdx = argv.indexOf('--append-system-prompt');
    ok(flagIdx >= 0, '--append-system-prompt flag passed to the Claude spawn (argv len ' + argv.length + ')');
    // 第26波b 修存量过期断言: --append-system-prompt 现在会在用户 append 之后【追加】编排提示(第22/23波)与
    // 账本 digest(第26波b),故断言从「精确等于」改为「以配置值开头」(用户 append 段是最高优先级、恒在最前)。
    const flagVal = flagIdx >= 0 ? String(argv[flagIdx + 1] || '') : '';
    ok(flagVal.startsWith(MARKER), 'the flag carries the configured value (' + MARKER + ') as its leading segment — got ' + JSON.stringify(flagVal.slice(0, 40)));

    // The re-read settings.json (after the turn) still has no appendSystemPrompt key.
    const settings2 = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    ok(!Object.prototype.hasOwnProperty.call(settings2, 'appendSystemPrompt'), 'settings.json STILL has no appendSystemPrompt key after a turn');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nE2-APPEND-SYSTEM-PROMPT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
