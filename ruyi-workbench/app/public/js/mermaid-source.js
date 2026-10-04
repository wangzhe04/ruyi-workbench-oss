'use strict';
// 109c(2026-10-04 五路走查):mermaid 源码的两道预处理 —— 纯函数,不碰 DOM,Node 里可直接 import 测。
//
//   prepareMermaidSource(src)  每次渲染前都跑。只改 mermaid 会【静默画错】的写法(解析能过、画出来不对):
//                              <Generic> 被 HTML 消毒整段吞掉、甘特「3天」画成空条、全角冒号被当成正文、
//                              时间线里一长串中文不换行压到邻列、甘特区段名比左边距宽压到任务条上。
//                              这些写法今天画出来本来就是错的,改写不会把一张原本画对的图改坏。
//   repairMermaidSource(src)   仅在第一次渲染【抛错】之后跑一次,返回 { source, labels } 或 null。
//                              每条规则只认今天必然解析失败的写法(未加引号的括号/斜杠/竖线标签、行尾 %% 注释、
//                              未加引号的中文 xychart/饼图/象限/树图/雷达/分支名、中文日期 ……),
//                              所以同样不会改动任何一张原本就能画出来的图。
//
// 两道都不改 <pre> 里的原文:「复制」「源码」与缓存哈希仍是模型写的那一份。
// 走查实测(196 段模型风格源码):回落成源码 48 → 11,原本能画的 148 段零回归。

// ── 识别图类型 ─────────────────────────────────────────────────────────────────────
const TYPE_ALIASES = Object.freeze({
  flowchart: 'flowchart', graph: 'flowchart', 'flowchart-elk': 'flowchart',
  sequenceDiagram: 'sequence', classDiagram: 'class', 'classDiagram-v2': 'class',
  stateDiagram: 'state', 'stateDiagram-v2': 'state', erDiagram: 'er',
  gantt: 'gantt', pie: 'pie', mindmap: 'mindmap', timeline: 'timeline', journey: 'journey',
  gitGraph: 'gitGraph', quadrantChart: 'quadrant', xychart: 'xychart', 'xychart-beta': 'xychart',
  sankey: 'sankey', 'sankey-beta': 'sankey', 'radar-beta': 'radar', treemap: 'treemap', 'treemap-beta': 'treemap',
});

// 正文从哪一行开始:跳过开头空行与 --- frontmatter ---。
function bodyStart(lines) {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && /^\s*---\s*$/.test(lines[i])) {
    i += 1;
    while (i < lines.length && !/^\s*---\s*$/.test(lines[i])) i += 1;
    i += 1;
  }
  return Math.min(i, lines.length);
}

// 第一条有内容、不是 %% 注释/指令的行的首词,归一成上表的类型名;认不出给 ''。
export function mermaidDiagramType(src) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  for (let i = bodyStart(lines); i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%')) continue;
    const word = (/^([A-Za-z][\w-]*)/.exec(line) || [])[1] || '';
    return TYPE_ALIASES[word] || '';
  }
  return '';
}

// 逐行改写正文;%% 注释/指令行与 frontmatter 原样保留。
function mapBody(src, fn) {
  const lines = String(src).split('\n');
  const start = bodyStart(lines);
  return lines.map((line, i) => (i < start || line.trim().startsWith('%%') ? line : fn(line, i))).join('\n');
}

const isWide = ch => ch.codePointAt(0) >= 0x2e80;

// ── 第一道:prepareMermaidSource(每次都跑)─────────────────────────────────────────

// <List<String>> 这类尖括号:mermaid 的 HTML 消毒把它当未知标签整段删掉(「List<String>」画成「List」)。
// 改成 #lt;…#gt; 实体;<br>/<b> 等真 HTML 与 <<interface>> 这类构造型原样保留。
const HTML_TAGS = new Set('br hr b i u s em strong small sub sup code span p div a img font mark del ins kbd ul ol li pre center h1 h2 h3 h4 h5 h6 table thead tbody tr td th blockquote'.split(' '));
function escapeAngles(line) {
  const masks = [];
  let s = line.replace(/<<[A-Za-z]+>>/g, m => { masks.push(m); return `\u0001${masks.length - 1}\u0001`; });
  // 内容里不许有 < > - = " ( ):吞不进箭头(<-- / <|--)与带属性的 HTML。
  const RE = /<([A-Za-z][\p{L}\p{N}_\s,.?&|:*[\]#;]*)>/gu;
  for (let round = 0; round < 4; round += 1) {
    const next = s.replace(RE, (m, inner) => {
      const name = /^[A-Za-z][A-Za-z0-9]*/.exec(inner)[0];
      const after = inner.slice(name.length);
      return HTML_TAGS.has(name.toLowerCase()) && (after === '' || /^[\s/]/.test(after)) ? m : `#lt;${inner}#gt;`;
    });
    if (next === s) break;
    s = next;
  }
  return s.replace(/\u0001(\d+)\u0001/g, (m, i) => masks[Number(i)]);
}

// 甘特任务里的中文时长:「3天」「2周」解析能过,画出来是一条空带。
const GANTT_KEYWORDS = /^\s*(title|section|dateFormat|axisFormat|excludes|includes|todayMarker|tickInterval|weekday|weekend|accTitle|accDescr|displayMode)\b/;
const CJK_UNITS = Object.freeze({ 天: 'd', 日: 'd', 周: 'w', 星期: 'w', 个月: 'M', 月: 'M', 小时: 'h', 年: 'y' });
function ganttDurations(line) {
  const m = /^(\s*[^:\n]+?\s*:)(.*)$/.exec(line);
  if (!m || GANTT_KEYWORDS.test(line)) return line;
  return m[1] + m[2].replace(/(^|,)\s*(\d+(?:\.\d+)?)\s*(天|日|星期|周|个月|月|小时|年)\s*(?=,|$)/g,
    (x, pre, num, unit) => `${pre} ${num}${CJK_UNITS[unit]}`);
}

// 甘特区段名画在左边距里(默认 75px),中文 6 个字以上就压到任务条上。按字宽估一个够用的左边距。
const GANTT_DEFAULT_LEFT_PADDING = 75;
function ganttLeftPadding(src) {
  if (/leftPadding/.test(src)) return 0;   // 作者自己给了就不动
  let widest = 0;
  for (const line of String(src).split('\n')) {
    const m = /^\s*section\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(/<br\s*\/?>/i)) {
      let width = 0;
      for (const ch of part) width += isWide(ch) ? 11 : 6.2;
      widest = Math.max(widest, width);
    }
  }
  const needed = Math.ceil(10 + widest + 10);
  return needed > GANTT_DEFAULT_LEFT_PADDING ? Math.min(240, needed) : 0;
}

// 在 frontmatter 之后插一条 %%{init}%% 指令(mermaid 会把多条指令合并)。
function withInitDirective(src, config) {
  const lines = String(src).split('\n');
  const at = bodyStart(lines);
  lines.splice(at, 0, `%%{init: ${JSON.stringify(config)}}%%`);
  return lines.join('\n');
}

// 时间线只在空白处换行:一长串不带空格的中文画成一行、压到邻列。每 8 个字插一个 <br>。
function wrapCjkRuns(text, perLine = 8) {
  return text.split(/(<br\s*\/?>|\s+)/i).map(piece => {
    if (!piece || /^(<br\s*\/?>|\s+)$/i.test(piece)) return piece;
    let units = 0;
    for (const ch of piece) units += isWide(ch) ? 1 : 0.5;
    if (units <= perLine + 2) return piece;
    let out = '';
    let run = 0;
    for (const ch of piece) {
      const w = isWide(ch) ? 1 : 0.5;
      if (run + w > perLine) { out += '<br>'; run = 0; }
      out += ch;
      run += w;
    }
    return out;
  }).join('');
}
function timelineLine(line) {
  if (/^\s*(title|section|accTitle|accDescr)\b/.test(line) || /^\s*timeline\b/.test(line)) return line;
  // 全角冒号当分隔符(行里没有半角冒号时):「2018:事件」被画成一整段正文。
  const normalized = !line.includes(':') && line.includes('：') ? line.replace(/\s*：\s*/g, ' : ') : line;
  return normalized.split(':').map(segment => wrapCjkRuns(segment)).join(':');
}

// 状态图连线标签的全角冒号:「A --> B:标签」整段当成状态名。
function stateColon(line) {
  return /-->/.test(line) && !line.includes(':') && line.includes('：') ? line.replace('：', ' : ') : line;
}

// ER 关系标签里带空格却没加引号:后半截被当成第二个实体名。
function erLabel(line) {
  const m = /^(\s*[\w\u0080-￿-]+\s+[|}o]{1,2}[-.]{2}[|{o]{1,2}\s+[\w\u0080-￿-]+\s*:\s*)([^"\n]*\s[^"\n]*)$/.exec(line);
  return m && /\s/.test(m[2].trim()) ? `${m[1]}"${m[2].trim()}"` : line;
}

export function prepareMermaidSource(src) {
  const type = mermaidDiagramType(src);
  let out = String(src == null ? '' : src);
  if (['flowchart', 'class', 'state', 'er', 'mindmap'].includes(type)) out = mapBody(out, escapeAngles);
  if (type === 'gantt') {
    out = mapBody(out, ganttDurations);
    const leftPadding = ganttLeftPadding(out);
    if (leftPadding) out = withInitDirective(out, { gantt: { leftPadding } });
  }
  if (type === 'timeline') out = mapBody(out, timelineLine);
  if (type === 'state') out = mapBody(out, stateColon);
  if (type === 'er') out = mapBody(out, erLabel);
  return out;
}

// ── 第二道:repairMermaidSource(仅在渲染抛错之后)─────────────────────────────────

// 行尾 %% 注释:流程图 / ER 里是语法错误(独占一行的注释没问题)。
function stripTrailingComment(line) {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if ('[({'.includes(c)) depth += 1;
      else if ('])}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (c === '%' && line[i + 1] === '%' && line[i + 2] !== '{' && depth === 0 && (i === 0 || /[\s;]/.test(line[i - 1]))) {
        return line.slice(0, i).replace(/\s+$/, '');
      }
    }
  }
  return line;
}

// 流程图标签里的括号 / 斜杠 / 竖线 / 引号 / @ / ; —— 整段加英文双引号(内层引号转 #quot;)。
const RISKY = /[()[\]{}"|;@`]|^[/\\]|&&/;
const MULTI = [['[(', ')]'], ['((', '))'], ['([', '])'], ['[[', ']]'], ['{{', '}}']];
function quoteFlowLabels(line) {
  if (/^\s*(style|classDef|class|click|linkStyle|subgraph|direction|end|accTitle|accDescr|title)\b/.test(line)) return line;
  const fixed = line.replace(/(-{2,}[>ox]?|={2,}>?|-\.+-?>?)(\s*)\|([^|\n"]+)\|/g,
    (m, arrow, sp, text) => (/[()[\]{}]/.test(text) ? `${arrow}${sp}|"${text.replace(/"/g, '#quot;')}"|` : m));
  const wrap = (open, inner, close) => `${open}"${inner.replace(/"/g, '#quot;')}"${close}`;
  let out = '';
  let i = 0;
  while (i < fixed.length) {
    const ch = fixed[i];
    if (ch === '"') {
      const j = fixed.indexOf('"', i + 1);
      if (j < 0) { out += fixed.slice(i); break; }
      out += fixed.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ('[({'.includes(ch) && i > 0 && /[\w\u0080-￿-]/.test(fixed[i - 1])) {
      const rest = fixed.slice(i);
      let consumed = 0;
      const stray = /^([[({]{1,2})"/.exec(rest);
      if (stray) {
        // ["含"引号"的节点"]:已加引号,里头还有引号。
        const closer = { '[': '"]', '(': '")', '{': '"}' }[stray[1][0]];
        const end = rest.indexOf(closer, stray[1].length + 1);
        if (end > 0 && rest.slice(stray[1].length + 1, end).includes('"')) {
          out += `${stray[1]}"${rest.slice(stray[1].length + 1, end).replace(/"/g, '#quot;')}${closer}`;
          consumed = end + closer.length;
        } else { out += ch; i += 1; continue; }
      } else {
        const multi = MULTI.find(([open]) => rest.startsWith(open));
        if (multi) {
          const end = rest.indexOf(multi[1], multi[0].length);
          const inner = end > 0 ? rest.slice(multi[0].length, end) : '';
          if (end > 0 && inner[0] !== '"' && RISKY.test(inner)) { out += wrap(multi[0], inner, multi[1]); consumed = end + multi[1].length; }
        } else {
          const firstClose = rest.indexOf(']');
          const slashShape = ch === '[' && '/\\'.includes(rest[1]) && firstClose > 1 && '/\\'.includes(rest[firstClose - 1]);
          if (!slashShape && !(ch === '(' && '([{'.includes(rest[1])) && !(ch === '{' && rest[1] === '{')) {
            let depth = 1;
            let j = 1;
            for (; j < rest.length; j += 1) {
              const c = rest[j];
              if ('[({'.includes(c)) depth += 1;
              else if ('])}'.includes(c)) { depth -= 1; if (depth === 0) break; }
            }
            const close = { '[': ']', '(': ')', '{': '}' }[ch];
            if (j < rest.length && rest[j] === close) {
              const inner = rest.slice(1, j);
              if (inner[0] !== '"' && RISKY.test(inner)) { out += wrap(ch, inner, close); consumed = j + 1; }
            }
          }
        }
      }
      if (consumed) { i += consumed; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}
function quoteSubgraphTitle(line) {
  const m = /^(\s*subgraph\s+)(.+?)\s*$/.exec(line);
  if (!m || m[2].startsWith('"')) return line;
  const withId = /^([\w\u0080-￿-]+)\s*\[(.*)\]$/.exec(m[2]);
  if (withId) return RISKY.test(withId[2]) && withId[2][0] !== '"' ? `${m[1]}${withId[1]}["${withId[2].replace(/"/g, '#quot;')}"]` : line;
  return /[()[\]{}|;]/.test(m[2]) ? `${m[1]}"${m[2].replace(/"/g, '#quot;')}"` : line;
}
// 把 end 当节点名(「开始 --> end」)是保留字错误;改成 End。
function endAsId(line) {
  if (/^\s*end\s*$/.test(line) || /^\s*subgraph\b/.test(line)) return line;
  let out = '';
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (!quoted) { if ('[({'.includes(c)) depth += 1; else if ('])}'.includes(c)) depth = Math.max(0, depth - 1); }
    if (!quoted && depth === 0 && line.startsWith('end', i)
      && !/[\w\u0080-￿]/.test(line[i - 1] || ' ') && !/[\w\u0080-￿]/.test(line[i + 3] || ' ')) {
      out += 'End';
      i += 2;
      continue;
    }
    out += c;
  }
  return out;
}

// xychart:不加引号的文字只认 [A-Za-z0-9 :+,=*#_.&-];中文、括号、百分号都要加引号。
const XY_SAFE = /^[A-Za-z0-9:+,=*#_.& -]*$/;
const xyQuote = s => {
  const t = s.trim();
  if (!t || /^["`]/.test(t) || XY_SAFE.test(t) || t.includes('"')) return s;
  return `"${t}"`;
};
function splitOutsideQuotes(inner) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function xyAxis(rest) {
  const open = rest.indexOf('[');
  if (open >= 0) {
    const close = rest.lastIndexOf(']');
    if (close < open) return rest;
    const head = rest.slice(0, open);
    const items = splitOutsideQuotes(rest.slice(open + 1, close)).map(item => {
      const t = item.trim();
      const q = xyQuote(t);
      return q === t ? item : ` ${q}`;
    });
    return `${xyQuote(head.trimEnd())}${head.trim() ? ' ' : ''}[${items.join(',')}]${rest.slice(close + 1)}`;
  }
  const range = /^(.*?)(\s+[+-]?\d*\.?\d+\s*--+>\s*[+-]?\d*\.?\d+\s*)$/.exec(rest);
  if (range) return xyQuote(range[1]) + range[2];
  return xyQuote(rest);
}
function xychartLine(line) {
  let m;
  if ((m = /^(\s*title\s+)(\S.*?)\s*$/.exec(line))) return m[1] + xyQuote(m[2]);
  if ((m = /^(\s*[xy]-axis)(\s+\S.*?)\s*$/.exec(line))) return `${m[1]} ${xyAxis(m[2].trim())}`;
  if ((m = /^(\s*(?:bar|line)\s+)([^[]*\S)(\s*\[.*)$/.exec(line))) return m[1] + xyQuote(m[2]) + m[3];
  return line;
}

// 象限图:点名加引号、全角标点、坐标只认 0~1 的 0.x / 1(「1.0」「.5」都是解析错误;从不夹取或缩放)。
function quadrantCoord(v) {
  const t = v.trim();
  if (/^1(\.0+)?$/.test(t)) return '1';
  if (/^\.\d+$/.test(t)) return `0${t}`;
  return t;
}
function quadrantLine(line) {
  const m = /^\s*("?)([^"\n:：[]+?)\1\s*[:：]\s*\[\s*([\d.]+)\s*[,，]\s*([\d.]+)\s*\](.*)$/.exec(line);
  if (!m) return line;
  return `    "${m[2].trim()}": [${quadrantCoord(m[3])}, ${quadrantCoord(m[4])}]${m[5]}`;
}

// 树图:名字必须加引号(连英文也是)。
function treemapLine(line) {
  if (!line.trim() || /^\s*(treemap|classDef|style|title|accTitle|accDescr)\b/.test(line)) return line;
  const m = /^(\s*)(.*?)(\s*:\s*[+-]?[\d.,]+)?(\s*:::\w+)?\s*$/.exec(line);
  if (!m || !m[2] || m[2].includes('"')) return line;
  return `${m[1]}"${m[2]}"${m[3] || ''}${m[4] || ''}`;
}

// 雷达:axis/curve 的显示名 a[沟通] 要写成 a["沟通"]。
function radarLine(line) {
  if (!/^\s*(axis|curve)\b/.test(line)) return line;
  return line.replace(/([\w-]+)\[([^\]"]+)\]/g, '$1["$2"]');
}

// gitGraph:中文分支名要加引号。
function gitLine(line) {
  const m = /^(\s*(?:branch|checkout|switch|merge)\s+)([^\s"]+)(.*)$/.exec(line);
  return m && /[^\x00-\x7f]/.test(m[2]) ? `${m[1]}"${m[2]}"${m[3]}` : line;
}

// 时序图:全角冒号、消息里的 ; (被当成语句分隔)。
function sequenceLine(line) {
  const m = /^(\s*(?:[^:\n]*?(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)[+-]?[^:：\n]*|Note\b[^:：\n]*))([:：])(.*)$/.exec(line);
  return m ? `${m[1]}: ${m[3].replace(/^\s+/, '').replace(/;/g, '#59;')}` : line;
}

// 饼图:标签不加引号、全角冒号、数值后跟 %。
function pieLine(line) {
  if (/^\s*(pie|title|showData|accTitle|accDescr)\b/.test(line)) return line;
  const m = /^\s*"?([^"\n:：]+?)"?\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(line);
  return m ? `    "${m[1].trim()}" : ${m[2]}` : line;
}

// 桑基图:节点名只认 ASCII(加引号也一样)。中文名换成 ASCII 代号画,画完再把文字换回来。
const SANKEY_SAFE = /^[\x20-\x21\x23-\x2b\x2d-\x7e]*$/;
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '""'; i += 1; continue; }
      quoted = !quoted;
      cur += ch;
    } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const unquoteCsv = s => {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
};
function aliasSankey(src) {
  const lines = String(src).split('\n');
  const header = lines.findIndex(line => /^\s*sankey(-beta)?\b/.test(line));
  if (header < 0) return null;
  const rows = lines.map((line, i) => {
    if (i <= header || !line.trim() || /^\s*%%/.test(line)) return null;
    const fields = splitCsv(line);
    return fields.length === 3 ? { a: unquoteCsv(fields[0]), b: unquoteCsv(fields[1]), v: fields[2].trim() } : null;
  });
  const taken = new Set(rows.flatMap(row => (row ? [row.a, row.b] : [])));
  const aliasOf = new Map();
  const labels = {};
  const alias = name => {
    if (SANKEY_SAFE.test(name)) return name;
    if (!aliasOf.has(name)) {
      let token;
      let n = aliasOf.size + 1;
      do { token = `N${n}x`; n += 1; } while (taken.has(token));
      taken.add(token);
      aliasOf.set(name, token);
      labels[token] = name;
    }
    return aliasOf.get(name);
  };
  const out = lines.map((line, i) => (rows[i] ? `${alias(rows[i].a)},${alias(rows[i].b)},${rows[i].v}` : line));
  return aliasOf.size ? { source: out.join('\n'), labels } : null;
}

// 甘特:中文日期「2026年10月5日」;任务行全角冒号。
function ganttRepair(src) {
  let out = String(src)
    .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日?/g, (m, y, mo, d) => `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`)
    .replace(/^(\s*dateFormat\s+).*[年月日].*$/m, '$1YYYY-MM-DD');
  out = mapBody(out, line => (!GANTT_KEYWORDS.test(line) && !line.includes(':') && line.includes('：') ? line.replace('：', ' :') : line));
  return out;
}

export function repairMermaidSource(src) {
  const original = String(src == null ? '' : src);
  const type = mermaidDiagramType(original);
  let out = original;
  let labels = null;
  if (type === 'flowchart') out = mapBody(out, line => endAsId(quoteFlowLabels(quoteSubgraphTitle(stripTrailingComment(line)))));
  else if (type === 'er') out = mapBody(out, stripTrailingComment);
  else if (type === 'sequence') out = mapBody(out, sequenceLine);
  else if (type === 'pie') out = mapBody(out, pieLine);
  else if (type === 'gantt') out = ganttRepair(out);
  else if (type === 'journey') out = mapBody(out, line => (!/^\s*(title|section)\b/.test(line) && line.includes('：') ? line.replace(/\s*：\s*/g, ': ') : line));
  else if (type === 'xychart') out = mapBody(out, xychartLine);
  else if (type === 'quadrant') out = mapBody(out, quadrantLine);
  else if (type === 'treemap') out = mapBody(out, treemapLine);
  else if (type === 'radar') out = mapBody(out, radarLine);
  else if (type === 'gitGraph') out = mapBody(out, gitLine);
  else if (type === 'sankey') {
    const aliased = aliasSankey(out);
    if (aliased) { out = aliased.source; labels = aliased.labels; }
  }
  return out === original ? null : { source: out, labels };
}
