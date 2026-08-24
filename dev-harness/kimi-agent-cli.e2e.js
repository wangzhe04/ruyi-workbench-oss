// Kimi Code Agent CLI adapter contract: config selection, npm-shim escape hatch, native JSONL parsing,
// and settings surface. This test is credential-free and does not invoke the real Kimi service.
'use strict';
const fs = require('fs');
const cp = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const server = require(path.join(WB, 'app', 'server.js'));

let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
};

const normalized = server.normalizeConfig({ agentCliType: 'kimi', kimiPath: '  X:\\tools\\kimi.cmd  ' }).config;
ok(normalized.agentCliType === 'kimi', 'config preserves Kimi driver selection');
ok(normalized.kimiPath === 'X:\\tools\\kimi.cmd', 'config normalizes Kimi launcher path');
ok(server.normalizeConfig({ agentCliType: 'kimi', model: 'k3-256k' }).config.model === 'kimi-code/k3-256k', 'legacy bare Kimi model migrates to its native alias');
ok(server.normalizeConfig({ agentCliType: 'unknown' }).config.agentCliType === 'claude', 'unknown driver falls back to Claude');
ok(Object.keys(server.AGENT_CLI_TYPES).join(',') === 'claude,kimi', 'driver registry contains only Claude and Kimi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-adapter-'));
try {
  const bin = path.join(tmp, 'node_modules', '.bin');
  const entry = path.join(tmp, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(entry, '');
  const shim = path.join(bin, 'kimi.cmd');
  fs.writeFileSync(shim, '');
  const spawn = server.prepareAgentCliSpawn('kimi', shim, ['--version']);
  ok(path.resolve(spawn.command) === path.resolve(process.execPath), 'Kimi npm shim resolves to direct Node launch');
  ok(path.resolve(spawn.args[0]) === path.resolve(entry) && spawn.args[1] === '--version', 'direct launch preserves entrypoint and args');
  const globalRoot = path.join(tmp, 'global-npm');
  const globalEntry = path.join(globalRoot, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  fs.mkdirSync(path.dirname(globalEntry), { recursive: true });
  fs.writeFileSync(globalEntry, '');
  const globalShim = path.join(globalRoot, 'kimi.cmd');
  fs.writeFileSync(globalShim, '');
  const globalSpawn = server.prepareAgentCliSpawn('kimi', globalShim, ['--version']);
  ok(path.resolve(globalSpawn.args[0]) === path.resolve(globalEntry), 'global npm shim layout also resolves directly');
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin + path.delimiter + String(originalPath || '');
    const bareSpawn = server.prepareAgentCliSpawn('kimi', 'kimi.cmd', ['--version']);
    ok(path.resolve(bareSpawn.command) === path.resolve(process.execPath), 'bare Kimi command resolves its shim from PATH');
    ok(path.resolve(bareSpawn.args[0]) === path.resolve(entry), 'bare PATH shim bypasses cmd.exe through the package entrypoint');
  } finally {
    process.env.PATH = originalPath;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const version = server.parseAgentCliEvent({ role: 'meta', type: 'system.version', version: '0.37.2' }, 'kimi');
ok(Array.isArray(version) && version.length === 0, 'version metadata is accepted without chat output');
const resume = server.parseAgentCliEvent({ role: 'meta', type: 'session.resume_hint', session_id: 'abc' }, 'kimi');
ok(resume[0]?.kind === 'init' && resume[0]?.sessionId === 'abc', 'resume hint binds native Kimi session');
const assistant = server.parseAgentCliEvent({ role: 'assistant', content: 'done', tool_calls: [{ id: 't1', function: { name: 'ReadFile', arguments: '{"path":"a"}' } }] }, 'kimi');
ok(assistant[0]?.kind === 'text' && assistant[0]?.text === 'done', 'assistant content becomes text');
ok(assistant[1]?.kind === 'tool_use' && assistant[1]?.name === 'ReadFile' && assistant[1]?.input?.path === 'a', 'Kimi function call becomes tool event');
const tool = server.parseAgentCliEvent({ role: 'tool', tool_call_id: 't1', content: 'ok' }, 'kimi');
ok(tool[0]?.kind === 'tool_result' && tool[0]?.id === 't1', 'Kimi tool response becomes tool result');
const compactBegin = server.parseKimiWireCompaction({ type: 'full_compaction.begin', source: 'auto' });
ok(compactBegin?.type === 'compact' && compactBegin.phase === 'started' && compactBegin.trigger === 'auto', 'Kimi wire auto-compaction start becomes visible compact event');
const compactApplied = server.parseKimiWireCompaction({ type: 'context.apply_compaction', tokensBefore: 100000, tokensAfter: 42000, compactedCount: 18 });
ok(compactApplied?.phase === 'applied' && compactApplied.beforeTokens === 100000 && compactApplied.afterTokens === 42000, 'Kimi wire compaction application preserves exact before/after usage');
const rebased = server.parseKimiWireCompaction({ type: 'token_counting.rebased', tokens: 42000 });
ok(rebased?.type === 'usage' && rebased.contextTokens === 42000, 'Kimi rebased token count synchronizes Ruyi usage');

const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'provider-settings.js'), 'utf8');
const navigation = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'navigation-controls.js'), 'utf8');
const streamUi = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'chat-stream-runtime.js'), 'utf8');
const sessionUi = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'session-experience.js'), 'utf8');
ok(/compactProviderId/.test(navigation) && /默认（Kimi 原生压缩）/.test(navigation), 'context panel exposes universal compaction-model selector');
ok(/\/api\/agent\/compact/.test(streamUi) && !/sendPrompt\('\/compact'\)[\s\S]{0,120}agentCliType === 'kimi'/.test(streamUi), 'Kimi manual compact routes to native API instead of prompt text');
ok(/isProviderMode\(\) \|\| state\.config\?\.agentCliType !== 'kimi'/.test(sessionUi), 'Kimi status refresh cannot overwrite active Provider compaction usage');
ok(/handle && !isProviderMode\(\) && state\.config\?\.agentCliType === 'kimi'/.test(navigation), 'opening the Provider context popover cannot trigger a late Kimi usage overwrite');
ok(/case 'tool_use_update'/.test(streamUi) && /card\.inp\.textContent/.test(streamUi), 'live Kimi tool input updates refresh the existing Ruyi tool card');
const engine = fs.readFileSync(path.join(WB, 'app', 'src', '05-claude-engine.js'), 'utf8');
ok(/value="kimi">Kimi Code</.test(html) && /settings\.agentCli\.tab/.test(html), 'settings exposes Agent CLI selector with Kimi');
ok(/detectedKimiPath/.test(ui) && /currentAgentCliLabel/.test(ui), 'frontend readiness and labels follow selected driver');
ok(/runKimiAcpTurnPrepared/.test(engine) && /prepareAgentCliSpawn\('kimi', claude, \['acp'\]\)/.test(fs.readFileSync(path.join(WB, 'app', 'src', '05b-kimi-bridge.js'), 'utf8')), 'engine launches Kimi through ACP instead of prompt flags');

const mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-mcp-'));
try {
  const kimiHome = path.join(mcpHome, 'custom-kimi-home');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { keepMe: { command: 'keep-command' } } }));
  const mcpConfig = server.normalizeConfig({
    includeWorkbenchMcp: true, mcpCommandMode: 'node',
    desktopMcp: { enabled: true, autodetect: false, command: process.execPath, args: ['fake-acc-server.js'] },
    externalMcpServers: [
      { id: 'acc', label: 'Duplicate ACC alias', command: 'python', args: ['-m', 'ai_computer_control.server'], toolTimeoutMs: 120000 },
      { id: 'slow-tool', command: process.execPath, args: ['fake-slow-tool.js'], startupTimeoutMs: 4321, toolTimeoutMs: 123456, enabledTools: ['run'] },
    ],
  }).config;
  fs.writeFileSync(path.join(mcpHome, 'config.json'), JSON.stringify(mcpConfig, null, 2));
  const childScript = [
    `const fs=require('fs'); const server=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});`,
    `(async()=>{ const target=${JSON.stringify(path.join(kimiHome, 'mcp.json'))};`,
    `const cfg=server.normalizeConfig(${JSON.stringify(mcpConfig)}).config; await server.syncMcpServersToKimi(cfg); const enabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `await server.syncMcpServersToKimi({...cfg,includeWorkbenchMcp:false}); const disabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `process.stdout.write(JSON.stringify({enabled,disabled})); })().catch(e=>{console.error(e);process.exit(1)});`,
  ].join('');
  const synced = JSON.parse(cp.execFileSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: mcpHome, RUYI_HOME: mcpHome, KIMI_CODE_HOME: kimiHome, USERPROFILE: mcpHome, HOME: mcpHome },
  }));
  ok(synced.enabled?.mcpServers?.keepMe?.command === 'keep-command', 'Kimi MCP sync preserves unrelated user entries');
  ok(synced.enabled?.mcpServers?.['win-claude-workbench']?.command && !('type' in synced.enabled.mcpServers['win-claude-workbench']), 'Kimi MCP sync writes native inferred-transport shape');
  ok(synced.enabled?.mcpServers?.['win-claude-workbench']?.toolTimeoutMs === 900000, 'Kimi MCP sync grants Ruyi bridge its long-running tool budget');
  ok(synced.enabled?.mcpServers?.['ai-computer-control']?.toolTimeoutMs === 650000 && !synced.enabled?.mcpServers?.acc, 'Kimi MCP sync removes duplicate ACC aliases and avoids the 60-second transport timeout');
  ok(synced.enabled?.mcpServers?.['slow-tool']?.startupTimeoutMs === 4321 && synced.enabled?.mcpServers?.['slow-tool']?.toolTimeoutMs === 123456 && synced.enabled?.mcpServers?.['slow-tool']?.enabledTools?.[0] === 'run', 'Kimi MCP sync preserves per-server timeout and tool filters');
  ok(!synced.disabled?.mcpServers?.['win-claude-workbench'] && synced.disabled?.mcpServers?.keepMe?.command === 'keep-command', 'disabling Ruyi MCP removes only Ruyi-owned Kimi entries');
} finally {
  fs.rmSync(mcpHome, { recursive: true, force: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function getJson(port, requestPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: 3000,
      headers: testToken ? { 'x-wcw-token': testToken } : {} }, res => {
      let body = ''; res.on('data', chunk => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function health(port) { return getJson(port, '/health'); }
let testToken = '';
function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...(testToken ? { 'x-wcw-token': testToken } : {}) } }, res => {
      let text = ''; res.on('data', chunk => (text += chunk));
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.end(raw);
  });
}
function stream(port, body, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            if (line.trim()) {
              const event = JSON.parse(line); events.push(event);
              if (onEvent) Promise.resolve(onEvent(event)).catch(() => {});
            }
          } catch { /* diagnostic line */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('stream timeout')); });
    req.end(raw);
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-turn-'));
  let child = null;
  try {
    const project = path.join(home, 'project');
    const npmBin = path.join(home, 'npm', 'node_modules', '.bin');
    const entry = path.join(home, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(npmBin, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, [
      "import readline from 'node:readline';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('0.37.2-test'); process.exit(0); }",
      "if (args[0] === 'provider' && args[1] === 'list' && args.includes('--json')) { console.log(JSON.stringify({providers:{'managed:kimi-code':{type:'kimi'}},models:{'kimi-code/k3-256k':{provider:'managed:kimi-code',model:'k3-256k',displayName:'K3 256K',maxContextSize:262144},'custom/fast':{provider:'custom',model:'fast',displayName:'Fast'}}})); process.exit(0); }",
      "if (args[0] !== 'acp') process.exit(2);",
      "const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
      "let promptSeq=0; const waiting=new Map(); const reverse=(id,method,params,reply)=>{waiting.set(String(id),{reply});send({jsonrpc:'2.0',id,method,params});};",
      "const update=(sessionId,update)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});",
      "const current=(prompt,text)=>new RegExp('<current_user_message>\\\\s*'+text+'\\\\s*</current_user_message>').test(prompt); const finishPrompt=(msg,prompt,answer)=>{ const sid=String(msg.params.sessionId); const n=++promptSeq; update(sid,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:(answer||'KIMI_E2E:'+current(prompt,'hello-kimi'))}}); update(sid,{sessionUpdate:'tool_call',toolCallId:'turn'+n+':tool-1',title:'Read',kind:'read',status:'in_progress'}); update(sid,{sessionUpdate:'tool_call_update',toolCallId:'turn'+n+':tool-1',rawInput:{path:'demo-updated.txt'}}); update(sid,{sessionUpdate:'tool_call_update',toolCallId:'turn'+n+':tool-1',status:'completed',rawOutput:'fixture-result'}); update(sid,{sessionUpdate:'plan_update',plan:{type:'items',planId:'plan-e2e',entries:[{content:'Inspect ACP mapping',priority:'high',status:'completed'}]}}); update(sid,{sessionUpdate:'usage_update',used:1234+n,size:262144}); setTimeout(()=>send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn',usage:{inputTokens:101,outputTokens:7,totalTokens:108}}}),prompt.includes('cancel-kimi')?10000:(prompt.includes('steer-base')?500:10)); };",
      "const terminalFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);update(sid,{sessionUpdate:'tool_call',toolCallId:'native-bash',title:'Bash',kind:'execute',status:'in_progress'});reverse('reverse-terminal-create','terminal/create',{sessionId:sid,command:process.execPath,args:['-e',\"process.stdout.write('ACP_TERMINAL_OK')\"],cwd:process.cwd(),env:[],outputByteLimit:65536},created=>{if(created.error)return finishPrompt(msg,prompt,'KIMI_TERMINAL_ERROR:'+created.error.message);const terminalId=created.result.terminalId;update(sid,{sessionUpdate:'tool_call_update',toolCallId:'native-bash',title:'Running native Bash',rawInput:{command:'node marker'}});reverse('reverse-terminal-wait','terminal/wait_for_exit',{sessionId:sid,terminalId},()=>reverse('reverse-terminal-output','terminal/output',{sessionId:sid,terminalId},output=>reverse('reverse-terminal-release','terminal/release',{sessionId:sid,terminalId},()=>{update(sid,{sessionUpdate:'tool_call_update',toolCallId:'native-bash',status:'completed',content:{type:'terminal',terminalId}});finishPrompt(msg,prompt,'KIMI_TERMINAL:'+String(output.result&&output.result.output));})));});};",
      "const fsFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'acp-fs-roundtrip.txt');reverse('reverse-fs-write','fs/write_text_file',{sessionId:sid,path:file,content:'ACP_FS_OK'},written=>{if(written.error)return finishPrompt(msg,prompt,'KIMI_FS_ERROR:'+written.error.message);reverse('reverse-fs-read','fs/read_text_file',{sessionId:sid,path:file,line:1,limit:1},read=>finishPrompt(msg,prompt,'KIMI_FS:'+String(read.result&&read.result.content)));});};",
      "const elicitFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);reverse('reverse-elicit','elicitation/create',{sessionId:sid,toolCallId:'elicit-tool',mode:'form',message:'Choose execution settings',requestedSchema:{type:'object',properties:{strategy:{type:'string',title:'Strategy',oneOf:[{const:'safe',title:'Safe'},{const:'fast',title:'Fast'}]},confirm:{type:'boolean',title:'Confirm'}},required:['strategy','confirm']}},reply=>finishPrompt(msg,prompt,'KIMI_ELICIT:'+JSON.stringify(reply.result||reply.error)));};",
      "const cancelReverseFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);reverse('reverse-cancel-create','terminal/create',{sessionId:sid,command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],cwd:process.cwd(),env:[]},created=>{if(created.error)return finishPrompt(msg,prompt,'KIMI_CANCEL_CREATE_ERROR');const terminalId=created.result.terminalId;reverse('reverse-cancel-wait','terminal/wait_for_exit',{sessionId:sid,terminalId},waited=>reverse('reverse-cancel-kill','terminal/kill',{sessionId:sid,terminalId},()=>reverse('reverse-cancel-release','terminal/release',{sessionId:sid,terminalId},()=>finishPrompt(msg,prompt,'KIMI_CANCEL_CODE:'+String(waited.error&&waited.error.code)))));setTimeout(()=>send({jsonrpc:'2.0',method:'$/cancel_request',params:{requestId:'reverse-cancel-wait'}}),50);});};",
      "readline.createInterface({input:process.stdin}).on('line',line=>{ let msg; try{msg=JSON.parse(line)}catch{return}; if(!msg.method&&msg.id!==undefined){ const held=waiting.get(String(msg.id)); if(held){waiting.delete(String(msg.id)); if(held.reply)return held.reply(msg); const option=String(msg.result&&msg.result.outcome&&msg.result.outcome.optionId); finishPrompt(held.msg,held.prompt,(held.kind==='permission'?'KIMI_PERMISSION_OPTION:':'KIMI_QUESTION_OPTION:')+option);} return;} const m=msg.method; if(m==='initialize'){const caps=msg.params&&msg.params.clientCapabilities||{};if(caps.terminal!==true||caps.fs?.readTextFile!==true||caps.fs?.writeTextFile!==true||!caps.elicitation?.form||!caps.elicitation?.url||!caps.plan)return send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'missing Ruyi ACP client capabilities'}});return send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'0.37.2-test'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:{image:true,embeddedContext:true}}}});} if(m==='session/new') return send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'kimi-session-e2e',configOptions:[]}}); if(m==='session/resume') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[]}}); if(m==='session/set_config_option') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[{id:msg.params.configId,currentValue:msg.params.value}]}}); if(m==='session/close') return send({jsonrpc:'2.0',id:msg.id,result:{}}); if(m==='session/cancel') return; if(m==='session/prompt'){ const prompt=String(msg.params.prompt&&msg.params.prompt[0]&&msg.params.prompt[0].text||''); if(current(prompt,'fail-kimi')) return send({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'provider.auth_error: 403 usage limit reached'}}); if(current(prompt,'required-kimi')) return send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'required parameter cwd is missing'}}); if(current(prompt,'terminal-kimi'))return terminalFlow(msg,prompt); if(current(prompt,'fs-kimi'))return fsFlow(msg,prompt); if(current(prompt,'elicit-kimi'))return elicitFlow(msg,prompt); if(current(prompt,'cancel-reverse-kimi'))return cancelReverseFlow(msg,prompt); if(current(prompt,'approve-kimi')){ waiting.set('reverse-p',{msg,prompt,kind:'permission'}); return send({jsonrpc:'2.0',id:'reverse-p',method:'session/request_permission',params:{sessionId:msg.params.sessionId,toolCall:{toolCallId:'bash-1',title:'Bash',kind:'execute',rawInput:{command:'echo safe'},content:[]},options:[{optionId:'approve_once',name:'Approve once',kind:'allow_once'},{optionId:'approve_always',name:'Approve for this session',kind:'allow_always'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}});} if(current(prompt,'ask-kimi')){ waiting.set('reverse-q',{msg,prompt,kind:'question'}); return send({jsonrpc:'2.0',id:'reverse-q',method:'session/request_permission',params:{sessionId:msg.params.sessionId,toolCall:{toolCallId:'ask-1',title:'AskUserQuestion',content:[{type:'content',content:{type:'text',text:'Choose a Kimi option'}}]},options:[{optionId:'q0_opt_0',name:'Alpha',kind:'allow_once'},{optionId:'q0_opt_1',name:'Beta',kind:'allow_once'},{optionId:'q0_skip',name:'Skip',kind:'reject_once'}]}});} return finishPrompt(msg,prompt); } send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'unknown'}});});",
    ].join('\n'));
    const shim = path.join(npmBin, 'kimi.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0\\..\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 11, agentCliType: 'kimi', kimiPath: shim, defaultWorkspace: project,
      includeWorkbenchMcp: false, autoResumeClaudeSessions: true, killPortOnStart: false,
      permissionMode: 'default', engineMode: 'legacy', providers: [], knownModels: ['k3-256k', 'claude-old-model'],
    }, null, 2));

    const port = await getFreePort();
    child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, USERPROFILE: home, HOME: home },
    });
    let ready = null;
    for (let attempt = 0; attempt < 40 && !ready?.ok; attempt++) { await sleep(150); ready = await health(port); }
    ok(Boolean(ready?.ok), 'workbench starts with selected fake Kimi driver');
    if (ready?.ok) {
      testToken = String((await postJson(port, '/api/bootstrap', {}))?.token || '');
      const modelReply = await getJson(port, '/api/models');
      const modelIds = (modelReply?.models || []).map(model => model.id);
      ok(modelReply?.ok === true && modelReply?.agentCliType === 'kimi', 'Kimi model refresh queries the selected CLI');
      ok(modelIds.includes('kimi-code/k3-256k') && modelIds.includes('custom/fast'), 'Kimi model refresh returns configured aliases');
      ok(!modelIds.includes('k3-256k') && !modelIds.includes('claude-old-model'), 'Kimi picker excludes bare/Claude remembered model ids');
      const events = await stream(port, { message: 'hello-kimi', cwd: project, attachments: [] });
      const meta = events.find(event => event.type === 'meta');
      const sessionId = events.find(event => event.type === 'session')?.session?.id;
      ok(meta?.agentCliType === 'kimi' && meta?.agentDriver === 'kimi-acp', 'turn metadata identifies Kimi ACP driver');
      ok(events.some(event => event.type === 'assistant_delta' && /KIMI_E2E:true/.test(event.text)), 'Kimi ACP assistant chunks reach the chat stream');
      ok(events.some(event => event.type === 'tool_use' && event.name === 'Read'), 'Kimi tool call reaches the chat stream');
      ok(events.some(event => event.type === 'tool_use_update' && event.input?.path === 'demo-updated.txt'), 'late Kimi tool input updates reach the existing chat card');
      ok(events.some(event => event.type === 'tool_result' && /:tool-1$/.test(event.id)), 'Kimi tool result reaches the chat stream');
      ok(events.some(event => event.type === 'todo' && event.items?.[0]?.text === 'Inspect ACP mapping' && event.items[0].status === 'done'), 'nested ACP plan_update maps to Ruyi todos');
      ok(events.some(event => event.type === 'usage' && event.contextWindow === 262144), 'Kimi ACP usage update reaches the context panel');
      ok(events.some(event => event.type === 'result' && event.ok === true), 'Kimi process completion closes the turn successfully');
      ok(Boolean(sessionId), 'Kimi ACP turn exposes the Ruyi session id');
      const persistedTurn = await getJson(port, `/api/sessions/${sessionId}`);
      const persistedAssistant = persistedTurn?.session?.messages?.filter(message => message.role === 'assistant').at(-1);
      ok(persistedAssistant?.usage?.usage?.inputTokens === 101, 'ACP prompt-response usage is retained alongside context occupancy');

      const asked = await stream(port, { sessionId, message: 'ask-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'ask_user') return;
        const question = event.questions && event.questions[0];
        return postJson(port, '/api/chat/answer', {
          sessionId, questionId: event.questionId,
          answers: [{ questionId: question.id, selectedOptionIds: ['q0_opt_1'] }],
        });
      });
      ok(asked.some(event => event.type === 'ask_user' && event.questions?.[0]?.options?.some(option => option.id === 'q0_opt_1')), 'Kimi AskUserQuestion becomes a structured Ruyi prompt');
      ok(asked.some(event => event.type === 'assistant_delta' && /KIMI_QUESTION_OPTION:q0_opt_1/.test(event.text)), 'structured user answer round-trips through ACP reverse RPC');

      const approved = await stream(port, { sessionId, message: 'approve-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'permission_request') return;
        return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'session' });
      });
      ok(approved.some(event => event.type === 'permission_request' && event.toolName === 'Bash'), 'Kimi tool approval uses the Ruyi permission surface');
      ok(approved.some(event => event.type === 'assistant_delta' && /KIMI_PERMISSION_OPTION:approve_always/.test(event.text)), 'session-scoped approval maps to ACP allow_always');

      const terminal = await stream(port, { sessionId, message: 'terminal-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(terminal.some(event => event.type === 'assistant_delta' && /KIMI_TERMINAL:ACP_TERMINAL_OK/.test(event.text)), 'Kimi ACP Bash uses the Ruyi terminal capability and returns output');
      ok(terminal.some(event => event.type === 'tool_result' && event.id === 'native-bash' && event.content === 'ACP_TERMINAL_OK'), 'released ACP terminal output replaces the opaque terminalId in the Ruyi tool card');

      const fileRoundtrip = await stream(port, { sessionId, message: 'fs-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(fileRoundtrip.some(event => event.type === 'assistant_delta' && /KIMI_FS:ACP_FS_OK/.test(event.text)), 'Kimi ACP text write/read round-trips through guarded Ruyi filesystem calls');
      ok(fs.readFileSync(path.join(project, 'acp-fs-roundtrip.txt'), 'utf8') === 'ACP_FS_OK', 'ACP filesystem write is applied in the selected workspace');

      const elicited = await stream(port, { sessionId, message: 'elicit-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'ask_user') return;
        return postJson(port, '/api/chat/answer', {
          sessionId, questionId: event.questionId,
          answers: event.questions.map(question => ({
            questionId: question.id,
            selectedOptionIds: [question.header === 'Strategy' ? 'kimi_strategy_1' : 'kimi_confirm_0'],
          })),
        });
      });
      ok(elicited.some(event => event.type === 'assistant_delta' && /KIMI_ELICIT:.*\"strategy\":\"fast\".*\"confirm\":true/.test(event.text)), 'Kimi ACP form elicitation maps to structured Ruyi user input');

      const reverseCancelled = await stream(port, { sessionId, message: 'cancel-reverse-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(reverseCancelled.some(event => event.type === 'assistant_delta' && /KIMI_CANCEL_CODE:-32800/.test(event.text)), 'ACP $/cancel_request interrupts a pending Ruyi terminal wait with the standard cancellation code');

      let markSteerRunning;
      const steerRunning = new Promise(resolve => { markSteerRunning = resolve; });
      const steeredPromise = stream(port, { sessionId, message: 'steer-base', cwd: project, attachments: [] }, event => {
        if (event.type === 'process' && event.state === 'running') markSteerRunning();
      });
      await steerRunning;
      await sleep(80);
      const steerReply = await postJson(port, '/api/steer', { sessionId, text: 'steer-followup' });
      const steered = await steeredPromise;
      ok(steerReply?.ok === true && steerReply?.queued === 1 && steerReply?.protocol === 'kimi-acp-followup', 'Kimi steer honestly reports queued ACP follow-up semantics');
      ok(steered.some(event => event.type === 'steered' && event.text === 'steer-followup'), 'queued steer is injected into the same live Kimi ACP session');
      ok(steered.filter(event => event.type === 'assistant_delta').length >= 2, 'queued steer runs as a follow-up ACP prompt before the outer turn closes');

      let markCancelableRunning;
      const cancelableRunning = new Promise(resolve => { markCancelableRunning = resolve; });
      const cancelablePromise = stream(port, { sessionId, message: 'cancel-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'process' && event.state === 'running') markCancelableRunning();
      });
      await cancelableRunning;
      await sleep(80);
      const stopReply = await postJson(port, '/api/stop', { sessionId });
      const cancelled = await cancelablePromise;
      const cancelledResult = cancelled.find(event => event.type === 'result');
      ok(stopReply?.ok === true && stopReply?.stopped === true, 'Kimi ACP live turn accepts the common stop endpoint');
      ok(cancelledResult?.ok === false && cancelledResult?.aborted === true, 'stopped Kimi ACP prompt settles as aborted instead of a false success');

      const failed = await stream(port, { sessionId, message: 'fail-kimi', cwd: project, attachments: [] });
      const failedResult = failed.find(event => event.type === 'result');
      ok(failedResult?.ok === false && /usage limit/.test(String(failedResult.error || '')), 'Kimi stderr reaches the visible failed-result card');
      const required = await stream(port, { sessionId, message: 'required-kimi', cwd: project, attachments: [] });
      const requiredResult = required.find(event => event.type === 'result');
      ok(requiredResult?.ok === false && /required parameter/.test(String(requiredResult.error || '')) && !/kimi login/i.test(String(requiredResult.error || '')), 'non-auth ACP required-field errors are not misreported as login failures');
    }
  } finally {
    if (child?.pid) {
      try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    }
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
  else console.log('Kimi Agent CLI adapter contract passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
