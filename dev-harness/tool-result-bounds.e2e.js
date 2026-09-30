require('./lib/self-isolate-home.js'); // 家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(N2/N3 工具结果边界):真服务进程 + 脚本化假 provider,走真实的 provider 工具循环(09 runOpenAiTurn)。
//   [A] 一次输出 ~160K 字符 stdout、stderr、退出码 3 的脚本:
//       · 模型看到的 role:'tool' 消息仍是合法 JSON,含 stderr / code / timedOut,且 stdout 末尾的 ERROR 行在(修前从头切,全丢);
//       · 提示不再点名 offset/limit,而指向重定向到文件 + file_read;
//       · SSE 的 tool_result、会话 messages.ndjson、GET /api/sessions/:id 都是有界副本(修前 ≥160K,2MB 输出时 2MB+),
//         且保留 ok/code/stderr/timedOut 等标量键(buildTurnSummary / 管家读取 / UI 只看它们)。
//   [B] 两条相同的 file_read(200K 文件,默认 limit 100000):展示副本不超上限,内容头尾仍在。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-result-bounds-'));
const WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('TOOL RESULT BOUNDS');
const { ok } = t;

const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
function scenarioOf(messages) {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
}
const big = path.join(HOME, 'big.txt');
fs.writeFileSync(big, 'HEAD-' + 'x'.repeat(200000) + '-TAIL');

const fake = await startFakeProvider({
  async handler(req) {
    const msgs = req.messages;
    if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
    const scn = scenarioOf(msgs);
    const i = msgs.map(m => m && m.role).lastIndexOf('user');
    if (msgs.slice(i + 1).some(m => m.role === 'tool')) return textFrames('done');
    switch (scn) {
      case 'A': return toolCallFrames('script_run', { language: 'node', code: "console.log('build line\\n'.repeat(20000)+'ERROR at end');console.error('fatal stderr');process.exitCode=3" }, 'o1');
      case 'B': return toolCallFrames('file_read', { path: big }, 'r1');
      default: return textFrames('default');
    }
  },
});

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: WP, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); if (raw) r.write(raw); r.end();
  });
}
function stream(payload) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = []; let rawBytes = 0; const sizes = [];
      res.on('data', c => {
        buf += c; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let e = null; try { e = JSON.parse(line); } catch { /* partial */ }
          if (e) { events.push(e); if (e.type === 'tool_result') sizes.push(Buffer.byteLength(line)); }
        }
      });
      res.on('end', () => { events.rawBytes = rawBytes; events.toolResultBytes = sizes; resolve(events); });
    });
    r.on('error', reject); r.write(raw); r.end();
  });
}
const sessionIdOf = evs => { const s = evs.find(e => e.type === 'session'); return s && s.session && s.session.id; };

fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: HOME,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
  activeProvider: 'fake',
}));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
  cwd: WB, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME },
});
try {
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await request('GET', '/health')).status === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  ok(up, 'workbench starts');
  const page = await request('GET', '/');
  const token = (page.text.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  const H = { 'x-wcw-token': token };
  const scnRequests = scn => fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);

  // ── [A] shell 大输出 ──
  {
    const evs = await stream({ message: 'SCN-A 跑构建' });
    const sid = sessionIdOf(evs);
    const reqs = scnRequests('A');
    const toolMsg = reqs[reqs.length - 1].messages.filter(m => m.role === 'tool').map(m => contentText(m.content))[0] || '';
    let modelSaw = null; try { modelSaw = JSON.parse(toolMsg); } catch { /* not json */ }
    ok(toolMsg.length > 0 && toolMsg.length <= 60000, `A1 模型视图 ≤ 60000 字符(实得 ${toolMsg.length})`);
    ok(modelSaw !== null, 'A2 模型视图仍是合法 JSON(修前是切在 stdout 中间的坏 JSON)');
    ok(modelSaw && modelSaw.code === 3 && modelSaw.stderr && /fatal stderr/.test(modelSaw.stderr) && modelSaw.timedOut === false,
      'A3 模型视图保留 code / stderr / timedOut(修前全被切掉)');
    ok(modelSaw && /ERROR at end/.test(modelSaw.stdout || ''), 'A4 模型视图保留 stdout 末尾的 ERROR 行(尾部窗口)');
    ok(modelSaw && modelSaw._truncated && !/offset\/limit/.test(modelSaw._truncated.hint) && /file_read/.test(modelSaw._truncated.hint),
      'A5 恢复提示按工具给(重定向到文件 + file_read),不再点名 offset/limit');

    const tr = evs.find(e => e.type === 'tool_result' && e.id === 'o1');
    ok(tr && tr.content && tr.content.code === 3 && /fatal stderr/.test(tr.content.stderr || ''), 'A6 SSE tool_result 保留 code / stderr');
    const sseBytes = evs.toolResultBytes[0] || 0;
    ok(sseBytes > 0 && sseBytes <= 130000, `A7 SSE tool_result ≤ 130KB(实得 ${sseBytes};修前 ≈ 160KB+,输出 2MB 时 2MB+)`);
    ok(tr && /ERROR at end/.test(tr.content.stdout || ''), 'A8 SSE 展示副本也保留 stdout 末尾');

    const persisted = fs.readdirSync(path.join(HOME, 'sessions')).filter(n => n.startsWith(sid) && n.endsWith('.messages.ndjson'));
    const msgBytes = persisted.length ? fs.statSync(path.join(HOME, 'sessions', persisted[0])).size : -1;
    ok(msgBytes > 0 && msgBytes <= 135000, `A9 messages.ndjson ≤ 135KB(实得 ${msgBytes};修前 ≈ 160KB+)`);
    const g = await request('GET', '/api/sessions/' + sid, null, H);
    ok(g.status === 200 && g.text.length <= 190000, `A10 GET /api/sessions/:id ≤ 190KB(展示副本 ≤120K + 模型视图 ≤60K;实得 ${g.text.length},修前 ≥ 228KB)`);
    const sess = (g.json && (g.json.session || g.json)) || {};
    const call = ((sess.messages || []).find(m => m.role === 'assistant' && m.toolCalls) || { toolCalls: [] }).toolCalls[0];
    ok(call && call.result && call.result.code === 3 && call.result.ok === false && call.result.timedOut === false, 'A11 落盘的 toolCalls[].result 保留 ok/code/timedOut 标量键');
  }

  // ── [B] file_read 展示副本 ──
  {
    const evs = await stream({ message: 'SCN-B 读文件' });
    const tr = evs.find(e => e.type === 'tool_result' && e.id === 'r1');
    ok(tr && tr.content && tr.content.ok === true, 'B1 file_read 成功');
    const c = tr && tr.content && tr.content.content || '';
    ok(c.startsWith('HEAD-') && c.length <= 125000, `B2 展示副本内容有界且头部在(实得 ${c.length})`);
    ok(tr && tr.content.truncated === true && tr.content.totalChars === 200000 + 'HEAD--TAIL'.length, 'B3 file_read 自带的 truncated/totalChars 键保留');
    const reqs = scnRequests('B');
    const toolMsg = reqs[reqs.length - 1].messages.filter(m => m.role === 'tool').map(m => contentText(m.content))[0] || '';
    let modelSaw = null; try { modelSaw = JSON.parse(toolMsg); } catch { /* not json */ }
    ok(modelSaw && modelSaw.content.startsWith('HEAD-') && modelSaw._truncated && /offset/.test(modelSaw._truncated.hint), 'B4 模型视图:file_read 头部在,提示指向 offset');
    ok(toolMsg.length <= 60000 && toolMsg.length >= 40000, `B5 file_read 模型视图 ≈ 头 40K + 尾 8K(实得 ${toolMsg.length})`);
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { killOwnTree(wb.pid); } catch { /* already gone */ }
  await Promise.race([fake.close(), sleep(3000)]);   // 保活连接偶发拖住 close,不让收尾挂死
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  t.done({ exit: true });
}
})();
