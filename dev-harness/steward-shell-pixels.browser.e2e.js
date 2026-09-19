#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128d(48 号文 §1;47 号文 G3 缺口②「管家壳没有任何像素基线」):管家壳深浅两主题的像素基线。
//
// 尺子与 dom-screenshot(第 54 波,拍经典壳)同一把 —— lib/png-grid:画面切成格子、每格取均色,按「平均差」
// 与「变了的格子占比」两道判。机器间的字体抗锯齿抖动被格子平均掉;一块面板换了底色、整块没画出来、版面错位
// 这类真回归会让一片格子一起变。本件的格子更细(COLS×ROWS),因为管家壳的回归常常只动一个区域。
//
// 让画面可复现的几件事(每一件都是「不做就会抖」):
//   · 出厂默认档(不写 uiMode = 简易),固定视口 1440×900、DPR 1、隐藏滚动条;
//   · 关掉一切 CSS 动画／过渡／光标闪烁(注入一段样式 ＋ prefers-reduced-motion: reduce);
//   · 相对时间(「刚刚」「3 分钟前」「12:04」……)按文本形状整块藏掉 —— 它们会随跑的时刻变;
//   · 两条固定标题的线程、各一个回合,内容全是夹具写死的。
// 用法:`node steward-shell-pixels.browser.e2e.js --update` 只在【人眼看过两张图】、确认是有意的视觉改动之后用;
// 两张图随基线一起入库(visual-baselines/steward-shell-v1-{dark,light}.png,各约 70 KB)—— 审阅的人看得到「基线长什么样」,
// 改基线的提交里图也跟着变,diff 一眼能看。
// 判定行:`STEWARD SHELL PIXELS BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { signature, compare } = require('./lib/png-grid');

const BASELINE = path.join(__dirname, 'visual-baselines', 'steward-shell-v1.json');
const update = process.argv.includes('--update');
const COLS = 24;
const ROWS = 15;
// 阈值来自实测:加「等画面静止」之前,6 张图里 1 张在焦点卡头变了 2 格(拍到了轮询重画的半途);加了之后连跑 3 次 6 张逐格 0 差。
// 反向(改 CSS → 跑 → 还原核 sha256):左栏 268→220 px 变 7／6 格、焦点卡换底色变 86／105 格、【一枚按钮换色】变 4／5 格 ——
// 上限定在 3 格(0.9%),三种都红,离实测最坏噪声 2 格还留一格。一格 60×60 px:比一枚按钮还小的改动(一个字、一条细线)
// 仍可能漏,那是 DOM 断言的活。
const THRESHOLDS = { cellDelta: 18, meanMax: 2, changedMax: 0.009 };
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const FREEZE = `(() => {
  const style = document.createElement('style');
  style.id = 'kb-pixel-freeze';
  style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';
  document.head.appendChild(style);
  try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
  return true;
})()`;

// 相对时间／钟点按文本形状认,整块 visibility:hidden(保留占位,版面不动)。
const MASK_TIMES = `(() => {
  // 以相对时间／钟点【开头】的短文案都算(「1s 前有动静」「1秒钟前」「3 分钟前」「12:04」「昨天 18:00」)。
  const TIME = /^(刚刚|just now|\\d+\\s*(s|秒钟?|m|min|分钟?|h|小时|d|天|周|个月)\\s*(前|ago)|\\d+\\s*(sec|mins?|hrs?|days?)\\s*ago|\\d{1,2}:\\d{2}|昨天|今天|前天)/i;
  let n = 0;
  for (const node of document.querySelectorAll('body *')) {
    if (node.children.length) continue;
    const text = (node.textContent || '').trim();
    if (text && text.length <= 24 && TIME.test(text)) { node.style.visibility = 'hidden'; n++; }
  }
  return n;
})()`;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-steward-pixels-',
      width: 1440,
      height: 900,
      config: { uiMode: undefined, theme: 'dark' },
      prepare: async f => {
        for (const title of ['整理下载文件夹', '写周报初稿']) {
          const created = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          const sid = created && created.json && created.json.session && created.json.session.id;
          ok(Boolean(sid), `P0 线程「${title}」已建`);
          if (sid) await f.request('POST', '/api/chat/stream', { sessionId: sid, message: '开始吧', cwd: f.work }, 120000);
        }
      },
    });
    await fx.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const version = await fx.cdp.send('Browser.getVersion').catch(() => ({}));
    const browser = String(version.product || '');
    ok(Boolean(await fx.setLens('steward')), 'P0b 管家视角');
    await fx.evaluate(FREEZE);

    const shoot = async theme => {
      for (let i = 0; i < 4; i++) {
        if ((await fx.evaluate(`document.documentElement.getAttribute('data-theme')`)) === theme) break;
        await fx.evaluate(`(() => { document.getElementById('themeToggle').click(); document.getElementById('appGearMenu').hidden = true; return true; })()`);
        await sleep(200);
      }
      await fx.evaluate(`(() => { document.getElementById('appGearMenu').hidden = true; document.getElementById('appGearBtn').setAttribute('aria-expanded', 'false'); return true; })()`);
      await sleep(600);                                  // 字体与异步取数落定
      // 等画面静止:连拍两张、格子签名逐字相同才算数(最多 6 次)。焦点卡会被轮询重画,拍到半途的一帧就是噪声的来源。
      let masked = 0, png = null, prev = '', steady = false;
      for (let i = 0; i < 6 && !steady; i++) {
        masked = await fx.evaluate(MASK_TIMES);
        await sleep(150);
        png = await fx.screenshot();
        const sig = JSON.stringify(signature(png, COLS, ROWS).grid);
        steady = sig === prev;
        prev = sig;
        if (!steady) await sleep(300);
      }
      return { png, masked, steady, theme: await fx.evaluate(`document.documentElement.getAttribute('data-theme')`) };
    };
    const actual = { generatedAt: new Date().toISOString(), browser, viewport: '1440x900', uiMode: 'simple(default)', grid: `${COLS}x${ROWS}`, themes: {} };
    const pngs = {};
    for (const theme of ['dark', 'light']) {
      const shot = await shoot(theme);
      ok(shot.theme === theme && shot.png.length > 10000 && shot.steady, `P1 ${theme} 截到了、画面已静止(${shot.png.length} 字节,藏掉相对时间 ${shot.masked} 处,静止=${shot.steady})`);
      pngs[theme] = shot.png;
      actual.themes[theme] = signature(shot.png, COLS, ROWS);
    }
    const themeDistance = compare(actual.themes.dark, actual.themes.light, THRESHOLDS);
    ok(!themeDistance.ok && themeDistance.mean > 20, `P2 深浅两张确实不同(平均差 ${themeDistance.mean.toFixed(1)})—— 尺子分得出两主题`);

    if (update) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n');
      for (const theme of ['dark', 'light']) fs.writeFileSync(BASELINE.replace(/\.json$/, `-${theme}.png`), pngs[theme]);
      console.log('UPDATED ' + path.relative(process.cwd(), BASELINE) + '(旁边留了两张 PNG 供人眼审阅)');
    } else {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      if (baseline.browser && baseline.browser !== browser) {
        console.log(`NOTE 基线拍自 ${baseline.browser},本机是 ${browser} —— 若只有这一件红,先看是不是浏览器版本造成的渲染差(人眼比对后可 --update)`);
      }
      for (const theme of ['dark', 'light']) {
        const result = compare(actual.themes[theme], baseline.themes[theme], THRESHOLDS);
        const worst = result.changedCells.sort((a, b) => b[2] - a[2]).slice(0, 6).map(([r, c, d]) => `(${r},${c})Δ${d}`).join(' ');
        ok(result.ok, `P3 ${theme} 与基线一致(平均差 ${Number(result.mean).toFixed(2)} ≤ ${THRESHOLDS.meanMax};变了的格子 ${result.changed}/${result.cells} ≤ ${Math.floor(THRESHOLDS.changedMax * result.cells)}${worst ? ';变得最多的格子(行,列) ' + worst : ''})`);
        if (!result.ok && fx) {
          const out = path.join(fx.root, `steward-shell-${theme}-actual.png`);
          fs.writeFileSync(out, pngs[theme]);
          console.log('NOTE 实拍图留在 ' + out);
        }
      }
    }
    ok(fx.exceptions.length === 0, `P4 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'STEWARD SHELL PIXELS BROWSER E2E: ALL PASS' : `STEWARD SHELL PIXELS BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
