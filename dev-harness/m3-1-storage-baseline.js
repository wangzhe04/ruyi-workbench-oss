'use strict';
// M3-1b: synthetic plaintext storage baseline for the work-data encryption work (93 §6).
//
// This is a MEASUREMENT tool, not a gate: it asserts nothing and is not picked up by run-all
// (no `.e2e.js` suffix). It builds a synthetic corpus in a throw-away data root and a throw-away
// home, boots the real server against a fake OpenAI-compatible provider, and records cold/hot
// p50/p95 for the six paths 86/93 require (startup, chat first response, append write, session
// search, attachment first read, restart recovery) plus peak memory and on-disk size.
//
//   node dev-harness/m3-1-storage-baseline.js            # print the table only
//   node dev-harness/m3-1-storage-baseline.js --write    # also write the evidence JSON
//
// Rules it follows: no user data is read or written (every root is a temp directory, the CLI
// configs are redirected through fixture-home), no network beyond 127.0.0.1, and the numbers are
// reported as measured — never as a promise of "zero overhead".
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, usageFrame } = require('./lib/fake-openai-provider');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const EVIDENCE = path.join(ROOT, 'docs', 'optimization-plan', 'evidence', 'privacy-m3-1-storage-baseline.json');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const DATA = path.join(os.tmpdir(), 'ruyi-m31b-data-' + STAMP);
const WORKSPACE = path.join(os.tmpdir(), 'ruyi-m31b-work-' + STAMP);
const SESSIONS = 24;
const MESSAGES_PER_SESSION = 200;
const NEEDLE = 'needle-基线-关键词';
const ATTACHMENT_BYTES = 1024 * 1024;
const READS = 20;
const WRITES = 10;
const TURNS = 5;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const round = value => value === null || value === undefined ? null : Math.round(value * 10) / 10;
const percentile = (samples, p) => {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]);
};
const stats = samples => ({ samples: samples.map(round), count: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95),
  min: samples.length ? round(Math.min(...samples)) : null, max: samples.length ? round(Math.max(...samples)) : null });

function request(port, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = {};
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (options.token) headers['x-wcw-token'] = options.token;
    const started = now();
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: options.timeout || 60000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* binary or empty body */ }
        resolve({ status: res.statusCode, ms: now() - started, bytes: raw.length, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// One chat turn: first streamed event vs the whole turn. Both come from the same request so the
// difference is the local prep/append cost around the (fake) model call.
function chatTurn(port, token, sessionId, message) {
  return new Promise(resolve => {
    const payload = JSON.stringify({ sessionId, message });
    const started = now();
    let firstEventMs = null;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-wcw-token': token } }, res => {
      res.on('data', () => { if (firstEventMs === null) firstEventMs = now() - started; });
      res.on('end', () => resolve({ status: res.statusCode, firstEventMs, totalMs: now() - started }));
    });
    req.on('error', error => resolve({ status: 0, error: String(error && error.message || error) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

function waitHealth(port, deadlineMs) {
  return new Promise(resolve => {
    const started = now();
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve({ ok: true, ms: now() - started });
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => { if (now() - started > deadlineMs) return resolve({ ok: false, ms: now() - started }); setTimeout(attempt, 40); };
    attempt();
  });
}

// PeakWorkingSet64 is kept by the OS for the whole process lifetime: one call at the end is enough.
function peakWorkingSet(pid) {
  try {
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const value = Number(String(out).trim());
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function diskUsage(dir) {
  let bytes = 0, files = 0;
  const walk = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { files += 1; try { bytes += fs.statSync(full).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return { bytes, files };
}

function spawnServer(port, env) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env, windowsHide: true });
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { const line = String(chunk).trim(); if (line && process.env.RUYI_BASELINE_VERBOSE) console.log('[srv] ' + line); });
  return child;
}

const messagesFor = index => {
  const out = [];
  for (let i = 0; i < MESSAGES_PER_SESSION; i++) {
    const at = new Date(Date.now() - (MESSAGES_PER_SESSION - i) * 60000).toISOString();
    const body = `合成消息 s${index}-m${i}：` + '这是一段用于基线的普通中文内容，不含真实用户数据。'.repeat(4)
      + (i % 10 === 0 ? NEEDLE : '');
    out.push({ role: i % 2 ? 'assistant' : 'user', content: body, createdAt: at, turnSeq: Math.floor(i / 2) + 1 });
  }
  return out;
};

(async () => {
  const operations = {};
  const notes = [];
  const startedAt = new Date().toISOString();
  const port = await getFreePort();
  let server = null, token = '';
  const fake = await startFakeProvider({
    handler: () => [...textFrames('收到，这是基线回合的固定回复。'), usageFrame({ prompt_tokens: 64, completion_tokens: 12 })],
  });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const { env: isolated, home: fixtureHome } = fixtureChildEnv({ perTest: true });
  const env = { ...isolated, RUYI_HOME: DATA, WIN_CLAUDE_WORKBENCH_HOME: DATA };
  // Cleanup is idempotent and also runs on Ctrl+C / SIGTERM: an interrupted run must not leave a
  // server child or %TEMP%/ruyi-m31b-* behind.
  let cleanedUp = false;
  const stopServer = async () => {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    try { killOwnTree(server); } catch { /* already gone */ }
    await Promise.race([exited, sleep(3000)]);
  };
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await stopServer();
    await fake.close().catch(() => {});
    await sleep(300);
    // Windows can keep handles for a moment after the child dies, so retry instead of one silent
    // best-effort attempt; neither a failed nor a successful delete changes the measurements.
    for (const dir of [DATA, WORKSPACE, fixtureHome]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleep(250 * (attempt + 1)); }
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(130)); });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', activeProvider: 'fake',
    workspaces: [{ path: WORKSPACE }], defaultWorkspace: WORKSPACE, logsKeepDays: 1,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'baseline-key',
      model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
  }, null, 2), 'utf8');

  try {
    // ① cold start on an empty data root.
    let t0 = now();
    server = spawnServer(port, env);
    let health = await waitHealth(port, 30000);
    const coldStart = now() - t0;
    if (!health.ok) throw new Error('server never became healthy on :' + port);
    token = (await request(port, 'POST', '/api/bootstrap', { body: {} })).json?.token || '';
    if (!token) throw new Error('bootstrap returned no token');

    // Synthetic corpus through the product's own write path (no hand-written session files).
    const sessionIds = [];
    for (let index = 0; index < SESSIONS; index++) {
      const created = await request(port, 'POST', '/api/sessions', { token, body: { title: '合成基线会话 ' + index, cwd: WORKSPACE, messages: messagesFor(index) } });
      const id = created.json?.session?.id;
      if (!id) throw new Error('session seed failed: ' + created.status + ' ' + JSON.stringify(created.json).slice(0, 200));
      sessionIds.push(id);
    }
    const attachment = Buffer.from('基线附件内容。'.repeat(Math.ceil(ATTACHMENT_BYTES / 21)).slice(0, ATTACHMENT_BYTES), 'utf8');
    const uploaded = await request(port, 'POST', '/api/upload', { token, body: { name: 'baseline.txt', data: attachment.toString('base64') } });
    const uploadId = uploaded.json?.file?.id, uploadName = uploaded.json?.file?.name;
    if (!uploadId) throw new Error('upload failed: ' + uploaded.status + ' ' + JSON.stringify(uploaded.json).slice(0, 200));

    // ② session load: first read of a session this process has never served, then hot repeats.
    const target = sessionIds[0];
    const loadCold = await request(port, 'GET', '/api/sessions/' + target, { token });
    if (loadCold.status !== 200) throw new Error('session load failed: ' + loadCold.status);
    const loadColdSamples = [loadCold.ms];
    const loadHotSamples = [];
    for (let i = 0; i < READS; i++) loadHotSamples.push((await request(port, 'GET', '/api/sessions/' + target, { token })).ms);

    // ③ append write: the bulk import/append route (messages -> NDJSON append + head + index).
    const appendSamples = [];
    for (let i = 0; i < WRITES; i++) {
      const written = await request(port, 'POST', '/api/sessions', { token, body: { title: '追加基线 ' + i, cwd: WORKSPACE, messages: messagesFor(100 + i).slice(0, 20) } });
      if (written.status !== 200) throw new Error('append failed: ' + written.status);
      appendSamples.push(written.ms);
    }

    // ④ search: first query builds the index, repeats are warm.
    const searchCold = await request(port, 'GET', '/api/sessions/search?q=' + encodeURIComponent(NEEDLE), { token });
    if (searchCold.status !== 200) notes.push('search returned ' + searchCold.status + '; treated as warm-cache baseline only');
    const searchColdSamples = [searchCold.ms];
    const searchHotSamples = [];
    for (let i = 0; i < READS; i++) searchHotSamples.push((await request(port, 'GET', '/api/sessions/search?q=' + encodeURIComponent(NEEDLE), { token })).ms);

    // ⑤ attachment: the upload already wrote it; measure the first read and warm repeats.
    const attachCold = await request(port, 'GET', `/api/upload/content?id=${encodeURIComponent(uploadId)}&name=${encodeURIComponent(uploadName)}`, { token });
    if (attachCold.status !== 200) notes.push('attachment content read returned ' + attachCold.status);
    const attachColdSamples = [attachCold.ms];
    const attachHotSamples = [];
    for (let i = 0; i < READS; i++) attachHotSamples.push((await request(port, 'GET', `/api/upload/content?id=${encodeURIComponent(uploadId)}&name=${encodeURIComponent(uploadName)}`, { token })).ms);

    // ⑥ chat turn: first streamed event vs the whole turn (fake provider replies instantly).
    const firstSamples = [], totalSamples = [];
    for (let i = 0; i < TURNS; i++) {
      const turn = await chatTurn(port, token, target, '基线回合 ' + i + '：请回一句。');
      if (turn.status !== 200 || turn.firstEventMs === null) { notes.push('chat turn failed: ' + JSON.stringify(turn).slice(0, 200)); break; }
      firstSamples.push(turn.firstEventMs);
      totalSamples.push(turn.totalMs);
    }

    const afterWork = await request(port, 'GET', '/api/sessions/' + target, { token });
    const messagesBeforeKill = (afterWork.json?.session?.messages || []).length;
    const peakSamples = [peakWorkingSet(server.pid)];

    // ⑦ recovery: SIGKILL (no graceful flush) and restart on the same data root, three times. Each
    // cycle also gives a cold-process session read and a cold-process search, because a fresh process
    // has no in-memory cache left. The OS page cache is deliberately NOT dropped (that would need
    // machine-wide side effects), so these are cold-process / warm-disk numbers.
    const warmSamples = [], recoveryReadSamples = [], coldReadSamples = [], restartSearchSamples = [];
    const recoveries = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      t0 = now();
      server.kill('SIGKILL');
      await new Promise(resolve => server.once('exit', resolve));
      server = spawnServer(port, env);
      health = await waitHealth(port, 30000);
      const bootMs = now() - t0;
      if (!health.ok) throw new Error('server did not come back after SIGKILL (cycle ' + cycle + ')');
      warmSamples.push(bootMs);
      token = (await request(port, 'POST', '/api/bootstrap', { body: {} })).json?.token || token;
      const read = await request(port, 'GET', '/api/sessions/' + target, { token });
      recoveryReadSamples.push(read.ms);
      const messagesAfter = (read.json?.session?.messages || []).length;
      // Every cycle records its own counts; a growing count is NOT "consistent" — the kill happened
      // after the turn settled, so recovery must reproduce the exact same number.
      recoveries.push({ cycle, status: read.status, messagesBefore: messagesBeforeKill,
        messagesAfter, consistent: messagesAfter === messagesBeforeKill });
      const unread = sessionIds[1 + (cycle % Math.max(1, SESSIONS - 1))];
      coldReadSamples.push((await request(port, 'GET', '/api/sessions/' + unread, { token })).ms);
      restartSearchSamples.push((await request(port, 'GET', '/api/sessions/search?q=' + encodeURIComponent(NEEDLE), { token })).ms);
      peakSamples.push(peakWorkingSet(server.pid));
    }

    const disk = diskUsage(DATA);
    // Cold-process rows stay separate from the in-process first read: mixing them puts p50 on the
    // seam between two clusters, which makes the number flip between runs.
    operations['startup-cold'] = stats([coldStart]);
    operations['startup-warm'] = stats(warmSamples);
    operations['session-load-first-read'] = stats([loadCold.ms]);
    operations['session-load-cold-process'] = stats(coldReadSamples);
    operations['session-load-hot'] = stats(loadHotSamples);
    operations['session-create-import-write'] = stats(appendSamples);
    operations['search-first-query'] = stats([searchCold.ms]);
    operations['search-cold-process'] = stats(restartSearchSamples);
    operations['search-hot'] = stats(searchHotSamples);
    operations['attachment-first-read'] = stats(attachColdSamples);
    operations['attachment-repeat-read'] = stats(attachHotSamples);
    operations['chat-first-response'] = stats(firstSamples);
    operations['chat-turn-total'] = stats(totalSamples);
    operations['recovery-first-read'] = stats(recoveryReadSamples);

    const evidence = {
      schema: 1,
      generatedBy: 'dev-harness/m3-1-storage-baseline.js',
      generatedAt: startedAt,
      scope: 'M3-1b synthetic plaintext baseline before M3-2; temp data root and temp home, no user data, no external network',
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMemBytes: os.totalmem() },
      fixture: {
        sessions: SESSIONS, messagesPerSession: MESSAGES_PER_SESSION, messagesTotal: SESSIONS * MESSAGES_PER_SESSION,
        attachmentBytes: attachment.length, reads: READS, writes: WRITES, turns: TURNS,
        dataBytes: disk.bytes, dataFiles: disk.files,
      },
      operations,
      memory: { workPeakWorkingSetBytes: peakSamples[0], recoveryPeakWorkingSetBytes: Math.max(...peakSamples.slice(1)) },
      recovery: { cycles: recoveries.length, consistent: recoveries.every(row => row.consistent), runs: recoveries },
      // Frozen comparison rule (93 §6). Small-n rows are informational only: with nearest-rank
      // percentiles a 3-4 sample row can move 20%+ between identical runs, so a +10% gate on them
      // would be noise dressed up as a budget.
      thresholds: {
        frozenAt: startedAt,
        comparison: 'same machine, same fixture: run this tool three times and compare the median p50/p95 of the three runs; a single run outside +10% is a trigger to investigate, not a verdict',
        smallNRule: 'rows with n < 20 are informational only (nearest-rank percentiles on 1-5 samples move tens of percent between identical runs)',
        interactionStepsAdded: 0,
        baseline: Object.fromEntries(Object.entries(operations).map(([name, value]) => [name, { n: value.count, p50: value.p50, p95: value.p95 }])),
        absoluteBudgets: { startupMs: 7500, 'session-loadMs': 2000,
          source: 'the two budgets perf.e2e.js already enforces; no other absolute budget exists in the product, so the relative rule is the gate' },
        note: 'relative comparison against this baseline is mandatory for M3-2/M3-3; new absolute budgets are frozen only when a product requirement exists, never invented from a single sample',
      },
      notes: notes.concat([
        'cold = first call in a freshly started process; the OS page cache is not dropped (that needs machine-wide side effects), so these are cold-process/warm-disk numbers',
        'session-load-first-read (n=1) is the writing process reading a session it just created; session-load-cold-process (n=3) is a fresh process reading a session it has never served',
        'recovery-first-read re-reads the same session that was hot before the kill, so its page cache is warm and it is not comparable to session-load-cold-process',
        'search-first-query (n=1) is the writing process; search-cold-process (n=3) is the first query in each restarted process',
        'session-create-import-write creates a new session and imports 20 messages (POST /api/sessions with messages); it is not an append into an existing session',
        'chat-turn-total includes turn finalisation (title/thread-brief and stream teardown), which is not on the storage append path; chat-first-response is the storage-relevant number',
      ]),
    };

    print(evidence);
    if (process.argv.includes('--write')) {
      fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
      fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      console.log('\nwrote ' + path.relative(ROOT, EVIDENCE));
    }
  } finally {
    await cleanup();
  }
})().catch(error => { console.error('baseline failed: ' + (error && error.stack || error)); process.exitCode = 1; });

function print(evidence) {
  const rows = Object.entries(evidence.operations);
  console.log('\nsynthetic plaintext baseline — ' + evidence.environment.node + ', ' + evidence.fixture.messagesTotal + ' messages, '
    + evidence.fixture.dataFiles + ' files / ' + (evidence.fixture.dataBytes / 1024 / 1024).toFixed(1) + ' MiB');
  console.log('operation'.padEnd(26) + 'n'.padStart(3) + 'p50(ms)'.padStart(10) + 'p95(ms)'.padStart(10) + 'min'.padStart(9) + 'max'.padStart(9));
  for (const [name, value] of rows) {
    console.log(name.padEnd(26) + String(value.count).padStart(3) + String(value.p50).padStart(10) + String(value.p95).padStart(10)
      + String(value.min).padStart(9) + String(value.max).padStart(9));
  }
  console.log('peak RSS: work ' + mb(evidence.memory.workPeakWorkingSetBytes) + ', recovery ' + mb(evidence.memory.recoveryPeakWorkingSetBytes));
  if (evidence.recovery) console.log('recovery: ' + evidence.recovery.runs.map(row => row.messagesBefore + '->' + row.messagesAfter).join(', ')
    + ' (consistent=' + evidence.recovery.consistent + ')');
  if (evidence.notes.length) console.log('notes: ' + evidence.notes.join(' | '));
}
function mb(bytes) { return bytes === null ? 'n/a' : (bytes / 1024 / 1024).toFixed(1) + ' MiB'; }
