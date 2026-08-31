#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// summary-entity-check.e2e.js — 第 105 波切片 c · 摘要实体确定性抽检(23 号方案 §4.1)
//
// 覆盖:
//   [U] 白盒(require server.js,临时数据根):
//       开关默认关/显式开/sanitize 只认 JSON 布尔 / 八类实体抽取(路径×2、版本、日期、
//       带量级数字、大数字、反引号代号、「」代号) / 噪声过滤(and/or、10/20) /
//       采样上限与尾部优先 / 包含清扫(2026-08-31 ⊃ 2026、v2.6.2 ⊃ 2.6.2) /
//       checkSummaryEntities 缺失清单
//   [H] 真实历史(本机 checkpoints 存在时;缺失显式 SKIP,不计通过):
//       真实快照抽取 ≥ minSamples 且含版本/路径类实体;篡改摘要被正确标记缺失
//   [E] fake-openai 集成(真实 HTTP 回合):
//       场景1 首稿缺实体 → 恰好一次修补(请求体含缺失清单、不重发全量历史)→ reseed 采用修补稿
//       场景2 修补稿结构非法 → 保留原稿,总摘要调用恰好 2 次(不无界重试)
//       场景3 开关关闭 → 总摘要调用恰好 1 次,原样采用首稿(零行为变化)
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

let failures = 0;
let skips = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
const skip = l => { skips++; console.log('SKIP ' + l); };

// ═══ [U] 白盒:开关 / 抽取 / 检查 ═══
const UHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105c-u-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = UHOME;
process.env.RUYI_HOME = UHOME;
const srv = require(path.join(WB, 'app', 'server.js'));

const BS = String.fromCharCode(92); // 反斜杠字面量,避开各层转义
const PLANTED = '请记住以下事实,后面要考:支付服务文件在 E:' + BS + 'proj' + BS + 'pay' + BS + 'app.ts,前端入口是 pay/gateway/router.js,版本锁 v9.8.7,2026-08-30 已确认方案,代号 `payGateway`,内部叫「夜莺」,累计 12345 条记录,错误率 7.5%。';

const FLAWED = [
  '【目标】修复支付服务缺陷并完成回归(标记甲)',
  '',
  '【已确认的决定】',
  '无',
  '',
  '【未完成事项】',
  '完成修复与回归',
  '',
  '【当前执行状态】',
  '已完成:无;正在进行:定位中;阻塞:无;下一步:给出修复方案',
  '',
  '【关键文件与上下文】',
  '支付相关代码与配置',
].join('\n');

const REPAIRED = FLAWED.replace('支付相关代码与配置',
  '支付相关代码与配置:E:' + BS + 'proj' + BS + 'pay' + BS + 'app.ts、pay/gateway/router.js、v9.8.7、2026-08-30、payGateway、夜莺、12345 条、7.5%');

(async () => {
  console.log('── [U] 开关与确定性抽取 ──');
  ok(srv.summaryEntityCheckEnabled(srv.normalizeConfig({}).config) === false, 'U1 默认配置 summaryEntityCheckEnabled=false(取证期默认关)');
  ok(srv.summaryEntityCheckEnabled(srv.normalizeConfig({ runtimeSummaryEntityCheckV1: true }).config) === true, 'U2 显式 true 开启');
  ok(srv.summaryEntityCheckEnabled(srv.normalizeConfig({ runtimeSummaryEntityCheckV1: 'true' }).config) === false, 'U3 sanitize 只认 JSON 布尔(字符串 "true" 洗回 false)');
  ok(typeof srv.extractSummaryEntities === 'function' && typeof srv.checkSummaryEntities === 'function', 'U4 抽取/检查函数已导出');

  const ents = srv.extractSummaryEntities(PLANTED);
  const EXPECT = ['E:' + BS + 'proj' + BS + 'pay' + BS + 'app.ts', 'pay/gateway/router.js', 'v9.8.7', '2026-08-30', 'payGateway', '夜莺', '12345 条', '7.5%'];
  ok(EXPECT.every(e => ents.includes(e)), 'U5 八类实体全部抽出(' + ents.length + ' 个):' + ents.join(' | '));
  ok(!ents.some(e => e === 'and/or' || e === '10/20'), 'U6 噪声过滤(and/or、10/20 不进实体)');

  const many = [];
  for (let i = 0; i < 30; i++) many.push('src/mod' + i + '/file' + i + '.js');
  const capped = srv.extractSummaryEntities(many.join(' ') + ' 尾部代号 `tailMark` 收尾');
  ok(capped.length <= 12, 'U7 采样上限 maxSamples=12(实际 ' + capped.length + ')');
  ok(capped.includes('tailMark') && !capped.includes('src/mod0/file0.js'), 'U8 尾部优先:超上限时最近实体保留、最早实体淘汰');

  const cont = srv.extractSummaryEntities('日期 2026-08-31 与版本 v2.6.2 已定');
  ok(cont.includes('2026-08-31') && cont.includes('v2.6.2') && !cont.includes('2026') && !cont.includes('2.6.2'), 'U9 包含清扫:短项不重复抽检(' + cont.join(' | ') + ')');

  const missingAll = srv.checkSummaryEntities(FLAWED, ents);
  ok(missingAll.length === ents.length && EXPECT.every(e => missingAll.includes(e)), 'U10 缺失清单完整(首稿全无实体 → 全量 missing)');
  ok(srv.checkSummaryEntities(REPAIRED, ents).length === 0, 'U11 修补稿逐字含全部实体 → missing 为空');
  ok(srv.checkSummaryEntities(FLAWED, []).length === 0, 'U12 空实体集 → 空缺失(不臆造检查)');

  // ═══ [H] 真实历史抽取门(本机 checkpoints 存在时) ═══
  console.log('── [H] 真实历史抽取 ──');
  const SRC_ROOT = 'C:/Users/87179/.win-claude-workbench/checkpoints'; // 只读,绝不写入
  let histFile = null, histSize = 0;
  try {
    if (fs.existsSync(SRC_ROOT)) {
      for (const d of fs.readdirSync(SRC_ROOT)) {
        const dir = path.join(SRC_ROOT, d);
        for (const f of fs.readdirSync(dir)) {
          if (!/^history-\d+\.json\.gz$/.test(f)) continue;
          const sz = fs.statSync(path.join(dir, f)).size;
          if (sz > histSize) { histSize = sz; histFile = path.join(dir, f); }
        }
      }
    }
  } catch { histFile = null; }
  if (!histFile) {
    skip('H1-H3 本机无真实 checkpoints 快照(CI/他机显式跳过,不计通过)');
  } else {
    try {
      const hist = JSON.parse(zlib.gunzipSync(fs.readFileSync(histFile)).toString('utf8'));
      const text = hist.map(m => (typeof (m && m.content) === 'string' ? m.content : JSON.stringify((m && m.content) || ''))).join('\n');
      const hents = srv.extractSummaryEntities(text);
      ok(hents.length >= 4, 'H1 真实历史抽出 ≥minSamples 实体(' + hents.length + ' 个,源 ' + path.basename(histFile) + ')');
      ok(hents.some(e => /^\d{4}-\d{2}-\d{2}$|^v?\d+\.\d+/.test(e) || e.includes('/') || e.includes(BS)), 'H2 真实实体含日期/版本/路径类');
      const hSummary = '【目标】x\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成:无;正在进行:无;阻塞:无;下一步:无\n【关键文件与上下文】\n' + hents.join('、');
      ok(srv.checkSummaryEntities(hSummary, hents).length === 0, 'H3 全量引用实体的摘要通过抽检');
      ok(srv.checkSummaryEntities(FLAWED, hents).length >= 1, 'H4 篡改摘要(不含真实实体)被标记缺失');
    } catch (e) { ok(false, 'H* 真实历史解析异常: ' + e.message); }
  }

  // ═══ [E] fake-openai 集成:真实 HTTP 回合 ═══
  console.log('── [E] fake-openai 集成 ──');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const health = port => new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
  const getJson = (port, p) => new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
  const postJson = (port, p, payload) => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
  const postStream = (port, payload) => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });

  // 每个场景独立的 fake + workbench + HOME(序列与环境均为进程级)。
  async function runScenario(label, { flagValue, sequence }) {
    const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105c-e-'));
    const SUMDIR = path.join(HOME, 'sum-req');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
      ...(flagValue === null ? {} : { runtimeSummaryEntityCheckV1: flagValue }),
      providers: [{
        id: 'fake', label: 'Fake', type: 'openai-compat',
        baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key',
        model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], reasoning: true,
      }],
      activeProvider: 'fake',
    }, null, 2));
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
      env: { ...process.env, FAKE_RECORD_SUMMARY_DIR: SUMDIR, FAKE_SUMMARY_SEQUENCE: JSON.stringify(sequence) },
      windowsHide: true,
    });
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
      cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true,
    });
    const out = { label, ok: false, requests: [], ph0: '', events: [], log: '' };
    wb.stdout.on('data', d => { out.log += String(d); });
    wb.stderr.on('data', d => { out.log += String(d); });
    fake.stderr.on('data', d => { out.log += '[fake!] ' + String(d); });
    try {
      let h = null; for (let i = 0; i < 80 && !h; i++) { await sleep(250); h = await health(WB_PORT); }
      if (!h) throw new Error('workbench not listening :: ' + out.log.slice(-400));
      const events = await postStream(WB_PORT, { message: PLANTED });
      const sid = (events.find(e => e.type === 'session') || {}).session?.id;
      if (!sid) throw new Error('no session id');
      const cr = await postJson(WB_PORT, '/api/provider/compact', { sessionId: sid });
      if (!cr || cr.ok !== true) throw new Error('compact failed: ' + (cr && cr.error));
      const after = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
      const ph = (after && after.session && after.session.providerHistory) || [];
      out.ph0 = String(ph[0] && ph[0].content || '');
      await sleep(400); // 等 logStream 落盘
      out.requests = fs.existsSync(SUMDIR) ? fs.readdirSync(SUMDIR).sort().map(f => fs.readFileSync(path.join(SUMDIR, f), 'utf8')) : [];
      const logsDir = path.join(HOME, 'logs');
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          if (!/^workbench-.*\.ndjson$/.test(f)) continue;
          for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const rec = JSON.parse(line); if (rec.kind === 'summary_entity_check') out.events.push(rec); } catch { /* ignore */ }
          }
        }
      }
      out.ok = true;
    } catch (e) { out.error = e.message; }
    finally {
      for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
      fs.rmSync(HOME, { recursive: true, force: true });
    }
    return out;
  }

  // 场景1:首稿缺实体 → 恰好一次修补 → 采用修补稿。
  const s1 = await runScenario('repaired', { flagValue: true, sequence: [FLAWED, REPAIRED] });
  ok(s1.ok, 'E1 场景1流程跑通' + (s1.error ? ' (' + s1.error + ')' : ''));
  ok(s1.requests.length === 2, 'E2 摘要调用恰好 2 次(首稿+一次定向修补,实际 ' + s1.requests.length + ')');
  ok(s1.requests.length >= 2 && s1.requests[1].includes('v9.8.7') && s1.requests[1].includes('夜莺'), 'E3 修补请求体含缺失清单(逐字实体)');
  ok(s1.requests.length >= 2 && !s1.requests[1].includes('请记住以下事实'), 'E4 修补不重发全量历史(只发 当前摘要+缺失清单)');
  ok(s1.ph0.includes('v9.8.7') && s1.ph0.includes('夜莺') && s1.ph0.includes('E:' + BS + 'proj'), 'E5 reseed 采用修补稿(实体已回摘要)');
  ok(s1.events.some(e => e.outcome === 'repaired' && e.missingCount >= 4), 'E6 遥测 summary_entity_check outcome=repaired 且缺失计数正确');

  // 场景2:修补稿结构非法 → 保留原稿,恰好 2 次调用。
  const s2 = await runScenario('repair_rejected', { flagValue: true, sequence: [FLAWED, '标记乙 无法修订的退化输出'] });
  ok(s2.ok, 'E7 场景2流程跑通' + (s2.error ? ' (' + s2.error + ')' : ''));
  ok(s2.requests.length === 2, 'E8 修补稿非法时总调用恰好 2 次(不二次重试,实际 ' + s2.requests.length + ')');
  ok(s2.ph0.includes('标记甲') && !s2.ph0.includes('标记乙'), 'E9 保留原摘要(修补稿被拒)');
  ok(s2.events.some(e => e.outcome === 'repair_rejected'), 'E10 遥测 outcome=repair_rejected');

  // 场景3:开关关闭 → 恰好 1 次调用,原样采用首稿,零抽检事件。
  const s3 = await runScenario('disabled', { flagValue: null, sequence: [FLAWED] });
  ok(s3.ok, 'E11 场景3流程跑通' + (s3.error ? ' (' + s3.error + ')' : ''));
  ok(s3.requests.length === 1, 'E12 开关关闭时摘要调用恰好 1 次(零修补,实际 ' + s3.requests.length + ')');
  ok(s3.ph0.includes('标记甲'), 'E13 开关关闭时原样采用首稿(零行为变化)');
  ok(!s3.events.length, 'E14 开关关闭时零 summary_entity_check 事件');

  fs.rmSync(UHOME, { recursive: true, force: true });
  console.log('\nSUMMARY-ENTITY-CHECK E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS') + (skips ? ' (' + skips + ' skipped)' : ''));
  setImmediate(() => process.exit(failures ? 1 : 0));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
