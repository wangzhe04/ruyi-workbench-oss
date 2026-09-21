'use strict';
// 假的【流式】识别组件(独立脚本,由如意按登记文件的 run 拉起,端口经 FAKE_STREAM_PORT 给到;本文件不 spawn 任何东西)。
// 照 ruyi-toolbox docs/02-asr-stream-plan.md §2 的会话 API:开会话／喂块回 partial+finals／finish／DELETE。
// 判据可预测:partial = 'p<累计字节>';每收到 3 块就收口一句「句N」;finish 收成「尾句」;时间轴按收到的字节算(ms = 字节/32)。
// (composer-voice-stream.browser.e2e.js 与 toolbox-discovery.e2e.js 各有一份内联的同款;新件用这里的,不再复制第三份。)
const http = require('http'), crypto = require('crypto');
const port = Number(process.env.FAKE_STREAM_PORT || 0);
const sessions = new Map();
let deleted = 0;
http.createServer((req, res) => {
  const j = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.url === '/health') return j(200, { ok: true, component: 'fake-stream-component', version: '0.0.1', loaded: true, sessions: sessions.size, deleted });
  const m = req.url.match(/^\/v1\/stream\/sessions(?:\/([0-9a-f]{32})(?:\/(audio|finish))?)?$/);
  if (!m) return j(404, { error: { message: 'no', type: 'not_found' } });
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && !m[1]) { const id = crypto.randomBytes(16).toString('hex'); sessions.set(id, { bytes: 0, chunks: 0, finals: 0, lastEnd: 0 }); return j(200, { id, sampleRate: 16000 }); }
    const s = sessions.get(m[1]);
    if (!s) return j(404, { error: { message: 'unknown', type: 'unknown_session' } });
    if (req.method === 'DELETE') { sessions.delete(m[1]); deleted += 1; res.writeHead(204); return res.end(); }
    if (m[2] === 'audio') {
      s.bytes += body.length; s.chunks += 1;
      const finals = [];
      if (s.chunks % 3 === 0) { s.finals += 1; finals.push({ text: '句' + s.finals, startMs: s.lastEnd, endMs: Math.round(s.bytes / 32) }); s.lastEnd = Math.round(s.bytes / 32); }
      return j(200, { partial: 'p' + s.bytes, finals });
    }
    if (m[2] === 'finish') { sessions.delete(m[1]); return j(200, { finals: [{ text: '尾句', startMs: s.lastEnd, endMs: Math.round(s.bytes / 32) }] }); }
    j(404, { error: { message: 'no', type: 'not_found' } });
  });
}).listen(port, '127.0.0.1');
