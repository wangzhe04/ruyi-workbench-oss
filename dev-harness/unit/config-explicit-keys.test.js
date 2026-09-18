'use strict';
// 128a(48 号文 §2):配置只落「改过的键」。真源码、临时 HOME、真读盘真写盘(readConfig／mutateConfig 整条环)。
//
// 为什么非有这把锁不可:修前任一次写盘都把整份合并配置落下去,装过一次的机器上每个键都写着当年的默认值,
// 此后产品改任何默认值,存量安装一个也吃不到(107-T1 只能靠一次性迁移补三个键;P1 又测出降级再升级会把
// 用户关掉的开关重新打开)。这里钉的是「盘上到底写了什么」—— 只看内存视图的断言对这个缺陷是瞎的:
// 修前修后内存视图一模一样,差别全在文件里。
//
// 判据:
//   [A] 全新安装:第一次读只落簿记键(configSchema／configExplicitKeysV1／version)＋ 迁移播种出的工作区表。
//   [B] 旧版本写下的整份配置:等于当前默认的键第一次读就从盘上清掉,不等于的记成显式并保留。
//   [C] 经 mutateConfig 改过的键进显式集合并落盘;之后即使改回默认值,仍然钉住(「你碰过」)。
//   [D] 手改 config.json:不等于默认的键记成显式;等于默认的不算。
//   [E] 本版不认识的键原样保留(更新的版本写的,降级时不能被抹)。
//   [F] 迁移按显式键判:schema 11 且在显式集合里的开关不被 <12 迁移打开(Brief §4.2 第 24 条);不在集合里的照旧打开。
//   [G] 降级往返:旧版把整份配置连同 schema 11 写回来(保留不认识的 configExplicitKeysV1),回来后显式关掉的仍关。
//   [H] 不会每读必写:第二次读盘上内容逐字节不变。
//   [I] version 戳:旧文件的 '2.7.0' 不被当成显式钉住,落盘恒为当前版本。
//   [J] mutator 删掉一个已知键 = 恢复默认:从显式集合与盘上一起拿掉。
//   [K] claudePath 落盘的是用户给的原值,不是解析后的值;改别的键不动它。
//   [L] 投影幂等:normalizeConfig(投影).persisted 与投影相同、changed 为假。
//   [M] 迁移给 raw 里没有的键造出的值(<10 的工作区播种)在迁移那一次读就落盘(第一轮全量逮到的丢数据缺陷)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cfg-explicit-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { normalizeConfig, readConfig, mutateConfig, CONFIG_SCHEMA } = srv;
const CFG = path.join(root, 'config.json');
const DEFAULTS = normalizeConfig(null).config;
const onDisk = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
const writeDisk = obj => { fs.writeFileSync(CFG, JSON.stringify(obj, null, 2)); try { fs.unlinkSync(CFG + '.prev'); } catch { /* 没有就算了 */ } };
const reset = () => { for (const f of [CFG, CFG + '.prev']) { try { fs.unlinkSync(f); } catch { /* 没有就算了 */ } } };
const FLIPPED = ['runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1'];
// 一份「旧版本写下的整份配置」:当前默认铺满,改几处 —— 与 2.8.0 及以前每一次写盘的形状相同。
const fullOldFile = (patch = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULTS)), configExplicitKeysV1: undefined, configSchema: 12, version: '2.8.0', ...patch });

test('前提:schema 已抬到 13,默认表里有簿记键 configExplicitKeysV1', () => {
  assert.equal(CONFIG_SCHEMA, 13);
  assert.deepEqual(srv.defaultConfig().configExplicitKeysV1, []);
});

test('[A] 全新安装第一次读只落簿记键', async () => {
  reset();
  const cfg = await readConfig();
  const disk = onDisk();
  // 盘上除了三个簿记键,只允许【默认表里没有】的键 —— 也就是一次性迁移的标记位(searchBackendMigrated／
  // subagentBudgetMigrated:置位后才让用户显式选的值生效,它们正该活过降级)。默认表里的键一个都不许出现。
  // 唯一例外是 workspaces:全新安装时 <10 那道迁移从 defaultWorkspace 给工作区表播种,这一份【必须】落盘 ——
  // schema 抬到 13 之后播种再也不会跑(见 [M])。本条第一版断言「只有簿记键」,恰好把这个丢数据的缺陷钉成了对的。
  const TABLE = srv.defaultConfig();
  const known = Object.keys(disk).filter(k => Object.prototype.hasOwnProperty.call(TABLE, k));
  assert.deepEqual(known.sort(), ['configExplicitKeysV1', 'configSchema', 'version', 'workspaces']);
  assert.deepEqual(disk.configExplicitKeysV1, ['workspaces']);
  assert.ok(Array.isArray(disk.workspaces) && disk.workspaces.length === 1, '播种出来的那一行工作区落盘了');
  assert.deepEqual(Object.keys(disk).filter(k => !known.includes(k)).sort(), ['searchBackendMigrated', 'subagentBudgetMigrated']);
  assert.equal(disk.configSchema, 13);
  assert.equal(cfg.permissionMode, DEFAULTS.permissionMode, '内存视图照旧是整份');
  assert.ok(Object.keys(cfg).length > 100, `内存视图的键数 ${Object.keys(cfg).length}`);
});

test('[B] 旧版本的整份配置:等于默认的键清掉,不等于的记成显式', async () => {
  reset();
  const altMode = DEFAULTS.permissionMode === 'bypass' ? 'default' : 'bypass';
  writeDisk(fullOldFile({ permissionMode: altMode }));
  const cfg = await readConfig();
  const disk = onDisk();
  assert.equal(cfg.permissionMode, altMode);
  assert.equal(disk.permissionMode, altMode, '改过的留着');
  assert.ok(disk.configExplicitKeysV1.includes('permissionMode'), '并记成显式');
  assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'toolLoadingMode'), '等于默认的 toolLoadingMode 第一次读就从盘上清掉');
  assert.ok(!disk.configExplicitKeysV1.includes('toolLoadingMode'));
  assert.ok(Object.keys(disk).length < 20, `盘上只剩 ${Object.keys(disk).length} 个键(修前是整份)`);
});

test('[C] mutateConfig 改过的键进显式集合;改回默认值仍然钉住', async () => {
  reset();
  await readConfig();
  const other = DEFAULTS.toolLoadingMode === 'auto' ? 'full' : 'auto';
  await mutateConfig(current => { current.toolLoadingMode = other; });
  let disk = onDisk();
  assert.equal(disk.toolLoadingMode, other);
  assert.ok(disk.configExplicitKeysV1.includes('toolLoadingMode'));
  await mutateConfig(current => { current.toolLoadingMode = DEFAULTS.toolLoadingMode; });
  disk = onDisk();
  assert.equal(disk.toolLoadingMode, DEFAULTS.toolLoadingMode, '改回默认值也照样落盘(你碰过)');
  assert.ok(disk.configExplicitKeysV1.includes('toolLoadingMode'), '仍在显式集合里 —— 默认以后再变也不动它');
  assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'permissionMode'), '没碰过的键仍不落盘');
});

test('[D] 手改 config.json:不等于默认的算显式,等于默认的不算', async () => {
  reset();
  writeDisk({ configSchema: 13, version: srv.VERSION || '2.8.0', configExplicitKeysV1: [],
    runtimeHistoryReadDedupV1: false, toolLoadingMode: DEFAULTS.toolLoadingMode });
  const cfg = await readConfig();
  const disk = onDisk();
  assert.equal(cfg.runtimeHistoryReadDedupV1, false, '手册教的「写 false 关掉」照样生效');
  assert.ok(disk.configExplicitKeysV1.includes('runtimeHistoryReadDedupV1'));
  assert.ok(!disk.configExplicitKeysV1.includes('toolLoadingMode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'toolLoadingMode'));
});

test('[E] 本版不认识的键原样保留(读与写两条路)', async () => {
  reset();
  writeDisk({ ...fullOldFile(), someFutureKeyV9: { a: 1 }, anotherFutureFlag: true });
  await readConfig();
  assert.deepEqual(onDisk().someFutureKeyV9, { a: 1 });
  await mutateConfig(current => { current.toolLoadingMode = DEFAULTS.toolLoadingMode === 'auto' ? 'full' : 'auto'; });
  const disk = onDisk();
  assert.deepEqual(disk.someFutureKeyV9, { a: 1 });
  assert.equal(disk.anotherFutureFlag, true);
});

test('[F] <12 迁移按显式键判', async () => {
  reset();
  writeDisk(fullOldFile({ configSchema: 11, configExplicitKeysV1: ['runtimeHistoryReadDedupV1'],
    runtimeHistoryReadDedupV1: false, runtimeSummaryPromptI18nV1: false, runtimeReseedTailUnitsV1: false }));
  const cfg = await readConfig();
  assert.equal(cfg.runtimeHistoryReadDedupV1, false, '在显式集合里 = 用户明确关的,不迁');
  assert.equal(cfg.runtimeSummaryPromptI18nV1, true, '不在集合里的冻结默认值照旧迁成 true(107-T1 行为不变)');
  assert.equal(cfg.runtimeReseedTailUnitsV1, true);
  const disk = onDisk();
  assert.equal(disk.runtimeHistoryReadDedupV1, false);
  assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'runtimeSummaryPromptI18nV1'), '迁成默认值之后不落盘');
});

test('[G] 降级往返:显式关掉的开关活过旧版的整份回写', async () => {
  reset();
  await readConfig();
  await mutateConfig(current => { current.runtimeHistoryReadDedupV1 = false; });
  const sparse = onDisk();
  assert.ok(sparse.configExplicitKeysV1.includes('runtimeHistoryReadDedupV1'));
  // 旧版(9/16 那份 2.7.0 构建的形状)读进来:默认铺满、三开关旧默认 false、不认识的 configExplicitKeysV1 原样保留、schema 写回 11。
  const oldWrite = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...sparse, configSchema: 11, version: '2.7.0',
    runtimeHistoryReadDedupV1: false, runtimeSummaryPromptI18nV1: false, runtimeReseedTailUnitsV1: false };
  writeDisk(oldWrite);
  const cfg = await readConfig();
  assert.equal(cfg.runtimeHistoryReadDedupV1, false, '用户关掉的没有被重新打开(修前 P1 实测会被打开)');
  assert.equal(cfg.runtimeSummaryPromptI18nV1, true, '旧版冻下的默认值照旧迁移');
});

test('[H] 不会每读必写', async () => {
  reset();
  await readConfig();
  await mutateConfig(current => { current.toolLoadingMode = DEFAULTS.toolLoadingMode === 'auto' ? 'full' : 'auto'; });
  const before = fs.readFileSync(CFG, 'utf8');
  const mtime = fs.statSync(CFG).mtimeMs;
  await readConfig();
  await readConfig();
  assert.equal(fs.readFileSync(CFG, 'utf8'), before);
  assert.equal(fs.statSync(CFG).mtimeMs, mtime, '文件没被重写');
});

test('[I] version 戳不被当成显式', async () => {
  reset();
  writeDisk(fullOldFile({ version: '2.7.0' }));
  await readConfig();
  const disk = onDisk();
  assert.ok(!disk.configExplicitKeysV1.includes('version'));
  assert.notEqual(disk.version, '2.7.0');
  assert.equal(disk.configSchema, 13);
});

test('[J] mutator 删掉已知键 = 恢复默认', async () => {
  reset();
  await readConfig();
  const other = DEFAULTS.toolLoadingMode === 'auto' ? 'full' : 'auto';
  await mutateConfig(current => { current.toolLoadingMode = other; });
  assert.ok(onDisk().configExplicitKeysV1.includes('toolLoadingMode'));
  const r = await mutateConfig(current => { delete current.toolLoadingMode; });
  const disk = onDisk();
  assert.equal(r.config.toolLoadingMode, DEFAULTS.toolLoadingMode);
  assert.ok(!disk.configExplicitKeysV1.includes('toolLoadingMode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'toolLoadingMode'));
});

test('[K] claudePath 落盘的是用户给的原值', async () => {
  reset();
  const given = path.join(root, 'not-installed', 'claude.cmd');
  writeDisk({ configSchema: 13, version: '2.8.0', configExplicitKeysV1: [], claudePath: given });
  await readConfig();
  assert.equal(onDisk().claudePath, given);
  await mutateConfig(current => { current.toolLoadingMode = DEFAULTS.toolLoadingMode === 'auto' ? 'full' : 'auto'; });
  assert.equal(onDisk().claudePath, given, '改别的键不动 claudePath');
  await mutateConfig(current => ({ next: { ...current, permissionMode: current.permissionMode } }));
  assert.equal(onDisk().claudePath, given, 'mutator 返回展开后的新对象也不动');
});

test('[L] 投影幂等', () => {
  const altMode = DEFAULTS.permissionMode === 'bypass' ? 'default' : 'bypass';
  const first = normalizeConfig(fullOldFile({ permissionMode: altMode, someFutureKeyV9: 1 }));
  assert.equal(first.changed, true);
  const again = normalizeConfig(JSON.parse(JSON.stringify(first.persisted)));
  assert.equal(again.changed, false, '投影再归一化一遍不该再触发写盘');
  assert.deepEqual(JSON.parse(JSON.stringify(again.persisted)), JSON.parse(JSON.stringify(first.persisted)));
});

// [M] 128a 第一轮全量逮到的缺陷:迁移给 raw 里【没有】的键造出的值必须在那一次读就落盘。schema 7 的文件没有
// workspaces,<10 迁移从 defaultWorkspace 播种;修前推断只看 raw 里出现的键 ⇒ 播种结果不落盘,schema 抬到 13 后
// 播种再也不跑 ⇒ 工作区表被清空,管家开线程一律 invalid_request(11 件 e2e 连坐红)。
test('[M] 迁移造出来的值(raw 里没有的键)在迁移那一次读就落盘,并活过下一次读', async () => {
  reset();
  const ws = path.join(root, 'ws-seeded');
  writeDisk({ configSchema: 7, defaultWorkspace: ws, recentWorkspaces: [] });
  const first = await readConfig();
  assert.equal(first.workspaces.length, 1, '迁移那一趟内存里有播种出的一行');
  const disk = onDisk();
  assert.ok(disk.configExplicitKeysV1.includes('workspaces'));
  assert.equal(disk.workspaces[0].path, ws, '播种结果落盘了');
  const second = await readConfig();
  assert.equal(second.workspaces.length, 1, '第二次读(schema 已是 13,播种不再跑)工作区表还在');
  assert.equal(second.workspaces[0].path, ws);
});
