(async () => {
// E2E (E3): dual-engine continuity. The Claude CLI's native transcript (reached via --resume) only holds
// Claude turns. When the user runs Provider (OpenAI-compat) turns AFTER a Claude turn and then switches back to
// Claude in the SAME workbench process, --resume silently drops that middle work AND the recovery-history seed
// is normally suppressed (the claudeSessionId is already in claudeSessionsSeenThisProcess). The fix detects
// "the previous assistant turn ran on the provider engine" and force-injects just the trailing Provider turns
// into the Claude recovery history. Sequence exercised here: Claude(A) -> Provider(B) -> Claude(C), asserting
// C's Claude prompt re-injects B's work but NOT A's (A is already in the CLI transcript).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-e3-engine-switch-e2e');
const STDIN_CAP = path.join(HOME, 'claude-stdin.txt');   // fake-claude overwrites this with each Claude turn
const ARGV_CAP = path.join(HOME, 'claude-argv.json');
const PROVIDER_CAP = path.join(HOME, 'provider-captures');
const CLAUDE_MARK_A = 'CLAUDE_TURN_A_MARK_11';
const PROVIDER_MARK_B = 'PROVIDER_TURN_B_MARK_22';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', engineMode: 'interactive',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
  activeProvider: '', // start on the Claude engine
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
function postConfig(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/config', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function latestProviderRequest() {
  const files = fs.existsSync(PROVIDER_CAP) ? fs.readdirSync(PROVIDER_CAP).filter(f => /^req-\d+\.json$/.test(f)).sort() : [];
  return files.length ? JSON.parse(fs.readFileSync(path.join(PROVIDER_CAP, files[files.length - 1]), 'utf8')) : null;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_CAPTURE_DIR: PROVIDER_CAP }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  // USERPROFILE/HOME isolate ~/.claude; WCW_FAKE_CLAUDE replays offline; WCW_FAKE_STDIN_CAPTURE records the
  // exact prompt the workbench feeds Claude on each Claude turn (overwritten per turn).
  const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_STDIN_CAPTURE: STDIN_CAP, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = readToken();
    ok(!!token, 'workbench token read from runtime.json (for config PATCH)');

    // Turn A — Claude engine. Establishes the CLI session id (added to claudeSessionsSeenThisProcess).
    const a = await postStream(WB_PORT, { message: CLAUDE_MARK_A + ' 记住这个上下文' });
    const sid = (a.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, 'session created on the Claude turn');
    const firstClaudeArgs = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8'));
    ok(!firstClaudeArgs.includes('--continue'), 'a new workbench chat never uses global Claude --continue (no unrelated transcript splice)');

    // Switch to the Provider engine and run Turn B (its user message carries a distinctive marker).
    const c1 = await postConfig(WB_PORT, token, { activeProvider: 'fake' });
    ok(c1 && c1.ok, 'config switched to provider engine');
    const b = await postStream(WB_PORT, { sessionId: sid, message: PROVIDER_MARK_B + ' 用 provider 干点活', cwd: HOME });
    const bMeta = b.find(e => e.type === 'meta');
    ok(bMeta && bMeta.engine === 'openai', 'Turn B ran on the provider engine');
    const bReq = latestProviderRequest();
    ok(bReq && JSON.stringify(bReq.messages || []).includes(CLAUDE_MARK_A), 'Turn B Provider request includes the preceding Claude turn');

    // E3-fix2: a trailing meta assistant message (agent_workflow summary / fallback — NO engine tag) must NOT
    // mask the preceding Provider turn. Inject one after B; without the lastAssistantEngine skip-meta fix this
    // makes Turn C read no cross-engine gap and silently drop B. With it, C still injects the provider tail.
    const sessFile = path.join(HOME, 'sessions', sid + '.json');
    { const s = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      s.messages.push({ role: 'assistant', content: '（工作流总结）已完成 2 个节点', createdAt: new Date().toISOString(), source: 'agent_workflow', runId: 'run_deadbeef01' });
      fs.writeFileSync(sessFile, JSON.stringify(s)); }

    // Switch back to Claude and run Turn C.
    const c2 = await postConfig(WB_PORT, token, { activeProvider: '' });
    ok(c2 && c2.ok, 'config switched back to Claude engine');
    // fake-claude overwrites the capture file (a single-line JSON envelope in interactive mode) with C's
    // prompt; poll+parse until it reflects the new turn's user message.
    let sentText = '';
    const c = await postStream(WB_PORT, { sessionId: sid, message: '刚才我们用 provider 做了什么？', cwd: HOME });
    const cMeta = c.find(e => e.type === 'meta');
    for (let i = 0; i < 20; i++) {
      try { const env2 = JSON.parse(fs.readFileSync(STDIN_CAP, 'utf8')); sentText = env2.message.content[0].text; } catch { sentText = ''; }
      if (sentText.includes('刚才我们')) break;
      await sleep(100);
    }

    ok(cMeta && cMeta.historyRecoveryInjected === true, 'Turn C (Claude, already-seen sid) STILL injects recovery history — the E3 cross-engine override fired');
    ok(sentText.includes(PROVIDER_MARK_B), 'Turn C recovery re-injects the intermediate Provider turn (marker present)');
    ok(sentText.includes('<workbench_history_recovery>'), 'recovery block wraps the injected provider turn');
    ok(sentText.includes('<current_user_message>') && sentText.includes('刚才我们'), 'current user message stays separately delimited');
    // Only the trailing provider tail is injected — Turn A (already in the CLI transcript) is NOT re-duplicated.
    ok(!sentText.includes(CLAUDE_MARK_A), 'Turn A content is NOT re-injected (only the provider tail since the last Claude turn)');

    // Switch once more. Provider history is already non-empty here, which is the exact legacy bug: the old
    // lazy seed ran only when length===0 and therefore omitted Turn C forever.
    const c3 = await postConfig(WB_PORT, token, { activeProvider: 'fake' });
    ok(c3 && c3.ok, 'config switched to provider a second time');
    const cQuestion = '刚才我们用 provider 做了什么？';
    const d = await postStream(WB_PORT, { sessionId: sid, message: '继续核对共享上下文', cwd: HOME });
    const dMeta = d.find(e => e.type === 'meta');
    const dReq = latestProviderRequest();
    ok(dMeta && dMeta.engine === 'openai', 'Turn D ran on the provider engine');
    ok(dReq && JSON.stringify(dReq.messages || []).includes(cQuestion), 'Turn D Provider request absorbs the intervening Claude turn even with non-empty providerHistory');
    const persisted = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    ok(persisted.providerHistoryCursor === persisted.messages.length, 'Provider/display history cursor is persisted at the shared tail');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nE3-ENGINE-SWITCH-CONTINUITY E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
