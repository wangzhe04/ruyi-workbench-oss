require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 123 波 P1 ① · 38 号文):管家**输出契约完整性**的兜底。
//
// 现象(用户 2026-09-14 真机,主会话已取证,本件照那一份的形状造剧本):
//   用户对管家说「下周一整周大A该怎么操作」,管家回「我把你这句话原样递给『下周A股走势分析』那条
//   线程了」「按钮就在这条消息下面,点『打开线程』」——**界面上没有任何按钮,线程也从没收到那句话**。
// 铁证:真机 sessions/steward.provider.ndjson 里模型的原始输出【只有 say 一个键】,七轮无一例外;
//   落盘的七条 assistant 消息 acts=0 actions=0 parsed=true;配的是 deepseek-v4-flash 这个快档。
// 病根:模型没按四字段契约输出、一个工具都没调,却在 say 里把动作说成已完成 —— 而系统这一侧
//   【完全没有兜底】:parsed 仍是 true,前端照常只画一句话。
//
// 判据用「契约完整性」而不是猜 say 的文本:关键词匹配「已经递了/按钮在下面」这类完成时陈述既脆弱
// 又要维护中英词表;契约完整性是机器可判的硬事实 —— 06b 的输出契约把 why 写成必填的「依据一句话」,
// 模型连这个键都没给,就是没按契约输出。**acts / actions 一律不当判据**(纯答问回合本来就不需要
// 它们)。判据落在 13o stewardParseReply,审计与盖章落在 13q,帧的白名单落在 13h。
//
// 覆盖:
//  (A) 起服务。
//  (B) 病态回合(只有 say 一个键):steward_reply 帧带 contractIncomplete、parsed 仍是 true、acts/actions 都空。
//  (C) 落盘:管家会话最后一条助手消息的 .steward 章上 contractIncomplete === true,acts/actions 都空。
//  (D) 审计:workbench-*.ndjson 里【恰一条】 steward_contract_incomplete,带 trigger / 模型给了哪些键 / sayChars。
//  (E) 对照:契约完整(四字段齐全)的那一轮**不**打旗、**不**新增审计条 —— 连 why:'' 这种「给了键但没话说」
//      也不算不完整(既有剧本与线上老回合大量这么写,拿值空当判据等于给每一句寒暄盖红戳)。
//
// 反向验证(已实测,见提交说明):把 13o 里 `const contractIncomplete = !Object.prototype.hasOwnProperty
// .call(value, 'why');` 改成恒 false → B/C/D 三段全红(旗子不见、审计零条)。
//
// 端口全部 getFreePort() 动态取(run-all 端口审计口径)。判定行:`STEWARD CONTRACT GUARD E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-contract-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();

// ── 剧本 ────────────────────────────────────────────────────────────────────────────────────
// [0] 病态那一条:**照抄用户真机那一份的形状** —— 顶层只有 say 一个键,内容是一句完成时陈述。
//     它本身是合法 JSON(所以 parsed 会是 true),这正是修前那条路径的可怕之处:什么都没做,却一路
//     绿灯落盘。
const SAY_ONLY = JSON.stringify({
  say: '我把你这句话原样递给「下周A股走势分析」那条线程了。按钮就在这条消息下面,点「打开线程」。',
});
// [1] 对照那一条:四字段齐全。why 有内容,acts/actions 都是空数组 —— 纯答问回合的正常形状。
const FULL_CONTRACT = JSON.stringify({
  say: '大盘这一周我先不下结论,你要的话我开一条线程去查。',
  why: '来自线程总览:目前没有相关线程在跑',
  acts: [],
  actions: [],
});
// [2] 第二条对照:四字段齐全但 why 是空串 —— 「给了键、这一轮没依据可写」。判据只看键在不在,
//     所以它同样【不算】契约不完整(拿值空当判据会把既有剧本与线上老回合整片打红)。
const EMPTY_WHY = JSON.stringify({ say: '好的,我记下了。', why: '', acts: [], actions: [] });

const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(PROVIDER_PORT)], {
  env: { ...process.env, FAKE_REPLY_SEQUENCE: JSON.stringify([SAY_ONLY, FULL_CONTRACT, EMPTY_WHY]) },
  windowsHide: true,
});
fake.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
await sleep(600);

// ── config ──────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', permissionTimeoutMs: 120000,
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
  subagentMaxPerTurn: 0, killOnDisconnect: false,
  stewardEnabledV1: true, stewardPollMs: 120000,
  stewardMaxTurnsPerHour: 12, stewardMaxCostPerDay: 1,
  stewardContextBudgetTokens: 200000, stewardReadBudgetChars: 48000,
  stewardVisitIdleMinutes: 60, stewardConversationRetention: 'visit',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────────────────────
function token() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(method, urlPath, body) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: WB_PORT, path: urlPath, method,
      headers: { 'x-wcw-token': token(), ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json, lines: text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
      });
    });
    req.on('error', () => resolve({ status: 0, text: '', json: null, lines: [] }));
    if (payload) req.write(payload);
    req.end();
  });
}
// 落盘的那份章:管家会话【最后一条】助手消息的 .steward(13p stewardStampReply 盖在那儿)。
// 正文住在 <id>.messages.ndjson(02-session-store v2 存储:头与两份正文分家)—— 用户真机那份铁证
// 读的就是这个文件。盖章走的是 saveSession 的 per-id 写链,响应回来时链可能还差最后一拍,故有界等。
async function lastStamp() {
  const file = path.join(HOME, 'sessions', 'steward.messages.ndjson');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] && rows[i].role === 'assistant') {
          if (rows[i].steward) return rows[i].steward;
          break;   // 最后一条助手消息还没盖上章:再等一拍
        }
      }
    } catch { /* 正文还没落盘 */ }
    await sleep(100);
  }
  return null;
}
function auditRows(kind) {
  try {
    return fs.readdirSync(path.join(HOME, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f)).sort()
      .flatMap(f => fs.readFileSync(path.join(HOME, 'logs', f), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean))
      .filter(r => r && r.kind === kind);
  } catch { return []; }
}

let wb = null;
try {
  /* ═════════ (A) 起服务 ═════════ */
  console.log('── (A) 起服务 ──');
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  let up = null;
  for (let i = 0; i < 100 && !up; i++) { await sleep(150); const r = await request('GET', '/api/status'); up = r.status === 200 ? r : null; }
  ok(!!up, 'A0 工作台起来了');

  /* ═════════ (B) 病态回合:只有 say 一个键 ═════════ */
  console.log('── (B) 契约不完整的那一轮 ──');
  const bad = await request('POST', '/api/steward/message', { message: '下周一整周大A该怎么操作' });
  const badReply = bad.lines.find(l => l && l.type === 'steward_reply') || null;
  ok(bad.status === 200 && !!badReply, `B0 回了一条 steward_reply(status ${bad.status})`);
  ok(!!badReply && badReply.contractIncomplete === true,
    `B1 帧上带 contractIncomplete(实得 ${badReply && JSON.stringify(badReply.contractIncomplete)})——13h 那一帧是白名单,13q 加的字段不写进白名单就到不了前端`);
  ok(!!badReply && badReply.parsed === true,
    `B2 parsed 仍然是 true(实得 ${badReply && JSON.stringify(badReply.parsed)})——它是【合法 JSON 但缺必填键】,与 steward_contract_unparsed 那条老路径是两回事`);
  ok(!!badReply && Array.isArray(badReply.acts) && badReply.acts.length === 0
    && Array.isArray(badReply.actions) && badReply.actions.length === 0,
    `B3 acts / actions 都是空的(实得 ${badReply && badReply.acts.length} / ${badReply && badReply.actions.length})——用户看到的「按钮就在下面」指向的那枚按钮根本不存在`);

  /* ═════════ (C) 落盘的章 ═════════ */
  const badStamp = await lastStamp();
  ok(!!badStamp && badStamp.contractIncomplete === true,
    `C1 落盘的章上 contractIncomplete === true(实得 ${badStamp && JSON.stringify(badStamp.contractIncomplete)})——刷新页面之后回放那条路读的就是这一份`);
  ok(!!badStamp && Array.isArray(badStamp.acts) && badStamp.acts.length === 0
    && Array.isArray(badStamp.actions) && badStamp.actions.length === 0,
    `C2 章上 acts / actions 也都是空的(实得 ${badStamp && badStamp.acts.length} / ${badStamp && badStamp.actions.length})`);

  /* ═════════ (D) 审计 ═════════ */
  const hits = auditRows('steward_contract_incomplete');
  ok(hits.length === 1, `D1 审计里恰一条 steward_contract_incomplete(实得 ${hits.length} 条)`);
  ok(hits.length === 1 && hits[0].trigger === 'user',
    `D2 带 trigger(实得 ${hits.length === 1 ? JSON.stringify(hits[0].trigger) : 'n/a'})`);
  ok(hits.length === 1 && Array.isArray(hits[0].keys) && hits[0].keys.length === 1 && hits[0].keys[0] === 'say',
    `D3 带【模型到底给了哪些键】(实得 ${hits.length === 1 ? JSON.stringify(hits[0].keys) : 'n/a'},应为 ["say"])`);
  ok(hits.length === 1 && Number(hits[0].sayChars) > 0,
    `D4 带 sayChars(实得 ${hits.length === 1 ? JSON.stringify(hits[0].sayChars) : 'n/a'})——只记长度,正文一个字不进审计`);

  /* ═════════ (E) 对照:契约完整的两轮不打旗 ═════════ */
  console.log('── (E) 契约完整的对照回合 ──');
  const good = await request('POST', '/api/steward/message', { message: '那你先别开线程' });
  const goodReply = good.lines.find(l => l && l.type === 'steward_reply') || null;
  const goodStamp = await lastStamp();
  ok(!!goodReply && goodReply.contractIncomplete === undefined,
    `E1 四字段齐全的那一轮:帧上【没有】这个键(实得 ${goodReply && JSON.stringify(goodReply.contractIncomplete)})——缺省不写,老前端读不到即为 false`);
  ok(!!goodStamp && goodStamp.contractIncomplete === undefined && goodStamp.why.length > 0,
    `E2 它落盘的章上也没有(实得 ${goodStamp && JSON.stringify(goodStamp.contractIncomplete)}),why 真的落下来了`);
  ok(auditRows('steward_contract_incomplete').length === 1,
    `E3 审计条数没涨,仍是 1(实得 ${auditRows('steward_contract_incomplete').length})`);

  const emptyWhy = await request('POST', '/api/steward/message', { message: '记一下这句' });
  const emptyReply = emptyWhy.lines.find(l => l && l.type === 'steward_reply') || null;
  const emptyStamp = await lastStamp();
  ok(!!emptyReply && emptyReply.contractIncomplete === undefined && emptyStamp && emptyStamp.contractIncomplete === undefined,
    `E4 why:'' 那一轮同样不打旗(帧 ${emptyReply && JSON.stringify(emptyReply.contractIncomplete)} / 章 ${emptyStamp && JSON.stringify(emptyStamp.contractIncomplete)})——判据只看【键在不在】,不看值空不空`);
  ok(auditRows('steward_contract_incomplete').length === 1,
    `E5 审计条数仍是 1(实得 ${auditRows('steward_contract_incomplete').length})——三轮里只有第一轮该被记上`);
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  kill(wb);
  kill(fake);
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 文件还被占着 */ }
  console.log(`\nSTEWARD CONTRACT GUARD E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
