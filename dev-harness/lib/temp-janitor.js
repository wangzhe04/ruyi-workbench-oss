'use strict';
// 129i(49 号文):夹具残留的扫地工。
//
// 病灶(129 波取证实得):这台机器的 %TEMP% 里积了 19730 个 `ruyi-*` 目录 —— 3386 个 run-all 的
// 夹具家、486 个浏览器 profile 根,其余一万五千多个是各件自己 mkdtemp 出来的。两处来源同一个形状:
//   · run-all 在【失败件】上有意保留取证(那是对的),但**从不老化** —— 一年前那次失败的现场还在;
//   · 各件自己的临时目录只在【成功】那条路上删,失败或被中断就永远留着。
// 后果不是占盘,是**让「全量绿」这句话不可信**:目录一多,Edge 冷启动与 mkdtemp 都被拖慢,
// 于是并行全量里冒出一批「超时但没有断言红」的假偶发(128 波 F8/F9 查的是同一族的进程侧,
// 129 波两轮全量各撞到一次:action-feedback 的 CDP 15 秒等不到、kimi-agent-cli 首跑猝死)。
//
// 判据的三条纪律(这是在用户机器上删东西,写在代码里而不是靠谁记得):
//   ① **只动给定根目录的直接子项**,名字前缀必须在 prefixes 里 —— 不递归去别处找、不碰别的名字;
//   ② **绝不碰新的**:younger than keepFreshMs(默认 6 小时)的一律留着 —— 当轮与刚才那轮的取证
//      必须活着,否则这个扫地工自己就成了「把现场扫掉」的那个人;
//   ③ 排除名单(worktree 之类)按前缀写死,删不掉就跳过并计数,绝不重试到底、绝不改权限硬删。
// 顺序是「先按年龄清,再按条数封顶」:年龄管的是「陈年现场没人会再看」,上限管的是
// 「一轮里失败了几百件」这种突发 —— 两条都只在 keepFreshMs 之外生效。

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

// 夹具目录的前缀:run-all 自己的两种 + 各件 mkdtemp 用的那一大族(它们无一例外以 ruyi- 开头)。
// 这里【只写一条】通配前缀,排除名单另列 —— 与其维护一张永远会漏的「所有件的前缀表」,
// 不如反过来:ruyi- 开头的都算夹具,除非它在排除名单里(手攒的名单要配机械锁,这条名单只有两项)。
const FIXTURE_PREFIX = 'ruyi-';
// 不是夹具、绝不能删:git worktree(ruyi-wt-* / ruyi-base-*)。它们和夹具同住 %TEMP% 是历史原因。
const NEVER_TOUCH_PREFIX = Object.freeze(['ruyi-wt-', 'ruyi-base-']);

function statMtime(full) {
  try { return fs.statSync(full).mtimeMs; } catch { return NaN; }
}

// 返回 { scanned, deleted, keptFresh, keptExcluded, failed }。
// dryRun: true 时只数不删(件与人都用得上)。
function pruneStaleFixtureDirs(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = String(opts.root || '');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 3 * DAY_MS;
  const keepFreshMs = Number.isFinite(opts.keepFreshMs) ? opts.keepFreshMs : 6 * 60 * 60 * 1000;
  const keepNewest = Number.isFinite(opts.keepNewest) ? opts.keepNewest : 500;
  const dryRun = opts.dryRun === true;
  const exclude = Array.isArray(opts.excludeAbsolute) ? opts.excludeAbsolute.map(p => String(p).toLowerCase()) : [];
  const out = { scanned: 0, deleted: 0, keptFresh: 0, keptExcluded: 0, failed: 0 };
  if (!root) return out;

  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }

  const candidates = [];
  for (const ent of entries) {
    const name = ent.name;
    if (!name.startsWith(FIXTURE_PREFIX)) continue;
    if (!ent.isDirectory()) continue;          // 只删目录;同名文件一律不动
    out.scanned += 1;
    const full = path.join(root, name);
    if (NEVER_TOUCH_PREFIX.some(p => name.startsWith(p)) || exclude.includes(full.toLowerCase())) {
      out.keptExcluded += 1;
      continue;
    }
    const mtime = statMtime(full);
    // 读不到时间 = 不知道它多老 —— 不知道就不删(fail-closed 的方向在这里是「留着」)。
    if (!Number.isFinite(mtime)) { out.keptFresh += 1; continue; }
    if (now - mtime < keepFreshMs) { out.keptFresh += 1; continue; }   // 纪律②:绝不碰新的
    candidates.push({ full, mtime });
  }

  // 先按年龄:超过 maxAgeMs 的直接清。
  const stale = [];
  const rest = [];
  for (const row of candidates) (now - row.mtime >= maxAgeMs ? stale : rest).push(row);
  // 再按条数封顶:剩下的(还没到年龄线、但也不新了)只留最近的 keepNewest 个。
  rest.sort((a, b) => b.mtime - a.mtime);
  const overflow = rest.slice(Math.max(0, keepNewest));

  for (const row of [...stale, ...overflow]) {
    if (dryRun) { out.deleted += 1; continue; }
    try { fs.rmSync(row.full, { recursive: true, force: true, maxRetries: 2 }); out.deleted += 1; }
    catch { out.failed += 1; }
  }
  return out;
}

module.exports = { pruneStaleFixtureDirs, FIXTURE_PREFIX, NEVER_TOUCH_PREFIX, DAY_MS };
