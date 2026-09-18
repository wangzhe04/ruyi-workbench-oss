'use strict';
// 107-P1(46 号文 §5):context-governance 规则的【内置副本】必须与 context-governance-rules.json 逐项相同。
//
// 为什么非有这把锁不可:10-context-governance.js 头注说得明白 —— 发布产物是单文件,离线更新/临时部署
// 不一定带 src/,所以留了一份「与版本化 JSON 同构」的内置副本当 fallback。可「同构」一直只写在注释里:
// 打包演练时 pkg 报「context-governance-rules.json 是动态路径、不会打进 Ruyi.exe」,一比才发现
//   ① fallback 的 summary.prompt 自 c7d2507(9/2)起把 promptGuidance 那句用【半角】标点烤进了正文,
//     而 JSON 把它拆成了全角标点的独立字段 —— summaryPromptWithGuidance 的 includes 去重对不上,
//     中文摘要提示词里那句话出现【两遍】;
//   ② 126-111d 加的 summary.promptEn 根本没进 fallback —— 英文界面在 Ruyi.exe 下拿到的仍是中文提示词,
//     而 2.8.0 恰好把 111d 翻成了默认开。
// 走启动器(node + app/server.js,旁边有 src/)的主路径读的是 JSON,不受影响;受影响的是单文件 Ruyi.exe。
//
// 判据分四组:
//   [A] owner:两处都真的找到了那段 IIFE(改名/挪位时这里先红,而不是后面几条静默比了个空)。
//   [B] 源码里的 fallback(existsSync 恒假)与 JSON 深相等。
//   [C] 构建产物 server.js 里的 fallback 同样深相等(打进 exe 的是产物,不是源码)。
//   [D] 行为:把产物单独拷进一个旁边没有 src/ 的目录 require —— 这正是 exe 的处境 ——
//       中文提示词里 guidance 恰出现一次;en-us＋111d 开时拿到的就是 JSON 的 promptEn。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const rules = JSON.parse(fs.readFileSync(path.join(app, 'src', 'context-governance-rules.json'), 'utf8'));
const ANCHOR = 'const CONTEXT_GOVERNANCE_RULES = (() => {';

function fallbackFrom(file) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(ANCHOR);
  const again = start >= 0 ? text.indexOf(ANCHOR, start + 1) : -1;
  const end = start >= 0 ? text.indexOf('})();', start) : -1;
  if (start < 0 || again >= 0 || end < 0) return { found: false, start, again, end };
  const body = text.slice(start, end + '})();'.length).replace('const CONTEXT_GOVERNANCE_RULES =', 'return');
  // existsSync 恒假 = 旁边没有 src/ 的单文件部署;require 不该被走到,走到就当场炸。
  const value = new Function('fs', 'path', '__dirname', 'require', body)(
    { existsSync: () => false }, path, '/nonexistent', () => { throw new Error('fallback path must not require the JSON'); });
  return { found: true, value };
}

const fromSrc = fallbackFrom(path.join(app, 'src', '10-context-governance.js'));
const fromBuilt = fallbackFrom(path.join(app, 'server.js'));

test('[A] 源码与产物里都恰好找到一段内置规则 IIFE', () => {
  assert.equal(fromSrc.found, true, `src 里没找到或找到多段:${JSON.stringify(fromSrc)}`);
  assert.equal(fromBuilt.found, true, `server.js 里没找到或找到多段:${JSON.stringify(fromBuilt)}`);
});

test('[B] 源码里的 fallback 与 context-governance-rules.json 深相等', () => {
  assert.deepStrictEqual(fromSrc.value, rules);
});

test('[C] 产物 server.js 里的 fallback 与 JSON 深相等(打进 Ruyi.exe 的是它)', () => {
  assert.deepStrictEqual(fromBuilt.value, rules);
});

test('[D] 旁边没有 src/ 时(= Ruyi.exe 的处境)摘要提示词的实际行为与 JSON 一致', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cg-fallback-'));
  const lone = path.join(root, 'app');
  fs.mkdirSync(lone);
  fs.copyFileSync(path.join(app, 'server.js'), path.join(lone, 'server.js'));
  process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'home');
  assert.equal(fs.existsSync(path.join(lone, 'src', 'context-governance-rules.json')), false, '前提:拷贝旁边确实没有 src/');
  const srv = require(path.join(lone, 'server.js'));
  const guidance = rules.summary.callPolicy.promptGuidance;
  assert.ok(typeof guidance === 'string' && guidance.length > 10, '前提:JSON 里有 promptGuidance');
  const zh = srv.summaryPromptWithGuidance({ locale: 'zh-CN', runtimeSummaryPromptI18nV1: true });
  assert.equal(zh, rules.summary.prompt + '\n' + guidance, '中文 = JSON 的 prompt + 一次 guidance');
  assert.equal(zh.split('map 每节尽量短').length - 1, 1, 'guidance 那句只出现一次(修前半角一遍、全角一遍)');
  const en = srv.summaryPromptWithGuidance({ locale: 'en-US', runtimeSummaryPromptI18nV1: true });
  assert.equal(en, rules.summary.promptEn, '英文界面 + 111d 开 = JSON 的 promptEn(修前 fallback 没有它,回落成中文)');
});
