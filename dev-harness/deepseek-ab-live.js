// LIVE A/B: SAME multi-step tool-loop tasks through the REAL DeepSeek API, comparing the
// 'chat' (Chat Completions /chat/completions) vs 'responses' (Responses API /responses)
// protocol on the REAL workbench engine (runOpenAiTurn + native tool loop).
//
// What it measures per protocol:
//   * wall-clock total / TTFT (first assistant|thinking delta)
//   * number of DeepSeek HTTP calls (count of usage events emitted during the tool loop)
//   * summed input / output / cached-input tokens, cached-hit ratio
//   * correctness (secret markers must come back) and turn-level ok
//
// Cost estimate uses the workbench preset pricing for deepseek-v4-flash
// (CNY per 1M tokens): input 1, cached-input 0.02, output 2.
//
// Usage: node dev-harness/deepseek-ab-live.js <API_KEY> [MODEL=deepseek-v4-flash]
// Requires network + a real DeepSeek key (argv, never persisted; temp config wiped after).
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const KEY = process.argv[2];
const MODEL = process.argv[3] || 'deepseek-v4-flash';
if (!KEY) { console.error('Usage: node dev-harness/deepseek-ab-live.js <DEEPSEEK_API_KEY> [MODEL]'); process.exit(2); }

// deepseek-v4-flash preset pricing (CNY / 1M tokens) — matches 05-claude-engine.js preset.
const PRICING = { inputPerM: 1, outputPerM: 2, cachedInputPerM: 0.02 };
const STYLES = ['chat', 'responses'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }

function postStream(port, payload, onFirstEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = []; let firstEventMs = null;
      res.on('data', c => {
        buf += c; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (firstEventMs === null) firstEventMs = Date.now() - started;
            events.push(e);
            if (onFirstEvent) onFirstEvent(e, firstEventMs);
          } catch { /* ignore */ }
        }
      });
      res.on('end', () => {
        if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } }
        resolve({ events, totalMs: Date.now() - started, firstEventMs });
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function runOneStyle(styleName, tasks, runIdx) {
  const port = await getFreePort();
  const home = path.join(os.tmpdir(), `wcw-ab-${styleName}-${runIdx}`);
  const work = path.join(home, 'work');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // Task fixtures: two secret files inside the default workspace.
  const SECRET_A = 'AB_SECRET_ALPHA_' + runIdx + '_' + styleName.toUpperCase();
  const SECRET_B = 'AB_SECRET_BETA_' + runIdx + '_' + styleName.toUpperCase();
  const FILE_A = path.join(work, 'secret-a.txt');
  const FILE_B = path.join(work, 'secret-b.txt');
  fs.writeFileSync(FILE_A, 'The first secret marker is ' + SECRET_A + '.');
  fs.writeFileSync(FILE_B, 'The second secret marker is ' + SECRET_B + '.');

  // Heavy-task fixtures: a ~20k-token Chinese context (forces large payload re-transmission on
  // EVERY tool-loop round) plus 5 sequential secret files (forces a multi-round tool chain).
  const LONGCTX = path.join(work, 'longctx.txt');
  const HEAVY_KEY = 'RC-8842';
  {
    const rows = [];
    for (let i = 1; i <= 700; i++) {
      if (i === 137) rows.push('【关键行】区域批准码 = ' + HEAVY_KEY + '；其余所有码均为干扰项。');
      rows.push(`记录${String(i).padStart(3, '0')}：项目代号P-${String((i * 7919) % 100000).padStart(5, '0')}，负责人${'用户' + (i % 23)}，状态${i % 3 === 0 ? '等待' : '进行中'}，预算${((i * 137) % 9000) + 1000}元，里程碑${i % 5 === 0 ? '已达成' : '未达成'}。`);
    }
    fs.writeFileSync(LONGCTX, rows.join('\n'), 'utf8');
  }
  const HEAVY_SECRETS = [];
  const HEAVY_FILES = [];
  for (let k = 1; k <= 5; k++) {
    const s = `HEAVY_S${k}_TOK_${runIdx}_${styleName.toUpperCase()}`;
    HEAVY_SECRETS.push(s);
    const f = path.join(work, `secret-${k}.txt`);
    HEAVY_FILES.push(f);
    fs.writeFileSync(f, `Secret ${k} marker is ${s}.`);
  }

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: work,
    providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', apiStyle: styleName,
      baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], reasoning: true }],
    activeProvider: 'deepseek',
  }, null, 2));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  const run = { style: styleName, tasks: [], wb, port, home, SECRET_A, SECRET_B, FILE_A, FILE_B, LONGCTX, HEAVY_KEY, HEAVY_SECRETS, HEAVY_FILES };
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); }
    if (!h) throw new Error('workbench not listening on :' + port);

    for (const task of tasks) {
      const payload = { message: task.prompt(run) };
      let ttftMs = null;
      const onFirst = e => { if (ttftMs === null && (e.type === 'assistant_delta' || e.type === 'thinking_delta')) ttftMs = Date.now(); };
      const t0 = Date.now();
      const { events, totalMs, firstEventMs } = await postStream(port, payload, onFirst);
      const wallMs = Date.now() - t0;
      const toolUses = events.filter(e => e.type === 'tool_use');
      const toolResults = events.filter(e => e.type === 'tool_result');
      const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
      const think = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
      const usages = events.filter(e => e.type === 'usage');
      const result = events.find(e => e.type === 'result');
      const errEvt = events.find(e => e.type === 'error') || (result && result.error ? result : null);

      const usage = { input: 0, output: 0, cached: 0 };
      for (const u of usages) {
        const gu = (u && u.usage) || {};
        usage.input += Number(gu.input_tokens || 0);
        usage.output += Number(gu.output_tokens || 0);
        usage.cached += Number(gu.cached_input_tokens || 0);
      }
      const cachedRatio = usage.input > 0 ? usage.cached / usage.input : 0;
      const cost = (usage.input - usage.cached) / 1e6 * PRICING.inputPerM + usage.cached / 1e6 * PRICING.cachedInputPerM + usage.output / 1e6 * PRICING.outputPerM;

      const okFlag = !!(result && result.ok === true) && !errEvt;
      const done = { task: task.id, wallMs, totalMs, firstEventMs, ttftMs: ttftMs ? ttftMs - t0 : null,
        httpCalls: usages.length, input: usage.input, output: usage.output, cached: usage.cached,
        cachedRatio, cost, toolNames: toolUses.map(t => t.name), toolCount: toolUses.length,
        textLen: text.length, thinkChars: think.length, ok: okFlag, error: errEvt ? (errEvt.error || errEvt.message) : null,
        hasSecretA: text.includes(SECRET_A), hasSecretB: text.includes(SECRET_B),
        hasHeavyKey: text.includes(HEAVY_KEY),
        heavySecretHits: HEAVY_SECRETS.filter(s => text.includes(s)).length };
      run.tasks.push(done);
      console.log(`  [${run.style}] ${task.id}: ${done.wallMs}ms wall, ${done.httpCalls} HTTP calls, in=${done.input} out=${done.output} cached=${done.cached} (${(done.cachedRatio * 100).toFixed(1)}%), ¥${done.cost.toFixed(4)}${done.ok ? '' : ' ERR ' + done.error}`);
    }
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
  return run;
}

(async () => {
  const tasks = [
    {
      id: 'tool1_single_read',
      prompt: s => `请用 file_read 工具读取文件 ${s.FILE_A.replace(/\\/g, '\\\\')} 的内容，然后把里面的密标记字符串原样告诉我。`,
    },
    {
      id: 'tool2_seq_reads',
      prompt: s => `请依次用 file_read 工具读取文件 ${s.FILE_A.replace(/\\/g, '\\\\')} 和 ${s.FILE_B.replace(/\\/g, '\\\\')}，然后把两个文件里各自的密标记字符串告诉我，用逗号分隔。`,
    },
    {
      id: 'heavy_longchain',
      prompt: s => `这是压力测试任务，请严格按顺序执行，不要并行：
1. 先用 file_read 读取 ${s.LONGCTX.replace(/\\/g, '\\\\')}（很长），记住其中唯一带"【关键行】"字样的批准码。
2. 然后依次读取 ${s.HEAVY_FILES.map(f => f.replace(/\\/g, '\\\\')).join('、')} —— 每次只调用一个 file_read，等结果返回后再读下一个，总共 5 次。
3. 最后只输出一行 JSON：{"key":"<批准码>","secrets":["<secret-1的密标>","<secret-2的密标>","<secret-3的密标>","<secret-4的密标>","<secret-5的密标>"]}。
不要用其他工具，不要输出 JSON 以外的内容。`,
    },
  ];

  console.log(`\nDEEPSEEK A/B (${MODEL}) — chat vs responses — ${new Date().toISOString()}\n`);
  const results = [];
  for (let i = 0; i < STYLES.length; i++) {
    const style = STYLES[i];
    console.log(`[${style}] starting workbench …`);
    try { results.push(await runOneStyle(style, tasks, i)); }
    catch (e) { console.error(`[${style}] ERROR ${e.message}`); results.push({ style, tasks: [], error: e.message }); }
    await sleep(500);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const byStyle = {};
  for (const r of results) byStyle[r.style] = r;
  console.log('\n┌────────────────────────────────────────────────────────────────┐');
  console.log('│  A/B 对比表 · ' + MODEL + ' · 真实 DeepSeek API · 工具循环任务        │');
  console.log('└────────────────────────────────────────────────────────────────┘');
  const rows = [];
  for (const t of tasks) {
    const a = byStyle.chat && byStyle.chat.tasks.find(x => x.task === t.id);
    const b = byStyle.responses && byStyle.responses.tasks.find(x => x.task === t.id);
    if (!a || !b) { console.log(`  ${t.id}: missing run (chat=${!!a}, responses=${!!b})`); continue; }
    const row = {
      task: t.id,
      chat: { wallMs: a.wallMs, ttft: a.ttftMs, http: a.httpCalls, in: a.input, out: a.output, cached: a.cached, cachedRatio: a.cachedRatio, cost: a.cost, ok: a.ok, tools: a.toolNames },
      responses: { wallMs: b.wallMs, ttft: b.ttftMs, http: b.httpCalls, in: b.input, out: b.output, cached: b.cached, cachedRatio: b.cachedRatio, cost: b.cost, ok: b.ok, tools: b.toolNames },
    };
    rows.push(row);
    console.log(`\n[${t.id}]`);
    console.log(`  耗时 wall:  chat=${a.wallMs}ms  responses=${b.wallMs}ms  (Δ ${((b.wallMs - a.wallMs) / a.wallMs * 100).toFixed(1)}%)`);
    console.log(`  TTFT:       chat=${a.ttftMs == null ? '-' : a.ttftMs + 'ms'}  responses=${b.ttftMs == null ? '-' : b.ttftMs + 'ms'}`);
    console.log(`  HTTP 轮数:  chat=${a.httpCalls}  responses=${b.httpCalls}`);
    console.log(`  input:      chat=${a.input}  responses=${b.input}`);
    console.log(`  output:     chat=${a.output}  responses=${b.output}`);
    console.log(`  cached:     chat=${a.cached} (${(a.cachedRatio * 100).toFixed(1)}%)  responses=${b.cached} (${(b.cachedRatio * 100).toFixed(1)}%)`);
    console.log(`  估算成本 ¥: chat=${a.cost.toFixed(4)}  responses=${b.cost.toFixed(4)}  (Δ ${((b.cost - a.cost) / a.cost * 100).toFixed(1)}%)`);
    const extra = t.id === 'heavy_longchain'
      ? `  正确性:     chat=key:${a.hasHeavyKey} secrets:${a.heavySecretHits}/5  responses=key:${b.hasHeavyKey} secrets:${b.heavySecretHits}/5  (工具数 chat=${a.toolCount} / responses=${b.toolCount})`
      : `  结果:       chat=${a.ok ? 'OK' : 'FAIL' + (a.error || '')}  responses=${b.ok ? 'OK' : 'FAIL' + (b.error || '')}`;
    console.log(extra);
  }

  const outDir = path.join(__dirname, 'ab-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { model: MODEL, at: new Date().toISOString(), pricing: PRICING, styles: STYLES, rows };
  fs.writeFileSync(path.join(outDir, `ab-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport: ${path.join(outDir, `ab-${stamp}.json`)}`);
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
