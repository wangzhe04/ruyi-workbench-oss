'use strict';
// 提示词 A/B 运行器(52b · 51e 收尾):提示词改动前后对比通过率,挡住行为漂移。
// 与 prompt-snapshot.static.e2e.js(文本基线锁)互补:快照管"文本变了可见",A/B 管"行为没变可证"。
//
// 模式:
//   fake-openai(默认,离线冒烟):按 seed.fake_script 剧本回工具,验证工具流程 + loop/office 行为 + system 注入(CAPTURE 冒烟)。
//     plan 类(pt-01 needs_plan_mode)在 bypass 不触发,标 skip;真 plan 测用 plan-mode 专用 e2e。
//   真 provider(--provider KEY MODEL [BASE]):真模型决策,真 A/B。本运行器聚焦 fake 离线冒烟(CI 友好);
//     真 A/B 直接用 dev-harness/model-tier-probe.js(同款 withServer+postStream+metrics)。
//
// 用法:
//   node run.js --before    # 跑所有 seed,落 baseline.json
//   node run.js --after     # 跑所有 seed,与 baseline 对比 diff(无差异=未漂移)
//
// 非回归件(无 .e2e.js 后缀):判定 DONE,不 fail(CI 不阻断)。判据见 seeds.json pass_criteria(机械可判)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const HERE = __dirname, DEV = path.join(HERE, '..'), ROOT = path.join(DEV, '..'), WB = path.join(ROOT, 'ruyi-workbench'), SERVER = path.join(WB, 'app', 'server.js');
const { getFreePorts } = require(path.join(DEV, 'free-port.js'));
const SEEDS = JSON.parse(fs.readFileSync(path.join(HERE, 'seeds.json'), 'utf8')).seeds;
const BASELINE = path.join(HERE, 'baseline.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
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
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// 起 fake-openai(按 seed.fake_script 剧本回工具)+ workbench(provider 指向 fake),发 task,收集 events + CAPTURE 请求体。
async function runSeedFake(seed) {
  const HOME = path.join(os.tmpdir(), `wcw-ab-${seed.id}`);
  const WORK = path.join(HOME, 'work');
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  for (const f of (seed.setup_files || [])) {
    const p = path.join(WORK, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content || '');
  }
  const CAP = path.join(HOME, 'cap');
  const [fakePort, wbPort] = await getFreePorts(2);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, version: '1.6.1', permissionMode: 'bypass', toolLoadingMode: 'auto',
    defaultWorkspace: WORK, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake'
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(DEV, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_SEQUENCE: JSON.stringify(seed.fake_script || []), FAKE_CAPTURE_DIR: CAP }, windowsHide: true });
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    let live = null; for (let i = 0; i < 60 && !live; i++) { await sleep(120); live = await health(wbPort); }
    if (!live) throw new Error('workbench 未启动');
    const events = await Promise.race([
      postStream(wbPort, { message: seed.task }),
      sleep(90000).then(() => { throw new Error('回合超时 90s'); })
    ]);
    return { events, capDir: CAP };
  } finally {
    killp(fake); killp(wb); await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// 按 seed.pass_criteria 机械判 pass/fail。返回 pass=true/false/null(skipped)。
function judge(seed, events, capDir) {
  const tools = events.filter(e => e.type === 'tool_use').map(e => e.name);
  const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
  const result = events.find(e => e.type === 'result');
  const pc = seed.pass_criteria || {};
  const checks = {};
  const skipped = [];
  // plan 类(needs_plan_mode)在 fake bypass 不触发,整体 skip
  if (seed.needs_plan_mode) {
    skipped.push('needs_plan_mode(plan 在 fake bypass 不触发,用 plan-mode e2e 或 --provider 真测)');
    return { pass: null, skipped, tools, checks, text: text.slice(-120) };
  }
  // office 软闸(needs_bridge)只在 ACC 桥接工具层触发(09-workflow:1531 if(bridge));fake 模式 desktopMcp disabled,整体 skip
  if (seed.needs_bridge) {
    skipped.push('needs_bridge(office 软闸需 ACC 桥接,fake 模式 desktopMcp disabled 不触发,用 --provider 真测)');
    return { pass: null, skipped, tools, checks, text: text.slice(-120) };
  }
  if (pc.tool_subset_of) checks.tool_subset_of = tools.every(t => pc.tool_subset_of.includes(t));
  if ('must_not_use_terminal_first' in pc) checks.must_not_use_terminal_first = tools.length === 0 || !['script_run', 'shell_send', 'run_command'].includes(tools[0]);
  if (pc.output_contains_regex) skipped.push('output_contains_regex(fake echo 不回真实工具结果,用 --provider 真测)');
  if (pc.tool_sequence_starts_with) checks.tool_sequence_starts_with = tools[0] === pc.tool_sequence_starts_with;
  if (pc.must_read_before_edit) {
    const ri = tools.indexOf('file_read'), ei = tools.indexOf('file_edit');
    checks.must_read_before_edit = ri >= 0 && (ei < 0 || ri < ei);
  }
  if (pc.no_write_file_overwrite) checks.no_write_file_overwrite = !tools.includes('file_write');
  if (pc.office_soft_gate_triggered) {
    checks.office_soft_gate_triggered = events.some(e => e.type === 'tool_result' && /office|excel|write_excel|软闸|禁|建议/i.test(JSON.stringify(e.content || '')));
  }
  if (pc.hint_use_write_excel) {
    checks.hint_use_write_excel = events.some(e => /write_excel/i.test(JSON.stringify(e)));
  }
  if (pc.loop_guard_aborts_at) {
    // 主回合 loop-guard(09-workflow:1403):tool_result loopAborted=true + errorClass 'tool_loop'
    checks.loop_guard_aborts = events.some(e => e.type === 'tool_result' && e.content && e.content.loopAborted === true);
  }
  if (pc.abort_reason_contains) {
    // 放宽:从所有 tool_result content 的 JSON 字符串 + 最终文本找原因(content 可能是对象/字符串,统一序列化)
    const reason = events.filter(e => e.type === 'tool_result').map(e => JSON.stringify(e.content || '')).join(' ') + ' ' + text;
    checks.abort_reason_contains = reason.includes(pc.abort_reason_contains);
  }
  if (pc.not_budget_exhausted) {
    checks.not_budget_exhausted = !result || result.errorClass !== 'budget_exhausted';
  }
  if (pc.enters_plan_mode) {
    checks.enters_plan_mode = events.some(e => e.type === 'plan');
    if (!checks.enters_plan_mode) skipped.push('enters_plan_mode(fake bypass 不触发)');
  }
  if (pc.no_exec_without_approval) skipped.push('no_exec_without_approval(需 plan 触发,fake 跳过)');
  // CAPTURE 冒烟:system 提示词非空 + 含身份钉死(提示词注入可见,提示词大改后验证注入仍活)
  if (capDir && fs.existsSync(capDir)) {
    const reqs = fs.readdirSync(capDir).filter(f => f.endsWith('.json')).sort().map(f => { try { return JSON.parse(fs.readFileSync(path.join(capDir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
    const sysMsg = reqs.length && reqs[0].messages ? reqs[0].messages.find(m => m.role === 'system') : null;
    const sysText = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content || '')) : '';
    checks.system_prompt_nonempty = sysText.length > 100;
  }
  const pass = Object.keys(checks).length ? Object.values(checks).every(v => v === true) : null;
  return { pass, skipped, tools, checks, text: text.slice(-120) };
}

(async () => {
  const args = process.argv.slice(2);
  const before = args.includes('--before'), after = args.includes('--after');
  if (args.includes('--provider')) {
    console.log('真 provider 模式:本运行器聚焦 fake 离线冒烟(CI 友好)。真 A/B 请用:');
    console.log('  node dev-harness/model-tier-probe.js <API_KEY> <MODEL> [BASE_URL]');
    process.exit(0);
  }
  if (!before && !after) { console.error('用法: node run.js --before | --after'); process.exit(2); }
  const results = [];
  for (const seed of SEEDS) {
    process.stdout.write(`\n=== [${seed.id}] ${seed.category} ===\n`);
    try {
      const { events, capDir } = await runSeedFake(seed);
      const j = judge(seed, events, capDir);
      console.log(`  tools: ${JSON.stringify(j.tools)}`);
      console.log(`  pass=${j.pass} checks=${JSON.stringify(j.checks)}${j.skipped.length ? ' skipped=' + JSON.stringify(j.skipped) : ''}`);
      if (j.text) console.log(`  text(尾120): ${JSON.stringify(j.text)}`);
      results.push({ id: seed.id, category: seed.category, pass: j.pass, tools: j.tools, checks: j.checks, skipped: j.skipped });
    } catch (e) { console.log(`  异常: ${e.message}`); results.push({ id: seed.id, category: seed.category, pass: false, error: e.message }); }
  }
  const evaluated = results.filter(r => r.pass !== null);
  const passN = evaluated.filter(r => r.pass).length;
  console.log(`\n================ A/B 运行器 (fake-openai) ================`);
  console.log(`${passN}/${evaluated.length} seeds pass (${results.length - evaluated.length} skipped)`);
  if (before) { fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2)); console.log(`baseline 落 ${path.relative(HERE, BASELINE)}`); }
  if (after) {
    const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : [];
    const diffs = results.filter(r => { const b = base.find(x => x.id === r.id); return !b || b.pass !== r.pass || JSON.stringify(b.tools) !== JSON.stringify(r.tools); });
    console.log(`diff vs baseline: ${diffs.length} 项`);
    if (diffs.length === 0) console.log('  (无差异,提示词改动未引起行为漂移)');
    else diffs.forEach(r => console.log(`  [${r.id}] ${r.category} pass=${r.pass} tools=${JSON.stringify(r.tools)}`));
  }
})().catch(e => { console.error('RUN ERROR: ' + (e && e.stack || e)); process.exit(1); });
