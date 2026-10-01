'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// ─────────────────────────────────────────────────────────────────────────────
// observation-recall-snapshot-cap.e2e.js —— 「压缩给了 rawRef,observation_recall 却回 not_found / ENOENT」
//
// 用户报告(Windows 真机,qwen3.8-flash,1M 窗口):模型按压缩视图里的 rawRef 调 observation_recall,
// 回 {"ok":false,"error":"not_found","message":"observation recall failed: ENOENT"}。
// 根因(02-session-store journalGlobalSweep):检查点目录有一道 200 MB 的整仓上限(RUYI_JOURNAL_GLOBAL_MAX_BYTES 可压小),
// 超限时「谁的目录 mtime 最旧就整目录删谁」—— 包括【刚写完快照、正在跑回合的这条会话自己】。每次上下文压缩都会写一份带内容哈希的整史快照
// (history-<回合>-<哈希>.json.gz,1M 窗口的会话一份几 MB),一条会话自己的检查点树就能越过上限;清扫于是把它整个目录删光,
// 紧接着模型拿着刚拿到的 rawRef 去回读 → ENOENT(它的文件回滚点也一并没了)。
//
// 本件(离线:真实工作台 → 本地假 chat 端点;子进程把整仓上限压到 16 KB):
//   1. 三次整读大文件把窗口顶过预算 → L1 蒸发出带 rawRef 的缩减视图(observation_reduced 事件);
//   2. 假模型从【自己收到的请求】里抠出这个 rawRef,调 observation_recall;
//   3. 断言回读成功(ok:true、原件长度),快照文件仍在盘上 —— 即使该会话自己的检查点树已经超过整仓上限;
//   4. 另一条与回合无关的旧会话照旧被按上限清掉(上限没有被放弃)。
// 另有一条小断言:真缺文件时,recall 的失败信息告诉模型「原件取不回、别重试、重跑原工具」,而不是裸的 ENOENT。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const crypto = require('crypto');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const t = createRunner('OBSERVATION-RECALL-SNAPSHOT-CAP');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CAP = 16 * 1024;

function getJson(port, p) {
  return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); });
}
function postStream(port, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', () => resolve([])); req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write(data); req.end();
  });
}
// 约 180 KB 的伪随机「词」文本:可压缩但不会被 gzip 压成几十字节(快照要真超过 16 KB 的上限)。
function noisyText(seed) {
  let x = seed >>> 0; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x; };
  const words = [];
  for (let i = 0; i < 4000; i++) { let w = ''; const len = 3 + (rnd() % 6); for (let j = 0; j < len; j++) w += String.fromCharCode(97 + (rnd() >>> 8) % 26); words.push(w); }
  let out = '';
  while (out.length < 180000) { for (let i = 0; i < 12; i++) out += words[rnd() % words.length] + ' '; out += '\n'; }
  return out;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-orsc-'));
  const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true });
  const files = [1, 2, 3].map(n => { const f = path.join(work, `big${n}.txt`); fs.writeFileSync(f, `FIRST-LINE-MARK-${n}\n` + noisyText(n * 7919), 'utf8'); return f; });
  let reads = 0, recallCalled = false, rawRefUsed = '';
  const fake = await startFakeProvider({
    handler(req) {
      if (!req.tools.length) return textFrames('(summary)'); // L2 摘要调用(不应触发,兜底)
      if (reads < 3) { const f = files[reads]; reads += 1; return toolCallFrames('file_read', { path: f, limit: 50000 }, 'read_' + reads); }
      const joined = req.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const m = /rawRef=(history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16})/.exec(joined);
      if (m && !recallCalled) { recallCalled = true; rawRefUsed = m[1]; return toolCallFrames('observation_recall', { rawRef: m[1], maxChars: 3000 }, 'recall_1'); }
      return textFrames(m ? 'RECALL_DONE' : 'NO_RAWREF');
    },
  });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    stewardThreadBriefV1: false, configSchema: 6, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: work,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 50000 }],
    activeProvider: 'fake', autoImportClaudeCodeMcp: false, autoCompactThreshold: 0.8,
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
  }, null, 2));
  // 一条与本回合无关的旧会话检查点(带一份 20 KB 不可压快照):整仓上限仍要把它清掉。
  const oldDir = path.join(home, 'checkpoints', 'sess_old_unrelated');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'history-1.json.gz'), crypto.randomBytes(20 * 1024));
  const past = new Date(Date.now() - 3600 * 1000); fs.utimesSync(oldDir, past, past);

  const wbPort = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, RUYI_JOURNAL_GLOBAL_MAX_BYTES: String(CAP) },
  });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    let h = null; for (let i = 0; i < 300 && !h; i++) { await sleep(150); h = await getJson(wbPort, '/health'); }
    ok(!!h, 'S0 workbench listening');
    const events = await postStream(wbPort, { message: '请把 big1/big2/big3 各读一遍,再根据压缩视图里的 rawRef 取回第一份的原文。' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, 'S1 session id captured');
    const reduced = events.filter(e => e.type === 'observation_reduced');
    ok(reduced.length > 0 && reduced.every(e => /^history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}$/.test(String(e.rawRef))), 'S2 压缩 L1 产出带 rawRef 的缩减视图(' + reduced.length + ' 条)');
    ok(recallCalled && /^history:/.test(rawRefUsed), 'S3 假模型从自己收到的请求里抠出了 rawRef 并调用 observation_recall');
    await sleep(600); // 后台整仓清扫(冷启动首轮)在快照写完后异步跑,等它落定
    const ckDir = path.join(home, 'checkpoints', sid);
    const snaps = fs.existsSync(ckDir) ? fs.readdirSync(ckDir).filter(f => /^history-\d+-[a-f0-9]{16}\.json\.gz$/.test(f)) : [];
    const snapBytes = snaps.reduce((n, f) => n + fs.statSync(path.join(ckDir, f)).size, 0);
    ok(snapBytes > CAP, 'S4 前提成立:本会话自己的快照(' + snapBytes + ' B)已经超过整仓上限(' + CAP + ' B)');
    ok(snaps.length > 0, 'S5 本会话的历史快照仍在盘上(修前被整仓清扫连目录一起删光)');
    const s1 = await getJson(wbPort, '/api/sessions/' + encodeURIComponent(sid));
    const ph = (s1 && s1.session && s1.session.providerHistory) || [];
    const recallMsg = ph.find(m => m && m.role === 'tool' && m.tool_call_id === 'recall_1');
    let recall = null; try { recall = JSON.parse(recallMsg && recallMsg.content || 'null'); } catch { /* ignore */ }
    ok(!!recall && recall.ok === true && recall.originalChars > 30000 && /FIRST-LINE-MARK-1/.test(String(recall.content || '')),
      'S6 observation_recall 回读成功,拿回原件(ok:true,originalChars=' + (recall && recall.originalChars) + ';修前 = ' + JSON.stringify(recall && (recall.error || recall.message)) + ')');
    ok(!fs.existsSync(oldDir), 'S7 无关的旧会话检查点照旧被整仓上限清掉(上限没有被放弃)');
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'S8 回合 result ok:true');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch { /* ignore */ }
    await fake.close();
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 真缺文件时的失败信息(进程内直调,不依赖整仓清扫)────────────────────────────────────────────
  {
    const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-orsc-u-'));
    process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME2; process.env.RUYI_HOME = HOME2;
    fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({ configSchema: 6, version: '1.0.0', permissionMode: 'bypass', runtimeObservationReducerV1: true, runtimeObservationRecallV1: true }));
    const srv = require(path.join(WB, 'app', 'server.js'));
    const r = await srv.toolCall('observation_recall', { rawRef: 'history:12:d66a180b2794c811:0:2a70a591984010f2' }, { session: { id: 'sess_gone', turnSeq: 12, providerHistory: [{ role: 'user', content: 'x' }] } });
    ok(r.ok === false && r.error === 'not_found', 'U1 快照缺失 → 稳定码 not_found 不变');
    ok(/observation recall failed: ENOENT/.test(r.message) && /do not retry the same rawRef/.test(r.message) && /Re-run the original tool call/.test(r.message),
      'U2 失败信息点明「原件取不回 / 别重试同一 rawRef / 重跑原工具」(' + JSON.stringify(r.message).slice(0, 120) + '…)');
    fs.rmSync(HOME2, { recursive: true, force: true });
  }
  t.done({ exit: true });
})();
