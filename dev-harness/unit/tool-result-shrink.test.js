'use strict';
// N2 / N3:工具结果的结构感知收缩(10-context-governance.js 的 TOOL-RESULT-SHRINK 区间 + truncateToolResult)。
// 修前 truncateToolResult 把序列化后的 JSON 串硬切前 60000 字符:shell 结果的 stderr / code / timedOut 与日志末尾一并丢掉,
// 提示还点名了多数工具没有的 offset/limit。修后:小字段与状态键原样留,大字符串头+尾+「省略 N 字符」标记,数组留计数,
// 提示按工具给;展示副本(落盘/SSE)同一套收缩、上限更大,原对象不被改动。
// 区间内只有纯函数与常量,依赖(countCjkCodeUnits / tokensFromTextCounts)从 09d 源码切片注入,零 IO。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sliceBlock, constBlock, functionBlock } = require('../lib/source-slice');

const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const gov = fs.readFileSync(path.join(SRC, '10-context-governance.js'), 'utf8');
const est = fs.readFileSync(path.join(SRC, '09d-token-estimation.js'), 'utf8');

const region = sliceBlock(gov, '// <<TOOL-RESULT-SHRINK BEGIN', '// >>TOOL-RESULT-SHRINK END');
// 区间不存在(修前的源码)时退回抽 4 个常量,让 truncateToolResult 至少能跑 —— 这样红的是行为断言,不是加载。
const constsOnly = ['TOOL_RESULT_CAP', 'FILE_READ_HEAD', 'FILE_READ_TAIL', 'IMG_B64_TRIM_RE'].map(n => constBlock(gov, n)).join('\n');
const deps = [functionBlock(est, 'countCjkCodeUnits'), functionBlock(est, 'tokensFromTextCounts')].join('\n');
const ESTIMATION_RULES = { factors: { json: 3.6, code: 3.6 } };
const T = new Function('ESTIMATION_RULES', `${deps}\n${region || constsOnly}\n${functionBlock(gov, 'truncateToolResult')}
return { truncateToolResult, shrinkToolResultForDisplay: typeof shrinkToolResultForDisplay === 'function' ? shrinkToolResultForDisplay : null,
  shrinkToolText: typeof shrinkToolText === 'function' ? shrinkToolText : null, toolResultCharCap: typeof toolResultCharCap === 'function' ? toolResultCharCap : null };`)(ESTIMATION_RULES);

const lines = (n, text) => Array.from({ length: n }, (_, i) => `${text} ${i}`).join('\n') + '\n';

test('N2 shell 结果:stderr / code / timedOut 与 stdout 末尾在截断后仍在', () => {
  const stdout = lines(20000, 'build line') + 'ERROR at end: linker failed';
  const res = { ok: false, code: 3, stdout, stderr: 'fatal stderr', elapsedMs: 1234, timedOut: false, interrupted: false };
  const out = T.truncateToolResult('powershell_run', JSON.stringify(res));
  assert.ok(out.length <= 60000, `length ${out.length}`);
  assert.ok(out.length >= 50000, `换行转义后仍应把预算基本用满,而不是收得过狠(实得 ${out.length})`);
  const parsed = JSON.parse(out);                                   // 仍是合法 JSON
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 3);
  assert.equal(parsed.stderr, 'fatal stderr');
  assert.equal(parsed.timedOut, false);
  assert.equal(parsed.elapsedMs, 1234);
  assert.ok(parsed.stdout.startsWith('build line 0\n'), '头部保留');
  assert.ok(parsed.stdout.endsWith('ERROR at end: linker failed'), '尾部保留');
  assert.match(parsed.stdout, /\[…已截断 \d+ 字符 \/ \d+ chars omitted…\]/);
  assert.ok(parsed._truncated && parsed._truncated.fields[0].path === 'stdout');
  assert.match(parsed._truncated.hint, /重定向到文件|file_read/);
  assert.doesNotMatch(parsed._truncated.hint, /offset\/limit/, 'exec 类工具的提示不能点名它没有的参数');
});

test('N2 stderr 与 stdout 同时超大:两者都留头尾,不会一方被挤成零', () => {
  const res = { ok: false, code: 1, stdout: 'O'.repeat(90000) + 'OUT-END', stderr: 'E'.repeat(70000) + 'ERR-END', timedOut: true };
  const parsed = JSON.parse(T.truncateToolResult('script_run', JSON.stringify(res)));
  assert.equal(parsed.timedOut, true);
  assert.equal(parsed.code, 1);
  assert.ok(parsed.stdout.endsWith('OUT-END') && parsed.stderr.endsWith('ERR-END'));
  assert.ok(parsed.stdout.length >= 2000 && parsed.stderr.length >= 2000);
  assert.equal(parsed._truncated.fields.length, 2);
});

test('N2 file_read:内容头 40K + 尾 8K 不变,提示指向 offset/lineOffset,状态键保留', () => {
  const content = 'H'.repeat(45000) + 'M'.repeat(20000) + 'T'.repeat(35000);
  const res = { ok: true, path: 'C:\\w\\big.txt', content, size: 100000, totalChars: 250000, truncated: true };
  const parsed = JSON.parse(T.truncateToolResult('file_read', JSON.stringify(res)));
  assert.equal(parsed.path, 'C:\\w\\big.txt');
  assert.equal(parsed.totalChars, 250000);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.content.startsWith('H'.repeat(39000)));
  assert.ok(parsed.content.endsWith('T'.repeat(7000)));
  assert.match(parsed._truncated.hint, /offset/);
  assert.match(parsed._truncated.hint, /lineOffset/);
  assert.ok(parsed.content.length <= 48000 + 200);
});

test('N2 数组:按条数截断并留计数标记,其余键不动', () => {
  const rows = Array.from({ length: 4000 }, (_, i) => ({ path: `C:\\src\\file${i}.js`, line: i, text: 'match text '.repeat(3) }));
  const out = T.truncateToolResult('file_search', JSON.stringify({ ok: true, count: 4000, results: rows }));
  assert.ok(out.length <= 60000);
  const parsed = JSON.parse(out);
  assert.equal(parsed.count, 4000);
  const tail = parsed.results[parsed.results.length - 1];
  assert.equal(typeof tail, 'string');
  assert.match(tail, /已截断 \d+ 项 \/ \d+ items omitted/);
  assert.equal(parsed.results[0].line, 0);
  assert.equal(parsed._truncated.arrays[0].path, 'results');
});

test('N2 幂等:预算内的结果原样返回;已收缩过的结果再收缩一次不变', () => {
  const small = JSON.stringify({ ok: true, stdout: 'x'.repeat(30000), stderr: '' });
  assert.equal(T.truncateToolResult('powershell_run', small), small);
  const big = JSON.stringify({ ok: true, code: 0, stdout: lines(30000, 'row') });
  const once = T.truncateToolResult('powershell_run', big);
  assert.equal(T.truncateToolResult('powershell_run', once), once);
  assert.equal(T.truncateToolResult('powershell_run', T.truncateToolResult('powershell_run', big)), once);
});

test('N2 中文结果按 token 口径收紧:同样的字符数,CJK 更早被截', () => {
  assert.ok(T.toolResultCharCap, '需要 toolResultCharCap');
  const zh = JSON.stringify({ ok: true, text: '汉'.repeat(50000) });
  const en = JSON.stringify({ ok: true, text: 'a'.repeat(50000) });
  assert.equal(T.truncateToolResult('web_fetch', en), en, '英文 50K 字符在预算内');
  const zhOut = T.truncateToolResult('web_fetch', zh);
  assert.ok(zhOut.length < zh.length, '中文 50K 字符 ≈ 33K token,超预算');
  assert.ok(zhOut.length >= 24000 - 2000 && zhOut.length <= 30000, `length ${zhOut.length}`);
  assert.match(JSON.parse(zhOut).text, /已截断/);
});

test('N2 非 JSON 串回退整串截头(带标记与按工具的提示),file_read 仍是头+尾', () => {
  const plain = 'x'.repeat(100000);
  const out = T.truncateToolResult('web_fetch', plain);
  assert.match(out, /已截断，共 100000 字符/);
  assert.doesNotMatch(out, /offset\/limit/);
  assert.ok(out.length < 61000);
  const fr = T.truncateToolResult('file_read', 'y'.repeat(100000));
  assert.match(fr, /中间已截断，共 100000 字符/);
});

test('N2 头尾切点不劈代理对(emoji),也尽量落在行边界', () => {
  const text = '😀'.repeat(30000) + '\n' + '尾'.repeat(10);
  const cut = T.shrinkToolText(text, 5001, 0.5);
  for (let i = 0; i < cut.length; i++) {
    const c = cut.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) assert.ok(cut.charCodeAt(i + 1) >= 0xDC00 && cut.charCodeAt(i + 1) <= 0xDFFF, `孤立高代理 @${i}`);
    if (c >= 0xDC00 && c <= 0xDFFF) assert.ok(cut.charCodeAt(i - 1) >= 0xD800 && cut.charCodeAt(i - 1) <= 0xDBFF, `孤立低代理 @${i}`);
  }
  const lineCut = T.shrinkToolText(lines(2000, 'abcdefghij'), 4000, 0.5);
  assert.ok(/\n\[…已截断/.test(lineCut), '头部在换行处收尾');
});

test('N3 展示副本:大结果同构收缩、原对象不动;小结果同一引用', () => {
  assert.ok(T.shrinkToolResultForDisplay, '需要 shrinkToolResultForDisplay');
  const res = { ok: true, code: 0, stdout: lines(40000, 'chatty build output line'), stderr: 'warn: x', elapsedMs: 9 };
  const before = JSON.stringify(res);
  const shown = T.shrinkToolResultForDisplay('powershell_run', res);
  assert.equal(JSON.stringify(res), before, '原对象不被改动(写时复制)');
  assert.notEqual(shown, res);
  const size = JSON.stringify(shown).length;
  assert.ok(size <= 120000, `size ${size}`);
  assert.ok(size < before.length / 5);
  assert.equal(shown.stderr, 'warn: x');
  assert.equal(shown.code, 0);
  assert.ok(shown.stdout.endsWith('chatty build output line 39999\n') || shown.stdout.includes('line 39999'));
  const small = { ok: true, path: 'a.txt', content: 'hello' };
  assert.equal(T.shrinkToolResultForDisplay('file_read', small), small);
  const frozen = Object.freeze({ ok: true, stdout: 'z'.repeat(300000) });
  assert.doesNotThrow(() => T.shrinkToolResultForDisplay('powershell_run', frozen));
});

test('N3 展示副本:嵌套字段(results[i].body)也按最大字段先收', () => {
  const res = { ok: true, results: [{ url: 'u1', body: 'a'.repeat(200000) }, { url: 'u2', body: 'small' }] };
  const shown = T.shrinkToolResultForDisplay('web_fetch', res);
  assert.equal(shown.results[1].body, 'small');
  assert.equal(shown.results[0].url, 'u1');
  assert.ok(shown.results[0].body.length < 125000);
  assert.match(shown.results[0].body, /已截断/);
});

// ── N3 图片:大图 base64 落附件,结果里只留占位 + imageAttachments ─────────────────────────────
// boundToolResultForDisplay 带 IO(uploads 目录),故与上面的纯区间分开抽取,注入临时 uploads 与真 fs。
const os = require('os');
const crypto = require('crypto');
function loadImageBound(uploadsDir, fsOverride) {
  const parts = [constBlock(gov, 'TOOL_IMAGE_KEY_RE'), constBlock(gov, 'TOOL_IMAGE_B64_MIN'), constBlock(gov, 'TOOL_IMAGE_B64_BODY_RE'),
    functionBlock(gov, 'toolImageMime'), functionBlock(gov, 'findToolImageFields'), functionBlock(gov, 'boundToolResultForDisplay'),
    functionBlock(gov, 'cowToolResultParent')].join('\n');
  return new Function('ESTIMATION_RULES', 'fsp', 'path', 'paths', 'crypto', 'Buffer', 'toolImageSessionTag',
    `${deps}\n${region}\n${parts}\nreturn boundToolResultForDisplay;`)(ESTIMATION_RULES, fsOverride || fs.promises, path, { uploads: uploadsDir }, crypto, Buffer,
    sid => 'T' + String(sid).replace(/[^A-Za-z0-9]/g, '').slice(0, 9).padEnd(9, '0'));
}
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const fakePng = n => Buffer.concat([PNG_HEAD, Buffer.alloc(n, 7)]);

test('N3 图片:image_base64 落 uploads 附件,存盘/发送的结果只留占位与 imageAttachments', async () => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trs-up-'));
  try {
    const bound = loadImageBound(uploads);
    const png = fakePng(300000);                                     // ≈ 400K base64 字符,修前整段进 messages 与 SSE
    const res = { ok: true, success: true, width: 1920, height: 1080, image_base64: png.toString('base64') };
    const before = JSON.stringify(res);
    const shown = await bound('ai_computer_control__screenshot', res);
    assert.equal(JSON.stringify(res), before, '原对象不被改动(模型视图/视觉通路仍用它)');
    assert.ok(JSON.stringify(shown).length < 2000, '展示副本只剩占位与元数据');
    assert.equal(shown.width, 1920);
    assert.equal(shown.ok, true);
    assert.match(shown.image_base64, /^\[image omitted from stored result: \d+ base64 chars, saved as attachment toolimg_[0-9a-f]{24}\/screenshot\.png\]$/);
    assert.equal(shown.imageAttachments.length, 1);
    const att = shown.imageAttachments[0];
    assert.deepEqual([att.field, att.mime, att.size, att.name], ['image_base64', 'image/png', png.length, 'screenshot.png']);
    assert.match(att.id, /^[A-Za-z0-9_-]{1,64}$/, 'id 必须过 /api/upload/content 的 id 校验');
    assert.deepEqual(fs.readFileSync(path.join(uploads, att.id, att.name)), png, '附件字节与截图一致');
    const again = await bound('ai_computer_control__screenshot', res);   // 同一张图:同 id,不重复写
    assert.equal(again.imageAttachments[0].id, att.id);
  } finally { fs.rmSync(uploads, { recursive: true, force: true }); }
});

test('N3 图片:data: URI、嵌套 screenshot.image、jpeg 识别;小图与非图字段不动', async () => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trs-up-'));
  try {
    const bound = loadImageBound(uploads);
    const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(20000, 3)]);
    const shown = await bound('window_screenshot', { ok: true, screenshot: { image: 'data:image/jpeg;base64,' + jpg.toString('base64'), title: 'w' } });
    assert.equal(shown.screenshot.title, 'w');
    assert.match(shown.screenshot.image, /^\[image omitted/);
    assert.equal(shown.imageAttachments[0].mime, 'image/jpeg');
    assert.equal(shown.imageAttachments[0].name, 'window_screenshot.jpg');
    assert.equal(shown.imageAttachments[0].field, 'screenshot.image');
    const small = { ok: true, image_base64: 'iVBORw0KGgo=' };            // 小于门槛:不是截图,原样
    assert.equal(await bound('screenshot', small), small);
    const notImage = { ok: true, text: 'A'.repeat(50000) };               // 字段名不像图片:不当图处理
    assert.equal(await bound('web_fetch', notImage), notImage);
    const notB64 = { ok: true, image_caption: 'hello world '.repeat(2000) };
    assert.equal(await bound('web_fetch', notB64), notB64, '名字像图但内容不是 base64:不动');
  } finally { fs.rmSync(uploads, { recursive: true, force: true }); }
});

test('N3 图片:uploads 不可写时只留占位(无 imageAttachments),回合不受影响', async () => {
  const blocker = path.join(os.tmpdir(), 'ruyi-trs-blocker-' + process.pid);
  fs.writeFileSync(blocker, 'x');                                        // 拿一个【文件】当 uploads 根,mkdir 必失败
  try {
    const bound = loadImageBound(blocker);
    const shown = await bound('screenshot', { ok: true, image_base64: fakePng(20000).toString('base64') });
    assert.match(shown.image_base64, /^\[image omitted from stored result: \d+ base64 chars\]$/);
    assert.equal(shown.imageAttachments, undefined);
  } finally { fs.rmSync(blocker, { force: true }); }
});

test('[file_read CJK] 默认一页 40K 汉字不被 CJK 收紧挖洞:页面完整到模型,nextOffset 仍衔接', () => {
  const page = '汉'.repeat(40000);                                     // file_read 的默认页(FILE_READ_HEAD 字符)
  const res = { ok: true, path: 'C:\\w\\zh.txt', content: page, offset: 0, nextOffset: 40000, totalChars: 90000, truncated: true };
  const raw = JSON.stringify(res);
  const out = T.truncateToolResult('file_read', raw);
  assert.equal(out, raw, '修前 CJK 收紧把 cap 压到 ~25K,40K 汉字页被从中间挖掉,而模型会直接从 nextOffset 续读,永远补不上');
  const parsed = JSON.parse(out);
  assert.equal(parsed.content.length, 40000);
  assert.equal(parsed.nextOffset, parsed.offset + parsed.content.length, 'nextOffset 与本页长度一致');
  // 混合内容、带换行的中文页也一样
  const mixed = Array.from({ length: 2500 }, (_, i) => `第${i}行:这是一段中文内容 with some ascii ${i}`).join('\n').slice(0, 40000);
  const r2 = JSON.stringify({ ok: true, content: mixed, offset: 0, nextOffset: mixed.length });
  assert.equal(T.truncateToolResult('file_read', r2), r2);
  // 对照:其它工具的 CJK 大结果仍按 token 口径收紧(收紧本身没被关掉)
  const other = JSON.stringify({ ok: true, body: '汉'.repeat(40000) });
  assert.ok(T.truncateToolResult('web_fetch', other).length < 30000);
  // file_read 超出模型上限的页(显式大 limit)仍按头 40K + 尾 8K 收缩
  const huge = JSON.stringify({ ok: true, content: '汉'.repeat(100000), nextOffset: 100000 });
  const cut = JSON.parse(T.truncateToolResult('file_read', huge));
  assert.match(cut.content, /已截断/);
});

test('N3 图片:附件先写 tmp 再 rename;带会话标签的目录名;同一张图再来不重写', async () => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trs-up-'));
  try {
    const writes = [];
    const spy = Object.assign({}, fs.promises, {
      async writeFile(p, data, ...rest) { writes.push({ p: String(p), finalExisted: fs.existsSync(String(p).replace(/\.\d+\.[0-9a-f]+\.tmp$/, '')) }); return fs.promises.writeFile(p, data, ...rest); },
    });
    const bound = loadImageBound(uploads, spy);
    const png = fakePng(20000);
    const res = { ok: true, image_base64: png.toString('base64') };
    const shown = await bound('ai_computer_control__screenshot', res, { sessionId: 'sess_abcdef123456' });
    const att = shown.imageAttachments[0];
    assert.match(att.id, /^toolimg_T[A-Za-z0-9]{9}_[0-9a-f]{24}$/, '目录名带会话标签:' + att.id);
    assert.ok(att.id.length <= 64, '仍过 /api/upload/content 的 id 校验');
    assert.equal(writes.length, 1);
    assert.match(writes[0].p, /\.tmp$/, '写的是临时文件,不是最终路径');
    assert.equal(writes[0].finalExisted, false);
    assert.deepEqual(fs.readFileSync(path.join(uploads, att.id, att.name)), png);
    assert.deepEqual(fs.readdirSync(path.join(uploads, att.id)), [att.name], '没有残留 .tmp');
    await bound('ai_computer_control__screenshot', res, { sessionId: 'sess_abcdef123456' });
    assert.equal(writes.length, 1, '同一张图不重写');
    const plain = await bound('ai_computer_control__screenshot', res);
    assert.match(plain.imageAttachments[0].id, /^toolimg_[0-9a-f]{24}$/, '不传 sessionId 沿用旧命名');
  } finally { fs.rmSync(uploads, { recursive: true, force: true }); }
});
