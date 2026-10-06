#!/usr/bin/env node
'use strict';
// 安全走查 S12 的静态锁:index.html 的 CSP 不再带 script-src 'unsafe-inline',唯一的内联脚本(首屏预绘:主题 / 界面模式 / 视角)
// 改用 CSP 哈希放行。哈希是那段 script 正文的 SHA-256 —— 谁改了那段脚本的任何一个字符,这里就红,并打印新值。
//   [H1] script-src 只有 'self' 与 'sha256-…',没有 'unsafe-inline' / 'unsafe-eval' / 外域 / 通配 / data: / blob:;
//   [H2] index.html 里每一段内联 script 的哈希都在 CSP 里(浏览器按 HTML 解析器归一换行后的 UTF-8 字节算,CRLF 检出也不影响);
//   [H3] CSP 里的每个哈希都对应一段真实存在的内联脚本(没有过期哈希赖着);
//   [H4] index.html 里没有内联事件处理属性(onclick= 之类)与 javascript: 链接(去掉 unsafe-inline 之后它们都会被拦);
//   [H5] 前端代码里没有动态造内联 script / 设 on* 属性 / eval / new Function(同上;vendor 不在此列);
//   [H6] 其余指令没被顺手放宽:connect-src 'self'、object-src 'none'、base-uri 'self'、form-action 'self'、default-src 'self'。
const { createRunner } = require('./lib/harness');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const t = createRunner('INLINE SCRIPT CSP HASH');
const { ok } = t;
const PUBLIC = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const normalized = html.replace(/\r\n?/g, '\n');   // HTML 输入流预处理:CR LF / CR 一律归一成 LF,再切出脚本正文
const withoutComments = normalized.replace(/<!--[\s\S]*?-->/g, '');

const csp = (normalized.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const directive = name => ((csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) || '').slice(name.length).trim());
const scriptSrc = directive('script-src').split(/\s+/).filter(Boolean);
const cspHashes = scriptSrc.filter(x => /^'sha256-[A-Za-z0-9+/=]+'$/.test(x)).map(x => x.slice(8, -1));

ok(Boolean(csp), 'H0 index.html 里有 CSP meta');
ok(scriptSrc.includes("'self'") && scriptSrc.every(x => x === "'self'" || /^'sha256-[A-Za-z0-9+/=]+'$/.test(x)),
  `H1 script-src 只有 'self' 与 sha256 哈希(实得 ${scriptSrc.join(' ')})`);
ok(!/unsafe-inline|unsafe-eval|strict-dynamic|\*|data:|blob:|https?:/.test(directive('script-src')), 'H1b script-src 里没有 unsafe-inline / unsafe-eval / 通配 / 外域');

const inline = [...withoutComments.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attrs: m[1], body: m[2] }));
ok(inline.length >= 1, `H2a 找到了内联脚本(${inline.length} 段)`);
const hashOf = body => crypto.createHash('sha256').update(body, 'utf8').digest('base64');
const missing = [];
for (const { body } of inline) if (!cspHashes.includes(hashOf(body))) missing.push(`'sha256-${hashOf(body)}'`);
ok(missing.length === 0, `H2 每段内联脚本的哈希都在 CSP 里${missing.length ? `(缺:把 ${missing.join(' ')} 写进 script-src,或改回外置脚本)` : ''}`);
const live = new Set(inline.map(s => hashOf(s.body)));
const stale = cspHashes.filter(h => !live.has(h));
ok(stale.length === 0, `H3 CSP 里没有过期哈希${stale.length ? `(多余:${stale.join(', ')})` : ''}`);
ok(inline.every(s => !/\btype\s*=\s*["']?module/i.test(s.attrs)), 'H2b 内联脚本是经典脚本(预绘必须同步跑在任何模块之前)');

const handlers = [...withoutComments.matchAll(/\s(on[a-z]{3,}\s*=)/gi)].map(m => m[1]);
ok(handlers.length === 0, `H4 index.html 没有内联事件处理属性(${handlers.join(', ') || '无'})`);
ok(!/javascript:/i.test(withoutComments), 'H4b index.html 没有 javascript: 链接');

const offenders = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
    if (!/\.js$/.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const rel = path.relative(PUBLIC, p).replace(/\\/g, '/');
    if (/setAttribute\(\s*['"]on[a-z]+['"]/i.test(src)) offenders.push(rel + ': setAttribute(on*)');
    if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) offenders.push(rel + ': eval / new Function');
    if (/createElement\(\s*['"]script['"]\s*\)/.test(src) && /\.(text|textContent|innerHTML)\s*=/.test(src.slice(src.search(/createElement\(\s*['"]script['"]\s*\)/), src.search(/createElement\(\s*['"]script['"]\s*\)/) + 600))) offenders.push(rel + ': 动态内联 script');
    if (/['"`]javascript:/.test(src)) offenders.push(rel + ': javascript: 字面量');
  }
};
walk(PUBLIC);
ok(offenders.length === 0, `H5 前端代码里没有依赖 unsafe-inline 的写法(${offenders.join('; ') || '无'})`);

ok(directive('default-src') === "'self'" && directive('connect-src') === "'self'" && directive('object-src') === "'none'"
  && directive('base-uri') === "'self'" && directive('form-action') === "'self'", 'H6 其余指令原样(default/connect/base-uri/form-action 是 self,object-src 是 none)');
ok(directive('style-src').includes("'unsafe-inline'"), 'H6b style-src 仍保留 unsafe-inline(界面大量 style= 属性,不在本次收紧范围;如要收紧须先清 style 属性)');

t.done({ exit: true });
