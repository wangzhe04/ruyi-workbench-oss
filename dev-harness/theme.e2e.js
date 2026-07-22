// E2E for v1.0-S1「青花主题重铸」: 纯静态校验如意 Ruyi 青花瓷设计令牌迁移。零依赖、离线、node 直跑。
//
// 只读解析 app/public/styles.css 与 index.html —— 不起服务、不触网。断言:
//   (a) 令牌键集一致:两 [data-theme] 块定义的设计令牌键集合完全一致(含五个新令牌
//       --panel-2/--accent-hover/--link/--gold/--gold-soft);--eng-* 为引擎身份色,允许 light 覆盖,
//       从对比中排除(记录但不参与集合等值)。
//   (b) 旧赤陶橙隔离:#d97757 与 #c96442(大小写不敏感)在 styles.css 中只允许出现在含 --eng-claude 的行。
//   (c) 对比度红线(WCAG 相对亮度):两主题各自 ink/bg>=7、muted/panel>=4.5、accent-ink/accent>=4.5、
//       link/bg>=4.5。实现标准 WCAG 2.x 相对亮度 + 对比度公式。
//   (d) 空状态:index.html 不含 `empty-logo">C<` 残留,且 .empty-logo 内含内联 <svg>。
//
// 末行判定固定为 `THEME E2E: ALL PASS`(任何失败打印明细并以非零码退出)。
'use strict';
const fs = require('fs');
const path = require('path');
const { readFrontendSrc } = require('./read-frontend-src.js'); // v1.3-FE1:app.js 拆模块后聚合读 public/app.js+public/js/**

const PUB = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
const CSS_PATH = path.join(PUB, 'styles.css');
const HTML_PATH = path.join(PUB, 'index.html');

// ── WCAG 相对亮度 + 对比度 ──────────────────────────────────────────────────────────────────────
function chan(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function hexRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relLum(hex) { const [r, g, b] = hexRgb(hex); return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b); }
function contrast(a, b) { const la = relLum(a), lb = relLum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }

// ── 解析一个选择器块内的 --token: value 声明 ─────────────────────────────────────────────────────
// 返回 { key -> value } 映射。value 去掉行尾注释与分号。
function parseTokenBlock(css, selector) {
  const idx = css.indexOf(selector);
  if (idx < 0) return null;
  const open = css.indexOf('{', idx);
  if (open < 0) return null;
  // 找到匹配的右花括号(这些块内不含嵌套 {},简单扫描即可)。
  const close = css.indexOf('}', open);
  if (close < 0) return null;
  const body = css.slice(open + 1, close);
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(body))) { out[m[1].toLowerCase()] = m[2].trim(); }
  return out;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const appjs = readFrontendSrc(); // 聚合:public/app.js + public/js/**/*.js(拆分后函数不再只在 app.js)

  // ══════════ (a) 两主题令牌键集一致 ══════════
  const dark = parseTokenBlock(css, ':root[data-theme="dark"]');
  const light = parseTokenBlock(css, ':root[data-theme="light"]');
  ok(dark && Object.keys(dark).length > 0, '(a) 解析到 dark 主题令牌块');
  ok(light && Object.keys(light).length > 0, '(a) 解析到 light 主题令牌块');

  if (dark && light) {
    // 引擎身份色 --eng-* 允许 light 覆盖 → 从键集等值中排除(它们不是主题设计令牌)。
    const isEng = k => k.startsWith('--eng-');
    const dKeys = new Set(Object.keys(dark).filter(k => !isEng(k)));
    const lKeys = new Set(Object.keys(light).filter(k => !isEng(k)));
    const onlyDark = [...dKeys].filter(k => !lKeys.has(k));
    const onlyLight = [...lKeys].filter(k => !dKeys.has(k));
    ok(onlyDark.length === 0, '(a) dark 无 light 缺失的令牌' + (onlyDark.length ? ' → 多出: ' + onlyDark.join(',') : ''));
    ok(onlyLight.length === 0, '(a) light 无 dark 缺失的令牌' + (onlyLight.length ? ' → 多出: ' + onlyLight.join(',') : ''));

    // 五个新令牌必须两主题都定义(第50波清障:--gold-soft 零引用删除,移出必查清单;键集对称断言仍兜底)。
    const NEW5 = ['--panel-2', '--accent-hover', '--link', '--gold'];
    for (const t of NEW5) {
      ok(t in dark && t in light, '(a) 新令牌 ' + t + ' 两主题均定义');
    }
    // 第50波(UI-DESIGN-V4):玻璃/场景令牌族必须两主题对称定义(键集断言之上的点名锁)。
    const GLASS = ['--scene-bg', '--glass-bg-1', '--glass-bg-2', '--glass-bg-3', '--glass-border',
      '--glass-border-strong', '--glass-highlight', '--glass-shadow', '--glass-shadow-soft', '--accent-2', '--noise'];
    for (const t of GLASS) {
      ok(t in dark && t in light, '(a) 玻璃令牌 ' + t + ' 两主题均定义(UI-DESIGN-V4)');
    }
  }

  // ══════════ (b) 旧赤陶橙只能出现在 --eng-claude 行 ══════════
  const OLD = ['#d97757', '#c96442'];
  const lines = css.split(/\r?\n/);
  for (const hexBad of OLD) {
    const offenders = [];
    lines.forEach((ln, i) => {
      if (ln.toLowerCase().includes(hexBad)) {
        if (!ln.includes('--eng-claude')) offenders.push(i + 1);
      }
    });
    ok(offenders.length === 0, '(b) ' + hexBad + ' 仅现于 --eng-claude 行' + (offenders.length ? ' → 违规行: ' + offenders.join(',') : ''));
  }

  // ══════════ (c) 对比度红线(WCAG),两主题各自达标 ══════════
  const CHECKS = [
    { name: 'ink/bg', a: '--ink', b: '--bg', min: 7 },
    { name: 'muted/panel', a: '--muted', b: '--panel', min: 4.5 },
    { name: 'accent-ink/accent', a: '--accent-ink', b: '--accent', min: 4.5 },
    { name: 'link/bg', a: '--link', b: '--bg', min: 4.5 },
  ];
  for (const [tname, tokens] of [['dark', dark], ['light', light]]) {
    if (!tokens) continue;
    for (const c of CHECKS) {
      const av = tokens[c.a], bv = tokens[c.b];
      if (!av || !bv || !/^#[0-9a-f]{3,8}$/i.test(av) || !/^#[0-9a-f]{3,8}$/i.test(bv)) {
        ok(false, '(c) ' + tname + ' ' + c.name + ' 令牌缺失或非 hex (' + c.a + '=' + av + ', ' + c.b + '=' + bv + ')');
        continue;
      }
      const r = contrast(av, bv);
      ok(r >= c.min, '(c) ' + tname + ' ' + c.name + ' = ' + r.toFixed(2) + ' (need >=' + c.min + ')');
    }
  }

  // ══════════ (d) 空状态残留 + 内联 svg ══════════
  ok(!/empty-logo">C</.test(html), '(d) index.html 无 empty-logo">C< 残留');
  // v1.0-S3 收官补:app.js 动态重建空状态也不得回退到字母 "C"(须走 buildRuyiLogo 的如意标)。
  ok(!/'empty-logo',\s*'C'/.test(appjs), "(d) app.js 无 el('empty-logo','C') 字母兜底残留");
  ok(/function buildRuyiLogo\(/.test(appjs), '(d) app.js 定义 buildRuyiLogo(JS 侧如意标)');
  // .empty-logo 容器内含内联 <svg>(取 class="empty-logo" 起到其闭合 </div> 的片段做检查)。
  const emIdx = html.indexOf('class="empty-logo"');
  ok(emIdx >= 0, '(d) index.html 存在 .empty-logo 容器');
  if (emIdx >= 0) {
    const tail = html.slice(emIdx, emIdx + 800);
    ok(/<svg[\s>]/.test(tail), '(d) .empty-logo 内含内联 <svg>');
    ok(/var\(--brand-qh\)/.test(tail) && /var\(--brand-au\)/.test(tail), '(d) 内联 svg 走 --brand-qh/--brand-au 填色');
  }

  console.log('\nTHEME E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
