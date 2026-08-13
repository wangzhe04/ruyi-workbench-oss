(async () => {
// E2E (M5 候选 D 波 #3): data_profile 数据画像摘要工具。
// require server.js 直调 toolCall(同 tool-dispatch B 段),无 provider/无网络。
// 覆盖: CSV(列类型/缺失/离群)/JSON/JSONL/TSV/text-log 五种格式 + 越界 root 拒绝 + 非法参数。
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const UNIT_DATA = path.join(os.tmpdir(), 'wcw-data-profile-e2e');
const WORK = path.join(UNIT_DATA, 'work');
const OUTSIDE = path.join(os.tmpdir(), 'wcw-data-profile-OUTSIDE');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.rmSync(UNIT_DATA, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
fs.rmSync(OUTSIDE, { recursive: true, force: true }); fs.mkdirSync(OUTSIDE, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = UNIT_DATA;
const S = require(SERVER);

const P = (base) => ({ providers: [{ id: 'p', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'm' }], activeProvider: 'p' });
const ctx = { config: { ...P('https://api.deepseek.com'), defaultWorkspace: WORK }, session: { cwd: WORK } };

// Seed files.
fs.writeFileSync(path.join(WORK, 'data.csv'), [
  'name,amount,flag',
  'a,10,true',
  'b,20,false',
  'c,,true',       // amount 缺失
  'd,30,false',
  'e,1000,true',   // amount 离群点
].join('\n'));
fs.writeFileSync(path.join(WORK, 'data.tsv'), ['name\tval', 'x\t1', 'y\t2', 'z\t3'].join('\n'));
fs.writeFileSync(path.join(WORK, 'data.json'), JSON.stringify([{ "name": "a", "amount": 1 }, { "name": "b", "amount": 2 }]));
fs.writeFileSync(path.join(WORK, 'data.jsonl'), '{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n{"a":3}\n');
fs.writeFileSync(path.join(WORK, 'app.log'), ['2026-08-13 INFO start', '2026-08-13 INFO work', '2026-08-13 ERROR fail'].join('\n'));
fs.writeFileSync(path.join(OUTSIDE, 'secret.csv'), 'secret\n1\n');

try {
    // (a) CSV: 列类型/缺失/离群
    const a = await S.toolCall('data_profile', { path: path.join(WORK, 'data.csv') }, ctx);
    ok(a && a.ok === true, '(a) csv ok, err=' + (a && a.error));
    ok(a && a.format === 'csv' && a.rowCount === 5 && a.colCount === 3, '(a) csv row=5 col=3 (got ' + (a && a.format) + '/' + (a && a.rowCount) + '/' + (a && a.colCount) + ')');
    const amountCol = a && a.columns && a.columns.find(c => c.name === 'amount');
    ok(amountCol && amountCol.type === 'numeric', '(a) amount 列为 numeric');
    ok(amountCol && amountCol.nullCount === 1, '(a) amount 缺失 1 个');
    ok(amountCol && amountCol.outlierCount === 1, '(a) amount 离群点 1 个(1000)');
    ok(amountCol && amountCol.max === 1000 && amountCol.min === 10, '(a) amount min=10 max=1000');
    const flagCol = a && a.columns && a.columns.find(c => c.name === 'flag');
    ok(flagCol && flagCol.type === 'boolean', '(a) flag 列为 boolean');

    // (b) TSV 自动探测分隔符
    const b = await S.toolCall('data_profile', { path: path.join(WORK, 'data.tsv') }, ctx);
    ok(b && b.ok === true && b.rowCount === 3 && b.colCount === 2, '(b) tsv row=3 col=2');
    ok(b && b.delimiter === '\t', '(b) tsv 分隔符自动探测为 tab');

    // (c) JSON 数组
    const c = await S.toolCall('data_profile', { path: path.join(WORK, 'data.json') }, ctx);
    ok(c && c.ok === true && c.format === 'json' && c.rowCount === 2 && c.colCount === 2, '(c) json row=2 col=2');

    // (d) JSONL(键并集)
    const d = await S.toolCall('data_profile', { path: path.join(WORK, 'data.jsonl') }, ctx);
    ok(d && d.ok === true && d.format === 'jsonl' && d.rowCount === 3 && d.colCount === 2, '(d) jsonl row=3 col=2(键并集 a,b)');
    // (d2) 无扩展名多行 JSON(对抗验证 MEDIUM): 首字符 { 的 JSONL 必须回落 jsonl,不得误判 json 而解析失败。
    fs.writeFileSync(path.join(WORK, 'events'), '{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n');
    const d2 = await S.toolCall('data_profile', { path: path.join(WORK, 'events') }, ctx);
    ok(d2 && d2.ok === true && d2.format === 'jsonl' && d2.rowCount === 2 && d2.colCount === 2, '(d2) 无扩展名 JSONL 回落 jsonl(row=2 col=2, got ' + (d2 && d2.format) + ')');
    // (d3) 极值列(对抗验证 LOW): std/mean 非有限时输出 null,不得是 Infinity(JSON 序列化会失真)。
    fs.writeFileSync(path.join(WORK, 'extreme.csv'), 'v\n1e308\n-1e308\n');
    const d3 = await S.toolCall('data_profile', { path: path.join(WORK, 'extreme.csv') }, ctx);
    const d3col = d3 && d3.columns && d3.columns[0];
    ok(d3 && d3.ok === true && d3col && d3col.std === null, '(d3) 极值列 std=null(非 Infinity, got ' + (d3col && d3col.std) + ')');

    // (e) text/log 行画像
    const e = await S.toolCall('data_profile', { path: path.join(WORK, 'app.log') }, ctx);
    ok(e && e.ok === true && e.format === 'text' && e.rowCount === 3, '(e) text/log row=3');
    ok(e && Array.isArray(e.topPrefixes) && e.topPrefixes.length > 0, '(e) text 行首模式统计非空');

    // (f) 越界 root 拒绝(远端 provider)
    const f = await S.toolCall('data_profile', { path: path.join(OUTSIDE, 'secret.csv') }, ctx);
    ok(f && f.ok === false && f.code === 'not-allowed', '(f) 越界 path 被工作区读闸拒绝(code=not-allowed)');

    // (g) 非法参数: 缺 path
    const g = await S.toolCall('data_profile', {}, ctx);
    ok(g && g.ok === false, '(g) 缺 path 拒绝(err=' + (g && g.error) + ')');

    // (h) 不存在的文件
    const h = await S.toolCall('data_profile', { path: path.join(WORK, 'nope.csv') }, ctx);
    ok(h && h.ok === false && /不存在|无法读取/.test(h.error || ''), '(h) 不存在文件拒绝');

    // (i) 坏 JSON
    fs.writeFileSync(path.join(WORK, 'bad.json'), 'not json');
    const i = await S.toolCall('data_profile', { path: path.join(WORK, 'bad.json') }, ctx);
    ok(i && i.ok === false && /JSON/.test(i.error || ''), '(i) 坏 JSON 拒绝');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    fs.rmSync(UNIT_DATA, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    console.log('\nDATA-PROFILE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
