'use strict';
// 107-F5（46 号文 §5 ⓪）：扫「墙钟量出来的时长 ≤ 写死的上界」这一形状的断言。给 fixture-home.static 那把
// 「写死墙钟窗口的件要么进独占桶、要么就地写明豁免理由」的锁用（42 号文 §5-undecies 留给 107 的第二件）。
//
// 形状（三条同时满足才算一处）：
//   ① 在 ok(…)／assert(…)／assert.ok(…) 的【第一个实参】（条件）里有一个上界比较：量 < 界、量 <= 界
//      （或镜像的 界 > 量、界 >= 量）。下界（≥）不算 —— 负载只会把耗时拉长，拉长拖不红「等够了」。
//   ② 「量」是墙钟时长：要么就地写着 Date.now()／performance.now()／process.hrtime／Date.parse( 参与的减法，
//      要么是本文件里由这种减法赋值出来的名字（`elapsed = Date.now() - t0`、`ms: Date.now() - startedAt`、
//      `function latencyMs(f) { return f.at - … }` 里 at 是 `at: Date.now()` 打的戳），并沿赋值往下传
//      （`startupMax = Math.max(...startupMs)`）。
//   ③ 「界」是写死的：里面不再出现任何量出来的时长或时间戳（字面量、全大写常量、它们的算式）。两边都是量
//      出来的（`甲耗时 < 乙耗时`、`a.at < b.at`）是相对／次序判据，不是窗口，不算。
// 注释、字符串、模板串、正则字面量先抹成空白再扫（位置与换行保留），所以源码正则里写着 `Date\.now\(\) -`
// 的静态断言、标签文案里的「< 5000ms」都不会被误认。
//
// 已知扫不到的（登记，不假装覆盖）：在浏览器里算好再经 CDP 字符串带回来的时长（ec-d-performance 的
// interactiveMs —— 那件已由「自己算 percentile」那条锁钉进独占桶）；自己算百分位的（同一条锁）；
// 「sleep 固定毫秒之后假设某事已发生」这类窗口（thread-arbiter ⑩ 那种）—— 没有零误报的机械形状，逐件治。

const CLOCK_SRC = /\bDate\.now\s*\(\s*\)|\bperformance\.now\s*\(\s*\)|\bprocess\.hrtime\b|\bDate\.parse\s*\(/;

// 抹注释、字符串／模板串／正则字面量的内容（定界符与换行保留，偏移不变）。
function blankJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return k;
    return -1;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += c; i++; continue;
    }
    if (c === '/') {
      const k = lastSignificant();
      const prev = k >= 0 ? out[k] : '';
      const word = (out.slice(0, k + 1).match(/[A-Za-z_$]+$/) || [''])[0];
      const regexContext = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|in|of|delete|void|throw|new)$/.test(word);
      if (regexContext) {
        out += '/'; i++;
        let inClass = false;
        while (i < n) {
          const r = src[i];
          if (r === '\\') { out += '  '; i += 2; continue; }
          if (r === '\n') break;
          if (inClass) { if (r === ']') inClass = false; out += ' '; i++; continue; }
          if (r === '[') { inClass = true; out += ' '; i++; continue; }
          if (r === '/') break;
          out += ' '; i++;
        }
        out += '/'; i++;
        while (i < n && /[a-z]/.test(src[i])) { out += ' '; i++; }
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

// code[open] 是开括号：取到配对闭括号为止的内部文本（code 已抹过，括号不会藏在字面量里）。
function bracketBody(code, open) {
  let i = open + 1, depth = 1;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return code.slice(open + 1, i - 1);
}
function firstArgument(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}
// 一条赋值的右侧：到同层的 ; , 换行，或把它包住的那层括号为止。
function rhsFrom(code, from) {
  let i = from, depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) break;
    i++;
  }
  return code.slice(from, i);
}
const escapeName = name => name.replace(/\$/g, '\\$');
const mentions = (text, name) => new RegExp('(?:^|[^\\w$])' + escapeName(name) + '(?![\\w$])').test(text);
const hasSubtraction = text => /[\w$)\]]\s*-\s*[\w$(]/.test(text.replace(/=>/g, '  '));

function clockNames(code) {
  const defs = [];
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|:(?!:))\s*/g)) {
    defs.push({ name: m[1], rhs: rhsFrom(code, m.index + m[0].length) });
  }
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = code.indexOf('{', m.index);
    if (open > 0) defs.push({ name: m[1], rhs: bracketBody(code, open) });
  }
  // 时间戳：直接由时钟源赋值、本身不含减法（`t0 = Date.now()`、`at: Date.now()`）。
  const stamps = new Set(defs.filter(d => CLOCK_SRC.test(d.rhs) && !hasSubtraction(d.rhs)).map(d => d.name));
  // 时长：含减法，且减法里有时钟源或时间戳。
  const durations = new Set();
  for (const d of defs) {
    if (!hasSubtraction(d.rhs)) continue;
    if (CLOCK_SRC.test(d.rhs) || [...stamps].some(s => mentions(d.rhs, s))) durations.add(d.name);
  }
  // 沿赋值往下传（Math.max(...xs)、xs.map(r => r.ms) 之类）；全大写常量不是量出来的，不传。
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const d of defs) {
      if (durations.has(d.name) || stamps.has(d.name) || /^[A-Z0-9_]+$/.test(d.name)) continue;
      if ([...durations].some(x => mentions(d.rhs, x))) { durations.add(d.name); grew = true; }
    }
    if (!grew) break;
  }
  return { stamps, durations };
}

function comparisonsIn(cond) {
  const out = [];
  const re = /(<=|>=|<|>)/g;
  let m;
  while ((m = re.exec(cond))) {
    const at = m.index, op = m[1];
    const before = cond[at - 1], after = cond[at + op.length];
    if (before === '=' || before === '<' || before === '>' || after === '<' || after === '>' || (op.length === 1 && after === '=')) continue;
    let i = at - 1, depth = 0;
    while (i >= 0) {
      const c = cond[i];
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ',' || c === '?' || c === ':' || c === '!' || c === '=' || (c === '&' && cond[i - 1] === '&') || (c === '|' && cond[i - 1] === '|'))) break;
      i--;
    }
    let j = at + op.length; depth = 0;
    while (j < cond.length) {
      const c = cond[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ',' || c === '?' || c === ':' || (c === '&' && cond[j + 1] === '&') || (c === '|' && cond[j + 1] === '|'))) break;
      j++;
    }
    out.push({ op, left: cond.slice(i + 1, at).trim(), right: cond.slice(at + op.length, j).trim() });
  }
  return out;
}

// 返回 [{ line, expr }]：line 是断言调用所在行（1 起）。
function scanWallclockWindows(src) {
  const code = blankJs(src);
  const { stamps, durations } = clockNames(code);
  const isDuration = expr => {
    if (CLOCK_SRC.test(expr) && hasSubtraction(expr)) return true;
    return [...durations].some(x => mentions(expr, x) || new RegExp('\\.' + escapeName(x) + '(?![\\w$])').test(expr));
  };
  const isMeasured = expr => isDuration(expr) || CLOCK_SRC.test(expr) || [...stamps].some(s => mentions(expr, s) || new RegExp('\\.' + escapeName(s) + '(?![\\w$])').test(expr));
  const hits = [];
  const call = /(?:^|[^\w$.])(?:ok|assert|assert\.ok)\s*\(/g;
  let m;
  while ((m = call.exec(code))) {
    const open = m.index + m[0].length - 1;
    const cond = firstArgument(bracketBody(code, open));
    for (const c of comparisonsIn(cond)) {
      const upper = c.op === '<' || c.op === '<=';
      const measured = upper ? c.left : c.right;
      const bound = upper ? c.right : c.left;
      if (!measured || !bound || !isDuration(measured) || isMeasured(bound)) continue;
      if (!/\d|[A-Z][A-Z0-9_]{2,}/.test(bound)) continue;
      hits.push({ line: src.slice(0, open).split('\n').length, expr: `${measured} ${c.op} ${bound}`.replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

module.exports = { blankJs, scanWallclockWindows };
