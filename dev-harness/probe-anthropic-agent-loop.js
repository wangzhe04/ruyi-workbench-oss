'use strict';
// Explicit live qualification of the production HTTP Agent Loop, real file_read, and usage ledger.
// node dev-harness/probe-anthropic-agent-loop.js --live [--provider ID] [--model MODEL] [--style anthropic|chat|responses] [--baseline-head] --report FILE
// The forwarding proxy keeps the real API key in memory; the isolated child receives a fake key only.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const reportFile = args.includes('--report') ? args[args.indexOf('--report') + 1] : '';
if (!args.includes('--live')) console.log('SKIP: --live authorizes three isolated Sonnet turns with real file_read.');
else main().catch(error => { console.error('Agent loop probe failed: ' + (error.code || error.name)); process.exitCode = 1; });

async function main() {
  const srv = require('../ruyi-workbench/app/server.js');
  const source = await srv.readConfig();
  const selected = option('--provider') ? source.providers.find(provider => provider.id === option('--provider')) : null;
  if (option('--provider') && !selected) throw Object.assign(new Error(), { code: 'configured_provider_required' });
  const style = option('--style') || selected?.apiStyle || 'anthropic';
  if (!['chat', 'responses', 'anthropic'].includes(style)) throw Object.assign(new Error(), { code: 'unsupported_style' });
  const real = selected || source.providers.find(p => style === 'anthropic' ? p.apiStyle === 'anthropic' && /^Yotta A/i.test(p.label) : p.label === 'Yotta');
  if (!real?.apiKey) throw Object.assign(new Error(), { code: 'configured_provider_required' });
  const wire = srv.PROVIDER_WIRE_PROTOCOLS[style];
  const model = option('--model') || selected?.model || 'claude-sonnet-5-5';
  const baseline = args.includes('--baseline-head');
  const gitHead = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-agent-cache-live-'));
  const home = path.join(root, 'data'), work = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(work);
  const nonce = crypto.randomBytes(12).toString('hex');
  const markers = [1, 2, 3].map(i => `CACHE-${i}-${nonce}`);
  const files = markers.map((marker, i) => { const file = path.join(work, `marker-${i + 1}.txt`); fs.writeFileSync(file, marker + '\n'); return file; });
  let appDir = path.resolve(__dirname, '../ruyi-workbench/app');
  if (baseline) {
    appDir = path.join(root, 'baseline', 'app'); fs.mkdirSync(appDir, { recursive: true });
    const frozen = cp.execFileSync('git', ['show', 'HEAD:ruyi-workbench/app/server.js'], { cwd: path.resolve(__dirname, '..'), maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(path.join(appDir, 'server.js'), frozen);
    for (const dir of ['public', 'src']) fs.symlinkSync(path.resolve(__dirname, '../ruyi-workbench/app', dir), path.join(appDir, dir), 'junction');
    for (const dir of ['resources', 'config']) fs.symlinkSync(path.resolve(__dirname, '../ruyi-workbench', dir), path.join(root, 'baseline', dir), 'junction');
  }
  const report = { schema: 1, createdAt: new Date().toISOString(), model, style, providerId: real.id, baselineHead: baseline, gitHead,
    baselineScope: baseline ? 'Frozen HEAD server.js; public/src/resources/config support paths shared with the working tree.' : 'Built working-tree server.js',
    serverSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(appDir, 'server.js'))).digest('hex'),
    syntheticOnly: true, realWorkbench: true, turns: [], requests: [], status: 'pending' };
  const save = () => { if (reportFile) fs.writeFileSync(path.resolve(reportFile), JSON.stringify(report, null, 2) + '\n'); };
  const inputTotal = usage => Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const cacheRead = usage => Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.prompt_cache_hit_tokens ?? 0);
  const cacheWrite = usage => Number(usage?.cache_creation_input_tokens ?? usage?.input_tokens_details?.cache_write_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens ?? 0);
  let wb, proxy;
  try {
    proxy = http.createServer(async (req, res) => {
      try {
        const endpointPath = new URL(wire.completionUrl('http://127.0.0.1:1/v1')).pathname;
        if (req.method !== 'POST' || req.url !== endpointPath) { res.writeHead(404); res.end(); return; }
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw Object.assign(new Error(), { code: 'request_too_large' }); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.model !== model || body.stream !== true || report.requests.length >= 18) throw Object.assign(new Error(), { code: 'unexpected_model_request' });
        const row = { index: report.requests.length, model: body.model, tools: (body.tools || []).length, messageCount: (body.messages || body.input || []).length,
          systemHash: crypto.createHash('sha256').update(JSON.stringify(body.system ?? body.instructions ?? (body.messages || []).filter(message => message.role === 'system'))).digest('hex'),
          toolsHash: crypto.createHash('sha256').update(JSON.stringify(body.tools)).digest('hex'), rawUsage: {}, normalizedUsage: null };
        report.requests.push(row);
        const upstream = await fetch(wire.completionUrl(real.baseUrl), { method: 'POST', redirect: 'error',
          headers: wire.requestHeaders(real, { model }), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        row.httpStatus = upstream.status;
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' });
        let pending = ''; const decoder = new TextDecoder();
        const observe = line => {
          if (!line.startsWith('data:')) return;
          let event; try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
          const responseModel = event.message?.model || event.response?.model || event.model;
          if (responseModel) row.responseModel = responseModel;
          const usage = event.message?.usage || event.response?.usage || event.usage;
          // Keep numerical billing evidence only; never persist arbitrary upstream strings/debug fields.
          for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cost_usd', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens']) {
            if (typeof usage?.[key] === 'number' && Number.isFinite(usage[key])) row.rawUsage[key] = usage[key];
          }
          for (const key of ['prompt_tokens_details', 'input_tokens_details']) {
            if (usage?.[key] && typeof usage[key] === 'object') row.rawUsage[key] = Object.fromEntries(Object.entries(usage[key]).filter(([name, value]) => ['cached_tokens', 'cache_write_tokens'].includes(name) && typeof value === 'number' && Number.isFinite(value)));
          }
        };
        for await (const chunk of upstream.body) {
          res.write(chunk); pending += decoder.decode(chunk, { stream: true });
          let nl; while ((nl = pending.indexOf('\n')) >= 0) { observe(pending.slice(0, nl).replace(/\r$/, '')); pending = pending.slice(nl + 1); }
        }
        pending += decoder.decode(); if (pending.trim()) observe(pending);
        row.normalizedUsage = wire.normalizeUsage(row.rawUsage);
        res.end(); save();
      } catch (error) { report.proxyError = error.code || error.name; res.destroy(); save(); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const provider = { id: 'cache-live', label: 'Synthetic cache qualification', type: 'openai-compat', apiStyle: style,
      baseUrl: `http://127.0.0.1:${proxy.address().port}` + (style === 'responses' ? '/v1' : ''), apiKey: 'synthetic-local-key', model, models: [{ id: model, label: model }],
      anthropicThinking: 'off', reasoning: 'low', systemPrompt: `Synthetic qualification ${nonce}. Read only the files explicitly requested. Reply only with the marker. Never delegate.\n` + 'Stable reference data for cache qualification.\n'.repeat(180) };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 12, permissionMode: 'bypass', defaultWorkspace: work,
      providers: [provider], activeProvider: provider.id, stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false,
      importAgentInstructions: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
      bridgeExternalTools: false, memoryEnabled: false, runtimeSummaryEntityCheckV1: false, openaiMaxToolIterations: 6 }));
    const port = await getFreePort();
    wb = cp.spawn(process.execPath, [path.join(appDir, 'server.js'), 'serve', '--port', String(port)], { cwd: path.dirname(appDir), windowsHide: true,
      env: { ...fixtureChildEnv(), RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home } });
    wb.stdout.resume(); wb.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) {
      healthy = await fetch(base + '/health').then(r => r.ok).catch(() => false);
      if (!healthy) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!healthy) throw Object.assign(new Error(), { code: 'workbench_start_failed' });
    const html = await fetch(base).then(r => r.text());
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const headers = { 'content-type': 'application/json', 'x-wcw-token': token };
    const created = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ title: 'Synthetic cache qualification', cwd: work }) }).then(r => r.json());
    if (!created.session?.id) throw Object.assign(new Error(), { code: 'session_create_failed' });
    for (let i = 0; i < 3; i++) {
      const before = report.requests.length;
      const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ sessionId: created.session.id, cwd: work, message: `第${i + 1}轮：必须调用 file_read 读取 ${files[i]}，仅回复文件中的完整标记。禁止用脚本或其它工具代替，不要读任何其它文件。` }) });
      const events = (await response.text()).trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
      // The workbench may finish at message_stop before the forwarding observer reaches upstream EOF.
      // Wait for every accepted request's observation to settle before comparing its counters with the ledger.
      const settleDeadline = Date.now() + 5000;
      while (report.requests.slice(before).some(row => !row.normalizedUsage) && Date.now() < settleDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (report.requests.slice(before).some(row => !row.normalizedUsage)) throw Object.assign(new Error(), { code: 'upstream_observation_incomplete' });
      const result = events.find(e => e.type === 'result');
      const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
      const calls = events.filter(e => e.type === 'tool_use');
      const usedRead = calls.some(e => e.name === 'file_read' && path.resolve(e.input?.path || '') === files[i]
        && events.some(result => result.type === 'tool_result' && result.id === e.id && result.isError !== true && JSON.stringify(result.content).includes(markers[i])));
      const turn = { turn: i + 1, ok: result?.ok === true, markerCorrect: text.includes(markers[i]), realFileRead: usedRead,
        modelRequests: report.requests.length - before, cachedInput: report.requests.slice(before).reduce((sum, row) => sum + cacheRead(row.rawUsage), 0) };
      report.turns.push(turn); console.log(JSON.stringify(turn)); save();
      if (!turn.ok || !turn.markerCorrect || !usedRead || turn.modelRequests < 2) throw Object.assign(new Error(), { code: 'real_file_read_turn_failed' });
    }
    const ledgerDir = path.join(home, 'usage');
    const ledger = fs.readdirSync(ledgerDir).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(path.join(ledgerDir, file), 'utf8').trim().split('\n').map(JSON.parse)).filter(row => row.provider === provider.id && row.kind === 'turn');
    const expectedInput = report.requests.reduce((sum, row) => sum + inputTotal(row.normalizedUsage), 0);
    const expectedCached = report.requests.reduce((sum, row) => sum + cacheRead(row.rawUsage), 0);
    report.ledger = { rows: ledger.length, input: ledger.reduce((sum, row) => sum + row.inTok, 0), cached: ledger.reduce((sum, row) => sum + row.cachedInTok, 0),
      expectedInput, expectedCached };
    const sonnetPricing = model === 'claude-sonnet-5-5';
    report.costCheck = report.requests.map(row => {
      const u = row.rawUsage;
      if (!sonnetPricing) return { reportedUsd: typeof u.cost_usd === 'number' ? u.cost_usd : null, calculatedUsd: null, matches: null, note: 'No pricing assumed for this model; usage-only qualification.' };
      const read = cacheRead(u), written = cacheWrite(u);
      const ordinary = Math.max(0, inputTotal(row.normalizedUsage) - read - written);
      // Official Sonnet 5.5 USD rates per million: ordinary input 2, 5m write 2.5, cache read 0.1, output 10.
      const calculatedUsd = (ordinary * 2 + written * 2.5 + read * 0.1 + Number(u.completion_tokens ?? u.output_tokens ?? 0) * 10) / 1e6;
      return { reportedUsd: typeof u.cost_usd === 'number' ? u.cost_usd : null, calculatedUsd,
        matches: typeof u.cost_usd === 'number' && Math.abs(calculatedUsd - u.cost_usd) < 1e-8 };
    });
    report.reportedCostUsd = report.costCheck.every(check => check.reportedUsd != null) ? report.costCheck.reduce((sum, check) => sum + check.reportedUsd, 0) : null;
    if (sonnetPricing && (!report.costCheck.length || !report.costCheck.every(check => check.matches))) throw Object.assign(new Error(), { code: 'cost_arithmetic_mismatch' });
    if (ledger.length !== 3 || report.ledger.input !== expectedInput || report.ledger.cached !== expectedCached || (style === 'anthropic' && !baseline && !report.turns.slice(1).every(turn => turn.cachedInput > 0))) throw Object.assign(new Error(), { code: 'ledger_or_cache_mismatch' });
    report.status = 'passed'; console.log(JSON.stringify({ status: report.status, ledger: report.ledger, reportedCostUsd: report.reportedCostUsd }));
  } catch (error) { report.status = 'failed'; report.error = error.code || error.name; throw error; }
  finally {
    if (wb) killOwnTree(wb);
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    save();
    // Isolated synthetic artifacts contain a fake key only; preserved for diagnosis, no real key is written.
  }
}
