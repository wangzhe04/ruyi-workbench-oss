'use strict';
// 源码切片的公共件(架构还债批 3·D)。
//
// 静态锁先问自己:要断言的东西能不能在运行时拿到?server.js 的导出、public/js 的 ES 模块、
// tools/ 的 CommonJS 模块 —— 能拿到就断言它的值或行为,别读源码(见 docs/architecture/source-text-locks.md)。
// 只有「本来就是结构性」的判据(某文件零 setInterval、零 innerHTML、某段代码不许出现某个调用)才读源码;
// 那时用这里的三个切片,不要每件测试各写一条 /const X = \[([\s\S]*?)\n\];/ —— 那种正则一遇到
// 合并常量表、改缩进、在表尾加一行注释就静默切错或切空。
//
//   sliceBlock(src, start, end, { inclusive })  从 start 标记切到其后的 end 标记(字符串或正则);找不到给 ''。
//   constBlock(src, name)                        `const|let|var NAME = …` 整条声明(按括号配对到初值结束)。
//   functionBlock(src, name)                     `[async] function NAME(…) { … }` 整个函数(按括号配对)。
//   bracedBlock(src, start)                      从 start 标记切到其后第一个 `{` 的配对 `}`(循环体、if 块、对象字面量)。
//
// 括号配对跳过字符串、模板字面量(含 ${} 嵌套)、注释与正则字面量,所以表里写着 '}' 或 /\]/ 也不会切歪。
// 三个函数找不到时一律返回 '' —— 调用方应先断言「切到了」(非空、长度下限),免得锁对空串恒绿。

function indexOfMarker(src, marker, from = 0) {
  if (typeof marker === 'string') {
    const at = src.indexOf(marker, from);
    return at < 0 ? null : { index: at, length: marker.length };
  }
  const flags = marker.flags.includes('g') ? marker.flags : marker.flags + 'g';
  const re = new RegExp(marker.source, flags);
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? { index: m.index, length: m[0].length } : null;
}

function sliceBlock(src, start, end, { inclusive = false } = {}) {
  const s = indexOfMarker(src, start);
  if (!s) return '';
  const e = indexOfMarker(src, end, s.index + s.length);
  if (!e) return '';
  return src.slice(s.index, inclusive ? e.index + e.length : e.index);
}

const CLOSE = { '(': ')', '[': ']', '{': '}' };
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

// 从 i 处的一个字面量/注释起点跳到它之后;不是起点就返回 -1。
function skipNonCode(src, i, prevSignificant, before) {
  const c = src[i];
  const n = src[i + 1];
  if (c === '/' && n === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  if (c === '\'' || c === '"') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === c || src[j] === '\n') return j + 1;
    }
    return src.length;
  }
  if (c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') { j = matchFrom(src, j + 1) - 1; }
    }
    return src.length;
  }
  if (c === '/' && (prevSignificant === '' || REGEX_PRECEDERS.has(prevSignificant) || REGEX_KEYWORDS.test(before))) {
    let inClass = false;
    for (let j = i + 1; j < src.length; j++) {
      const d = src[j];
      if (d === '\\') { j++; continue; }
      if (d === '\n') return -1;                 // 不是正则(除号跨行不可能是正则)
      if (d === '[') inClass = true;
      else if (d === ']') inClass = false;
      else if (d === '/' && !inClass) { let k = j + 1; while (/[a-z]/i.test(src[k] || '')) k++; return k; }
    }
    return -1;
  }
  return -1;
}

// open 是开括号的下标;返回与之配对的闭括号之后的下标(配不上返回 -1)。
function matchFrom(src, open) {
  const stack = [CLOSE[src[open]]];
  if (!stack[0]) return -1;
  let prev = src[open];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (/\s/.test(c)) continue;
    const skipped = skipNonCode(src, i, prev, src.slice(Math.max(0, i - 12), i).trimEnd());
    if (skipped >= 0) { if (!isComment(src, i)) prev = 'x'; i = skipped - 1; continue; }
    if (CLOSE[c]) stack.push(CLOSE[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
    prev = c;
  }
  return -1;
}

function isComment(src, i) { return src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*'); }

function escapeName(name) { return String(name).replace(/[$]/g, '\\$'); }

function constBlock(src, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escapeName(name)}[ \\t]*=`).exec(src);
  if (!m) return '';
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let prev = '=';
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const c = src[i];
    if (/\s/.test(c)) continue;
    const skipped = skipNonCode(src, i, prev, src.slice(Math.max(0, i - 12), i).trimEnd());
    if (skipped >= 0) { if (!isComment(src, i)) prev = 'x'; i = skipped - 1; continue; }
    if (c === ';' || c === ',') return src.slice(start, i + 1);
    if (CLOSE[c]) {
      const end = matchFrom(src, i);
      if (end < 0) return '';
      // 初值在配对括号处结束,除非后面紧跟链式调用/运算符(`[…].map(…)`、`{…} || x`)。
      let j = end;
      while (j < src.length && /[ \t\r\n]/.test(src[j])) j++;
      if (src[j] === ';' || src[j] === ',') return src.slice(start, j + 1);
      if (!/[.([?:+\-*/|&]/.test(src[j] || '')) return src.slice(start, end);
      i = end - 1; prev = ')';
      continue;
    }
    prev = c;
  }
  return src.slice(start);
}

function functionBlock(src, name) {
  const m = new RegExp(`(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*${escapeName(name)}[ \\t]*\\(`).exec(src);
  if (!m) return '';
  const paramsEnd = matchFrom(src, m.index + m[0].length - 1);
  if (paramsEnd < 0) return '';
  const open = src.indexOf('{', paramsEnd);
  if (open < 0) return '';
  const end = matchFrom(src, open);
  return end < 0 ? '' : src.slice(m.index, end);
}

function bracedBlock(src, start) {
  const s = indexOfMarker(src, start);
  if (!s) return '';
  const open = src.indexOf('{', s.index + s.length);
  if (open < 0) return '';
  const end = matchFrom(src, open);
  return end < 0 ? '' : src.slice(s.index, end);
}

module.exports = { sliceBlock, constBlock, functionBlock, bracedBlock };
