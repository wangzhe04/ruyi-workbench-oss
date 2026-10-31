#!/usr/bin/env node
'use strict';
// A local synthetic fixture, not a complete workbench UI acceptance test.
const http = require('node:http');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) throw new Error('Pass the compiled native probe executable');
const root = path.resolve(__dirname, '../..');
const token = crypto.randomBytes(16).toString('hex');
const html = `<!doctype html><meta charset="utf-8"><div id="markdown"></div><div id="diagram"></div>
<script src="/marked.js"></script><script src="/mermaid.js"></script><script>
(async()=>{
 const results={scope:'WKWebView synthetic loopback fixture; no real microphone or workbench data'};
 try {
  results.unauthenticatedDenied=(await fetch('/protected')).status===403;
  const bootstrap=await (await fetch('/bootstrap',{method:'POST'})).json();
  results.bootstrap=typeof bootstrap.token==='string';
  results.authenticatedFetch=(await fetch('/protected',{headers:{'x-p0-token':bootstrap.token}})).status===200;
  results.sse=await new Promise((resolve,reject)=>{
   const es=new EventSource('/events'); let seen=[];
   const timer=setTimeout(()=>{es.close();reject(new Error('SSE timeout'));},5000);
   es.onmessage=e=>{seen.push(JSON.parse(e.data).seq);if(seen.length===3){clearTimeout(timer);es.close();resolve(seen.join(',')==='1,2,3');}};
   es.onerror=()=>{clearTimeout(timer);es.close();reject(new Error('SSE connection'));};
  });
  const form=new FormData();form.append('file',new Blob(['P0 upload 中文'],{type:'text/plain'}),'sample.txt');
  results.upload=(await (await fetch('/upload',{method:'POST',headers:{'x-p0-token':bootstrap.token},body:form})).json()).ok===true;
  document.getElementById('markdown').innerHTML=marked.parse('# P0 中文\\n\\n**bold**');
  results.markdown=document.querySelector('#markdown h1').textContent==='P0 中文' && !!document.querySelector('#markdown strong');
  mermaid.initialize({startOnLoad:false,securityLevel:'strict'});
  const diagram=await mermaid.render('p0-diagram','graph TD; A[Start] --> B[Finish]');
  document.getElementById('diagram').innerHTML=diagram.svg;
  results.mermaid=!!document.querySelector('#diagram svg');
  results.media={secureContext:window.isSecureContext,getUserMedia:!!navigator.mediaDevices?.getUserMedia,
   audioContext:!!(window.AudioContext||window.webkitAudioContext),
   webmOpus:!!window.MediaRecorder?.isTypeSupported('audio/webm;codecs=opus'),
   mp4:!!window.MediaRecorder?.isTypeSupported('audio/mp4'),microphoneRequested:false};
  results.ok=['unauthenticatedDenied','bootstrap','authenticatedFetch','sse','upload','markdown','mermaid'].every(k=>results[k]===true);
 }catch(e){results.ok=false;results.error=String(e.message||e).slice(0,300);}
 window.webkit.messageHandlers.p0.postMessage(results);
})();</script>`;
const server = http.createServer((req, res) => {
  const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body); };
  if (req.url === '/') return send(200, 'text/html; charset=utf-8', html);
  const vendors = { '/marked.js': 'marked.min.js', '/mermaid.js': 'mermaid.min.js' };
  if (vendors[req.url]) return send(200, 'text/javascript', fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/vendor', vendors[req.url])));
  if (req.url === '/bootstrap' && req.method === 'POST') return send(200, 'application/json', JSON.stringify({ token }), { 'set-cookie': `p0=${token}; HttpOnly; SameSite=Strict; Path=/` });
  const authorized = req.headers['x-p0-token'] === token;
  if (req.url === '/protected') return send(authorized ? 200 : 403, 'application/json', JSON.stringify({ ok: authorized }));
  if (req.url === '/events') {
    if (req.headers.cookie !== `p0=${token}`) return send(403, 'text/plain', 'denied');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let seq = 0;
    const timer = setInterval(() => { res.write(`data: ${JSON.stringify({ seq: ++seq })}\n\n`); if (seq === 3) { clearInterval(timer); res.end(); } }, 100);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/upload' && req.method === 'POST' && authorized) {
    const chunks = []; let bytes = 0;
    req.on('data', data => { bytes += data.length; if (bytes > 65536) req.destroy(); else chunks.push(data); });
    req.on('end', () => send(200, 'application/json', JSON.stringify({ ok: Buffer.concat(chunks).includes(Buffer.from('P0 upload 中文')) })));
    return;
  }
  send(404, 'text/plain', 'not found');
});
server.listen(0, '127.0.0.1', () => {
  const child = cp.spawn(binary, ['webview', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let result = '', diagnostics = '';
  child.stdout.on('data', data => { result = (result + data).slice(-65536); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-16384); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 50000);
  child.on('error', error => { diagnostics += error.code; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    server.closeAllConnections(); server.close();
    let parsed;
    try { parsed = JSON.parse(result.trim()); } catch { parsed = { ok: false, error: 'invalid_native_output' }; }
    console.log(JSON.stringify({ exitCode: code, signal, timedOut, result: parsed, diagnostics }, null, 2));
    process.exitCode = code === 0 && !timedOut && parsed.ok ? 0 : 1;
  });
});
