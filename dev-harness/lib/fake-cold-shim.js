'use strict';
// 133f:假的「冷启动」本地识别组件 —— 模拟真 asr-shim 与预热有关的全部行为,给 asr-warmup.e2e 与 composer-voice-warmup.browser.e2e 共用。
// 它是个独立脚本(由如意按登记文件的 run 拉起,端口经 FAKE_ASR_PORT 给到),不是 spawn 点:本文件不 spawn 任何东西。
//
// 行为(照 ruyi-toolbox/asr-shim 的真实形状):
//   · GET  /health                    只读状态、【不触发加载】:{component,model:'fake-auto',resolvedModel,loaded,loads,calls,unloads,lastModel,lastFileBytes}
//   · POST /v1/audio/transcriptions   multipart(model/file);没装着(或请求的是另一份)→ 先「加载」FAKE_COLD_LOAD_MS 毫秒再转;
//                                     串行(一把锁,和真 shim 一样:加载期间后来的请求排队);model=fake-auto 解析成 fake-small(像 auto 挑了小的)
//   · POST /v1/unload                 立刻卸载(control ignoreUnload=1 时装作卸了、其实没卸 —— 模拟「卸载那一发失败」)
//   · POST /control?fail=1&loadMs=N&ignoreUnload=1   测试专用旋钮:下一发转写回 500 / 改加载耗时 / 忽略卸载(如意从不打它)
const http = require('http');
const port = Number(process.env.FAKE_ASR_PORT || 0);
let loadMs = Number(process.env.FAKE_COLD_LOAD_MS || 1500);
const st = { loaded: false, loadedModel: '', loads: 0, calls: 0, unloads: 0, lastModel: '', lastFileBytes: 0, failNext: false, ignoreUnload: false };
let lock = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const resolveModel = m => (!m || m === 'fake-auto' ? 'fake-small' : m);

// 极简 multipart:latin1 保字节长度一一对应。回 { model, fileBytes }。
function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/i.exec(String(contentType || ''));
  const out = { model: '', fileBytes: 0 };
  if (!m) return out;
  const text = buf.toString('latin1');
  for (const part of text.split('--' + m[1].trim())) {
    const cut = part.indexOf('\r\n\r\n');
    if (cut < 0) continue;
    const head = part.slice(0, cut), body = part.slice(cut + 4).replace(/\r\n$/, '');
    if (/name="model"/.test(head)) out.model = body.trim();
    if (/name="file"/.test(head)) out.fileBytes = body.length;
  }
  return out;
}

http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    return json(200, { ok: true, component: 'fake-cold-shim', version: '0.0.1', pid: process.pid, model: 'fake-auto', resolvedModel: st.loadedModel || 'fake-auto',
      loaded: st.loaded, loads: st.loads, calls: st.calls, unloads: st.unloads, lastModel: st.lastModel, lastFileBytes: st.lastFileBytes });
  }
  if (req.method === 'POST' && url.pathname === '/control') {
    if (url.searchParams.has('fail')) st.failNext = url.searchParams.get('fail') === '1';
    if (url.searchParams.has('loadMs')) loadMs = Number(url.searchParams.get('loadMs')) || 0;
    if (url.searchParams.has('ignoreUnload')) st.ignoreUnload = url.searchParams.get('ignoreUnload') === '1';
    return json(200, { ok: true, loadMs, ...st });
  }
  if (req.method === 'POST' && url.pathname === '/v1/unload') {
    st.unloads += 1;
    if (!st.ignoreUnload) { st.loaded = false; st.loadedModel = ''; }
    return json(200, { ok: true, unloaded: !st.ignoreUnload, loaded: st.loaded });
  }
  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const parsed = parseMultipart(Buffer.concat(chunks), req.headers['content-type']);
      lock = lock.then(async () => {
        if (st.failNext) { st.failNext = false; return json(500, { error: { message: 'boom: 模型加载失败', type: 'engine_error' } }); }
        const want = resolveModel(parsed.model);
        if (!st.loaded || st.loadedModel !== want) {
          st.loaded = false;   // 换模型:先卸后载,加载期间 /health 说 loaded:false(真 shim 同)
          await sleep(loadMs);
          st.loaded = true; st.loadedModel = want; st.loads += 1;
        }
        st.calls += 1; st.lastModel = parsed.model; st.lastFileBytes = parsed.fileBytes;
        return json(200, { text: '[fake-cold] model=' + want + ' bytes=' + parsed.fileBytes });
      }).catch(() => { try { json(500, { error: { message: 'internal' } }); } catch { /* 已答 */ } });
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
}).listen(port, '127.0.0.1');
