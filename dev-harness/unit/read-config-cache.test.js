// Unit(perf · readConfig 读缓存):readConfig 有 ~45 个调用点,85 KB 的配置每次 ~10 ms(parse + normalizeConfig)。
// 缓存的设计与理由在 01-config.js 的 configReadCache 头注(上一版因「e2e 直接写 config.json 拿不到」「别名被调用方改脏」被回退,
// 这一版靠文件戳失效 + 近期改动不入缓存 + 命中给深拷贝)。这里用【读盘计数】而不是计时来断言,全部确定性:
//   [C1] 命中:文件没变,连续多次 readConfig 一次盘都不读(fsp.readFile 计数器不动);
//   [C2] 等价:命中的结果与真读盘归一化的结果 deepStrictEqual(含 Symbol 键 CONFIG_GIVEN_CLAUDE_PATH);
//   [C3] 别名安全:调用方把返回值改得面目全非,下一次命中仍是原样(深拷贝),且两次返回不是同一个对象;
//   [C4] 外部改写:换内容/换大小/同大小换 mtime,下一次读都看得见(戳变即失效);
//   [C5] racy 保护:刚写下的文件不入缓存 —— 同大小、同 mtime 的原地二次改写也读得到(戳完全相同也不会陈旧命中);
//   [C6] 进程内写(mutateConfig → writeConfig → writeConfigAtomic):写完立刻读到新值。
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 计数钩子装在它的属性上
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-readconfig-cache-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const cfgFile = path.join(root, 'config.json');

let configReads = 0;
const realReadFile = fsp.readFile;
before(() => {
  fsp.readFile = function patched(p, ...rest) {
    if (String(p) === cfgFile) configReads += 1;
    return realReadFile.call(this, p, ...rest);
  };
});
after(() => { fsp.readFile = realReadFile; });

// 把文件 mtime 拨到 sec 秒前(缓存有「近期改动不入缓存」的保护窗口,要让文件「老」下来才会被缓存)。
function ageFile(sec = 30) { const t = new Date(Date.now() - sec * 1000); fs.utimesSync(cfgFile, t, t); }
function writeRaw(mutate) {
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  mutate(raw);
  fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2), 'utf8');
}
// 让文件处于「老 + 已经过一次干净读(迁移已落盘)+ 缓存已填」的稳态,返回填缓存那一次读到的配置。
async function settle() {
  await srv.readConfig();          // 首次/迁移那次读可能自己回写
  ageFile();
  await srv.readConfig();          // 干净读:缓存在这里填上
  ageFile();                       // 迁移若又落盘过,mtime 被刷新了 —— 再拨老一次(戳变 → 下一读重填)
  return srv.readConfig();
}
function heavy(raw) {
  raw.providers = Array.from({ length: 6 }, (_, i) => ({ id: 'prov' + i, name: 'P' + i, base: 'https://api' + i + '.example.com/v1', apiKey: 'sk-' + 'a'.repeat(30), model: 'm0', models: Array.from({ length: 20 }, (_, k) => 'model-' + i + '-' + k), apiStyle: 'chat' }));
  raw.appendSystemPrompt = 'aaaa';
}

describe('readConfig 读缓存', () => {
  it('[C1] 命中:文件没变时连续 readConfig 一次盘都不读', async () => {
    await srv.readConfig();
    writeRaw(heavy);
    await settle();
    const before1 = configReads;
    for (let i = 0; i < 5; i++) await srv.readConfig();
    assert.strictEqual(configReads - before1, 0, '文件没变,命中缓存不应读盘');
  });

  it('[C2] 等价:命中的结果与真读盘归一化的结果逐项相同(含 Symbol 键)', async () => {
    const hit = await srv.readConfig();
    // 换一个「老」mtime 逼出一次真读盘(戳变了 → 未命中)
    ageFile(60);
    const readsBefore = configReads;
    const miss = await srv.readConfig();
    assert.ok(configReads > readsBefore, '戳变了应当真读盘');
    assert.deepStrictEqual(hit, miss);
    const symsHit = Object.getOwnPropertySymbols(hit);
    assert.ok(symsHit.length >= 1, '归一化结果带 CONFIG_GIVEN_CLAUDE_PATH 这个 Symbol 键');
    assert.deepStrictEqual(symsHit.map(s => hit[s]), Object.getOwnPropertySymbols(miss).map(s => miss[s]));
    ageFile(60);
    await srv.readConfig();   // 重新填上缓存
    const again = await srv.readConfig();
    assert.deepStrictEqual(again, miss);
  });

  it('[C3] 别名安全:调用方就地改返回值不影响缓存,两次命中不是同一个对象', async () => {
    const pristine = await srv.readConfig();
    const snapshot = JSON.parse(JSON.stringify(pristine));
    const a = await srv.readConfig();
    a.providers.length = 0;
    a.providers.push({ id: 'evil' });
    a.theme = 'zzz';
    a.extra = { nested: [1, 2, 3] };
    delete a.defaultWorkspace;
    const b = await srv.readConfig();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.providers, b.providers);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), snapshot, '命中应给缓存快照的深拷贝,不受上一个调用方涂改的影响');
    assert.strictEqual(b.extra, undefined);
  });

  it('[C4] 外部改写(不同大小 / 同大小换 mtime)下一次读就看得见', async () => {
    await settle();
    const hitBefore = configReads;
    await srv.readConfig();
    assert.strictEqual(configReads, hitBefore, '前提:此刻是命中态');
    // 不同大小
    writeRaw(raw => { raw.appendSystemPrompt = 'a-longer-value'; });
    assert.strictEqual((await srv.readConfig()).appendSystemPrompt, 'a-longer-value');
    ageFile(); await srv.readConfig(); ageFile(); await srv.readConfig();    // 稳态,缓存已填
    const stable = configReads;
    await srv.readConfig();
    assert.strictEqual(configReads, stable, '前提:又回到命中态');
    // 同大小(原地改写)+ 把 mtime 拨到另一个老时刻:size/ino 都不变,只有 mtime 变 —— 也必须失效
    writeRaw(raw => { raw.appendSystemPrompt = 'b-longer-value'; });   // 与上一值等长
    ageFile(90);
    assert.strictEqual((await srv.readConfig()).appendSystemPrompt, 'b-longer-value');
  });

  it('[C5] racy 保护:刚写下的文件不入缓存 —— 同大小、同 mtime 的原地二次改写也读得到', async () => {
    await settle();
    const fresh = new Date(Date.now() - 200);       // 「刚改过」:距今远不足保护窗口
    writeRaw(raw => { raw.appendSystemPrompt = 'racy-AAAA'; });
    fs.utimesSync(cfgFile, fresh, fresh);
    assert.strictEqual((await srv.readConfig()).appendSystemPrompt, 'racy-AAAA');
    // 原地改成等长的另一个值,并把 mtime 精确拨回同一个时刻:size/mtimeNs/ino 三样与上一次读到的戳逐位相同
    writeRaw(raw => { raw.appendSystemPrompt = 'racy-BBBB'; });
    fs.utimesSync(cfgFile, fresh, fresh);
    assert.strictEqual((await srv.readConfig()).appendSystemPrompt, 'racy-BBBB', '戳完全相同也不许陈旧命中(刚改过的文件没有入缓存)');
    const reads0 = configReads;
    await srv.readConfig(); await srv.readConfig();
    assert.strictEqual(configReads - reads0, 2, '保护窗口内每次读都真读盘(与修前行为一致)');
    // 窗口过后才开始命中
    ageFile(30);
    await srv.readConfig();
    const reads1 = configReads;
    await srv.readConfig();
    assert.strictEqual(configReads, reads1);
  });

  it('[C6] 进程内写(mutateConfig)之后立刻读到新值,缓存被作废', async () => {
    await settle();
    const stable = configReads;
    await srv.readConfig();
    assert.strictEqual(configReads, stable, '前提:命中态');
    const result = await srv.mutateConfig(cfg => { cfg.appendSystemPrompt = 'from-mutate'; });
    assert.strictEqual(result.ok, true);
    const readsBefore = configReads;
    const after = await srv.readConfig();
    assert.strictEqual(after.appendSystemPrompt, 'from-mutate');
    assert.ok(configReads > readsBefore, '写完之后缓存已作废,应当真读盘');
    // mutator 手里的 current 是可改的拷贝:就地改它不能污染缓存
    await settle();
    await srv.mutateConfig(cfg => { cfg.appendSystemPrompt = 'x1'; return { abort: 'no-write' }; });
    assert.strictEqual((await srv.readConfig()).appendSystemPrompt, 'from-mutate');
  });
});
