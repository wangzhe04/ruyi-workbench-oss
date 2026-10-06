'use strict';
// 走查 W1 #4 / #10 / #11(06d-memory-domain)与 #8(12-tool-dispatch parseFrontmatter)。真源码、临时 HOME、零网络。
// 这几个都是未导出的内部函数 —— 经 dev-harness/lib/server-internals.js 取真函数(不增加 14-main.js 的导出面)。
//   [S] memoryProposalLooksSensitive:JS 的 \b 只认 ASCII 单词字符,修前 `\b(?:…|密码|密钥)` 对中文永远不命中,冒号也只认半角。
//   [T] memorySearchTerms:ASCII 与 CJK 各保底 48 个名额(修前 ASCII 先收满、整体 slice(0,96),「日志 + 中文提问」的中文词被整段截掉);
//       英文停用词够全 + 2 字符 ASCII 词只认整词(修前 to/in/it/you、"ai"⊂"main" 这类子串让几乎任何英文提问都「命中」)。
//   [D] deleteMemory:unlink 失败不再回 ok:true(修前 .catch(()=>{}) 吞掉)。
//   [F] parseFrontmatter:只剥成对的外层引号。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-w1-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
const { loadServerInternals } = require('../lib/server-internals');
const { memoryProposalLooksSensitive, memorySearchTerms, rankRelevantMemories, deleteMemory, memoryGlobalDir, saveMemory, parseFrontmatter } = loadServerInternals([
  'memoryProposalLooksSensitive', 'memorySearchTerms', 'rankRelevantMemories', 'deleteMemory', 'memoryGlobalDir', 'saveMemory', 'parseFrontmatter',
]);

// ───────────── [S] ─────────────
test('[S1] 中文「密码/密钥 + 冒号/等号 + 值」被拦(半角与全角分隔符)', () => {
  for (const body of ['数据库密码: hunter2xyz', '我的密码=Abcdef12', '服务器的密钥：abcdef123456', '登录密码＝Zz9988xx', '密码 : p4ssw0rd!', '- 密钥:   sk_live_abcdef\n']) {
    assert.equal(memoryProposalLooksSensitive({ name: '连接信息', description: 'x', body }), true, `应拦:${body}`);
  }
  assert.equal(memoryProposalLooksSensitive({ body: '密码：hunter2xyz' }), true, '字符串开头的关键词也要认(\\b 在开头对 CJK 不成立)');
});

test('[S2] 英文旧规则保留,且同样认全角冒号', () => {
  for (const body of ['password: hunter2xyz', 'API_KEY=abcdef123456', 'access token: abcdef123456', 'Authorization: Bearer abcdef123456', 'password：hunter2xyz',
    '-----BEGIN RSA PRIVATE KEY-----', 'postgres://user:secret@host/db', 'ghp-abcdefghijklmnop']) {
    assert.equal(memoryProposalLooksSensitive({ body }), true, `应拦:${body}`);
  }
});

test('[S3] 普通中文/英文句子不误拦', () => {
  for (const body of ['用户偏好用中文回复,提交信息写清楚改了什么', '密码策略由管理员统一负责', '密码是一个很重要的东西', '数据库密码: 无', '修改密码需要二次验证吗',
    '这个项目的密钥管理方案见 docs/security.md', 'the password policy is documented elsewhere', 'passwords: n/a']) {
    assert.equal(memoryProposalLooksSensitive({ name: 'n', description: 'd', body }), false, `不应拦:${body}`);
  }
  assert.equal(memoryProposalLooksSensitive(null), false);
  assert.equal(memoryProposalLooksSensitive({}), false);
});

// ───────────── [T] ─────────────
const uniqueAscii = (n, prefix = 'tok') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}x`).join(' ');
// 互不相邻的汉字对,每个 run 恰好 2 个字 → 每个 run 产出 1 个二元组(整段 ≤6 字的 run 本身与该二元组相同,Set 去重)。
const uniqueCjkRuns = n => Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + i * 2) + String.fromCharCode(0x4e00 + i * 2 + 1)).join(' ');
const isAscii = t => t.charCodeAt(0) < 128;

test('[T1] 日志(大量 ASCII 词)+ 中文提问:中文词不再被截掉', () => {
  const terms = memorySearchTerms(uniqueAscii(150) + '\n请问部署流程是什么');
  assert.ok(terms.includes('部署'), `中文词保住了(修前被 slice(0,96) 整段截掉):${terms.slice(-8).join(',')}`);
  assert.ok(terms.includes('流程'));
  assert.ok(terms.length <= 96);
});

test('[T2] 预算分配:各 48 保底、一边不满余额让给另一边、纯一边仍是 96', () => {
  const count = text => { const t = memorySearchTerms(text); return { all: t.length, ascii: t.filter(isAscii).length, cjk: t.filter(x => !isAscii(x)).length }; };
  assert.deepEqual(count(uniqueAscii(200) + ' ' + uniqueCjkRuns(200)), { all: 96, ascii: 48, cjk: 48 }, '两边都超:各 48');
  assert.deepEqual(count(uniqueAscii(10) + ' ' + uniqueCjkRuns(200)), { all: 96, ascii: 10, cjk: 86 }, 'ASCII 不满:余额给 CJK');
  assert.deepEqual(count(uniqueAscii(200) + ' ' + uniqueCjkRuns(5)), { all: 96, ascii: 91, cjk: 5 }, 'CJK 不满:余额给 ASCII');
  assert.deepEqual(count(uniqueAscii(200)), { all: 96, ascii: 96, cjk: 0 }, '纯 ASCII 仍是 96(与修前相同)');
  assert.deepEqual(count(uniqueCjkRuns(200)), { all: 96, ascii: 0, cjk: 96 }, '纯中文仍是 96(与修前相同)');
});

test('[T3] 英文停用词:虚词/代词/助动词/疑问词不产生词项', () => {
  const noisy = 'How do you want to use it in the new tool? What is it about, and can you tell me when it will be done? I am in it to win it.';
  const terms = memorySearchTerms(noisy);
  for (const w of ['how', 'do', 'you', 'want', 'to', 'use', 'it', 'in', 'the', 'what', 'is', 'about', 'and', 'can', 'tell', 'me', 'when', 'will', 'be', 'done', 'am']) {
    assert.ok(!terms.includes(w), `${w} 不该是词项`);
  }
  assert.ok(terms.includes('tool') && terms.includes('win'), '实义词保留');
  assert.deepEqual(memorySearchTerms('a deploy-canary_check run'), ['deploy-canary_check', 'deploy', 'canary', 'run'], '分词口径不变(整词 + 按 _.- 拆开的片段;check 在原停用词表里)');
});

const entry = (id, name, description, type = 'lesson', scope = 'project') => ({ id, name, description, type, scope, createdAt: '2026-01-01T00:00:00Z' });

test('[T4] 召回:无关的英文提问不再因短词子串而「命中」', () => {
  const registry = [
    entry('city-store-notes', 'City store notes', 'Notes about the store within the city'),
    entry('tool-main-guide', 'Tool main guide', 'A guide to the main tool'),
  ];
  assert.deepEqual(rankRelevantMemories(registry, 'What is in it for you to do with the city?', 3).map(e => e.id), ['city-store-notes'],
    '只有实义词 city 命中;to/in/it/you/do 不再靠子串拉进 tool-main-guide');
  assert.deepEqual(rankRelevantMemories(registry, 'how do you do it to it in a way', 3), [], '全是虚词 → 零命中(修前 to ⊂ tool/store 等全命中)');
});

test('[T5] 召回:2 字符 ASCII 词只认整词(ui/ci/db 不丢,"ai" 不再 ⊂ "main")', () => {
  const registry = [
    entry('theme-ui', 'UI theme rules', 'Rules for the UI theme tokens'),
    entry('main-build', 'Main build', 'How the main rebuild and valid ids work'),
  ];
  assert.deepEqual(rankRelevantMemories(registry, 'ui', 3).map(e => e.id), ['theme-ui'], '整词 ui 命中,"build/rebuild/valid" 里的 ui 子串不算');
  assert.deepEqual(rankRelevantMemories(registry, 'ai', 3), [], '"ai" 不再 ⊂ "main"');
  assert.deepEqual(rankRelevantMemories(registry, 'id', 3).map(e => e.id), [], '"id" 不再 ⊂ "valid"/"ids"');
  const withCi = [entry('ci-pipeline', 'CI pipeline', 'the ci pipeline rules')];
  assert.deepEqual(rankRelevantMemories(withCi, 'ci failed', 3).map(e => e.id), ['ci-pipeline'], '整词 ci 命中');
});

test('[T6] 召回:中文二元组与 ≥3 字符 ASCII 词仍按子串命中(不回归)', () => {
  const registry = [entry('deploy-canary', '金丝雀部署', '灰度发布与回滚的做法'), entry('misc', '杂项', 'unrelated')];
  assert.deepEqual(rankRelevantMemories(registry, '怎么做灰度发布', 3).map(e => e.id), ['deploy-canary']);
  assert.deepEqual(rankRelevantMemories(registry, 'canary deployment rollback', 3).map(e => e.id), ['deploy-canary']);
});

// ───────────── [D] ─────────────
test('[D1] deleteMemory:删得掉回 ok;已不存在回 not found;unlink 失败如实回 ok:false 且文件仍在', async () => {
  const saved = await saveMemory({ id: 'w1-del-ok', scope: 'global', name: 'del ok', description: 'd', type: 'lesson', body: 'body text' }, root);
  assert.equal(saved.ok, true);
  const file = path.join(memoryGlobalDir(), 'w1-del-ok.md');
  assert.ok(fs.existsSync(file));
  const ok = await deleteMemory('w1-del-ok', 'global', root);
  assert.deepEqual({ ok: ok.ok, deleted: ok.deleted, scope: ok.scope }, { ok: true, deleted: 'w1-del-ok', scope: 'global' });
  assert.equal(fs.existsSync(file), false);
  const gone = await deleteMemory('w1-del-ok', 'global', root);
  assert.deepEqual({ ok: gone.ok, error: gone.error }, { ok: false, error: 'memory not found' });
  assert.equal(gone.unlinkFailed, undefined, '找不到不是「删不掉」(路由据此给 404 / 500)');

  // 造「access 通过、unlink 失败」:同名 .md 是个目录(Linux 给 EISDIR,Windows/macOS 给 EPERM;与文件被占用/只读同属「非 ENOENT 的 unlink 失败」,
  // 且 root 身份下也成立 —— 不能靠 chmod 造权限失败)。
  const stuck = path.join(memoryGlobalDir(), 'w1-del-stuck.md');
  fs.mkdirSync(stuck, { recursive: true });
  const failed = await deleteMemory('w1-del-stuck', 'global', root);
  assert.equal(failed.ok, false, '修前这里回 ok:true,前端提示「已删除」、刷新后条目又回来');
  assert.equal(failed.unlinkFailed, true);
  assert.match(failed.error, /删除失败/);
  assert.match(failed.error, /E[A-Z]+/, '带错误码,便于定位');
  assert.ok(fs.existsSync(stuck), '文件还在');
  assert.equal((await deleteMemory('../escape', 'global', root)).error, 'invalid memory id', '非法 id 的判定不变');
});

// ───────────── [F] ─────────────
test('[F] parseFrontmatter 只剥成对的外层引号', () => {
  const fm = body => parseFrontmatter(`---\n${body}\n---\nbody\n`);
  assert.equal(fm('description: 当用户说 "继续"').description, '当用户说 "继续"', '尾引号属于正文(修前读回 `当用户说 "继续`)');
  assert.equal(fm('description: 说 "继续" 然后 "停止"').description, '说 "继续" 然后 "停止"');
  assert.equal(fm('title: 5" pipe').title, '5" pipe');
  assert.equal(fm('title: it\'s').title, 'it\'s', '单个撇号不是引号');
  assert.equal(fm('description: "整句被双引号包住"').description, '整句被双引号包住', '成对双引号照剥');
  assert.equal(fm("description: '整句被单引号包住'").description, '整句被单引号包住', '成对单引号照剥');
  assert.equal(fm('description: "尾随空白"   ').description, '尾随空白', '闭引号后的尾随空白不挡剥引号');
  assert.equal(fm('description: "  内侧空白  "').description, '内侧空白', '剥完仍 trim(与修前一致)');
  assert.equal(fm('description: "左双右单\'').description, '"左双右单\'', '不成对不剥');
  assert.equal(fm('description: "').description, '"', '孤零零一个引号不剥');
  assert.equal(fm('description: plain').description, 'plain');
  assert.equal(fm('description:').description, '', '空值');
  assert.equal(fm('name: "a"\ndescription: 当用户说 "继续"').name, 'a', '同文件多键互不影响');
  assert.equal(parseFrontmatter('\uFEFF---\nname: "x"\n---\n').name, 'x', 'BOM 照旧处理');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
