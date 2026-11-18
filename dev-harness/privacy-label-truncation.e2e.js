'use strict';
// 150 P1(先截断后识别)/ P6(代号截在中间、列表不还原)的真链路件。真 provider 引擎回合、真起名(threadBriefOnce)、
// 真管家回合(steward_threads_search / steward_thread_status 走 HTTP 模型循环)、真 /api/sessions · /api/missions ·
// GET /api/sessions/:id 路由;只有模型(进程内假 provider)与本机密钥封装(内存假件)是假的。
//   L1 隐私 enhanced 下首条消息的邮箱横跨标题 60 字、身份证横跨最近请求 240 字:会话头的 title / recentUserRequest
//      只留完整值或完全不留,没有半截。
//   L2 助手回复里的代号横跨摘要 160 字:summary 不含半个代号。
//   L3 起名:模型回的名字带代号 → 存的是本线程 scope 里还原出的原文,24 字截在值的边界上,没有 [[RUYI_PVT。
//   L4 管家回合发给假 provider 的全部字节里没有任何敏感值的原文或半截(≥6 字前缀)。
//   L5 /api/sessions、/api/missions、GET 单会话(title/summary/brief/displayTitle)不含 [[RUYI_PVT,遗留的半截代号也不。
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { createRunner } = require('./lib/harness');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-label-truncation-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'runSessionTurn', 'runStewardTurn', 'createSession', 'loadSession', 'saveSession', 'readConfig', 'mutateConfig', 'handleApi', 'RUNTIME'], { withEval: true });
const f = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
app.__eval(`detectClaudePath = () => ''; detectKimiPath = () => '';`);
const t = createRunner('PRIVACY LABEL TRUNCATION');

const FILLER = '请帮我核对一下这份客户资料里的联系方式与证件信息是否填写正确并整理成表格发给财务同事复核谢谢';
const fill = n => { let s = ''; while (s.length < n) s += FILLER; return s.slice(0, n); };
const EMAIL = 'qx7.private.contact@example-corp.cn';
const ID_BODY = '11010119900307123', WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const IDENTITY = ID_BODY + '10X98765432'[WEIGHTS.reduce((sum, w, i) => sum + w * Number(ID_BODY[i]), 0) % 11];
// 邮箱从第 50 字起(横跨 60);身份证从第 232 字起(横跨 240)。
const head1 = fill(49) + ' ', middle = ' ' + fill(232 - 50 - EMAIL.length - 2) + ' ';
// 审查 1:再带一个【校验位不对】的身份证号 —— 只有「身份证号」标签在旁边时才认得出;起名时它会脱离标签进名字。
const BAD_ID = '110101199003071234';
const MESSAGE = head1 + EMAIL + middle + IDENTITY + ' ,麻烦尽快处理,另外核对身份证号:' + BAD_ID + ' 是否填错。';
const halfOf = (text, value, min = 6) => { for (let n = value.length - 1; n >= min; n--) if (text.includes(value.slice(0, n))) return value.slice(0, n); return ''; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  let fake, host;
  try {
    let phase = 'thread', stewardStep = 0, threadId = '';
    const aliases = [];
    fake = await startFakeProvider({ handler(req) {
      const text = JSON.stringify(req.body.messages || []);
      const alias = (text.match(/\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]/) || [''])[0];
      const idAlias = (text.match(/\[\[RUYI_PVT:IDENTITY:[a-f0-9]{32}\]\]/g) || ['']).at(-1);   // 消息里第二个证件号 = BAD_ID
      if (/You name a conversation thread|你给一条对话线程起名字/.test(text)) {
        // 起名:名字里放代号(模型只见过代号),且 24 字预算落在还原后的邮箱中间。
        return textFrames(JSON.stringify({ title: '核对' + idAlias + '的资料', gist: '把资料发给 ' + alias + ' 并核对 ' + idAlias }));
      }
      if (phase === 'thread') {
        if (alias) aliases.push(alias);
        return textFrames('p'.repeat(150) + alias + ' 已整理完成。');
      }
      if (phase === 'steward') {
        const calls = [['steward_threads_search', { q: '核对', includeClosed: true }], ['steward_thread_status', { sessionId: threadId }]];
        const call = calls[stewardStep++]; if (call) return toolCallFrames(call[0], call[1], 'label-' + stewardStep);
      }
      return textFrames(JSON.stringify({ say: '已核对线程,原记录保留。', why: '', acts: [], actions: [] }));
    } });
    await app.mutateConfig(config => { Object.assign(config, {
      activeProvider: 'label-fixture', stewardProviderId: 'label-fixture',
      providers: [{ id: 'label-fixture', type: 'openai-compat', apiStyle: 'chat', model: 'synthetic-model', baseUrl: fake.url + '/v1', apiKey: '', contextWindow: 128000 }],
      privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, defaultWorkspace: work,
      permissionMode: 'acceptEdits', importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      bridgeExternalToolsToProvider: false, stewardEnabledV1: false, stewardThreadBriefV1: true, schedulerEnabledV1: false,
      runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
      allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false }, openaiMaxToolIterations: 8, locale: 'zh-CN',
    }); return {}; });

    // ── 线程回合 ──
    const session = await app.createSession({ cwd: work, title: 'New session', engineRoute: { engine: 'openai', providerId: 'label-fixture' } });
    threadId = session.id;
    const result = await app.runSessionTurn({ sessionId: session.id, message: MESSAGE, source: 'user', onEvent() {} });
    t.ok(result && result.ok === true, 'L0 the protected provider turn completes');
    t.ok(fake.requests.length >= 1 && !fake.requests.some(r => r.raw.includes(EMAIL) || r.raw.includes(IDENTITY)), 'L0 the thread model never receives the originals');
    // 起名是收尾后异步补写的:等它落盘(最多 10 s)。
    let head = null;
    for (let i = 0; i < 200; i++) { head = await app.loadSession(session.id); if (head.threadBrief && head.threadBrief.title) break; await sleep(50); }
    const norm = MESSAGE.replace(/\s+/g, ' ').trim();
    t.ok(norm.startsWith(head.title) && !halfOf(head.title, EMAIL, 4) && head.title.length <= 60, 'L1 title keeps the original text and no half email: ' + JSON.stringify(head.title.slice(-20)));
    const recent = head.recentUserRequest && head.recentUserRequest.text || '';
    t.ok(recent && norm.startsWith(recent) && !halfOf(recent, IDENTITY, 4) && recent.length <= 240, 'L1 recent request carries no half identity number: ' + JSON.stringify(recent.slice(-24)));
    t.ok(aliases.length >= 1 && !head.summary.includes('[[RUYI_PVT') && head.summary === 'p'.repeat(150), 'L2 summary stops before a reference it cannot hold whole: ' + JSON.stringify(head.summary.slice(-24)));
    const brief = head.threadBrief || {};
    t.ok(brief.title === '核对〔身份证〕的资料' && brief.gist === '把资料发给 ' + EMAIL + ' 并核对 〔身份证〕' && !JSON.stringify(brief).includes(BAD_ID.slice(0, 6)),
      'L3 the generated name keeps only originals a fresh scope recognizes in the name itself (email), the label-only ID becomes a word: ' + JSON.stringify(brief));

    // ── 管家回合:标题/摘要/最近请求/起名经线程清单与工具结果进管家模型 ──
    await app.mutateConfig(config => { config.stewardEnabledV1 = true; return {}; });
    phase = 'steward'; const stewardStart = fake.requests.length, events = [];
    const steward = await app.runStewardTurn({ trigger: 'user', message: '请看看刚才那条线程核对得怎么样了,不要改设置。', onEvent: event => events.push(event) });
    const wire = fake.requests.slice(stewardStart).map(r => r.raw).join('\n');
    const toolResults = events.filter(event => event.type === 'tool_result');
    t.ok(steward && steward.ok === true && stewardStep >= 2 && toolResults.length >= 2, 'L4 the steward traverses two thread tools through the model loop');
    t.ok(wire.includes(threadId), 'L4 the steward wire really carries this thread (the check below is not vacuous)');
    const leaks = [EMAIL, IDENTITY, BAD_ID].map(value => halfOf(wire, value, 6) || (wire.includes(value) ? value : '')).filter(Boolean);
    const around = leaks.map(frag => { const at = wire.indexOf(frag); return wire.slice(Math.max(0, at - 160), at + frag.length + 40); });
    t.ok(leaks.length === 0, 'L4 no original or fragment (>=6 chars) of the email / identity reaches the steward model: ' + JSON.stringify(around));
    t.ok(!aliases.some(alias => wire.includes(alias.slice(0, 25))), 'L4 no thread-scope reference (whole or half) crosses into the steward scope');

    // ── 列表与会话头的 display 还原 ──
    const legacy = await app.createSession({ cwd: work, title: '遗留线程', engineRoute: { engine: 'openai', providerId: 'label-fixture' } });
    const legacyHead = await app.loadSession(legacy.id);
    legacyHead.summary = 'p'.repeat(20) + aliases[0].slice(0, 26);           // 修前产品真会落下的半截代号
    legacyHead.threadBrief = { schema: 1, title: '给' + aliases[0].slice(0, 23), gist: '', at: new Date().toISOString(), model: 'legacy', stage: 'settled' };
    await app.saveSession(legacyHead);
    app.RUNTIME.token = 'f'.repeat(32);
    host = http.createServer((req, res) => { void app.handleApi(req, res, new URL(req.url, 'http://local').pathname).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}'); }); });
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
    const get = async route => { const r = await fetch('http://127.0.0.1:' + host.address().port + route, { headers: { 'x-wcw-token': app.RUNTIME.token } }); return { status: r.status, text: await r.text() }; };
    const list = await get('/api/sessions');
    const listed = JSON.parse(list.text).sessions || [];
    const labels = rows => JSON.stringify(rows.map(row => [row.title, row.displayTitle, row.summary, row.lastSay, row.brief, row.recentUserRequest]));
    t.ok(list.status === 200 && listed.some(row => row.id === legacy.id) && listed.some(row => row.id === threadId), 'L5 /api/sessions lists both threads');
    t.ok(!labels(listed).includes('RUYI_PVT'), 'L5 /api/sessions labels never show a reference, even a legacy half one: ' + labels(listed).slice(0, 300));
    const missions = await get('/api/missions');
    const cards = JSON.parse(missions.text).missions || [];
    t.ok(missions.status === 200 && cards.some(row => row.sessionId === threadId) && cards.some(row => row.sessionId === legacy.id), 'L5 /api/missions carries both thread rows (the check below is not vacuous)');
    t.ok(!labels(cards).includes('RUYI_PVT'), 'L5 /api/missions rows never show a reference: ' + labels(cards).slice(0, 300));
    for (const id of [threadId, legacy.id]) {
      const one = await get('/api/sessions/' + id), body = JSON.parse(one.text);
      const shown = JSON.stringify([body.displayTitle, body.session && body.session.title, body.session && body.session.summary, body.session && body.session.threadBrief, body.session && body.session.recentUserRequest]);
      t.ok(one.status === 200 && !shown.includes('RUYI_PVT'), 'L5 GET /api/sessions/' + (id === threadId ? 'thread' : 'legacy') + ' head labels go through display restoration: ' + shown.slice(0, 200));
    }
    t.ok(fake.errors.length === 0, 'L6 the fake provider saw no handler error');
  } catch (error) { t.fail('fixture failure: ' + String(error && error.stack || error).slice(0, 800)); }
  finally {
    if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
    if (fake) await fake.close();
    f.vault.clear();
    if (path.dirname(root) !== base || !path.basename(root).startsWith('ruyi-label-truncation-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  t.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
