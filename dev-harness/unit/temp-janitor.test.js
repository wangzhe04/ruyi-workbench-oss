'use strict';
// 单测(第 129 波 129i · 49 号文):夹具残留扫地工的判据。
//
// 它要在用户机器的 %TEMP% 上删东西,所以**每一条纪律都必须有一条会红的判据**:
//   [A] 只动给定根目录的直接子项,且名字前缀对得上 —— 别的名字、别处的目录一律不碰;
//   [B] **绝不碰新的**:keepFreshMs 之内的一律留着(当轮与刚才那轮的取证必须活着 ——
//       否则这个扫地工自己就成了「把现场扫掉」的那个人);
//   [C] 排除名单(git worktree 的两个前缀 ＋ 显式绝对路径)一个都不删;
//   [D] 年龄线之外再按条数封顶,且封顶只在 keepFreshMs 之外生效;
//   [E] 只删目录,同名文件不动;读不到 mtime 的不删(不知道多老就留着)。
// 全程在自己造的临时根里跑,不碰真的 %TEMP%。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneStaleFixtureDirs } = require('../lib/temp-janitor');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function mkRoot(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-unit-'));
  for (const [name, ageMs] of Object.entries(spec)) {
    const full = path.join(root, name);
    if (ageMs === 'FILE') { fs.writeFileSync(full, 'x', 'utf8'); continue; }
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'inside.txt'), 'evidence', 'utf8');
    const when = new Date(NOW - ageMs);
    fs.utimesSync(full, when, when);
  }
  return root;
}
const names = root => fs.readdirSync(root).sort();

test('129i 夹具扫地工:五条纪律各有一条会红的判据', () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  /* [A] 前缀与范围 */
  {
    const root = mkRoot({
      'ruyi-steward-old': 10 * DAY,
      'not-ruyi-old': 10 * DAY,          // 别的名字:不碰
      'ruyi2-old': 10 * DAY,             // 前缀不完整:不碰
    });
    const stats = pruneStaleFixtureDirs({ root, now: NOW });
    ok(stats.deleted === 1, `A1 只清掉前缀对得上的那一个(got ${stats.deleted})`);
    ok(names(root).join(',') === 'not-ruyi-old,ruyi2-old', `A2 别的名字一个没动(got ${names(root).join(',')})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [B] 绝不碰新的 */
  {
    const root = mkRoot({
      'ruyi-e2e-home-justnow': 60 * 1000,        // 一分钟前:当轮的现场
      'ruyi-e2e-home-2h': 2 * 60 * 60 * 1000,    // 两小时前:刚才那轮
      'ruyi-e2e-home-10d': 10 * DAY,             // 十天前:陈年
    });
    const stats = pruneStaleFixtureDirs({ root, now: NOW });
    ok(stats.deleted === 1 && names(root).includes('ruyi-e2e-home-justnow') && names(root).includes('ruyi-e2e-home-2h'),
      `B1 六小时内的两个都留着,只清十天前那个(实得留下 ${names(root).join(',')})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [C] 排除名单 */
  {
    const root = mkRoot({
      'ruyi-wt-old': 100 * DAY,      // git worktree:多老都不删
      'ruyi-base-83e9f7a': 100 * DAY,
      'ruyi-steward-old': 100 * DAY,
      'ruyi-keep-me': 100 * DAY,
    });
    const stats = pruneStaleFixtureDirs({ root, now: NOW, excludeAbsolute: [path.join(root, 'ruyi-keep-me')] });
    ok(names(root).includes('ruyi-wt-old') && names(root).includes('ruyi-base-83e9f7a'),
      'C1 worktree 的两个前缀多老都不删');
    ok(names(root).includes('ruyi-keep-me'), 'C2 显式绝对路径排除也生效(第二道保险)');
    ok(stats.keptExcluded === 3 && stats.deleted === 1, `C3 读数说得清各留了几个(excluded ${stats.keptExcluded} / deleted ${stats.deleted})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [D] 条数封顶,且只在 keepFreshMs 之外 */
  {
    const spec = {};
    for (let i = 0; i < 10; i++) spec[`ruyi-old-${i}`] = (12 + i) * 60 * 60 * 1000;  // 12..21 小时前:过了「新」线,没到 3 天
    for (let i = 0; i < 5; i++) spec[`ruyi-fresh-${i}`] = 60 * 1000;                  // 一分钟前
    const root = mkRoot(spec);
    const stats = pruneStaleFixtureDirs({ root, now: NOW, keepNewest: 4 });
    const left = names(root);
    ok(left.filter(n => n.startsWith('ruyi-fresh-')).length === 5, 'D1 封顶不碰「新的」那一批');
    ok(left.filter(n => n.startsWith('ruyi-old-')).length === 4,
      `D2 不够老的那批只留最近的 keepNewest 个(got ${left.filter(n => n.startsWith('ruyi-old-')).length})`);
    ok(left.includes('ruyi-old-0') && !left.includes('ruyi-old-9'),
      'D3 留下的是【最近的】那几个,不是随便几个');
    ok(stats.deleted === 6, `D4 读数对得上(got ${stats.deleted})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [E] 只删目录 */
  {
    const root = mkRoot({ 'ruyi-a-file': 'FILE', 'ruyi-a-dir': 10 * DAY });
    const stats = pruneStaleFixtureDirs({ root, now: NOW });
    ok(names(root).includes('ruyi-a-file'), 'E1 同名文件不动(夹具残留都是目录)');
    ok(stats.deleted === 1, `E2 只清掉那个目录(got ${stats.deleted})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [F] 干跑只数不删 */
  {
    const root = mkRoot({ 'ruyi-steward-old': 10 * DAY });
    const stats = pruneStaleFixtureDirs({ root, now: NOW, dryRun: true });
    ok(stats.deleted === 1 && names(root).includes('ruyi-steward-old'), 'F1 干跑报了数但一个没删');
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* [G] 根目录不存在 / 空参数:不抛、不乱删 */
  {
    const stats = pruneStaleFixtureDirs({ root: path.join(os.tmpdir(), 'janitor-does-not-exist-' + Date.now()), now: NOW });
    ok(stats.scanned === 0 && stats.deleted === 0, 'G1 根目录不存在时安静返回零');
    const empty = pruneStaleFixtureDirs({});
    ok(empty.scanned === 0 && empty.deleted === 0, 'G2 没给根目录时什么都不做(不会拿 cwd 或 %TEMP% 顶上)');
  }

  assert.equal(fail, 0, `${fail} 条判据红了`);
});
