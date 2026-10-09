// 11b-file-text-io.js - 单文件工具(file_read / file_write / file_edit / file_delete)的文本 I/O 内核。
//
// 只做「字节 <-> 文本」与「落盘」这类纯 I/O 原语,不碰权限/检查点/会话(那些留在 12 的 handler 里):
//   ① 编码:BOM 嗅探(UTF-8/UTF-16LE/BE)、严格 UTF-8 失败 -> GB18030 回退、GB18030 编码(懒建反查表 + 往返校验)。
//   ② 有界读:fd 上按块流式解码,只读「够返回窗口」的那一段,不再为读 2000 字符把 50MB 整个读进内存。
//   ③ 原子写:同目录临时文件 + rename,瞬时锁(EPERM/EBUSY/EACCES/EEXIST)退避重试,失败清理临时文件。
//   ④ file_edit 未命中的诊断:空白差异定位、多命中行号、整段 oldText 的最接近窗口。
//   ⑤ 文件系统错误 -> 带 code/hint 的结构化失败。
//
// 依赖环纪律:本模块【零出边】(不引用任何其他 app/src 模块的顶层符号,Node 内建自己 require),
// 所以不会被卷进 module-dependency-graph 的强连通分量。对外只暴露一个冻结对象 FileTextIo;
// 12 里的调用点一律 FileTextIo.xxx。fs/promises 用属性访问(不解构),单测在 fsp 上装的卡子照样命中。
const FileTextIo = (() => {
  const nodeFsp = require('fs/promises');
  const nodePath = require('path');
  const nodeCrypto = require('crypto');

  // ── 常量 ────────────────────────────────────────────────────────────────────────────────────────
  const CHUNK_BYTES = 4 * 1024 * 1024;          // 流式读块大小;首块同时用于编码嗅探(<=4MB 的文件嗅探是精确的)
  const SCAN_TOTALS_MAX_BYTES = 8 * 1024 * 1024; // 不超过它的文件扫到尾,给出精确 totalChars/totalLines;更大的只读窗口
  const NUL_SNIFF_BYTES = 8192;
  const LINE_CARRY_CAP = 400000;                 // 行模式里一条超长行最多攒这么多字符(更长的部分只计数不存)

  // ── 编码名归一 ──────────────────────────────────────────────────────────────────────────────────
  const ENCODING_ALIASES = {
    'utf8': 'utf8', 'utf-8': 'utf8',
    'utf16le': 'utf16le', 'utf-16le': 'utf16le', 'ucs2': 'utf16le', 'ucs-2': 'utf16le', 'utf16': 'utf16le', 'utf-16': 'utf16le',
    'utf16be': 'utf16be', 'utf-16be': 'utf16be',
    'gbk': 'gb18030', 'gb2312': 'gb18030', 'gb18030': 'gb18030', 'cp936': 'gb18030', 'windows-936': 'gb18030', '936': 'gb18030',
    'latin1': 'latin1', 'binary': 'latin1', 'iso-8859-1': 'latin1', 'ascii': 'latin1',
  };
  const ACCEPTED_ENCODINGS_TEXT = 'utf8 | utf-16le | utf-16be | gbk(=gb2312=gb18030) | latin1';
  // 返回 { enc }('auto' = 未指定,按内容判)或 { bad:true }。file_write 另有历史用法:base64/hex 等 Buffer 编码,
  // 由调用方在 bad 时自己再用 Buffer.isEncoding 判(读工具则直接拒绝)。
  function normalizeEncodingName(name) {
    if (name == null || name === '') return { enc: 'auto' };
    const key = String(name).trim().toLowerCase();
    if (key === 'auto') return { enc: 'auto' };
    const enc = ENCODING_ALIASES[key];
    return enc ? { enc } : { bad: true };
  }

  let gbSupport = null;
  function gb18030Supported() {
    if (gbSupport === null) {
      try { gbSupport = new TextDecoder('gb18030').encoding === 'gb18030'; } catch { gbSupport = false; }
    }
    return gbSupport;
  }

  // 流式解码器:write(buf) 可分多次喂,end() 收尾。UTF-8/16/GB18030 走 TextDecoder({stream:true}),
  // latin1 是单字节映射,无状态。fatal=true 时遇非法序列抛错(用于「合法性」判定)。
  function makeDecoder(enc, fatal) {
    if (enc === 'latin1') return { write: b => Buffer.from(b.buffer, b.byteOffset, b.length).toString('latin1'), end: () => '' };
    const label = enc === 'utf16le' ? 'utf-16le' : enc === 'utf16be' ? 'utf-16be' : enc === 'gb18030' ? 'gb18030' : 'utf-8';
    const td = new TextDecoder(label, { fatal: !!fatal, ignoreBOM: true });
    return { write: b => td.decode(b, { stream: true }), end: () => td.decode() };
  }
  function validIn(enc, buf, complete) {
    try {
      const td = new TextDecoder(enc === 'gb18030' ? 'gb18030' : 'utf-8', { fatal: true, ignoreBOM: true });
      td.decode(buf, { stream: !complete });
      return true;
    } catch { return false; }
  }

  // 嗅探:BOM 优先;其次严格 UTF-8;失败且 GB18030 可用且合法 -> gb18030;都不是 -> utf8 宽松(带 warning)。
  // complete=false 表示 buf 只是文件前缀(尾部可能切在多字节序列中间,不算非法)。
  function sniffEncoding(buf, complete) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf8', bomLength: 3, bom: true, detected: false };
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf16le', bomLength: 2, bom: true, detected: true };
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf16be', bomLength: 2, bom: true, detected: true };
    const hasNul = buf.subarray(0, NUL_SNIFF_BYTES).indexOf(0) >= 0;
    if (validIn('utf8', buf, complete)) return { encoding: 'utf8', bomLength: 0, bom: false, detected: false, hasNul };
    if (gb18030Supported()) {
      if (validIn('gb18030', buf, complete)) return { encoding: 'gb18030', bomLength: 0, bom: false, detected: true, hasNul };
      return { encoding: 'utf8', bomLength: 0, bom: false, detected: false, hasNul, lossy: true,
        warning: '文件既不是合法 UTF-8 也不是合法 GBK/GB18030,已按 UTF-8 宽松解码(坏字节显示为 U+FFFD);可用 encoding 参数指定(utf-16le / gbk / latin1)' };
    }
    return { encoding: 'utf8', bomLength: 0, bom: false, detected: false, hasNul, lossy: true,
      warning: '文件不是合法 UTF-8,可能是 GBK;当前 Node 运行时不带 GB18030 解码器,已按 UTF-8 宽松解码(坏字节显示为 U+FFFD)' };
  }

  // 给定显式编码时,BOM 只在与该编码匹配时才剥。
  function bomLengthFor(enc, buf) {
    if (enc === 'utf8' && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 3;
    if (enc === 'utf16le' && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 2;
    if (enc === 'utf16be' && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 2;
    return 0;
  }

  // ── GB18030 编码(Node 没有内建编码器):从 TextDecoder 反推,懒建、只建一次 ────────────────────────────
  // 覆盖单字节(0x80/欧元等)、双字节 0x81-0xFE x 0x40-0xFE、BMP 四字节(0x81-0x84 开头);
  // 增补平面(U+10000 以上)的四字节按算术公式。任何字符查不到 -> 抛 unencodable;
  // 最后再整体解码比对一次,保证「写出去的字节读回来就是这段文本」,绝不静默改字。
  let gbEncodeMap = null;
  function gbTable() {
    if (gbEncodeMap) return gbEncodeMap;
    const dec = new TextDecoder('gb18030');
    const map = new Map();
    const put = (s, code) => {
      if (!s || s === '�') return;
      const cp = s.codePointAt(0);
      if (s.length !== (cp > 0xffff ? 2 : 1)) return;      // 一个码点才算一对一映射
      if (!map.has(cp)) map.set(cp, code);
    };
    const one = Buffer.alloc(1), two = Buffer.alloc(2), four = Buffer.alloc(4);
    for (let b = 0x80; b <= 0xff; b += 1) { one[0] = b; put(dec.decode(one), b); }
    for (let b1 = 0x81; b1 <= 0xfe; b1 += 1) {
      two[0] = b1;
      for (let b2 = 0x40; b2 <= 0xfe; b2 += 1) { if (b2 === 0x7f) continue; two[1] = b2; put(dec.decode(two), (b1 << 8) | b2); }
    }
    for (let b1 = 0x81; b1 <= 0x84; b1 += 1) {
      four[0] = b1;
      for (let b2 = 0x30; b2 <= 0x39; b2 += 1) {
        four[1] = b2;
        for (let b3 = 0x81; b3 <= 0xfe; b3 += 1) {
          four[2] = b3;
          for (let b4 = 0x30; b4 <= 0x39; b4 += 1) { four[3] = b4; put(dec.decode(four), ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0); }
        }
      }
    }
    gbEncodeMap = map;
    return map;
  }
  class UnencodableError extends Error {
    constructor(char, index, encoding) {
      super(`character ${JSON.stringify(char)} (U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) at index ${index} cannot be encoded as ${encoding}`);
      this.code = 'UNENCODABLE'; this.char = char; this.index = index; this.encoding = encoding;
    }
  }
  function encodeGb18030(text) {
    if (!gb18030Supported()) { const e = new Error('GB18030 codec unavailable in this Node runtime'); e.code = 'NO_GB18030'; throw e; }
    const map = gbTable();
    // 写进按需翻倍的 Buffer(修前是逐字节 push 的 JS 数组:40MB 的 GBK 文件 file_edit 要 ~600MB 内存 / ~2.7s 同步计算)。
    let out = Buffer.allocUnsafe(Math.max(16, text.length * 2 + 16));
    let n = 0;
    const need = k => { if (n + k > out.length) { const bigger = Buffer.allocUnsafe(Math.max(out.length * 2, n + k)); out.copy(bigger, 0, 0, n); out = bigger; } };
    for (let i = 0; i < text.length; i += 1) {
      const cp = text.codePointAt(i);
      if (cp > 0xffff) {
        const p = cp - 0x10000 + 189000;
        need(4);
        out[n++] = Math.floor(p / 12600) + 0x81; out[n++] = Math.floor((p % 12600) / 1260) + 0x30; out[n++] = Math.floor((p % 1260) / 10) + 0x81; out[n++] = (p % 10) + 0x30;
        i += 1;
        continue;
      }
      need(4);
      if (cp < 0x80) { out[n++] = cp; continue; }
      const code = map.get(cp);
      if (code === undefined) throw new UnencodableError(String.fromCodePoint(cp), i, 'gb18030');
      if (code > 0xffffff) { out[n++] = (code >>> 24) & 0xff; out[n++] = (code >>> 16) & 0xff; out[n++] = (code >>> 8) & 0xff; out[n++] = code & 0xff; }
      else if (code > 0xff) { out[n++] = (code >>> 8) & 0xff; out[n++] = code & 0xff; }
      else out[n++] = code;
    }
    const buf = out.subarray(0, n);
    if (new TextDecoder('gb18030', { ignoreBOM: true }).decode(buf) !== text) throw new UnencodableError(text.charAt(0) || ' ', 0, 'gb18030');
    return buf;
  }

  // 文本 -> 目标编码字节。bom=true 时 UTF-16 / UTF-8 前置 BOM(UTF-8 的 BOM 也可以已经作为 \ufeff 留在 text 里,此时传 bom:false)。
  function encodeText(text, enc, bom) {
    const s = String(text);
    switch (enc) {
      case 'utf16le': { const b = Buffer.from(s, 'utf16le'); return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b; }
      case 'utf16be': { const b = Buffer.from(s, 'utf16le').swap16(); return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), b]) : b; }
      case 'gb18030': return encodeGb18030(s);
      case 'latin1': {
        const b = Buffer.from(s, 'latin1');
        if (b.toString('latin1') !== s) throw new UnencodableError(s.charAt(0) || ' ', 0, 'latin1');
        return b;
      }
      default: { const b = Buffer.from(s, 'utf8'); return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b; }
    }
  }

  // 整块字节 -> 文本(file_edit / file_write 用)。UTF-8 保持旧行为:BOM 留在文本里原样写回(ignoreBOM);
  // UTF-16 / GB18030 剥 BOM 由 bom 标志记住。非法字节不抛,交由 lossy/warning 带出(file_edit 遇 lossy 拒绝)。
  function decodeBuffer(buf, requestedEnc) {
    const req = requestedEnc && requestedEnc !== 'auto' ? requestedEnc : null;
    let sn;
    if (req) sn = { encoding: req, bomLength: req === 'utf8' ? 0 : bomLengthFor(req, buf), bom: req !== 'utf8' && bomLengthFor(req, buf) > 0, detected: false };
    else {
      sn = sniffEncoding(buf, true);
      if (sn.encoding === 'utf8') sn.bomLength = 0;          // UTF-8 BOM 留在文本里(旧行为)
    }
    const dec = makeDecoder(sn.encoding, false);
    const text = dec.write(buf.subarray(sn.bomLength)) + dec.end();
    return { text, encoding: sn.encoding, bom: sn.bom === true, detected: sn.detected === true, lossy: sn.lossy === true, warning: sn.warning || '', hasNul: !!sn.hasNul };
  }

  // ── 有界流式读 ───────────────────────────────────────────────────────────────────────────────────
  function countNl(s) { let n = 0, i = -1; while ((i = s.indexOf('\n', i + 1)) >= 0) n += 1; return n; }
  // 换行风格计数器(跨块的 \r|\n 拆分用 carry 拼回)。
  function makeEolTally() {
    let lf = 0, crlf = 0, cr = 0, held = '';
    const eat = (t) => {
      for (let i = 0; i < t.length; i += 1) {
        const c = t.charCodeAt(i);
        if (c === 13) { if (t.charCodeAt(i + 1) === 10) { crlf += 1; i += 1; } else cr += 1; }
        else if (c === 10) lf += 1;
      }
    };
    return {
      add(piece) {
        let t = held + piece; held = '';
        if (t.endsWith('\r')) { held = '\r'; t = t.slice(0, -1); }
        eat(t);
      },
      kind() {
        if (held) cr += 1, held = '';
        if (!lf && !crlf && !cr) return 'none';
        if (lf && !crlf && !cr) return 'lf';
        if (crlf && !lf && !cr) return 'crlf';
        return 'mixed';
      },
    };
  }
  function jsonLen(s) { return JSON.stringify(s).length - 2; }

  // 读一个文本文件的一个窗口。
  //   req = { encoding:'auto'|enc, mode:'chars'|'lines', offset, limit, lineOffset, lineLimit,
  //           jsonBudget (窗口内容序列化后的字符预算), xform (可选:序列化前对文本的变换,如非 ASCII 标注,只用来量体积),
  //           refuseNul (无扩展名文件:前 8KB 有 NUL 视为二进制) }
  // 失败返回 { ok:false, code, error, hint };成功返回 { ok:true, ... }(字段见下)。
  async function readTextWindow(filePath, st, req) {
    const size = st.size;
    const xform = typeof req.xform === 'function' ? req.xform : (s => s);
    const budget = Math.max(1000, Number(req.jsonBudget) || 50000);
    let fh;
    try { fh = await nodeFsp.open(filePath, 'r'); } catch (e) { throw e; }
    try {
      const first = Buffer.alloc(Math.min(size, CHUNK_BYTES));
      let got = 0;
      while (got < first.length) {
        const { bytesRead } = await fh.read(first, got, first.length - got, got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      const head = first.subarray(0, got);
      let sn;
      const complete = size <= CHUNK_BYTES;
      if (req.encoding && req.encoding !== 'auto') {
        const bl = bomLengthFor(req.encoding, head);
        sn = { encoding: req.encoding, bomLength: bl, bom: bl > 0, detected: false };
      } else {
        sn = sniffEncoding(head, complete);
        if (!sn.bom && sn.hasNul && req.refuseNul) {
          return { ok: false, code: 'binary', error: 'binary file (NUL bytes in the first 8KB)', hint: '这看起来是二进制文件(不是文本);如果其实是无 BOM 的 UTF-16 文本,请传 encoding:"utf-16le"(或 utf-16be)。图片/新版 Office/PDF 可用 file_read 原生读取,请确认扩展名;压缩包用 archive_unzip,数据库用 script_run 查询' };
        }
      }
      const decoder = makeDecoder(sn.encoding, false);
      const eol = makeEolTally();
      const scanTotals = size <= SCAN_TOTALS_MAX_BYTES;
      const linesMode = req.mode === 'lines';

      // 状态
      let consumed = 0;                    // 已解出的字符数
      let stop = false;
      // 字符模式
      const start = Math.max(0, Math.floor(Number(req.offset) || 0));
      const limit = Math.max(0, Math.floor(Number(req.limit) || 0));
      const parts = [];
      let lineBase = 1;                    // 窗口起点所在的行号(1 起)
      let sawBeyond = false;
      // 行模式
      const lineOffset = Math.max(1, Math.floor(Number(req.lineOffset) || 1));
      const lineLimit = Math.max(0, Math.floor(Number(req.lineLimit)));
      const outLines = [];
      let jsonAcc = 0, collecting = true, moreLines = false, nextLine = 0, lineTruncated = null;
      let carry = '', carryStart = 0, carryTrue = 0, carryClipped = false, lineNo = 1;

      const takeLine = (text, no, startChar, trueLen) => {
        if (no < lineOffset || !collecting) {
          if (!collecting && !scanTotals) stop = true;
          return;
        }
        if (outLines.length >= lineLimit) { moreLines = true; nextLine = no; collecting = false; if (!scanTotals) stop = true; return; }
        const cost = jsonLen(xform(String(no) + '\t' + text)) + 2;
        if (jsonAcc + cost > budget) {
          if (outLines.length > 0) { moreLines = true; nextLine = no; collecting = false; if (!scanTotals) stop = true; return; }
          // 首行就放不下:截到预算内,并给出字符偏移让模型改用字符模式接着读。
          let keep = Math.max(1, Math.floor(text.length * (budget - 60) / Math.max(1, cost)));
          while (keep > 1 && jsonLen(xform(String(no) + '\t' + text.slice(0, keep))) + 2 > budget) keep = Math.floor(keep * 0.9);
          if (keep > 0 && keep < text.length) { const cc = text.charCodeAt(keep - 1); if (cc >= 0xd800 && cc <= 0xdbff) keep -= 1; }
          outLines.push({ no, text: text.slice(0, keep) });
          lineTruncated = { line: no, keptChars: keep, lineChars: Math.max(text.length, trueLen || 0), nextOffset: startChar + keep };
          moreLines = true; nextLine = no + 1; collecting = false;
          if (!scanTotals) stop = true;
          return;
        }
        jsonAcc += cost;
        outLines.push({ no, text });
      };
      const feedLines = (piece) => {
        let from = 0, idx;
        while ((idx = piece.indexOf('\n', from)) >= 0) {
          const seg = piece.slice(from, idx);
          let text, trueLen, clipped = carryClipped;
          if (carryTrue > 0) {
            trueLen = carryTrue + seg.length;
            text = clipped ? carry : carry + seg;
            if (!clipped && text.length > LINE_CARRY_CAP) { text = text.slice(0, LINE_CARRY_CAP); clipped = true; }
          } else { trueLen = seg.length; text = seg; if (text.length > LINE_CARRY_CAP) { text = text.slice(0, LINE_CARRY_CAP); clipped = true; } }
          if (!clipped && text.endsWith('\r')) text = text.slice(0, -1);
          takeLine(text, lineNo, carryStart, trueLen);
          carryStart += trueLen + 1; lineNo += 1;
          carry = ''; carryTrue = 0; carryClipped = false;
          from = idx + 1;
          if (stop) return;
        }
        const rest = piece.slice(from);
        if (rest.length) {
          carryTrue += rest.length;
          if (!carryClipped) { carry += rest; if (carry.length > LINE_CARRY_CAP) { carry = carry.slice(0, LINE_CARRY_CAP); carryClipped = true; } }
        }
      };

      const onText = (piece) => {
        if (!piece) return;
        eol.add(piece);
        if (linesMode) { feedLines(piece); consumed += piece.length; return; }
        const pieceStart = consumed, pieceEnd = consumed + piece.length;
        const end = start + limit;
        if (pieceStart < start) lineBase += countNl(piece.slice(0, Math.min(piece.length, start - pieceStart)));
        if (pieceEnd > start && pieceStart < end) parts.push(piece.slice(Math.max(0, start - pieceStart), Math.max(0, end - pieceStart)));
        consumed = pieceEnd;
        if (consumed > end) { sawBeyond = true; if (!scanTotals) stop = true; }
      };

      // 泵:首块已在手,其余按块读。
      // 编码只嗅探了首块(4MB)。自动判成 UTF-8、后面的块却解出了 U+FFFD(常见:前面全是 ASCII,后面才出现 GBK 中文)→
      // 不静默给乱码,在结果里发 encodingWarning(让模型改用 encoding:"gbk" 重读)。
      const sniffedOnlyHead = !(req.encoding && req.encoding !== 'auto') && sn.encoding === 'utf8' && !sn.warning;
      let laterBad = false;
      const laterText = t => { if (sniffedOnlyHead && !laterBad && t && t.indexOf('\ufffd') >= 0) laterBad = true; return t; };
      let pos = got, atEof = got >= size;
      onText(decoder.write(head.subarray(sn.bomLength)));
      while (!stop && !atEof) {
        const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) { atEof = true; break; }
        pos += bytesRead;
        onText(laterText(decoder.write(buf.subarray(0, bytesRead))));
        if (pos >= size) atEof = true;
      }
      if (atEof && !stop) onText(laterText(decoder.end()));

      const base = {
        ok: true, encoding: sn.encoding, bom: sn.bom === true, encodingDetected: sn.detected === true,
        ...(sn.warning ? { encodingWarning: sn.warning } : {}),
        ...(laterBad ? { encodingWarning: '文件前 4MB 是合法 UTF-8,但更靠后的内容含无法按 UTF-8 解码的字节(显示为 U+FFFD),可能是 GBK 等其他编码;请用 encoding:"gbk"(或 latin1 / utf-16le)重读该部分' } : {}),
        ...(!sn.warning && !laterBad && sn.encoding === 'utf8' && sn.hasNul ? { encodingWarning: '文件含 NUL 字节:可能是无 BOM 的 UTF-16 文本,内容已按 UTF-8 解码;如是请传 encoding:"utf-16le"' } : {}),
        size, eol: eol.kind(),
      };
      if (linesMode) {
        if (atEof && !stop && carryTrue > 0) {
          let text = carry;
          if (!carryClipped && text.endsWith('\r')) text = text.slice(0, -1);
          takeLine(text, lineNo, carryStart, carryTrue); lineNo += 1;
        }
        const known = atEof && !stop;
        return { ...base, mode: 'lines', lines: outLines, lineOffset, lineLimit, truncated: moreLines,
          ...(moreLines ? { nextLine } : {}), ...(lineTruncated ? { lineTruncated } : {}),
          totalLines: known ? lineNo - 1 : null };
      }
      let content = parts.join('');
      let truncated = sawBeyond || !(atEof && !stop);
      // 序列化预算:超了就按比例收窄,并且不把代理对劈开。
      let jl = jsonLen(xform(content));
      let guard = 0;
      while (jl > budget && content.length > 1 && guard < 12) {
        let keep = Math.max(1, Math.floor(content.length * (budget - 200) / jl));
        if (keep >= content.length) keep = content.length - 1;
        content = content.slice(0, keep);
        jl = jsonLen(xform(content)); guard += 1; truncated = true;
      }
      if (content.length > 0) { const cc = content.charCodeAt(content.length - 1); if (cc >= 0xd800 && cc <= 0xdbff && (truncated || content.length === limit)) { content = content.slice(0, -1); truncated = true; } }
      const nextOffset = start + content.length;
      const totalChars = atEof && !stop ? consumed : null;
      if (totalChars !== null) truncated = nextOffset < totalChars;
      return { ...base, mode: 'chars', content, start, truncated, nextOffset, totalChars, lineBase };
    } finally {
      try { await fh.close(); } catch { /* best-effort */ }
    }
  }

  async function readHead(filePath, n) {
    const fh = await nodeFsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally { try { await fh.close(); } catch { /* best-effort */ } }
  }

  // ── 原子写 ──────────────────────────────────────────────────────────────────────────────────────
  // 同目录唯一临时名 -> writeFile -> rename 覆盖;rename 遇 Windows 瞬时锁(杀软/索引/编辑器持句柄)
  // EPERM/EBUSY/EACCES/EEXIST 退避重试 8 次(参数同 01-config atomicWriteJson)。
  // 目标是符号链接 / 多硬链接时改走原地写(rename 会让链接指向旧 inode / 断开硬链接)。
  // rename 永久失败时最后再试一次原地写(与旧行为等价),两者都失败才抛。
  async function writeFileAtomic(target, data, opts = {}) {
    let st = null;
    try { st = await nodeFsp.lstat(target); } catch { st = null; }
    const inPlace = async () => { await nodeFsp.writeFile(target, data); };
    // 符号链接 / 多硬链接:直接原地写(writeFile 自己会在无权时报 EACCES)。必须在 access 之前 —— 悬空链接的 access 会
    // 跟随链接报 ENOENT(假的 not_found),而原地写正好会经链接把目标创建出来(与改前 writeFile 行为一致)。
    if (st && (st.isSymbolicLink() || st.nlink > 1)) { await inPlace(); return { atomic: false, reason: st.isSymbolicLink() ? 'symlink' : 'hardlink' }; }
    // rename 会无视目标文件自身的只读位(只看目录权限),原地写不会 —— 先确认我们本来就有权写它,保持「只读文件写不进去」的语义。
    if (st) await nodeFsp.access(target, 2);
    const dir = nodePath.dirname(target);
    const tmp = nodePath.join(dir, '.' + nodePath.basename(target) + '.' + process.pid + '.' + nodeCrypto.randomBytes(4).toString('hex') + '.tmp');
    try { await nodeFsp.writeFile(tmp, data); }
    catch (e) {
      nodeFsp.unlink(tmp).catch(() => {});
      // 建不了临时文件(目录没有「创建文件」权 / 只读目录 / 加了临时名后路径超长 …)但目标文件本身可写:退回原地写(改前的行为),
      // 只有原地写也失败才报原错误。ENOSPC 不退(原地写会先截断目标,写不满就丢数据)。
      const c = e && e.code;
      if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS' || c === 'ENAMETOOLONG' || c === 'ENOENT') {
        try { await inPlace(); return { atomic: false, reason: 'tmp_create_failed:' + c }; }
        catch { throw e; }
      }
      throw e;
    }
    if (st && !(process.platform === 'win32')) { try { await nodeFsp.chmod(tmp, st.mode & 0o7777); } catch { /* 权限位尽力保留 */ } }
    const retries = Number.isFinite(opts.retries) ? opts.retries : 8;
    let lastErr = null;
    for (let attempt = 0; ; attempt += 1) {
      try { await nodeFsp.rename(tmp, target); return { atomic: true }; }
      catch (e) {
        lastErr = e;
        const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EEXIST');
        if (transient && attempt < retries) { await new Promise(r => setTimeout(r, 15 + attempt * 20)); continue; }
        break;
      }
    }
    try { await nodeFsp.unlink(tmp); } catch { /* best-effort tmp cleanup */ }
    // 目录/权限类错误不必再试原地写(同样会失败且会掩盖真因);锁类错误给原地写一次机会。
    if (lastErr && (lastErr.code === 'EISDIR' || lastErr.code === 'ENOTDIR' || lastErr.code === 'ENOSPC' || lastErr.code === 'EROFS')) throw lastErr;
    try { await inPlace(); return { atomic: false, reason: 'rename_failed:' + (lastErr && lastErr.code) }; }
    catch { throw lastErr; }
  }

  // ── 文件系统错误 -> 结构化失败 ─────────────────────────────────────────────────────────────────
  // 认识的 errno 给 code + hint;不认识的返回 null,由调用方原样抛出(保持旧行为)。
  function fsErrorEnvelope(e, filePath) {
    const c = e && e.code;
    const base = { ok: false, path: filePath, errno: c, detail: (e && e.message) || String(e) };
    switch (c) {
      case 'EISDIR': return { ...base, code: 'is_directory', error: '这是一个目录,不是文件', hint: '要看目录内容用 file_list 或 glob;要读/写文件请给出具体文件路径' };
      case 'EBUSY': case 'EPERM': case 'EACCES':
        return { ...base, code: c === 'EACCES' || c === 'EPERM' ? 'permission_or_locked' : 'locked',
          error: '文件被占用或没有写权限', hint: '文件可能被其他程序(编辑器/杀毒/索引服务)占用,或是只读文件;稍后重试,或让用户关闭占用它的程序 / 取消只读属性' };
      case 'ENOSPC': return { ...base, code: 'disk_full', error: '磁盘空间不足', hint: '目标磁盘已满;释放空间后重试(原文件未被改动)' };
      case 'ENAMETOOLONG': return { ...base, code: 'path_too_long', error: '路径过长', hint: 'Windows 默认路径上限约 260 字符;换一个更短的目录或文件名' };
      case 'EMFILE': case 'ENFILE': return { ...base, code: 'too_many_open_files', error: '打开的文件过多', hint: '稍后重试' };
      case 'ENOTDIR': return { ...base, code: 'not_a_directory', error: '路径中有一段不是目录', hint: '检查路径里的父级是否其实是一个文件' };
      case 'EROFS': return { ...base, code: 'read_only_fs', error: '目标位置是只读的', hint: '换一个可写位置' };
      case 'ENOENT': return { ...base, code: 'not_found', error: '文件或目录不存在', hint: '先用 glob 或 file_list 确认路径' };
      // 2026-10 走查(R2):父级是文件(file_write 到 a.txt/x.txt)、zip 条目 f 与 f/g.txt 互相冲突等 —— 修前是裸 EEXIST 异常。
      case 'EEXIST': return { ...base, code: 'already_exists', error: '路径上已存在同名的文件或目录,与要创建的类型冲突', hint: '检查路径里的某一段是不是已经存在、且是文件而不是目录(或反过来);换一个路径,或先移走/删除冲突项' };
      case 'ENOTEMPTY': return { ...base, code: 'not_empty', error: '目录非空', hint: '目标是一个非空目录;换一个路径' };
      // 路径里带 NUL(模型偶尔会把 "\0" 写进路径):Node 抛 ERR_INVALID_ARG_VALUE,修前是裸 TypeError。
      case 'ERR_INVALID_ARG_VALUE': case 'ERR_INVALID_ARG_TYPE':
        if (/null bytes/i.test(String((e && e.message) || ''))) return { ...base, code: 'bad_path', error: '路径含有 NUL 字符(\\0),不是合法路径', hint: '检查路径里有没有混入不可见的控制字符;重新给出一个正常的路径' };
        return null;
      default: return null;
    }
  }

  // ── file_edit 诊断 ──────────────────────────────────────────────────────────────────────────────
  const WS_RUN_RE = /[ \t\u00a0\u3000\u2000-\u200a\u202f\u205f]+/g;
  const normWs = s => s.replace(WS_RUN_RE, ' ').trim();
  const showWs = s => s.replace(/\t/g, '→').replace(/\u00a0/g, '⍽');

  // 某处 file 与 old 只差空白?返回 { line(1 起), lineCount, kinds[], actualText } 或 null。
  // 单行 oldText 允许是行内片段;多行时首行按后缀、末行按前缀、中间整行(归一空白后)比较。
  function findWhitespaceMatch(fileLines, oldLines, scanCap) {
    const k = oldLines.length;
    if (!k) return null;
    const normOld = oldLines.map(normWs);
    const scan = Math.min(fileLines.length - k + 1, scanCap);
    for (let i = 0; i < scan; i += 1) {
      const f0 = normWs(fileLines[i]);
      let hit;
      if (k === 1) hit = normOld[0] !== '' && f0.includes(normOld[0]);
      else hit = normOld[0] === '' ? f0 === '' : f0.endsWith(normOld[0]);
      if (!hit) continue;
      let good = true;
      for (let j = 1; j < k && good; j += 1) {
        const fj = normWs(fileLines[i + j]);
        if (j === k - 1) good = normOld[j] === '' ? true : fj.startsWith(normOld[j]);
        else good = fj === normOld[j];
      }
      if (!good) continue;
      const region = fileLines.slice(i, i + k);
      return { line: i + 1, lineCount: k, kinds: wsDiffKinds(region, oldLines), actualText: region.join('\n') };
    }
    return null;
  }
  function wsDiffKinds(fileRegion, oldLines) {
    const kinds = new Set();
    for (let j = 0; j < oldLines.length; j += 1) {
      const a = fileRegion[j], b = oldLines[j];
      if (a === b) continue;
      const lead = s => (s.match(/^[ \t\u00a0\u3000]*/) || [''])[0];
      if (/\t/.test(a) !== /\t/.test(b)) kinds.add('tab_vs_space');
      else if (lead(a) !== lead(b) && a.trimStart() === b.trimStart()) kinds.add('indent_width');
      if (a.replace(/[ \t]+$/, '') !== a !== (b.replace(/[ \t]+$/, '') !== b)) kinds.add('trailing_whitespace');
      const uni = /[\u00a0\u3000\u2000-\u200a\u202f\u205f]/;
      if (uni.test(a) !== uni.test(b)) kinds.add('unicode_space');
    }
    if (!kinds.size) kinds.add('internal_whitespace');
    return [...kinds];
  }
  const WS_KIND_TEXT = {
    tab_vs_space: '制表符与空格混用(文件与 oldText 缩进字符不同)',
    indent_width: '缩进宽度不同',
    trailing_whitespace: '行尾空白不同',
    unicode_space: '不间断空格/全角空格等特殊空白不同',
    internal_whitespace: '行内空白个数不同',
  };
  function describeWsKinds(kinds) { return kinds.map(k => WS_KIND_TEXT[k] || k).join(';'); }

  // 所有命中位置的行号(最多 max 条)+ 各自的一行上下文片段。
  function locateMatches(raw, needle, max) {
    const out = [];
    let from = 0, line = 1, last = 0, idx;
    while (out.length < max && (idx = raw.indexOf(needle, from)) >= 0) {
      line += countNl(raw.slice(last, idx)); last = idx;
      const ls = raw.lastIndexOf('\n', idx - 1) + 1;
      let le = raw.indexOf('\n', idx); if (le < 0) le = raw.length;
      out.push({ line, snippet: showWs(raw.slice(ls, le).replace(/\r$/, '')).slice(0, 160) });
      from = idx + Math.max(1, needle.length);
    }
    return out;
  }

  // 整段 oldText 的最接近窗口:按「窗口内与 oldText 逐行完全相等的行数」打分;一行都对不上时退回
  // 「用 oldText 里最有辨识度(最长)的一行做 Levenshtein」。返回 null 或 { start(0 起), matched, of, mismatch }。
  function closestWindow(fileLines, oldLines, scanCap, lev) {
    const k = oldLines.length;
    const scan = Math.min(fileLines.length, scanCap);
    let bestStart = -1, bestMatched = 0;
    if (k > 1) {
      const lim = Math.min(k, 200);
      for (let i = 0; i < scan; i += 1) {
        let m = 0;
        for (let j = 0; j < lim && i + j < fileLines.length; j += 1) if (fileLines[i + j] === oldLines[j] || fileLines[i + j].trim() === oldLines[j].trim()) m += 1;
        if (m > bestMatched) { bestMatched = m; bestStart = i; }
      }
    }
    let anchor = 0;
    for (let j = 1; j < k; j += 1) if (oldLines[j].trim().length > oldLines[anchor].trim().length) anchor = j;
    if (bestStart < 0) {
      // 退回:按最长行找最像的一行,窗口起点 = 该行 - anchor
      const needle = oldLines[anchor] || '';
      const lb = Math.min(needle.length, 500);
      let best = -1, bestDist = Infinity;
      for (let i = 0; i < scan; i += 1) {
        const la = Math.min(fileLines[i].length, 500);
        if (Math.abs(la - lb) >= bestDist) continue;
        const d = lev(needle, fileLines[i]);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best < 0) return null;
      bestStart = Math.max(0, best - anchor);
      bestMatched = 0;
      return { start: bestStart, matched: bestMatched, of: k, anchorLine: best + 1, anchorDistance: bestDist, mismatch: firstMismatch(fileLines, oldLines, bestStart) };
    }
    return { start: bestStart, matched: bestMatched, of: k, mismatch: firstMismatch(fileLines, oldLines, bestStart) };
  }
  function firstMismatch(fileLines, oldLines, start) {
    for (let j = 0; j < oldLines.length; j += 1) {
      const a = fileLines[start + j], b = oldLines[j];
      if (a === undefined) return { line: start + j + 1, expected: b.slice(0, 200), actual: null, column: 1, note: '文件在此之前已结束' };
      if (a === b) continue;
      let c = 0; while (c < a.length && c < b.length && a[c] === b[c]) c += 1;
      return { line: start + j + 1, oldTextLine: j + 1, column: c + 1, expected: showWs(b).slice(0, 200), actual: showWs(a).slice(0, 200) };
    }
    return null;
  }

  return Object.freeze({
    CHUNK_BYTES, SCAN_TOTALS_MAX_BYTES, ACCEPTED_ENCODINGS_TEXT,
    normalizeEncodingName, gb18030Supported, sniffEncoding, decodeBuffer, encodeText, UnencodableError,
    readTextWindow, readHead, writeFileAtomic, fsErrorEnvelope,
    findWhitespaceMatch, describeWsKinds, locateMatches, closestWindow, showWs,
  });
})();
