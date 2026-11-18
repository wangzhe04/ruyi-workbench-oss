'use strict';
// 150 P1(先截断后识别)/ P6(代号截在中间、列表不还原)的单测快通道。跑的是真 server.js(server-internals),
// 只把本机密钥封装换成内存假件;不起监听、不联网、不碰真实数据目录。
//   ① 截断语料:身份证 / 邮箱 / sk- 密钥 / 手机号 × 带标签 / 不带标签,起点逐字扫过 60 / 160 / 240 三个截断点两侧;
//      enhanced 下产品截出来的前缀里要么有完整值、要么一个字都没有(≥4 字的半截一律算泄露),且再经一个【新】scope
//      识别(管家等别的 scope 拿到的样子)后不剩任何半截;隐私 off 时与裸 slice 逐字相同,且截断函数零正则执行。
//   ② 代号边界:完整代号与写坏的代号都不被切开(off 档也一样,只是字面量查找)。
//   ③ 本 scope 学过、新 scope 认不出的值:即使整段落在窗口内也截到它前面(宁短勿泄)。
//   ④ 自定义正则规则(只在隔离 worker 里执行):同步截断不跑它,改为不切开一段连续的 ASCII / CJK 串。
//   ⑤ 新生成的标签装得下也复核(verify);修前满额落盘的标签在出口去掉末段,有正文时读时重算。
//   ⑥ 起名:代号在本线程 scope 还原,但只留新 scope 单看名字就认得出的原文,其余换类别词;不足 4 字放弃;
//      凭据与坏代号不还原;列表与会话头走 display 还原,还原结果按映射身份缓存。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-safe-prefix-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'sessionRecentUserRequest', 'sessionFirstUserExcerpt', 'threadBriefOnce'], { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const G = app.PrivacyGateway;
// 修前的检出里没有这几个名字:按名字取不到时测试明确失败(反向验证),而不是整文件装载失败。
const optional = name => app.__eval(`typeof ${name} === 'undefined' ? null : ${name}`);
const sessionAutoTitle = optional('sessionAutoTitle'), sessionAutoSummary = optional('sessionAutoSummary');
const fill = n => { let s = ''; while (s.length < n) s += FILLER; return s.slice(0, n); };
const policy = (mode, rules = []) => ({ privacyModeV1: mode, privacyTechnicalV1: false, privacyRulesV1: rules, providers: [], locale: 'zh-CN' });
const norm = text => text.replace(/\s+/g, ' ').trim();
after(() => {
  f.vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-safe-prefix-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});

function cnIdNumber(seed) {
  const body = String(110101 + (seed % 50) * 2) + '19' + String(70 + (seed % 25)).padStart(2, '0') + String(1 + (seed % 12)).padStart(2, '0')
    + String(1 + (seed % 28)).padStart(2, '0') + String(100 + (seed % 899)).padStart(3, '0');
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  return body + '10X98765432'[weights.reduce((sum, w, i) => sum + w * Number(body[i]), 0) % 11];
}
const KINDS = [
  { kind: 'cn_id', value: i => cnIdNumber(i + 3), label: '身份证号' },
  { kind: 'email', value: i => `zhang.wei${i}@example-corp.cn`, label: '邮箱' },
  { kind: 'sk_key', value: i => `sk-${'A1b2C3d4E5f6G7h8J9k0'.slice(i % 5)}QrStUvWxYz0123456789abcd`, label: '密钥' },
  { kind: 'cn_mobile', value: i => `13${String(800138000 + i * 7919).slice(0, 9)}`, label: '手机号' },
];
const FILLER = '请帮我核对一下这份客户资料里的联系方式与证件信息是否填写正确并整理成表格发给财务同事复核谢谢';
function corpus(from, to) {
  const out = [];
  for (const k of KINDS) for (const context of ['labelled', 'plain']) for (let offset = from; offset <= to; offset++) {
    const value = k.value(offset), lead = context === 'labelled' ? k.label + ':' : ' ';
    let prefix = ''; while (prefix.length < offset) prefix += FILLER;
    prefix = prefix.slice(0, offset - lead.length) + lead;
    out.push({ kind: k.kind, context, offset, value, text: prefix + value + ',麻烦尽快处理,后面还有一些补充说明不重要。' });
  }
  return out;
}
const freshProjection = text => {
  const options = { personal: true, confidential: false, technical: false, knownSecrets: [], rules: [] };
  return app.PrivacyCore.createScope({ scopeId: 'unit-fresh', detector: app.PrivacyCore.createDetector(options) }).protectRaw(text).text;
};
// 半截 = 留下了值的头 4 个字以上、却不是完整值。完整值交给下游识别;完全不在也行。
const fragmentOf = (out, value) => !out.includes(value) && out.includes(value.slice(0, 4));
const SITES = [
  { site: 'thread-title', cut: 60, from: 50, to: 70, cutText: text => sessionAutoTitle(text) },
  { site: 'thread-summary', cut: 160, from: 150, to: 170, cutText: text => sessionAutoSummary(text) },
  { site: 'recent-user-request', cut: 240, from: 230, to: 250, cutText: text => (app.sessionRecentUserRequest({ messages: [{ role: 'user', content: text }] }) || { text: '' }).text },
];

test('shared title/summary cut functions exist (three engines call one expression)', () => {
  assert.equal(typeof sessionAutoTitle, 'function', 'sessionAutoTitle (02) is the one title expression 05/05b/09 share');
  assert.equal(typeof sessionAutoSummary, 'function', 'sessionAutoSummary (02) is the one summary expression 05/05b/09 share');
  assert.equal(typeof G.safePrefixEnd, 'function');
});

test('enhanced: a cut never leaves a fragment of an identity/email/key/mobile, raw or after a fresh scope projects it', () => {
  G.configure(policy('enhanced'));
  let straddling = 0;
  for (const site of SITES) for (const c of corpus(site.from, site.to)) {
    const out = site.cutText(c.text), label = `${site.site} ${c.kind}/${c.context}@${c.offset}`;
    if (c.offset < site.cut && c.offset + c.value.length > site.cut) straddling++;
    assert.ok(norm(c.text).startsWith(out), label + ': local display keeps the original text (a prefix)');
    assert.ok(out.length <= site.cut, label + ': budget kept');
    assert.equal(fragmentOf(out, c.value), false, label + ': raw prefix splits the value: ' + JSON.stringify(out.slice(-24)));
    assert.equal(fragmentOf(freshProjection(out), c.value), false, label + ': another scope would disclose a fragment');
  }
  assert.ok(straddling >= 200, 'the corpus really straddles the cut points: ' + straddling);
});

test('off: byte-identical to the old raw slice and no regular-expression scan inside the cut', () => {
  G.configure(policy('off'));
  for (const site of SITES) for (const c of corpus(site.from, site.to)) assert.equal(site.cutText(c.text), norm(c.text).slice(0, site.cut), site.site);
  const sample = corpus(50, 70)[5].text;
  const count = mode => {
    G.configure(policy(mode));
    const original = RegExp.prototype.exec; let calls = 0;
    RegExp.prototype.exec = function (...args) { calls++; return original.apply(this, args); };
    try { G.safePrefixEnd(sample, 60); } finally { RegExp.prototype.exec = original; }
    return calls;
  };
  assert.equal(count('off'), 0, 'OFF must not run any detector');
  assert.ok(count('enhanced') > 0, 'probe sanity: the enhanced cut does scan');
});

test('references are atomic at every cut point, including malformed ones, in off and enhanced', () => {
  const token = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
  for (const mode of ['off', 'enhanced']) {
    G.configure(policy(mode));
    for (let at = 40; at <= 60; at++) {
      const text = 'x'.repeat(at) + token + ' 后面的话';
      const end = G.safePrefixEnd(text, 60);
      assert.ok(end <= at || end >= at + token.length, `${mode} complete@${at}: ${end}`);
      const broken = 'x'.repeat(at) + '[[RUYI_PVT:EMAIL:09c9f2' + ' 后面还有很多很多很多很多很多很多很多很多很多很多的话';
      assert.ok(G.safePrefixEnd(broken, 60) <= at, `${mode} malformed@${at}`);
    }
    assert.equal(sessionAutoSummary('y'.repeat(150) + token + ' 尾巴'), 'y'.repeat(150), mode + ': summary stops before a reference it cannot hold');
  }
});

test('a value this scope learned (unknown to a fresh scope) is cut out even when it fits in the window', async () => {
  const config = policy('enhanced'); G.configure(config);
  const learned = 'Zq9LearnedWord';
  await G.run('sess_safe_prefix_learned', config, async () => {
    G.active().scope.protectValue(learned, 'INTERNAL');
    const inside = FILLER.slice(0, 30) + ' ' + learned + ' ' + FILLER;   // fully inside the 60 window
    assert.equal(app.PrivacyGateway.safePrefix(inside, 60), FILLER.slice(0, 30));
    const straddle = FILLER.slice(0, 52) + learned + FILLER;
    assert.equal(app.PrivacyGateway.safePrefix(straddle, 60), FILLER.slice(0, 52));
  });
});

test('custom regex rules are not executed synchronously: the cut never splits an ASCII or a CJK run instead', () => {
  const lead = (FILLER + FILLER).slice(0, 52), text = lead + ' PROJ-12345678 ' + FILLER;   // the code spans 53..66
  G.configure(policy('enhanced'));
  assert.equal(G.safePrefix(text, 60), text.slice(0, 60), 'control: without the rule nothing is identified');
  G.configure(policy('enhanced', [{ id: 'proj', kind: 'regex', value: 'PROJ-[0-9]{8}', category: 'INTERNAL' }]));
  assert.equal(G.safePrefix(text, 60), lead);
  // A Chinese rule: the value 红星一二三四 straddles 60; back to the previous non-CJK character / punctuation.
  const cjk = (FILLER + FILLER).slice(0, 55) + ',红星一二三四五号仓库' + FILLER;
  G.configure(policy('enhanced', [{ id: 'star', kind: 'regex', value: '红星[一-鿿]{4}', category: 'INTERNAL' }]));
  assert.equal(G.safePrefix(cjk, 60), cjk.slice(0, 56), 'stops right after the punctuation before the CJK run');
  G.configure(policy('enhanced'));
  assert.equal(G.safePrefix(cjk, 60), cjk.slice(0, 60), 'control: no regex rule, no CJK backoff');
});

test('verify mode: a new label that fits is still cut before a value only this scope can recognize', async () => {
  const config = policy('enhanced'); G.configure(config);
  await G.run('sess_safe_prefix_verify', config, async () => {
    G.active().scope.protectValue('Zq9VerifyWord', 'INTERNAL');
    assert.equal(sessionAutoTitle('请核对 Zq9VerifyWord 的资料'), '请核对', 'short auto title');
    assert.equal(G.safePrefix('请核对 Zq9VerifyWord 的资料', 60), '请核对 Zq9VerifyWord 的资料', 'read-time copies (no verify) are untouched');
  });
  G.configure(policy('off'));
  assert.equal(sessionAutoTitle('请核对 Zq9VerifyWord 的资料'), '请核对 Zq9VerifyWord 的资料', 'OFF: unchanged');
});

test('legacy labels stored at exactly the old budget lose their trailing run at the exits (protection on only)', () => {
  const legacy = fill(37) + ' 身份证号:11010119900101123';   // 60 chars: the old raw cut, 17 digits
  assert.equal(legacy.length, 60);
  G.configure(policy('enhanced'));
  assert.equal(G.legacyLabelGuard(legacy, 60), fill(37) + ' 身份证号', 'the trailing non-CJK run (: + digits) goes');
  assert.equal(G.legacyLabelGuard(legacy.slice(0, 59), 60), legacy.slice(0, 59), 'not at the budget: untouched');
  // 1B2 re-review: an unpunctuated 60-char CJK label loses at most its last 24 characters, never everything.
  const cjk = '请帮我联系客户确认下周的报价单并打给一三八零零一三八零零零'.repeat(3).slice(0, 60);
  assert.equal(cjk.length, 60);
  const guarded = G.legacyLabelGuard(cjk, 60);
  assert.ok(guarded.length >= 36 && cjk.startsWith(guarded), 'kept: ' + guarded);
  G.configure(policy('off'));
  assert.equal(G.legacyLabelGuard(legacy, 60), legacy, 'OFF: untouched');
  // With the transcript at hand the legacy auto title is recomputed (02 sessionDisplayTitle).
  const sessionDisplayTitle = optional('sessionDisplayTitle');
  const message = fill(37) + ' 身份证号:' + cnIdNumber(7) + ' 请核对';
  G.configure(policy('enhanced'));
  const head = { id: 's', title: message.slice(0, 60), messages: [{ role: 'user', content: message }] };
  assert.equal(sessionDisplayTitle(head), fill(37) + ' 身份证号:');
  assert.equal(sessionDisplayTitle({ ...head, titleSource: 'user' }), message.slice(0, 60), 'a user title is never rewritten');
});

test('first-user excerpt (24 code points, enters the steward model) is cut on a value boundary', () => {
  G.configure(policy('enhanced'));
  const email = 'zhang.wei.long@example-corp.cn';
  const out = app.sessionFirstUserExcerpt({ messages: [{ role: 'user', content: '请发邮件给 ' + email + ' 说明一下进度' }] });
  assert.equal(fragmentOf(out, email), false, out);
  G.configure(policy('off'));
  assert.equal(app.sessionFirstUserExcerpt({ messages: [{ role: 'user', content: '请发邮件给 ' + email + ' 说明一下进度' }] }), [...('请发邮件给 ' + email)].slice(0, 24).join('') + '…');
});

test('generated names keep an original only when a fresh scope recognizes it inside the name; others become category words', async () => {
  const config = policy('enhanced'); G.configure(config);
  let email, key, words = {};
  await G.run('sess_safe_prefix_label', config, async () => {
    const scope = G.active().scope;
    email = scope.protectValue('li.ming@example.test', 'EMAIL'); key = scope.protectValue('sk-LABEL-' + 'K'.repeat(30), 'CREDENTIAL');
    assert.equal(G.safeLabel('给' + email + '发 ' + key + ' 报价 [[RUYI_PVT:EMAIL:09c9f2'), '给li.ming@example.test发 〔密钥〕 报价 〔隐私信息〕');
    // Values this thread recognized only by context (review probes): the context is gone inside a name.
    for (const [text, word] of [['身份证号:110101199003071234', '〔身份证〕'], ['邮箱:zhang at example dot com', '〔邮箱〕'], ['手机:一三八零零一三八零零零', '〔手机号〕']]) {
      const token = scope.protectRaw(text).text.match(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/)[0];
      words[word] = token;
      assert.equal(G.safeLabel('核对' + token + '的资料'), '核对' + word + '的资料', text);
    }
    // thread_title_update passes already restored originals: learned values are checked the same way.
    assert.equal(G.safeLabel('核对110101199003071234'), '核对〔身份证〕');
    assert.equal(G.safeLabel('回复zhang at example dot com'), '回复〔邮箱〕');
    assert.equal(G.safeLabel('打给一三八零零一三八零零零'), '打给〔手机号〕');
    assert.equal(G.safeLabel('发给 li.ming@example.test'), '发给 li.ming@example.test', 'a shape-recognizable value stays original');
    assert.equal(G.labelSubstance('核对〔身份证〕'), 2);
  });
  assert.equal(G.safeLabel('给' + email + '发报价'), '给〔邮箱〕发报价', 'outside the thread scope a reference is never restored');
  G.configure({ ...config, locale: 'en-US' });
  assert.equal(G.safeLabel('Mail ' + email), 'Mail [email]');
  G.configure(config);
  assert.equal(G.safeLabel('plain title'), 'plain title');
});

test('session lists and the session head go through the same display restoration as GET one session', async () => {
  const config = policy('enhanced'); G.configure(config);
  const sid = 'sess_safe_prefix_display'; let token;
  await G.run(sid, config, async () => {
    token = G.active().scope.protectValue('wang.fang@example.test', 'EMAIL');
    await G.beforeRequest({ messages: [{ role: 'user', content: token }] });
  });
  const plain = { id: 'sess_plain_row', title: 'plain', summary: 'plain' };
  const rows = [{ id: sid, title: '给' + token, summary: '已发给 ' + token.slice(0, 26), brief: { title: token, gist: 'g' }, recentUserRequest: { text: '发给' + token } }, plain];
  const before = JSON.stringify(rows);
  const shown = await G.displayLabels(rows);
  assert.equal(JSON.stringify(rows), before, 'canonical rows are not mutated');
  assert.equal(shown[0].title, '给wang.fang@example.test');
  assert.equal(shown[0].brief.title, 'wang.fang@example.test');
  assert.equal(shown[0].recentUserRequest.text, '发给wang.fang@example.test');
  assert.ok(!JSON.stringify(shown).includes('[[RUYI_PVT'), JSON.stringify(shown));
  assert.equal(shown[1], plain, 'rows without references are passed through untouched');
  const cards = await G.displayLabels([{ sessionId: sid, title: token, displayTitle: token, lastSay: token, missionTitle: token }], row => row.sessionId);
  assert.ok(!JSON.stringify(cards).includes('[[RUYI_PVT'));
  const envelope = await G.displayEnvelope(sid, { ok: true, displayTitle: '给' + token, session: { id: sid, title: '给' + token, summary: token, threadBrief: { title: token, gist: '' }, messages: [] } });
  assert.equal(envelope.displayTitle, '给wang.fang@example.test');
  assert.equal(envelope.session.title, '给wang.fang@example.test');
  assert.equal(envelope.session.threadBrief.title, 'wang.fang@example.test');
  assert.deepEqual(envelope.session.messages, []);
});

test('list display copies are cached per mapping identity: a hot list decrypts nothing, a mapping change misses', async () => {
  const config = policy('enhanced'); G.configure(config);
  const rows = [], tokens = new Map();
  for (let i = 0; i < 200; i++) {
    const sid = 'sess_label_cache_' + i;
    await G.run(sid, config, async () => {
      const token = G.active().scope.protectValue('cache' + i + '@example.test', 'EMAIL'); tokens.set(sid, token);
      await G.beforeRequest({ messages: [{ role: 'user', content: token }] });
    });
    rows.push({ sessionId: sid, title: '给' + tokens.get(sid), lastSay: '已发 ' + tokens.get(sid) });
  }
  let opens = 0; const open = app.PrivacyCore.configHooks.openLocal;
  app.PrivacyCore.configHooks.openLocal = (...args) => { opens++; return open(...args); };
  try {
    let t0 = performance.now();
    const cold = await G.displayLabelsStamped(rows, row => row.sessionId);
    const coldMs = performance.now() - t0, coldOpens = opens;
    t0 = performance.now();
    const hot = await G.displayLabelsStamped(rows, row => row.sessionId);
    const hotMs = performance.now() - t0, hotOpens = opens - coldOpens;
    console.log(`# label display 200 rows: cold ${coldMs.toFixed(1)} ms (${coldOpens} mapping opens), hot ${hotMs.toFixed(1)} ms (${hotOpens} opens)`);
    assert.ok(coldOpens >= 72, 'more than the 128 resident scopes: the cold pass reads mapping files (' + coldOpens + ')');
    assert.equal(hotOpens, 0, 'the hot pass decrypts nothing');
    assert.equal(hot.stamp, cold.stamp, 'unchanged mappings keep the list stamp (ETag stays valid)');
    assert.deepEqual(hot.rows, cold.rows);
    assert.equal(cold.rows[0].title, '给cache0@example.test');
    await G.run('sess_label_cache_0', config, async () => { G.active().scope.protectValue('another@example.test', 'EMAIL'); await G.beforeRequest({ messages: [{ role: 'user', content: 'x' }] }); });
    const changed = await G.displayLabelsStamped(rows, row => row.sessionId);
    assert.notEqual(changed.stamp, cold.stamp, 'a mapping write changes the list stamp');
  } finally { app.PrivacyCore.configHooks.openLocal = open; }
});

test('threadBriefOnce: a name the steward scope could not protect is not stored; a protectable one is stored as words/originals', async () => {
  const config = { ...policy('enhanced'), stewardThreadBriefV1: true, locale: 'zh-CN' }; G.configure(config);
  const state = app.__eval(`(() => {
    const state = { writes: [] };
    loadSession = async id => ({ id, kind: 'quick_ask', title: 'New session', rewindGen: 0, turnSeq: 1 });
    updateSessionMeta = async (id, patch) => { state.writes.push({ id, patch }); return { ok: true }; };
    threadBriefRateLimited = () => false;
    return state;
  })()`);
  const savedFetch = global.fetch;
  const email = 'zhang.wei.long@example-corp.cn', badId = '110101199003071234';
  let reply = () => ({});
  global.fetch = async (url, options) => {
    const sent = options.body, tokenOf = kind => (new RegExp('\\[\\[RUYI_PVT:' + kind + ':[a-f0-9]{32}\\]\\]').exec(sent) || [''])[0];
    assert.ok(tokenOf('EMAIL') && !sent.includes(email) && !sent.includes(badId), 'the model only sees references');
    const text = JSON.stringify(reply(tokenOf('EMAIL'), tokenOf('IDENTITY')));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
  };
  const provider = { id: 'synthetic-chat', type: 'openai-compat', apiStyle: 'chat', baseUrl: 'https://fixture.invalid/v1', model: 'synthetic-model', apiKey: '', serverWebSearch: false };
  const message = '请把报价单发给 ' + email + ' 并核对身份证号:' + badId + ' 是否正确';
  try {
    // A: the 24-char budget falls inside the restored email, leaving only 「给」: no name, the raw title stays.
    reply = mail => ({ title: '给' + mail + '发报价', gist: '把报价单发给 ' + mail + ' 并确认收到' });
    assert.equal(await app.threadBriefOnce({ sessionId: 'sess_brief_a', config, threadProvider: provider, stage: 'first_turn', message }, 'sess_brief_a'), null);
    assert.equal(state.writes.length, 0, 'nothing stored');
    // B: the labelled invalid-checksum ID is recognizable only with its label: a category word, never digits.
    reply = (mail, id) => ({ title: '核对' + id + '的客户资料', gist: '把报价单发给 ' + mail + ' 并核对 ' + id });
    const brief = await app.threadBriefOnce({ sessionId: 'sess_brief_b', config, threadProvider: provider, stage: 'first_turn', message }, 'sess_brief_b');
    assert.ok(brief, 'a brief is produced');
    const stored = state.writes.at(-1).patch.threadBrief;
    assert.equal(stored.title, '核对〔身份证〕的客户资料');
    assert.equal(stored.gist, '把报价单发给 ' + email + ' 并核对 〔身份证〕', 'a shape-recognizable value is kept whole as the original');
    for (const field of ['title', 'gist']) {
      assert.ok(!stored[field].includes('RUYI_PVT') && !stored[field].includes(badId.slice(0, 6)), field + ': ' + stored[field]);
      assert.equal(fragmentOf(stored[field], email), false, field + ': ' + stored[field]);
    }
    // C (1B2 复审): a short ordinary name with nothing replaced is stored as before (enhanced).
    reply = () => ({ title: '周报', gist: '整理本周周报' });
    const short = await app.threadBriefOnce({ sessionId: 'sess_brief_c', config, threadProvider: provider, stage: 'first_turn', message }, 'sess_brief_c');
    assert.ok(short, 'a short name without replacements is not discarded');
    assert.equal(state.writes.at(-1).patch.threadBrief.title, '周报');
  } finally { global.fetch = savedFetch; }
});

test('privacy off: short generated names keep their pre-fix behaviour (1B2 re-review)', () => {
  const brief = app.__eval('threadBriefLabels');
  G.configure(policy('off'));
  for (const name of ['周报', '写周报', 'Bug']) assert.deepEqual(brief(name, name + ' gist'), { title: name, gist: name + ' gist' }, name);
  G.configure(policy('enhanced'));
});
