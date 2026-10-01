'use strict';
// Unit:59 号文(语音词库第一步)—— 04j VoiceLexicon 的纯函数内核。
//
//   [V1] 设置页文本读写:一行一条「词 = 样子1, 样子2」,四种分隔、注释、同词合并、清洗(尖括号/控制字符)、错听样子的门槛
//   [V2] 落盘形状清洗:坏形状回落默认、键由词重算、来源白名单、次数夹紧、停用墓碑、原厂开关缺省开
//   [V3] 整份替换:留下的保留来源与次数(改了才更新时间)、手加的删掉就没了、学来的删掉留墓碑(排前面)、超上限报 overflow
//   [V4] 挑词:个人词全带(命中的在前)、原厂词只在命中错听样子或写法特殊的英文大小写不对时带、已写对的不带、同名让给个人词、
//        原厂开关关掉就一个都不带、上限、没字时只带个人词
//   [V5] 三处出形:<glossary> 行、整段识别 prompt(只列词、命中在前、≤ 400 字)、实时识别热词(只给个人词、按次数、去太短的)
//   [V6] 原厂表自检:够详细、无重名、每个写进去的错听样子都活着(没被门槛静默吃掉)、长度上限、错听样子不与别的词撞名
//   [V7] 设置页视图:墓碑不出现、原厂表全文只在要的时候给
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-lexicon-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const { VoiceLexicon: V } = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const stateOf = (text, extra = {}) => ({ ...V.applyText(V.defaultState(), text, '2026-10-01T00:00:00.000Z').state, ...extra });

test('[V1] 设置页文本:分隔符、注释、合并、清洗、错听样子门槛', () => {
  const { entries, skipped } = V.parseText([
    '# 注释行', '// 也是注释', '',
    'debug = 低报, 低暴，低爆、地堡;滴爆；迪巴格|d bug',
    '如意 ＝ 如艺',
    'Kubernetes ← 酷伯奈提斯',
    '张伟',
    'DEBUG = 低报, 迪八格',          // 同一个词(不分大小写)第二行:合并样子、去重
    '<b>HB360</b>   系统',          // 尖括号换成空格、空白收成一个
    '!!! = 没有词',                 // 纯标点的词不收
    'pull request = 在, ma, poor request, Pull Request',   // 单字中文、两个字母的英文、与词相同的都不收
  ].join('\r\n'));
  assert.equal(skipped, 1);
  assert.deepEqual(entries.map(e => e.term), ['debug', '如意', 'Kubernetes', '张伟', 'b HB360 /b 系统', 'pull request']);
  assert.deepEqual(entries[0].heard, ['低报', '低暴', '低爆', '地堡', '滴爆', '迪巴格', 'd bug', '迪八格']);
  assert.deepEqual(entries[1].heard, ['如艺']);
  assert.deepEqual(entries[5].heard, ['poor request']);
  const capped = V.parseText('x = ' + Array.from({ length: 12 }, (_, i) => '样子' + i).join(',')).entries[0];
  assert.equal(capped.heard.length, V.MAX_HEARD);
  assert.equal(V.parseText('甲'.repeat(60)).entries[0].term.length, V.MAX_TERM_CHARS);
  assert.equal(V.formatText(entries.slice(0, 3)), 'debug = 低报, 低暴, 低爆, 地堡, 滴爆, 迪巴格, d bug, 迪八格\n如意 = 如艺\nKubernetes = 酷伯奈提斯');
  // 读回去再写出来不变(设置页存一次、再打开看到的是同一份)
  const again = V.parseText(V.formatText(entries)).entries;
  assert.deepEqual(again, entries);
});

test('[V2] 落盘形状清洗', () => {
  assert.deepEqual(V.sanitizeState(null), V.defaultState());
  assert.deepEqual(V.sanitizeState({ terms: [] }), V.defaultState());
  const s = V.sanitizeState({
    base: false,
    terms: {
      wrongkey: { term: 'Redis', heard: ['瑞迪斯', '瑞', 7], src: 'learned', n: 3.9, at: 'x'.repeat(80), off: false },
      other: { term: '  如意  ', src: 'hacker', n: -5, off: 'yes' },
      bad: { term: '   ', heard: ['x'] },
      dup: { term: 'REDIS', heard: [], src: 'typed', n: 1 },
      nope: 'string',
    },
  });
  assert.equal(s.base, false);
  assert.deepEqual(Object.keys(s.terms), ['如意', 'redis']);   // 键由词重算;同名后来者覆盖并挪到最后
  assert.deepEqual(s.terms.redis, { term: 'REDIS', heard: [], src: 'typed', n: 1, at: '', off: false });
  assert.deepEqual(s.terms['如意'], { term: '如意', heard: [], src: 'manual', n: 0, at: '', off: false });
  const t = V.sanitizeState({ terms: { a: { term: 'Redis', heard: ['瑞迪斯', '瑞'], n: 3.9, at: 'x'.repeat(80) } } }).terms.redis;
  assert.deepEqual(t.heard, ['瑞迪斯']);
  assert.equal(t.n, 3);
  assert.equal(t.at.length, 40);
  assert.equal(V.sanitizeState({}).base, true);
});

test('[V3] 整份替换:来源与次数、删除与墓碑、上限', () => {
  const prev = V.sanitizeState({ terms: {
    a: { term: 'Redis', heard: ['瑞迪斯'], src: 'learned', n: 4, at: 'T0' },
    b: { term: '如意', heard: [], src: 'manual', n: 0, at: 'T0' },
    c: { term: 'HB360', heard: [], src: 'learned', n: 2, at: 'T0' },
    d: { term: '张伟', heard: [], src: 'manual', n: 0, at: 'T0' },
  } });
  const { state, skipped, overflow, count } = V.applyText(prev, 'Redis = 瑞迪斯\n如意 = 如艺\nDocker\n???', 'T1');
  assert.equal(skipped, 1);
  assert.equal(overflow, 0);
  assert.equal(count, 3);
  assert.deepEqual(Object.keys(state.terms), ['hb360', 'redis', '如意', 'docker']);   // 墓碑在前
  assert.deepEqual(state.terms.redis, { term: 'Redis', heard: ['瑞迪斯'], src: 'learned', n: 4, at: 'T0', off: false });   // 没改:时间不动
  assert.deepEqual(state.terms['如意'], { term: '如意', heard: ['如艺'], src: 'manual', n: 0, at: 'T1', off: false });     // 改了样子:更新时间
  assert.deepEqual(state.terms.docker, { term: 'Docker', heard: [], src: 'manual', n: 0, at: 'T1', off: false });
  assert.equal(state.terms.hb360.off, true);    // 学来的删掉 → 墓碑(免得又学回来)
  assert.equal(state.terms['张伟'], undefined); // 手加的删掉就没了
  // 墓碑被手动加回来 → 活过来、记成 manual
  const back = V.applyText(state, 'HB360', 'T2').state;
  assert.deepEqual(back.terms.hb360, { term: 'HB360', heard: [], src: 'manual', n: 2, at: 'T2', off: false });
  // 超上限:只留前面的、报多出来几条
  const many = Array.from({ length: V.MAX_TERMS + 3 }, (_, i) => 'w' + i).join('\n');
  const r = V.applyText(V.defaultState(), many, 'T');
  assert.equal(r.overflow, 3);
  assert.equal(Object.keys(r.state.terms).length, V.MAX_TERMS);
  assert.equal(V.setBase(state, false).base, false);
  assert.equal(V.setBase(V.setBase(state, false), true).base, true);
});

test('[V4] 挑词', () => {
  const st = stateOf('如意 = 如艺, 如一\nKubernetes = 酷伯奈提斯\n张伟\nredis');
  // 个人词全带,命中的排前面;原厂词只在命中时带
  const p1 = V.pick({ text: '用刀客起一个瑞迪斯容器,部署到酷伯奈提斯上', state: st });
  assert.deepEqual(p1.map(p => [p.term, p.src, p.hit]), [
    ['Kubernetes', 'user', true], ['如意', 'user', false], ['张伟', 'user', false], ['redis', 'user', false],
    ['Docker', 'base', true],
  ]);   // 瑞迪斯:原厂的 Redis 与个人词 redis 同名 → 让给个人词(个人词不带这个样子,不算命中)
  assert.deepEqual(p1[4].heard.slice(0, 2), ['刀客', '刀刻']);
  // 命中的错听样子排在最前
  const p2 = V.pick({ text: '把日志级别调成低暴', state: V.defaultState() });
  assert.deepEqual(p2.map(p => p.term), ['debug']);
  assert.equal(p2[0].heard[0], '低暴');
  // 写法特殊的英文大小写不对 → 带上;普通英文词(Word、Spring)不按大小写去「纠正」;已经写对的不带
  assert.deepEqual(V.pick({ text: '代码在 GITHUB 上,用 postgresql 存', state: V.defaultState() }).map(p => p.term), ['GitHub', 'PostgreSQL']);
  assert.deepEqual(V.pick({ text: '把 word 文档和 spring 的配置发我', state: V.defaultState() }), []);
  assert.deepEqual(V.pick({ text: '代码在 GitHub 上', state: V.defaultState() }), []);
  // 英文样子按词边界:doctor 里的 doct 不算 docker 的错听
  assert.deepEqual(V.pick({ text: 'the doctor said', state: V.defaultState() }), []);
  assert.deepEqual(V.pick({ text: '把 DOCT 容器重启一下', state: V.defaultState() }).map(p => p.term), ['Docker']);
  // 原厂开关关掉:一个原厂词都不带
  assert.deepEqual(V.pick({ text: '把日志级别调成低暴', state: { ...V.defaultState(), base: false } }), []);
  // 没字(整段识别前、开实时会话时):只带个人词
  assert.deepEqual(V.pick({ text: '', state: st }).map(p => p.src), ['user', 'user', 'user', 'user']);
  // 停用墓碑不带
  const tomb = V.sanitizeState({ terms: { a: { term: 'HB360', src: 'learned', off: true } } });
  assert.deepEqual(V.pick({ text: 'HB360', state: tomb }), []);
  // 上限
  const big = stateOf(Array.from({ length: 60 }, (_, i) => '词' + i).join('\n'));
  assert.equal(V.pick({ text: '', state: big }).length, V.PICK_USER_MAX);
  assert.equal(V.pick({ text: '', state: big, userMax: 3 }).length, 3);
  const noisy = Array.from(V.BASE.filter(b => b.heard.length).slice(0, 40), b => b.heard[0]).join(' ');
  assert.equal(V.pick({ text: noisy, state: V.defaultState() }).length, V.PICK_BASE_MAX);
  // 个人词里命中的、被改得多的在前(第二步的 n)
  const learned = V.sanitizeState({ terms: {
    a: { term: '甲方', n: 1 }, b: { term: '乙方', n: 9 }, c: { term: '丙方', heard: ['冰方'], n: 0 },
  } });
  assert.deepEqual(V.pick({ text: '冰方说', state: learned }).map(p => p.term), ['丙方', '乙方', '甲方']);
});

test('[V5] 三处出形', () => {
  const st = stateOf('如意 = 如艺, 如一\nHB360\n张伟');
  const picked = V.pick({ text: '先把日志级别调成低报,再问问如一那边', state: st });
  assert.deepEqual(V.glossaryLines(picked), ['如意 ← 如一、如艺', 'HB360', '张伟', 'debug ← 低报、低暴、低爆、滴爆']);
  // prompt:只列词、命中的在前(个人词命中的、原厂命中的,然后其余个人词)
  assert.equal(V.asrPrompt(picked), '如意, debug, HB360, 张伟');
  const long = stateOf(Array.from({ length: 80 }, (_, i) => '很长的专业名词第' + i + '号').join('\n'));
  const prompt = V.asrPrompt(V.pick({ text: '', state: long }));
  assert.ok(prompt.length <= V.PROMPT_MAX_CHARS && prompt.length > V.PROMPT_MAX_CHARS - 40, `prompt 长度 ${prompt.length}`);
  assert.equal(V.asrPrompt([]), '');
  // 热词:只给个人词、按次数、去掉太短的、不含墓碑
  const hs = V.sanitizeState({ terms: {
    a: { term: 'A', n: 9 }, b: { term: '如意', n: 1 }, c: { term: 'Kubernetes', n: 5 }, d: { term: 'HB360', src: 'learned', off: true }, e: { term: '张伟' },
  } });
  assert.deepEqual(V.hotwords(hs), ['Kubernetes', '如意', '张伟']);
  assert.deepEqual(V.hotwords(V.defaultState()), []);
  const many = stateOf(Array.from({ length: 300 }, (_, i) => '热词' + i).join('\n'));
  assert.equal(V.hotwords(many).length, V.HOTWORDS_MAX);
});

test('[V6] 原厂常用词表自检', () => {
  assert.ok(V.BASE.length >= 400, `原厂表 ${V.BASE.length} 条(用户要「尽量详细」)`);
  assert.ok(V.BASE.filter(b => b.heard.length).length >= 300, '多数词带常见的错听样子');
  const keys = V.BASE.map(b => b.term.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, '原厂表没有重名词条');
  // 写进 BASE_TEXT 的每个样子都活着 —— 没被门槛(太短/与词相同/重复)静默吃掉
  const lines = V.BASE_TEXT.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  let written = 0;
  for (const line of lines) { const m = line.match(/^(.*?)\s*=\s*(.*)$/); if (m) written += m[2].split(',').filter(s => s.trim()).length; }
  const alive = V.BASE.reduce((n, b) => n + b.heard.length, 0);
  assert.equal(alive, written, '每个写进原厂表的错听样子都过了门槛');
  assert.equal(lines.length, V.BASE.length, '原厂表一行一条、没有合并掉的重复行');
  for (const b of V.BASE) {
    assert.ok(b.term.length <= V.MAX_TERM_CHARS && b.heard.every(h => h.length <= V.MAX_HEARD_CHARS), b.term);
    assert.ok(!/[<>]/.test(b.term + b.heard.join('')), b.term);
  }
  // 错听样子不与别的原厂词撞名(否则「把它写成 X」与「X 是对的」打架)
  const termSet = new Set(keys);
  const clash = V.BASE.flatMap(b => b.heard.filter(h => termSet.has(h.toLowerCase())).map(h => b.term + ' ← ' + h));
  assert.deepEqual(clash, []);
  // 覆盖面:几个大类各抽一个
  for (const term of ['git', 'pull request', 'Python', 'Redis', 'Docker', 'Kubernetes', 'debug', 'prompt', 'Niagara', '服务器', '复现']) {
    assert.ok(keys.includes(term.toLowerCase()), '原厂表里有 ' + term);
  }
});

test('[V7] 设置页视图', () => {
  const st = V.sanitizeState({ base: false, terms: {
    a: { term: 'HB360', src: 'learned', off: true }, b: { term: '如意', heard: ['如艺'] }, c: { term: 'Redis', src: 'learned', n: 2 },
  } });
  const v = V.view(st);
  assert.equal(v.text, '如意 = 如艺\nRedis');
  assert.equal(v.count, 2);
  assert.equal(v.learned, 1);
  assert.deepEqual(v.base, { enabled: false, count: V.BASE.length });
  assert.equal(v.limits.maxTerms, V.MAX_TERMS);
  const vb = V.view(st, { withBase: true });
  assert.ok(vb.base.text.startsWith('# —— 版本管理与协作 ——') && vb.base.text.includes('debug = 低报'));
});
