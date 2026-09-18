'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// Wave 54 visual-regression gate v2: deterministic light/dark screenshots with a tolerant pixel-grid
// baseline. Zero npm dependencies: Edge/Chrome captures PNG; this file decodes 8-bit RGB/RGBA PNG with
// Node's zlib and compares a 12x8 perceptual grid. Use --update only when an intentional visual change has
// been reviewed in both themes.

const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const BASELINE = path.join(__dirname, 'visual-baselines', 'workbench-shell-v2.json');
const update = process.argv.includes('--update');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const { findBrowserExecutable } = require('./lib/browser-path');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');
const browserPath = findBrowserExecutable;
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
// 125 治抖（40 号文 §8.4 ⓪）：这一发【为什么】没成,修前一个字都不说 —— `ok(status===0 && 存在 && >10000)`
// 把「浏览器没起来」「90 s 超时」「文件没落地」「文件太小」四种结局压成同一行 FAIL,于是它每次上榜
// 都只留下「dark screenshot captured」这一句。本轮全量里它首跑红的正是这一条(靠新的 flaky 首跑
// 诊断才看见),再不分开就永远定不了机制。
function captureOnce(browser, url, output, profile) {
  const edgeCompat = /msedge\.exe$/i.test(browser) ? ['--edge-skip-compat-layer-relaunch'] : [];
  return cp.spawnSync(browser, [
    ...edgeCompat,
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--force-device-scale-factor=1',
    '--window-size=1440,1000', '--virtual-time-budget=10000',
    '--user-data-dir=' + profile, '--screenshot=' + output, url,
  ], { encoding: 'utf8', timeout: 90000, windowsHide: true });
}
// 一发的结局分成四类,并把证据带出来(stderr 只取末 200 字:Edge 的启动噪声很长,但真正的原因在末尾)。
function captureVerdict(result, output) {
  if (!result) return { ok: false, why: 'spawn 没有返回结果' };
  if (result.error) return { ok: false, why: `进程起不来:${result.error.code || result.error.message}` };
  if (result.signal) return { ok: false, why: `被信号打断:${result.signal}(多半是 90 s 超时)` };
  if (result.status !== 0) {
    const tail = String(result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(-200);
    return { ok: false, why: `退出码 ${result.status}${tail ? '；stderr 末尾:' + tail : '；stderr 为空'}` };
  }
  if (!fs.existsSync(output)) return { ok: false, why: '退出码 0 但 PNG 没落地(Edge 静默失败,通常是并发下的 profile 抢占)' };
  const size = fs.statSync(output).size;
  if (size <= 10000) return { ok: false, why: `PNG 只有 ${size} 字节(判为没画完)` };
  return { ok: true, why: `${size} 字节` };
}
// 抓不到就换一个全新 profile 再来一发。**这不是「失败了就重试」那种掩盖**:上面四类结局里,
// 只有「起不来／没落地／太小」这三种是启动期的环境抢占,重试一次能把它与「产品真的画错了」分开 ——
// 后者(PNG 拿到了、但像素比对不过)在下面是另一条断言,一次都不重试。
function capture(browser, url, output, profile) {
  const first = captureOnce(browser, url, output, profile);
  const verdict = captureVerdict(first, output);
  if (verdict.ok) return { verdict, attempts: 1 };
  try { fs.rmSync(output, { force: true }); } catch { /* 没落地就没得删 */ }
  const retryProfile = profile + '-retry';
  const second = captureOnce(browser, url, output, retryProfile);
  const retryVerdict = captureVerdict(second, output);
  return { verdict: retryVerdict, attempts: 2, firstWhy: verdict.why };
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}
function decodePng(file) {
  const png = fs.readFileSync(file);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`unsupported PNG ${bitDepth}/${colorType}/${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let source = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[source++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[source++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] || 0;
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      row[x] = filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + Math.floor((left + up) / 2)
              : value + paeth(left, up, upperLeft);
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels, dst = (y * width + x) * 4;
      pixels[dst] = row[src]; pixels[dst + 1] = row[src + 1]; pixels[dst + 2] = row[src + 2];
      pixels[dst + 3] = channels === 4 ? row[src + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}
function signature(file) {
  const image = decodePng(file);
  const cols = 12, rows = 8, grid = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * image.width / cols), x1 = Math.floor((gx + 1) * image.width / cols);
      const y0 = Math.floor(gy * image.height / rows), y1 = Math.floor((gy + 1) * image.height / rows);
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * image.width + x) * 4;
        r += image.pixels[i]; g += image.pixels[i + 1]; b += image.pixels[i + 2]; count += 1;
      }
      grid.push(Math.round(r / count), Math.round(g / count), Math.round(b / count));
    }
  }
  return { width: image.width, height: image.height, cols, rows, grid };
}
function compare(actual, expected) {
  if (!actual || !expected || actual.width !== expected.width || actual.height !== expected.height || actual.grid.length !== expected.grid.length) {
    return { ok: false, mean: Infinity, changed: Infinity };
  }
  let total = 0, changed = 0;
  for (let i = 0; i < actual.grid.length; i += 3) {
    const delta = (Math.abs(actual.grid[i] - expected.grid[i])
      + Math.abs(actual.grid[i + 1] - expected.grid[i + 1])
      + Math.abs(actual.grid[i + 2] - expected.grid[i + 2])) / 3;
    total += delta;
    if (delta > 18) changed += 1;
  }
  const cells = actual.grid.length / 3;
  return { ok: total / cells <= 8 && changed / cells <= 0.12, mean: total / cells, changed, cells };
}

(async () => {
  const port = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-visual-v2-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  // 121 波 K0（34 号文 §8.4）：stewardEnabledV1 默认翻成 true、首开默认落管家视角。本件的像素基线
  // 拍的是【经典壳】，管家开着会把整屏换成管家壳（实测 dark/light 两张 mean 11.26/8.52、96 格里
  // 变了 14/12 格）。显式关掉管家 = 本件继续拍它一直在拍的那一屏，基线不动。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass', theme: 'dark', stewardEnabledV1: false }));
  const server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true,
  });
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { await sleep(120); ready = await health(port); }
    ok(ready, 'visual v2 workbench started');
    const browser = browserPath();
    ok(Boolean(browser), 'visual v2 found Edge/Chrome');
    if (!ready || !browser) throw new Error('visual prerequisites unavailable');
    const actual = { generatedAt: new Date().toISOString(), viewport: '1440x1000', themes: {} };
    for (const theme of ['dark', 'light']) {
      const output = path.join(root, theme + '.png');
      const shot = capture(browser, `http://127.0.0.1:${port}/?theme=${theme}`, output, path.join(root, 'profile-' + theme));
      ok(shot.verdict.ok, `${theme} screenshot captured（${shot.verdict.why}${shot.attempts > 1 ? `；首发没成:${shot.firstWhy}，换新 profile 重来一发` : ''}）`);
      if (!shot.verdict.ok) throw new Error(`${theme} 截图两发都没成:${shot.firstWhy || ''} / ${shot.verdict.why}`);
      actual.themes[theme] = signature(output);
      actual.themes[theme].sha256 = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    }
    const themeDistance = compare(actual.themes.dark, actual.themes.light);
    ok(!themeDistance.ok && themeDistance.mean > 20, `light/dark are materially distinct (mean delta ${themeDistance.mean.toFixed(1)})`);
    if (update) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n');
      console.log('UPDATED ' + path.relative(process.cwd(), BASELINE));
    } else {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      for (const theme of ['dark', 'light']) {
        const result = compare(actual.themes[theme], baseline.themes[theme]);
        ok(result.ok, `${theme} pixel-grid matches baseline (mean ${result.mean.toFixed(2)}, changed ${result.changed}/${result.cells})`);
      }
    }
  } catch (error) {
    console.log('ERROR ' + (error && error.stack || error)); fail += 1;
  } finally {
    if (server.pid) {
      try { killOwnTree(server); } catch { /* ignore */ }
    }
    // 125 治抖（40 号文 §8.4 ⓪）：**本件是全仓唯一不收尸的浏览器夹具** —— 117q 那次普查把 10 件漏调
    // stopRuyiTestBrowsers 的补齐了，唯独它因为走 spawnSync（同步、以为「回来了就没了」）被漏掉。
    // 而 Chromium 的 renderer/GPU/crashpad 是会活过父进程的：它一趟开两个 profile（dark/light，失败
    // 重来还多一个），攒下的断头 Edge 正是「冷启动 4s → 86s」那条记忆里的病因，也解释了本件的症状
    // 恰恰是「截图这一步没成」。两件事在这儿对上了，所以补收尸不是顺手，是对因下药。
    for (const theme of ['dark', 'light']) {
      try { stopRuyiTestBrowsers(path.join(root, 'profile-' + theme)); } catch { /* best effort */ }
      try { stopRuyiTestBrowsers(path.join(root, 'profile-' + theme + '-retry')); } catch { /* best effort */ }
    }
    await sleep(250);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock; harmless */ }
    console.log('\nDOM-SCREENSHOT E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
