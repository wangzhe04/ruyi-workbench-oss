'use strict';
// 107-T1(46 号文 §5):CONFIG_SCHEMA 11 → 12 的一次性迁移。真源码、临时 HOME、零模型请求、不落盘。
//
// 为什么非有这把锁不可:126-111b/111d/111e 三个开关在 2.8.0 翻成了默认开,但 normalizeConfig 是
// `{ ...defaultConfig(), ...raw }` —— raw 永远赢;而 readConfig 只要 changed 为真就把【整份合并后的
// 配置】落盘,于是当年那批默认值被原样冻在盘上。所有写过一次 config.json 的安装(= 全部存量用户)
// 盘上都实打实写着 false,【光翻 defaultConfig 一个存量用户也吃不到】。迁移才是真正起作用的那一半,
// 它必须有自己的判据,否则哪天被删掉/写歪(例如写成 delete)都红不出来。
//
// 判据分五组:
//   [A] schema < 12 且显式 false → 必须变 true,且 changed 为真(否则不落盘 = 迁移白做)。
//   [B] schema >= 12 且显式 false → 必须【保持 false】:用户在 2.8.0 之后自己关掉的,升级不许再打开。
//   [C] 全新安装 / 键缺省 → 取新默认 true。
//   [D] 迁移名单【只有这三个】:111a(主指标反向)与 111c(量不出来)拍板不翻,谁顺手把名单扩大就红。
//   [E] 幂等:迁移后的配置再过一遍 normalizeConfig,结果不变。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cfg-schema12-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));

const FLIPPED = ['runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1'];
const NOT_FLIPPED = ['runtimeEvaporateBudgetBoundaryV1', 'runtimeReseedReattachFilesV1'];
const allOff = keys => Object.fromEntries(keys.map(k => [k, false]));

test('[A] schema<12 里显式写着的 false 被一次性翻成 true,并置 changed', () => {
  for (const schema of [6, 9, 10, 11]) {
    const { config, changed } = srv.normalizeConfig({ configSchema: schema, ...allOff(FLIPPED) });
    for (const k of FLIPPED) {
      // === true 而不是 truthy:写成 delete config[k] 的话这里拿到的是 undefined,本条当场红。
      assert.equal(config[k], true, `schema ${schema}: ${k} 应被迁移成 true,实得 ${JSON.stringify(config[k])}`);
    }
    assert.equal(changed, true, `schema ${schema}: changed 必须为真,否则 readConfig 不回写、迁移不落盘`);
  }
});

test('[B] schema>=12 的显式 false 保持关 —— 2.8.0 之后自己关掉的不会被再打开', () => {
  const { config } = srv.normalizeConfig({ configSchema: srv.CONFIG_SCHEMA, ...allOff(FLIPPED) });
  for (const k of FLIPPED) assert.equal(config[k], false, `${k} 在 schema ${srv.CONFIG_SCHEMA} 下必须保持 false`);
  assert.ok(srv.CONFIG_SCHEMA >= 12, `CONFIG_SCHEMA 必须 ≥ 12(实得 ${srv.CONFIG_SCHEMA}),否则本组测的不是迁移之后的世界`);
});

test('[C] 全新安装与键缺省都取新默认(开)', () => {
  for (const raw of [null, {}, { configSchema: 11 }]) {
    const { config } = srv.normalizeConfig(raw);
    for (const k of FLIPPED) assert.equal(config[k], true, `${JSON.stringify(raw)}: ${k} 默认应为 true`);
  }
});

test('[D] 迁移名单只有这三个 —— 111a / 111c 拍板不翻,显式 false 必须原样保持', () => {
  const { config } = srv.normalizeConfig({ configSchema: 11, ...allOff([...FLIPPED, ...NOT_FLIPPED]) });
  for (const k of NOT_FLIPPED) assert.equal(config[k], false, `${k} 不在 107-T1 的迁移名单里,不许被一起打开`);
  for (const k of NOT_FLIPPED) {
    const { config: d } = srv.normalizeConfig({ configSchema: 11 });
    assert.equal(d[k], false, `${k} 的出厂默认仍是关`);
  }
});

test('[E] 迁移幂等:结果再过一遍 normalizeConfig 不变', () => {
  const once = srv.normalizeConfig({ configSchema: 11, ...allOff(FLIPPED) }).config;
  const twice = srv.normalizeConfig(once).config;
  for (const k of FLIPPED) assert.equal(twice[k], true, `${k} 第二趟应保持 true`);
  assert.equal(twice.configSchema, srv.CONFIG_SCHEMA, 'configSchema 被盖成当前值(迁移只跑一次的前提)');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理是旁路 */ } });
