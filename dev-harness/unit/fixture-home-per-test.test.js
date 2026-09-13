#!/usr/bin/env node
// Unit: 122 波 §2.7 —— run-all 每件独立临时家。
//
// 根因:lib/fixture-home.js 的 fixtureHomeDir()/旧版 fixtureChildEnv() 整轮共用一份
// mkdtemp 目录(cachedFixtureHome),先跑的件往这份共用家写 .claude.json,后跑的件又把它
// 当"外部已装"的 MCP 导入 —— 8 路全量下 websearch 红的真根。
//
// 修法:fixtureChildEnv({ perTest: true }) 每次调用都 mkdtemp 一份全新目录,返回
// { env, home },不再复用 cachedFixtureHome。本测试钉住三件事:
//   ① 两次 perTest 调用返回的 home 目录不同;
//   ② 两次都落在 os.tmpdir() 之下(不是随便一个目录);
//   ③ 两次都不等于 REAL_HOME(不会指回真机家)。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { fixtureChildEnv, REAL_HOME, normalizeHome } = require('../lib/fixture-home');

describe('fixtureChildEnv({ perTest: true })', () => {
  it('每次调用都 mkdtemp 一份全新目录,两次不同', () => {
    const a = fixtureChildEnv({ perTest: true });
    const b = fixtureChildEnv({ perTest: true });
    try {
      assert.notEqual(a.home, b.home, '两次 perTest 调用的 home 必须不同(各自 mkdtemp)');
      assert.equal(a.env.USERPROFILE, a.home, 'env.USERPROFILE 必须等于本次的 home');
      assert.equal(a.env.HOME, a.home, 'env.HOME 必须等于本次的 home');
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
      fs.rmSync(b.home, { recursive: true, force: true });
    }
  });

  it('两次都落在 os.tmpdir() 之下', () => {
    const a = fixtureChildEnv({ perTest: true });
    const b = fixtureChildEnv({ perTest: true });
    try {
      const tmp = normalizeHome(os.tmpdir());
      assert.ok(normalizeHome(a.home).startsWith(tmp), `home ${a.home} 应落在 os.tmpdir() ${os.tmpdir()} 之下`);
      assert.ok(normalizeHome(b.home).startsWith(tmp), `home ${b.home} 应落在 os.tmpdir() ${os.tmpdir()} 之下`);
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
      fs.rmSync(b.home, { recursive: true, force: true });
    }
  });

  it('两次都不等于 REAL_HOME(不会指回真机家)', () => {
    const a = fixtureChildEnv({ perTest: true });
    const b = fixtureChildEnv({ perTest: true });
    try {
      assert.notEqual(normalizeHome(a.home), REAL_HOME, 'perTest 的 home 不许等于真机家');
      assert.notEqual(normalizeHome(b.home), REAL_HOME, 'perTest 的 home 不许等于真机家');
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
      fs.rmSync(b.home, { recursive: true, force: true });
    }
  });

  it('不传 opts 时向后兼容:返回值是【环境对象】本身,不是 { env, home }', () => {
    const env = fixtureChildEnv();
    assert.equal(typeof env.USERPROFILE, 'string', '旧签名(无 opts)必须直接返回带 USERPROFILE 的 env 对象');
    assert.equal(env.home, undefined, '旧签名返回值不应有 home 字段(不是 perTest 形状)');
  });

  // 123-M3(37 号文 §3.7):LOCALAPPDATA/APPDATA 不是从 USERPROFILE 派生的独立环境变量,
  // 换家目录时若不跟着换,子进程读到的还是真机的 —— 36 号文 §5.1 实测的泄漏根
  // (index-dedup.e2e.js 的 migrateLegacyAccMemory() 就是扫到真机 %LOCALAPPDATA% 命中出来的)。
  it('perTest 的 LOCALAPPDATA/APPDATA 都落在这次的临时家 home 之下,且目录已建好', () => {
    const a = fixtureChildEnv({ perTest: true });
    try {
      const home = normalizeHome(a.home);
      assert.ok(normalizeHome(a.env.LOCALAPPDATA).startsWith(home), `LOCALAPPDATA ${a.env.LOCALAPPDATA} 应落在本次 home ${a.home} 之下`);
      assert.ok(normalizeHome(a.env.APPDATA).startsWith(home), `APPDATA ${a.env.APPDATA} 应落在本次 home ${a.home} 之下`);
      assert.equal(a.env.LOCALAPPDATA, path.join(a.home, 'AppData', 'Local'), 'LOCALAPPDATA 是 <home>/AppData/Local');
      assert.equal(a.env.APPDATA, path.join(a.home, 'AppData', 'Roaming'), 'APPDATA 是 <home>/AppData/Roaming');
      assert.ok(fs.existsSync(a.env.LOCALAPPDATA), 'LOCALAPPDATA 目录必须已经 mkdir 出来(不是只写了一个不存在的路径)');
      assert.ok(fs.existsSync(a.env.APPDATA), 'APPDATA 目录必须已经 mkdir 出来');
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
    }
  });

  it('两次 perTest 的 LOCALAPPDATA/APPDATA 都 ≠ 真机(不会指回真机家)', () => {
    const a = fixtureChildEnv({ perTest: true });
    const b = fixtureChildEnv({ perTest: true });
    try {
      const realLocal = normalizeHome(path.join(REAL_HOME, 'AppData', 'Local'));
      const realRoaming = normalizeHome(path.join(REAL_HOME, 'AppData', 'Roaming'));
      assert.notEqual(normalizeHome(a.env.LOCALAPPDATA), realLocal, 'a 的 LOCALAPPDATA 不许等于真机的');
      assert.notEqual(normalizeHome(a.env.APPDATA), realRoaming, 'a 的 APPDATA 不许等于真机的');
      assert.notEqual(normalizeHome(b.env.LOCALAPPDATA), realLocal, 'b 的 LOCALAPPDATA 不许等于真机的');
      assert.notEqual(normalizeHome(b.env.APPDATA), realRoaming, 'b 的 APPDATA 不许等于真机的');
      assert.notEqual(a.env.LOCALAPPDATA, b.env.LOCALAPPDATA, '两次 perTest 的 LOCALAPPDATA 也不该彼此相同(各自独立的临时家)');
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
      fs.rmSync(b.home, { recursive: true, force: true });
    }
  });
});
