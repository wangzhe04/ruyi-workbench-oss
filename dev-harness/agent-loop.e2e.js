// E2E (v0.8-S1): agent loop over the new fake modes.
//  Part 1 (FAKE_TOOL_SEQUENCE): three DIFFERENT tools in order (file_write -> file_read -> file_search).
//    Asserts 3 tool_use events appear in that order, all 3 tool_result are ok, the terminal usage event
//    reports calls===4 (3 tool rounds + 1 echo finish) with input_tokens === sum of 4 frames, result ok.
//  Part 2 (FAKE_PARALLEL_TOOLS): two tools emitted in ONE assistant message. Asserts both tool_use land
//    in the same assistant round, both tool_result are present, and the turn finishes normally.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-agent-loop-e2e');
const HOOK_HOME = path.join(os.tmpdir(), 'wcw-agent-loop-hook-e2e');
process.env.RUYI_HOME = HOOK_HOME;
const hookApi = require(path.join(WB, 'app', 'server.js'));
const PER_CALL_PROMPT = 42; // from fake-openai usageFrame()

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
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  const spawnPair = (fakeEnv, fakePort, wbPort, home) => {
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), ...fakeEnv }, windowsHide: true });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fake, wb);
    return { fake, wb };
  };
  const killPair = pair => { for (const c of [pair.wb, pair.fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } } };
  const waitHealthy = async (port) => { let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); } return h; };

  try {
    // ---- Part 0: lifecycle hook contract (in-process, no provider required) ----
    {
      fs.rmSync(HOOK_HOME, { recursive: true, force: true }); fs.mkdirSync(HOOK_HOME, { recursive: true });
      const expectedPhases = ['onTurnStart', 'beforeModelCall', 'preToolCall', 'postToolCall', 'onTurnEnd', 'onError'];
      ok(JSON.stringify(hookApi.AGENT_LOOP_HOOK_PHASES) === JSON.stringify(expectedPhases), 'hooks: fixed lifecycle phase contract');
      const order = [];
      let frozen = false, followerRan = false;
      hookApi.registerAgentLoopHook({ id: 'e2e-first', onTurnStart: ctx => { order.push('first'); frozen = Object.isFrozen(ctx) && Object.isFrozen(ctx.nested); try { ctx.nested.value = 9; } catch { /* strict callers may throw */ } } });
      hookApi.registerAgentLoopHook({ id: 'e2e-second', onTurnStart: ctx => { order.push('second'); followerRan = ctx.nested.value === 1; } });
      const dispatched = await hookApi.dispatchAgentLoopHooks('onTurnStart', { traceId: 'trace_contract', nested: { value: 1 } });
      ok(order.join(',') === 'first,second' && dispatched.invoked === 2, 'hooks: deterministic registration order');
      ok(frozen && followerRan, 'hooks: context is deeply frozen and mutation cannot leak');
      ok(hookApi.listAgentLoopHooks().map(h => h.id).join(',') === 'e2e-first,e2e-second', 'hooks: registry metadata is inspectable');
      hookApi.unregisterAgentLoopHook('e2e-first'); hookApi.unregisterAgentLoopHook('e2e-second');

      hookApi.registerAgentLoopHook({ id: 'e2e-throws', onError: () => { throw new Error('expected hook failure'); } });
      hookApi.registerAgentLoopHook({ id: 'e2e-after', onError: () => { followerRan = true; } });
      followerRan = false;
      const isolated = await hookApi.dispatchAgentLoopHooks('onError', { traceId: 'trace_isolation' });
      ok(isolated.invoked === 2 && isolated.failed === 1 && followerRan, 'hooks: exception is isolated and later hooks still run');
      hookApi.unregisterAgentLoopHook('e2e-throws'); hookApi.unregisterAgentLoopHook('e2e-after');

      hookApi.registerAgentLoopHook({ id: 'e2e-timeout', timeoutMs: 25, beforeModelCall: () => new Promise(() => {}) });
      const timeoutStarted = Date.now();
      const timed = await hookApi.dispatchAgentLoopHooks('beforeModelCall', { traceId: 'trace_timeout' });
      ok(timed.failed === 1 && Date.now() - timeoutStarted < 500, 'hooks: timeout is bounded and fail-open');
      hookApi.unregisterAgentLoopHook('e2e-timeout');
      let invalidRejected = false;
      try { await hookApi.dispatchAgentLoopHooks('not-a-phase', {}); } catch { invalidRejected = true; }
      ok(invalidRejected, 'hooks: unknown lifecycle phase is rejected');
      const resultSummary = hookApi.summarizeAgentLoopToolResult({ ok: false, error: 'boom', content: 'large payload' });
      ok(resultSummary.ok === false && resultSummary.bytes > 0 && !Object.prototype.hasOwnProperty.call(resultSummary, 'content'), 'hooks: post-tool context uses bounded result metadata');
      const providerLoopSrc = fs.readFileSync(path.join(WB, 'app', 'src', '09-workflow.js'), 'utf8');
      const claudeLoopSrc = fs.readFileSync(path.join(WB, 'app', 'src', '05-claude-engine.js'), 'utf8');
      ok(expectedPhases.every(phase => providerLoopSrc.includes(`dispatchAgentLoopHooks('${phase}'`)), 'hooks: Provider native loop wires all six lifecycle phases');
      ok(['onTurnStart', 'beforeModelCall', 'onTurnEnd', 'onError'].every(phase => claudeLoopSrc.includes(`dispatchAgentLoopHooks('${phase}'`))
        && !claudeLoopSrc.includes("dispatchAgentLoopHooks('preToolCall'") && !claudeLoopSrc.includes("dispatchAgentLoopHooks('postToolCall'"), 'hooks: Claude CLI adapter exposes honest turn/model boundaries only');
    }

    // ---- Part 1: sequential three-step loop ----
    {
      const home = path.join(HOME, 'seq'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const target = path.join(home, 'made.txt');
      writeConfig(home, 8963);
      const seq = JSON.stringify([
        { name: 'file_write', args: { path: target, content: 'FINDME payload here' } },
        { name: 'file_read', args: { path: target } },
        { name: 'file_search', args: { pattern: 'FINDME', root: home } },
      ]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8963, 8964, home);
      const h = await waitHealthy(8964); ok(!!h, 'seq: workbench up');
      const events = await postStream(8964, { message: '三步走', cwd: home });
      const lifecycleEvents = events.filter(e => e && e.type && e.type !== 'session'); // session is the pre-turn stream envelope
      const traceIds = [...new Set(lifecycleEvents.map(e => e.traceId))];
      const untracedTypes = lifecycleEvents.filter(e => !e.traceId).map(e => e.type);
      ok(traceIds.length === 1 && /^trace_[0-9a-f]{16}$/.test(traceIds[0] || ''), 'seq: one traceId spans every streamed lifecycle event (got ' + JSON.stringify(traceIds) + '; untraced ' + untracedTypes.join(',') + ')');
      const toolUses = events.filter(e => e.type === 'tool_use');
      const toolResults = events.filter(e => e.type === 'tool_result');
      ok(toolUses.length === 3, 'seq: 3 tool_use events (got ' + toolUses.length + ')');
      ok(toolUses[0] && toolUses[0].name === 'file_write' && toolUses[1] && toolUses[1].name === 'file_read' && toolUses[2] && toolUses[2].name === 'file_search',
        'seq: tool_use order file_write -> file_read -> file_search (got ' + toolUses.map(t => t.name).join(',') + ')');
      ok(toolResults.length === 3 && toolResults.every(r => r.isError !== true), 'seq: 3 tool_result all ok');
      const usage = events.find(e => e.type === 'usage');
      ok(usage && usage.calls === 4, 'seq: usage.calls === 4 (3 tool rounds + 1 finish) (got ' + (usage && usage.calls) + ')');
      ok(usage && usage.usage && usage.usage.input_tokens === PER_CALL_PROMPT * 4, 'seq: input_tokens === 4*42 (got ' + (usage && usage.usage && usage.usage.input_tokens) + ')');
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'seq: result ok=true');
      killPair(pair);
    }

    // ---- Part 2: parallel two-tool round ----
    {
      const home = path.join(HOME, 'par'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const fA = path.join(home, 'pa.txt'); fs.writeFileSync(fA, 'alpha');
      const fB = path.join(home, 'pb.txt'); fs.writeFileSync(fB, 'beta');
      writeConfig(home, 8965);
      const par = JSON.stringify([
        { name: 'file_read', args: { path: fA } },
        { name: 'file_read', args: { path: fB } },
      ]);
      const pair = spawnPair({ FAKE_PARALLEL_TOOLS: par }, 8965, 8966, home);
      const h = await waitHealthy(8966); ok(!!h, 'par: workbench up');
      const events = await postStream(8966, { message: '并行两个', cwd: home });
      const lifecycleEvents = events.filter(e => e && e.type && e.type !== 'session'); // session is the pre-turn stream envelope
      const traceIds = [...new Set(lifecycleEvents.map(e => e.traceId))];
      const untracedTypes = lifecycleEvents.filter(e => !e.traceId).map(e => e.type);
      ok(traceIds.length === 1 && /^trace_[0-9a-f]{16}$/.test(traceIds[0] || ''), 'par: one traceId spans parallel tool events (got ' + JSON.stringify(traceIds) + '; untraced ' + untracedTypes.join(',') + ')');
      const toolUses = events.filter(e => e.type === 'tool_use');
      const toolResults = events.filter(e => e.type === 'tool_result');
      ok(toolUses.length === 2, 'par: 2 tool_use events (got ' + toolUses.length + ')');
      // Same assistant round: both tool_use appear before any tool_result-driven follow-up round; their
      // call ids are call_1 and call_2 as emitted in one message.
      ok(toolUses[0] && toolUses[1] && toolUses[0].id === 'call_1' && toolUses[1].id === 'call_2', 'par: ids call_1 & call_2 in one round');
      ok(toolResults.length === 2 && toolResults.every(r => r.isError !== true), 'par: 2 tool_result all ok');
      const usage = events.find(e => e.type === 'usage');
      ok(usage && usage.calls === 2, 'par: usage.calls === 2 (parallel round + finish) (got ' + (usage && usage.calls) + ')');
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'par: result ok=true');
      killPair(pair);
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(HOOK_HOME, { recursive: true, force: true });
    console.log('\nAGENT-LOOP E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
