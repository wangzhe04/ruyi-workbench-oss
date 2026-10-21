'use strict';
// Actual generated API and production Markdown/Mermaid rendering, synthetic
// scope vault and isolated Edge. No Clipboard permission grant or image upload.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { CdpClient, waitForTarget } = require('./lib/browser-fixture');
const { findBrowserExecutable } = require('./lib/browser-path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');
const { getFreePort } = require('./free-port');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mermaid-export-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'PrivacyTextExports', 'handleApi', 'serveStatic', 'send', 'createSession', 'saveSession', 'loadSession', 'mutateConfig', 'readConfig'], { withEval: true });
const vault = require('./lib/privacy-test-fixture').fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const t = createRunner('PRIVACY MERMAID EXPORT'), { ok } = t;
const secret = 'SYNTHETIC_MERMAID_PRIVATE_SENTINEL', diagram = 'flowchart LR\n  A["' + secret + '"] --> B["public"]\n';
const markdown = 'Public preface\n\n```mermaid\n' + diagram + '```\n\nPublic ending';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, base, browser, profile, cdp, onHold, serial = 0;
// Preserve all eagerly materialized clipboard formats solely in the STA helper's
// memory. Its stdout carries only readiness/restore markers or our new test text.
let clipboardGuard;
async function preserveClipboard() {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference='Stop'
$old=[Windows.Forms.Clipboard]::GetDataObject()
$saved=New-Object Windows.Forms.DataObject
if($null -ne $old){foreach($format in $old.GetFormats($false)){
  $value=$old.GetData($format,$false)
  if($value -is [IO.MemoryStream]){$value=New-Object IO.MemoryStream(,$value.ToArray())}
  elseif($value -is [ICloneable]){$value=$value.Clone()}
  $saved.SetData($format,$false,$value)
}}
[Console]::WriteLine('READY')
while($null -ne ($command=[Console]::ReadLine())){
  if($command -eq 'READ'){[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Windows.Forms.Clipboard]::GetText())))}
  elseif($command -eq 'RESTORE'){if($null -eq $old){[Windows.Forms.Clipboard]::Clear()}else{[Windows.Forms.Clipboard]::SetDataObject($saved,$true)};[Console]::WriteLine('RESTORED');break}
}`;
  const child=cp.spawn('powershell.exe',['-NoProfile','-STA','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=[], pending=[];let buffer='';
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();for(let at;(at=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);const resolve=pending.shift();if(resolve)resolve(line);else lines.push(line);}});
  const line=()=>Promise.race([lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>pending.push(resolve)),sleep(10000).then(()=>{throw Error('Clipboard preservation helper timeout');})]);
  if(await line()!=='READY')throw Error('Clipboard could not be preserved');
  clipboardGuard={child,read:async()=>{child.stdin.write('READ\n');return Buffer.from(await line(),'base64').toString('utf8');},restore:async()=>{child.stdin.write('RESTORE\n');if(await line()!=='RESTORED')throw Error('Clipboard restoration failed');}};
}
async function mode(privacyModeV1) {
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1, privacyRulesV1: [], providers: [], credentialEncryptionV1: true, activeProvider: '', stewardEnabledV1: false, schedulerEnabledV1: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false } }));
}
const privacy = config => ({ mode: config.privacyModeV1 || 'off', technical: config.privacyTechnicalV1 === true, rules: config.privacyRulesV1 || [] });
async function request(body) {
  const response = await fetch(base + '/api/privacy/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': 'synthetic-mermaid-token' }, body: JSON.stringify(body) });
  const value = await response.json(); return { status: response.status, value };
}
const consume = response => request({ op: 'validate', proof: response.value.proof, hash: response.value.hash });
async function seed(slot = 'content', document = markdown) {
  const session = await app.createSession({ title: 'Synthetic Mermaid ' + (++serial), cwd: root });
  const message = { role: 'assistant', createdAt: new Date().toISOString(), turnSeq: 1, content: slot === 'content' ? document : '' };
  if (slot !== 'content') message.segments = [{ type: slot === 'segment-text' ? 'text' : 'plan', ...(slot === 'segment-text' ? { text: document } : { markdown: document, status: 'complete' }) }];
  session.messages = [message]; await app.saveSession(session);
  await app.PrivacyGateway.withPolicy(session.id, () => app.PrivacyGateway.toolResult({ password: secret }));
  return session;
}
async function bodyFor(session, slot = 'content', extra = {}) {
  const message = session.messages[0];
  const response = await fetch(base + '/api/sessions/' + encodeURIComponent(session.id), { headers: { 'x-wcw-token': 'synthetic-mermaid-token' } });
  const displayed = (await response.json()).session.messages[0], document = slot === 'content' ? displayed.content : displayed.segments[0][slot === 'segment-text' ? 'text' : 'markdown'];
  return { kind: 'mermaid-document', sessionId: session.id, messageIndex: 0,
    messageIdentity: { id: message.id || '', role: message.role, createdAt: message.createdAt || '', turnSeq: message.turnSeq ?? null }, slot,
    ...(slot === 'content' ? {} : { segmentIndex: 0 }), expectedDocumentHash: hash(document), expectedPrivacy: privacy(await app.readConfig()), format: 'svg', ...extra };
}
async function waitValue(expression, attempts = 240) {
  for (let i = 0; i < attempts; i++) { const value = await cdp.evaluate(expression); if (value) return value; await sleep(25); }
  throw new Error('Timed out: ' + expression.slice(0, 160));
}
async function click(selector) {
  const box = await cdp.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('Missing target'); n.scrollIntoView({block:'center'}); const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}
async function mount(session, slot = 'content', options = {}) {
  await cdp.evaluate(`window.fixtureMount(${JSON.stringify(session.id)}, ${JSON.stringify(privacy(await app.readConfig()))}, ${JSON.stringify(options)}).then(() => true)`);
  await waitValue(`document.querySelector('#diagrams .mermaid-block[data-mermaid-state="ok"]') ? true : null`);
}
const downloadDir = path.join(root, 'downloads'); fs.mkdirSync(downloadDir);
async function downloaded(selector, extension) {
  const before = new Set(fs.readdirSync(downloadDir)); await click(selector);
  for (let i = 0; i < 300; i++) {
    const name = fs.readdirSync(downloadDir).find(name => !before.has(name) && name.endsWith(extension));
    if (name) return { name, bytes: fs.readFileSync(path.join(downloadDir, name)) };
    const failed = await cdp.evaluate(`window.fixtureFailure || null`); if (failed) throw Error(failed);
    await sleep(25);
  }
  throw Error('No actual download ' + extension);
}
(async () => {
  app.__eval("RUNTIME.token='synthetic-mermaid-token'");
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://fixture').pathname;
      if (pathname === '/mermaid-fixture') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><meta name="wcw-token" content="synthetic-mermaid-token"><link rel="stylesheet" href="/styles.css"><script src="/vendor/marked.min.js"></script><script src="/vendor/highlight.min.js"></script><div id="diagrams" style="width:760px"></div><textarea id="paste"></textarea><div id="toastTray"></div>'); }
      else if (pathname === '/fixture-hold') { if (onHold) { const hook = onHold; onHold = null; await hook(); } res.end('{}'); }
      else if (pathname.startsWith('/api/')) await app.handleApi(req, res, pathname);
      else app.send(res, await app.serveStatic(pathname, req));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  for (const value of ['off', 'basic', 'enhanced', 'strict']) {
    await mode(value);
    for (const slot of ['content', 'segment-text', 'segment-markdown']) {
      const session = await seed(slot), body = await bodyFor(session, slot), prepared = await request(body);
      ok(prepared.status === 200 && (value === 'off' ? prepared.value.content === markdown : !prepared.value.content.includes(secret)), `${value}/${slot} host projects the complete canonical document before any fence extraction`);
      ok((await consume(prepared)).status === 200, `${value}/${slot} one-time proof validates current source and policy`);
      const plain = await request({ ...body, plaintext: true });
      ok(plain.status === 200 && plain.value.content === markdown, `${value}/${slot} explicit plaintext is one canonical copy`); await consume(plain);
    }
  }
  await mode('enhanced');
  const canonical = await seed(), body = await bodyFor(canonical);
  for (const mutation of [{ messageIndex: 1 }, { messageIdentity: { ...body.messageIdentity, turnSeq: 2 } }, { slot: 'arbitrary-field' }, { expectedDocumentHash: 'f'.repeat(64) }, { sessionId: '../outside' }]) {
    ok((await request({ ...body, ...mutation })).status !== 200, 'forged canonical locator/hash cannot authorize a diagram source');
  }
  { const prepared = await request(body); await mode('off'); await mode('enhanced'); ok((await consume(prepared)).status !== 200, 'host proof rejects ON→OFF→ON even after signature returns'); }
  { await mode('off'); const localBody = { kind: 'mermaid-document', localDocument: diagram, expectedDocumentHash: hash(diagram), expectedPrivacy: privacy(await app.readConfig()), format: 'copy' }; const prepared = await request(localBody); ok(prepared.status === 200 && prepared.value.content === diagram, 'OFF-only source-less input remains a local literal copy without restoration authority'); await mode('basic'); ok((await consume(prepared)).status !== 200 && (await request({ ...localBody, expectedPrivacy: privacy(await app.readConfig()) })).status !== 200, 'OFF source-less proof opt-in and ON source-less requests both refuse'); }
  await mode('enhanced');
  const cross = 'cross-before\n```mermaid\n' + diagram + '```\ncross-after';
  const spanning = await seed('content', cross); await app.PrivacyGateway.withPolicy(spanning.id, () => app.PrivacyGateway.toolResult({ password: cross }));
  { const prepared = await request(await bodyFor(spanning)); ok(prepared.status === 200 && !prepared.value.content.includes(secret) && !prepared.value.content.includes('```'), 'sensitive span crossing fence boundaries is protected as one whole document'); await consume(prepared); }
  await preserveClipboard();
  const executable = findBrowserExecutable(); if (!executable) throw Error('Browser unavailable');
  const debugPort = await getFreePort(); profile = path.join(root, 'browser-profile');
  browser = cp.spawn(executable, ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, base + '/mermaid-fixture'], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, base + '/mermaid-fixture', browser); if (!target.target) throw Error(target.why);
  cdp = new CdpClient(target.target.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Page.bringToFront');
  await waitValue(`document.readyState === 'complete' && !!globalThis.marked`);
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await cdp.evaluate(`(async () => {
    const { state } = await import('/js/state.js'), util = await import('/js/util.js'), i18n = await import('/js/i18n.js'); await i18n.setLocale('zh-CN');
    const runtime = await import('/js/mermaid-runtime.js'), { createChatRenderPrimitives } = await import('/js/chat-render-primitives.js'), { createChatStaticRenderer } = await import('/js/chat-static-renderer.js'), narrative = await import('/js/turn-narrative.js');
    const primitives = createChatRenderPrimitives({ ...util, state, t:i18n.t, tCount:i18n.tCount, marked:globalThis.marked, hljs:globalThis.hljs, isProviderMode:()=>true, engineVisual:()=>({label:'Fixture',colorVar:'var(--accent)'}), renderMermaidBlocks:(node,opts)=>runtime.renderMermaidBlocks(node,{...opts,privacyMode:()=>state.config?.privacyModeV1||'off',exportSnapshot:()=>({sessionId:state.currentSession?.id,privacy:{mode:state.config?.privacyModeV1||'off',technical:state.config?.privacyTechnicalV1===true,rules:state.config?.privacyRulesV1||[]}})}) });
    const renderer = createChatStaticRenderer({ ...util, ...primitives, t:i18n.t, tCount:i18n.tCount, normalizeTurnSegments:narrative.normalizeTurnSegments, turnToolAnchorId:narrative.turnToolAnchorId, bindMermaidDocument:runtime.bindMermaidDocument, turnSummaryCard:()=>document.createElement('div'), turnArtifactChips:()=>null });
    window.fixtureState=state; window.fixtureResponses=[]; window.fixtureClipboard=[]; window.fixtureFailure=''; window.fixtureHold='';
    const realFetch=window.fetch; window.fetch=async(...args)=>{const url=String(args[0]),body=args[1]?.body?JSON.parse(args[1].body):null; if(url.includes('/api/privacy/export') && body?.op==='validate' && window.fixtureHold==='validate'){window.fixtureHold='';await realFetch('/fixture-hold');} const response=await realFetch(...args);if(url.includes('/api/privacy/export')){const data=await response.clone().json();window.fixtureResponses.push({body,status:response.status,data});if(response.status!==200)window.fixtureFailure=JSON.stringify(data);}return response;};
    const nativeWrite=navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write=items=>{const entry={done:false,failed:false};window.fixtureClipboard.push(entry);const result=nativeWrite(items);result.then(async()=>{entry.text=await(await items[0].getType('text/plain')).text();entry.done=true;},()=>{entry.failed=true;});return result;};
    const nativeRender = (await runtime.ensureMermaid()).render.bind(globalThis.mermaid); globalThis.mermaid.render=async(...args)=>{if(window.fixtureHold==='render'){window.fixtureHold='';await realFetch('/fixture-hold');}return nativeRender(...args);};
    const nativeBlob=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(window.fixtureHold==='toBlob'){window.fixtureHold='';realFetch('/fixture-hold').then(()=>nativeBlob.call(this,callback,...args));}else nativeBlob.call(this,callback,...args);};
    window.fixtureMount=async(id,privacy,options={})=>{const response=await realFetch('/api/sessions/'+encodeURIComponent(id),{headers:{'x-wcw-token':'synthetic-mermaid-token'}});state.currentSession=(await response.json()).session;state.config={privacyModeV1:privacy.mode,privacyTechnicalV1:privacy.technical,privacyRulesV1:privacy.rules};window.fixtureResponses=[];window.fixtureFailure='';window.fixtureHold='';const host=document.getElementById('diagrams');host.replaceChildren(renderer.renderStaticMessage(state.currentSession.messages[0],'fixture','fixture',{...(options.unbound?{}:{sessionId:id,messageIndex:0}),...(options.running?{running:true}:{})}));};
    return true;
  })()`);
  const button = index => '#diagrams .mermaid-tools > button:nth-child(' + index + ')';
  // Hold the actual first lazy module request after a real default SVG click.
  // Both host and known browser mode change before the module can sample state.
  {
    await mode('enhanced'); const session=await seed(); await mount(session); let paused;
    cdp.on('Fetch.requestPaused', event => { paused=event.requestId; });
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*privacy-export.js',requestStage:'Request'}]});
    const before=fs.readdirSync(downloadDir).length; await click(button(4));
    for(let i=0;i<200&&!paused;i++)await sleep(25); if(!paused)throw Error('Lazy export module was not intercepted');
    await mode('off'); await cdp.evaluate('window.fixtureState.config.privacyModeV1="off",true');
    await cdp.send('Fetch.continueRequest',{requestId:paused});await cdp.send('Fetch.disable');
    await waitValue(`document.getElementById('toastTray').textContent.includes('导出') ? true : null`);
    ok(fs.readdirSync(downloadDir).length===before && await cdp.evaluate('window.fixtureResponses.length===0'), 'synchronous ON click intent survives held first lazy import and refuses a newly sampled OFF state');
  }
  for (const value of ['off', 'basic', 'enhanced', 'strict']) {
    await mode(value); const session = await seed(); await mount(session);
    // Inject private metadata into the locally restored DOM: exported SVG must
    // be an independent render and never clone this hidden original layer.
    await cdp.evaluate(`document.querySelector('#diagrams .mermaid-view svg').insertAdjacentHTML('beforeend','<metadata>LOCAL_ONLY_PRIVATE_METADATA</metadata>'),true`);
    const before = await cdp.evaluate('window.fixtureClipboard.length'); await click(button(2));
    const copied = await waitValue(`window.fixtureClipboard[${before}]?.done || window.fixtureClipboard[${before}]?.failed ? window.fixtureClipboard[${before}] : null`);
    ok(copied.done && (value === 'off' ? copied.text === diagram : !copied.text.includes(secret)), `${value} real user click completes native promise-based clipboard write without permission grants`);
    const systemText=await clipboardGuard.read();
    ok(copied.done && systemText.replace(/\r\n/g,'\n') === copied.text.replace(/\r\n/g,'\n'), `${value} actual system clipboard contains the synthetic validated source (Windows newline normalization)`);
    const svg = await downloaded(button(4), '.svg');
    ok(!svg.bytes.includes(Buffer.from('LOCAL_ONLY_PRIVATE_METADATA')) && (value === 'off' ? svg.bytes.includes(Buffer.from(secret)) : !svg.bytes.includes(Buffer.from(secret))), `${value} actual SVG source/metadata uses an independent protected-source render`);
    const png = await downloaded(button(5), '.png');
    const pixels = await cdp.evaluate(`(async()=>{
      const decode=async(type,base64)=>{const blob=await(await fetch('data:'+type+';base64,'+base64)).blob();const image=new Image();await new Promise((yes,no)=>{image.onload=yes;image.onerror=no;image.src='data:'+type+';base64,'+base64;});return {blob,image};};
      const svg=await decode('image/svg+xml',${JSON.stringify(svg.bytes.toString('base64'))}), png=await decode('image/png',${JSON.stringify(png.bytes.toString('base64'))});
      const pixels=image=>{const canvas=document.createElement('canvas');canvas.width=png.image.width;canvas.height=png.image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,canvas.width,canvas.height);return ctx.getImageData(0,0,canvas.width,canvas.height).data;};
      const a=pixels(svg.image),b=pixels(png.image);let different=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])different++;return {width:png.image.width,height:png.image.height,different};
    })()`);
    ok(pixels.width > 0 && pixels.height > 0 && pixels.different === 0, `${value} actual PNG pixels match independent rasterization of the protected SVG counterpart`);
    ok(await cdp.evaluate('window.fixtureResponses.filter(x=>x.body.op!=="validate").every(x=>x.body.plaintext!==true)'), `${value} ordinary source/SVG/PNG actions stay single-click protected defaults`);
  }
  await mode('enhanced');
  {
    const session=await seed('segment-markdown');
    const alias=(await app.PrivacyGateway.withPolicy(session.id,()=>app.PrivacyGateway.toolResult({password:secret}))).password;
    session.messages[0].segments[0].markdown='```mermaid\nflowchart LR\nA["'+alias+'"] --> B["public"]\n```';await app.saveSession(session);await mount(session,'segment-markdown');
    const svg=await downloaded(button(4),'.svg');ok(!svg.bytes.includes(Buffer.from(secret)), 'actual GET literal plan alias matches canonical display provenance and exports protected SVG');
  }
  {
    const session=await seed();const alias=(await app.PrivacyGateway.withPolicy(session.id,()=>app.PrivacyGateway.toolResult({password:secret}))).password;
    session.messages[0].content=JSON.stringify({note:alias}).replaceAll('[','\\u005b').replaceAll(']','\\u005d');await app.saveSession(session);
    const prepared=await request(await bodyFor(session));ok(prepared.status===200&&!prepared.value.content.includes(secret), 'actual GET JSON-escaped content projection matches the host expected display hash');await consume(prepared);
  }
  for (const slot of ['segment-text', 'segment-markdown']) { const session = await seed(slot); await mount(session,slot); const svg=await downloaded(button(4),'.svg');ok(!svg.bytes.includes(Buffer.from(secret)), `${slot} actual pre-highlight locator authorizes only its canonical Markdown slot`); }
  for (const source of ['~~~mermaid\n'+diagram+'~~~', '> ```mermaid\n'+diagram.trimEnd().split('\n').map(line=>'> '+line).join('\n')+'\n> ```', '- diagram\n\n  ```mermaid\n'+diagram.trimEnd().split('\n').map(line=>'  '+line).join('\n')+'\n  ```']) { const session=await seed('content',source);await mount(session);const svg=await downloaded(button(4),'.svg');ok(!svg.bytes.includes(Buffer.from(secret)), 'existing marked parser handles tilde/blockquote/list fences without a backend grammar'); }
  { const session=await seed();await mount(session);await click('#diagrams .mermaid-plain-menu > summary');const svg=await downloaded('#diagrams .mermaid-plain-menu > button:nth-of-type(2)','.svg');ok(svg.bytes.includes(Buffer.from(secret)), 'explicit plaintext menu makes only the selected canonical SVG copy');const safe=await downloaded(button(4),'.svg');ok(!safe.bytes.includes(Buffer.from(secret)), 'next ordinary export returns to the protected default without a preference change'); }
  { const session=await seed();await mount(session,'content',{unbound:true});ok(await cdp.evaluate(`document.querySelectorAll('#diagrams .mermaid-tools > button:disabled').length===3 && !!document.querySelector('#diagrams .mermaid-tools > button:nth-child(3):not(:disabled)')`), 'ON source-less view keeps local viewing but disables copy/SVG/PNG without ambient session authority'); }
  { await mode('off');const session=await seed();await mount(session,'content',{unbound:true});const svg=await downloaded(button(4),'.svg');ok(svg.bytes.includes(Buffer.from(secret)), 'OFF source-less local view keeps literal independent-render export through a policy-only proof'); }
  await mode('enhanced');
  for (const stage of ['render','toBlob','validate']) {
    const session=await seed();await mount(session);const before=fs.readdirSync(downloadDir).length;
    onHold=async()=>{const current=await app.loadSession(session.id);current.messages[0].content+='\nchanged while preparing';await app.saveSession(current);};
    await cdp.evaluate(`window.fixtureHold=${JSON.stringify(stage)},true`);await click(button(stage==='toBlob'?5:4));
    await waitValue('window.fixtureFailure || null');await sleep(80);
    ok(fs.readdirSync(downloadDir).length===before, `canonical source mutation during ${stage} refuses before any download`);
  }
  for(const change of ['unmount','session','dom-source']){
    const session=await seed();await mount(session);const before=fs.readdirSync(downloadDir).length;
    onHold=()=>cdp.evaluate(change==='unmount'?`document.getElementById('diagrams').replaceChildren(),true`:change==='session'?`window.fixtureState.currentSession={id:'different-session'},true`:`document.querySelector('#diagrams code.language-mermaid').textContent+='changed',true`);
    await cdp.evaluate(`document.getElementById('toastTray').replaceChildren();window.fixtureHold='render';true`);await click(button(4));
    await waitValue(`document.getElementById('toastTray').textContent.includes('导出') ? true : null`);
    ok(fs.readdirSync(downloadDir).length===before, `${change} during independent render refuses the stale artifact before download`);
  }
  {await mount(spanning);const before=fs.readdirSync(downloadDir).length;await cdp.evaluate(`document.getElementById('toastTray').replaceChildren(),true`);await click(button(4));await waitValue(`document.getElementById('toastTray').textContent.includes('导出') ? true : null`);ok(fs.readdirSync(downloadDir).length===before,'whole-document projection changing fence structure refuses rather than rendering an original fallback');}
  for (const next of ['off','strict']) {
    const session=await seed();await mount(session);const before=fs.readdirSync(downloadDir).length;
    onHold=()=>mode(next);await cdp.evaluate('window.fixtureHold="validate",true');await click(button(4));await waitValue('window.fixtureFailure || null');await sleep(80);
    ok(fs.readdirSync(downloadDir).length===before, `policy change to ${next} during validation cannot fall back to the original SVG`);await mode('enhanced');
  }
  // The shared b1 action sends its known privacy snapshot even before the first
  // host request: another window turning protection off must not release raw.
  { const session=await seed();await mount(session);await mode('off');const before=fs.readdirSync(downloadDir).length;
    await cdp.evaluate(`(async()=>{const {downloadPrivacyExport}=await import('/js/privacy-export.js');window.sharedTextDone=false;const b=document.createElement('button');b.id='shared-text';b.textContent='export';b.onclick=()=>downloadPrivacyExport({kind:'session',format:'md',sessionId:${JSON.stringify(session.id)}}).then(value=>{window.sharedTextResult=value;window.sharedTextDone=true;});document.body.append(b);return true;})()`);
    await click('#shared-text');await waitValue('window.sharedTextDone');ok(await cdp.evaluate('window.sharedTextResult===null') && fs.readdirSync(downloadDir).length===before, 'b1 known-ON browser rejects a host already OFF before prepare rather than downloading raw');
  }
})().catch(error => { console.error(error.stack || error); t.fail('uncaught Mermaid export fixture error'); }).finally(async () => {
  if(cdp)await cdp.close();if(browser)await killOwnTree(browser);if(profile)stopRuyiTestBrowsers(profile);
  if(clipboardGuard){try{await clipboardGuard.restore();}finally{await killOwnTree(clipboardGuard.child);}}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}vault.clear();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});t.done();
});
