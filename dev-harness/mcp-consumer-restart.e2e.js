'use strict';
// Actual server.js serve main-path restart and product listenWithFallback.
// Isolated synthetic homes/data and an owned browser; no real account or external service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process');
const {killOwnTree}=require('./lib/kill-own-tree');
const {CdpClient,waitForTarget}=require('./lib/browser-fixture');
const {findBrowserExecutable}=require('./lib/browser-path');
const {stopRuyiTestBrowsers}=require('./lib/browser-cleanup');
const {getFreePort}=require('./free-port');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
void run();
async function run(){
  const {createRunner}=require('./lib/harness'),t=createRunner('MCP CONSUMER RESTART'),{ok}=t;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-consumer-restart-')),data=path.join(root,'data'),workspace=path.join(root,'workspace'),children=[];fs.mkdirSync(workspace,{recursive:true});
  Object.assign(process.env,require('./lib/release-checks').releaseEnvironment(path.join(root,'home'),data));
  let blocker,serial=0,browser,cdp,browserProfile;const lifelines=[];
  fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({privacyModeV1:'enhanced',privacyRulesV1:[],credentialEncryptionV1:true,permissionMode:'acceptEdits',defaultWorkspace:workspace,workspaces:[],recentWorkspaces:[],providers:[],schedulerEnabledV1:false,stewardEnabledV1:false,includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,autoOpenBrowser:false,desktopMcp:{enabled:false,autodetect:false}}));
  const serverFile=path.resolve(__dirname,'../ruyi-workbench/app/server.js');
  async function listenOwned(server,port){
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned listener deadline')),5000);server.once('error',error=>{clearTimeout(timer);reject(error);});server.listen(port,'127.0.0.1',()=>{clearTimeout(timer);resolve();});});
  }
  async function closeOwned(server){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned listener close deadline')),5000);server.close(error=>{clearTimeout(timer);if(error&&error.code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();});});}
  async function freePort(){const probe=http.createServer();try{await listenOwned(probe,0);return probe.address().port;}finally{await closeOwned(probe);}}
  async function host(port=0){
    if(!port)port=await freePort();
    const discoveryFile=path.join(data,'mcp-host-v1.json');try{fs.unlinkSync(discoveryFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    // This is the actual product CLI main/startServer/listenWithFallback path.
    // The fixture does not implement its own listener, port selection or vault.
    const child=cp.spawn(process.execPath,[serverFile,'serve','--port',String(port)],{env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      if(child.exitCode!==null||child.signalCode!==null)throw Error('Owned product serve exited before ready');
      try{
        const discovery=JSON.parse(fs.readFileSync(discoveryFile,'utf8')),runtime=JSON.parse(fs.readFileSync(path.join(data,'runtime.json'),'utf8'));
        if(discovery.schema===1&&discovery.host==='127.0.0.1'&&runtime.pid===child.pid&&runtime.port===discovery.port&&/^[a-f0-9]{48}$/.test(discovery.instanceId)&&/^[a-f0-9]{32}$/.test(runtime.token)){
          const base='http://127.0.0.1:'+discovery.port,response=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});
          if(response.ok)return {...discovery,child,base,managementToken:runtime.token};
        }
      }catch{}
      await wait(50);
    }
    throw Error('Owned product serve discovery/health timeout');
  }
  async function lease(host,consumerId,token,connection){
    const bytes=Buffer.from(JSON.stringify({op:'lease',consumerId,...connection}));
    return new Promise((resolve,reject)=>{
      let ack=false;const timer=setTimeout(()=>{owned.destroy();reject(Error('Owned lease ACK timeout'));},5000);
      const owned=http.request(host.base+'/api/mcp/consumer',{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,'x-ruyi-mcp-consumer':token}},response=>{
        response.on('data',chunk=>{if(response.statusCode!==200||chunk.toString().trim()){owned.destroy();if(!ack)reject(Error('Owned lease rejected'));return;}if(!ack){ack=true;clearTimeout(timer);resolve(owned);}});
        response.on('error',()=>{clearTimeout(timer);if(!ack)reject(Error('Owned lease failed'));});
      });
      lifelines.push(owned);owned.on('error',()=>{clearTimeout(timer);if(!ack)reject(Error('Owned lease failed'));});owned.end(bytes);
    });
  }
  async function exited(child){
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned host exit deadline')),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
  async function post(host,body,token=host.managementToken,endpoint='/api/mcp/consumers'){
    if(endpoint==='/api/mcp/consumer')return new Promise((resolve,reject)=>{
      const bytes=Buffer.from(JSON.stringify(body)),owned=http.request(host.base+endpoint,{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,'x-ruyi-mcp-consumer':token}},response=>{
        let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:response.statusCode,value,text});});response.on('error',reject);
      });owned.setTimeout(10000,()=>owned.destroy(Error('Owned non-browser consumer HTTP timeout')));owned.on('error',reject);owned.end(bytes);
    });
    const response=await fetch(host.base+endpoint,{method:'POST',headers:{'content-type':'application/json',...(endpoint==='/api/mcp/consumer'?{'x-ruyi-mcp-consumer':token}:{'x-wcw-token':token})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return{status:response.status,value,text};
  }
  function relay(entry){
    const child=cp.spawn(process.execPath,[path.resolve(__dirname,'../ruyi-workbench/app/server.js'),'mcp','--consumer'],{env:{...process.env,...entry.env},windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    let buffer='';const replies=new Map();child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line){const value=JSON.parse(line);if(value.id!==undefined)replies.set(value.id,value);}}});
    return {child,async send(method,params={}){const id=++serial;child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<400;i++){if(replies.has(id)){const value=replies.get(id);replies.delete(id);return value;}await wait(25);}throw Error('Owned relay response timeout');}};
  }
  async function browserSetupJourney(actualHost){
    const secondWorkspace=path.join(root,'workspace-two');fs.mkdirSync(secondWorkspace);
    const other=await post(actualHost,{title:'Browser other workspace',cwd:secondWorkspace},undefined,'/api/sessions');
    const original=await post(actualHost,{title:'Browser original workspace',cwd:workspace},undefined,'/api/sessions');
    ok(other.status===200&&original.status===200,'actual product API creates the two browser thread workspaces');
    const executable=findBrowserExecutable();if(!executable)throw Error('Owned browser unavailable');
    const debugPort=await getFreePort(),downloads=path.join(root,'browser-downloads');browserProfile=path.join(root,'browser-profile');fs.mkdirSync(downloads);
    browser=cp.spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync','--disable-background-networking','--remote-debugging-port='+debugPort,'--user-data-dir='+browserProfile,'about:blank'],{windowsHide:true,stdio:'ignore'});children.push(browser);
    const {target,why}=await waitForTarget(debugPort,'about:blank',browser);if(!target)throw Error(why||'Owned browser target unavailable');
    cdp=new CdpClient(target.webSocketDebuggerUrl);await cdp.connect();await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"try{localStorage.setItem('wcw.shellMode','classic');localStorage.setItem('wcw.uiMode','pro');}catch{}"});
    await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    async function capturePanel(stage){
      if(!process.env.RUYI_MCP_ARTIFACT_DIR)return;
      await cdp.evaluate("document.getElementById('mcpConsumersPanel').scrollIntoView({block:'center'})");
      const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.mkdirSync(process.env.RUYI_MCP_ARTIFACT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.RUYI_MCP_ARTIFACT_DIR,'consumer-panel-'+process.pid+'-'+stage+'.png'),Buffer.from(shot.data,'base64'));
    }
    let released=false,dialogs=0,consoleOverflow=false;const heldStatus=[],consoleText=[];
    cdp.on('Page.javascriptDialogOpening',()=>{dialogs++;void cdp.send('Page.handleJavaScriptDialog',{accept:false}).catch(()=>{});});
    cdp.on('Runtime.consoleAPICalled',event=>{if(consoleText.length<100)consoleText.push(event.args.map(arg=>String(arg.value??arg.description??'')).join(' '));else consoleOverflow=true;});
    cdp.on('Runtime.exceptionThrown',event=>{if(consoleText.length<100)consoleText.push(String(event.exceptionDetails?.text||'')+' '+String(event.exceptionDetails?.exception?.description||''));else consoleOverflow=true;});
    cdp.on('Fetch.requestPaused',event=>{if(released)void cdp.send('Fetch.continueRequest',{requestId:event.requestId}).catch(()=>{});else heldStatus.push(event.requestId);});
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:actualHost.base+'/api/status*',requestStage:'Request'}]});
    await cdp.send('Page.navigate',{url:actualHost.base+'/'});
    for(let i=0;i<400&&!heldStatus.length;i++)await wait(25);
    ok(heldStatus.length>0,'real product first status request is held before configuration hydration');
    const cold=await cdp.evaluate("Boolean(window.state&&!state.config.defaultWorkspace&&document.getElementById('mcpConsumersPanel')&&!document.getElementById('mcpConsumersPanel').dataset.mounted)");
    ok(cold,'boot event binding does not eagerly and permanently mount an empty workspace');
    await cdp.evaluate("document.getElementById('openSettingsBtn').click();document.querySelector('#settingsTabs [data-stab=integrations]').click();");
    for(let i=0;i<400;i++){if(heldStatus.length>=2&&await cdp.evaluate("document.getElementById('mcpConsumersPanel').dataset.mounting==='true'"))break;await wait(25);}
    ok(heldStatus.length>=2&&await cdp.evaluate("document.getElementById('mcpConsumersPanel').dataset.mounting==='true'&&!document.getElementById('mcpConsumersPanel').dataset.mounted&&!document.querySelector('#mcpConsumersPanel button')"),'opening actual MCP settings during delayed boot waits for authoritative workspace instead of allowing an empty-root grant');
    released=true;for(const requestId of heldStatus)await cdp.send('Fetch.continueRequest',{requestId});await cdp.send('Fetch.disable');
    for(let i=0;i<400;i++){if(await cdp.evaluate("document.getElementById('mcpConsumersPanel').dataset.mounted==='true'&&!!document.querySelector('#mcpConsumersPanel button')&&state.config.defaultWorkspace"))break;await wait(25);}
    const before=await cdp.evaluate("(()=>{const p=document.getElementById('mcpConsumersPanel'),r=p.getBoundingClientRect();return{root:p.querySelectorAll('p')[1].textContent,visible:r.width>0&&r.height>0,styles:document.styleSheets.length,role:p.querySelector('[role=status]')?.getAttribute('role')};})()");
    ok(before.visible&&before.styles>0&&before.root.includes(workspace)&&before.role==='status','real product modules/CSS render a visible explicit captured grant workspace');
    ok(await cdp.evaluate("(()=>{const c=document.querySelector('#mcpConsumersPanel input[type=checkbox]'),l=c.parentElement,r=document.createRange();r.selectNodeContents(l.lastChild);return getComputedStyle(l).display==='flex'&&c.getBoundingClientRect().width===16&&Math.abs(c.getBoundingClientRect().top-r.getBoundingClientRect().top)<8;})()"),'actual product checkbox and its clickable label stay on the same line without changing application input layout');
    await capturePanel('before-grant');
    const label='Browser one-time connection';
    await cdp.evaluate(`(()=>{const p=document.getElementById('mcpConsumersPanel');p.querySelector('input[type=text]').value=${JSON.stringify(label)};p.querySelector('input[type=checkbox]').checked=true;window.consumerSetupClicks=0;p.querySelector('button').addEventListener('click',()=>window.consumerSetupClicks++);p.querySelector('button').click();})()`);
    let files=[];for(let i=0;i<400;i++){files=fs.readdirSync(downloads).filter(name=>name.endsWith('.json'));if(files.length)break;await wait(25);}
    ok(files.length===1&&await cdp.evaluate('window.consumerSetupClicks===1'),'one actual settings setup click downloads exactly one configuration');
    const config=JSON.parse(fs.readFileSync(path.join(downloads,files[0]),'utf8')),keys=Object.keys(config.mcpServers||{}),entry=config.mcpServers?.[keys[0]],token=entry?.env?.RUYI_MCP_CONSUMER_TOKEN,id=entry?.env?.RUYI_MCP_CONSUMER_ID;
    ok(Object.keys(config).length===1&&keys.length===1&&keys[0]==='ruyi-consumer_'+id&&entry.type==='stdio'&&Array.isArray(entry.args)&&entry.args.includes('--consumer')&&/^[a-f0-9]{64}$/.test(token||'')&&!('WCW_TOKEN' in entry.env)&&!('WCW_PORT' in entry.env),'download is standard MCP JSON with one dedicated consumer configuration and no workbench management credential or manual port');
    const listed=await post(actualHost,{op:'list'}),row=listed.value.consumers.find(value=>value.id===id);
    ok(row?.label===label&&row.workspace===workspace&&row.tools.length===7&&!listed.text.includes(token)&&!await cdp.evaluate('document.getElementById("mcpConsumersPanel").textContent.includes('+JSON.stringify(token)+')'),'actual management list matches the displayed grant and never recovers/downloads its secret token');
    const local=relay(entry);ok(Boolean((await local.send('initialize')).result),'browser-downloaded configuration initializes actual stdio without another setup step');
    const localFile=path.join(workspace,'browser-ordinary.txt'),write=await local.send('tools/call',{name:'file_write',arguments:{path:localFile,content:'BROWSER-ORDINARY-PUBLIC'}}),read=await local.send('tools/call',{name:'file_read',arguments:{path:localFile}});
    ok(!write.result?.isError&&!read.result?.isError&&fs.readFileSync(localFile,'utf8')==='BROWSER-ORDINARY-PUBLIC'&&JSON.stringify(read.result).includes('BROWSER-ORDINARY-PUBLIC'),'ordinary granted local write/read reaches real IO without additional dialogs or daily configuration');
    await cdp.evaluate("document.querySelector('#settingsModal [data-close-modal]').click()");
    for(let i=0;i<400;i++){if(await cdp.evaluate('!!document.querySelector('+JSON.stringify('li.steward-board-thread[data-session-id="'+other.value.session.id+'"] [data-action=open]')+')'))break;await wait(25);}
    await cdp.evaluate('document.querySelector('+JSON.stringify('li.steward-board-thread[data-session-id="'+other.value.session.id+'"] [data-action=open]')+').click()');
    for(let i=0;i<400;i++){if(await cdp.evaluate('state.currentSession?.id==='+JSON.stringify(other.value.session.id)))break;await wait(25);}
    ok(await cdp.evaluate('state.currentSession?.id==='+JSON.stringify(other.value.session.id)),'actual product thread action changes to the second workspace');
    await cdp.evaluate("document.getElementById('openSettingsBtn').click();document.querySelector('#settingsTabs [data-stab=integrations]').click()");
    ok(await cdp.evaluate('document.querySelectorAll("#mcpConsumersPanel p")[1].textContent==='+JSON.stringify(before.root)),'mounted settings keep the same explicit workspace after thread switch instead of silently expanding the grant');
    await cdp.evaluate(`(()=>{const p=document.getElementById('mcpConsumersPanel');p.querySelector('input[type=text]').value='Browser after thread switch';p.querySelector('button').click();})()`);
    let secondRow,secondArtifact=false;
    for(let i=0;i<400;i++){
      const afterSwitch=await post(actualHost,{op:'list'});secondRow=afterSwitch.value.consumers.find(value=>value.label==='Browser after thread switch');
      if(secondRow)secondArtifact=fs.readdirSync(downloads).filter(name=>name.endsWith('.json')).some(name=>{try{return Object.values(JSON.parse(fs.readFileSync(path.join(downloads,name),'utf8')).mcpServers)[0].env.RUYI_MCP_CONSUMER_ID===secondRow.id;}catch{return false;}});
      if(secondArtifact)break;await wait(25);
    }
    ok(secondRow?.workspace===workspace&&secondRow.workspace!==secondWorkspace&&secondArtifact&&await cdp.evaluate('window.consumerSetupClicks===2'),'a later actual downloaded configuration grants precisely the still-displayed old workspace, not the newly opened thread root');
    await cdp.evaluate(`(()=>{const span=[...document.querySelectorAll('#mcpConsumersPanel span')].find(item=>item.textContent.startsWith(${JSON.stringify(label)}));if(!span)throw Error('Consumer row missing');span.parentElement.querySelector('button').click();})()`);
    let revoked;for(let i=0;i<200;i++){revoked=await post(actualHost,{op:'list'});if(revoked.value.consumers.find(value=>value.id===id)?.enabled===false)break;await wait(25);}
    const denied=await local.send('tools/list');
    ok(revoked.value.consumers.find(value=>value.id===id)?.enabled===false&&denied.error&&!JSON.stringify(denied).includes(token),'actual settings revoke invalidates the existing stdio connection without exposing its token in errors');
    const downloadedTokens=[token,...fs.readdirSync(downloads).filter(name=>name.endsWith('.json')).map(name=>Object.values(JSON.parse(fs.readFileSync(path.join(downloads,name),'utf8')).mcpServers)[0].env.RUYI_MCP_CONSUMER_TOKEN)];
    const panelText=await cdp.evaluate('document.getElementById("mcpConsumersPanel").textContent');
    ok(dialogs===0&&!consoleOverflow&&downloadedTokens.every(value=>!panelText.includes(value)&&!revoked.text.includes(value)&&!consoleText.some(text=>text.includes(value))),'setup/download/local tools/revoke produce zero browser dialogs and no downloaded consumer token in DOM/list/console');
    await capturePanel('after-revoke');
    cdp.close();cdp=null;await killOwnTree(browser);stopRuyiTestBrowsers(browserProfile);browser=null;browserProfile=null;
  }
  try{
    const first=await host(),issued=await post(first,{op:'create',label:'Restart fixture',workspace,tools:['file_read','file_list','file_search','file_write'],resources:['capabilities','workspace']});
    ok(issued.status===200,'actual first host issues explicit one-time consumer setup');const entry=Object.values(issued.value.configuration.mcpServers)[0],token=entry.env.RUYI_MCP_CONSUMER_TOKEN;
    await browserSetupJourney(first);
    const client=relay(entry);ok(Boolean((await client.send('initialize')).result),'actual stdio connects to first host');
    const privateFile=path.join(workspace,'private.txt');fs.writeFileSync(privateFile,'restart-private@example.test');
    const read=await client.send('tools/call',{name:'file_read',arguments:{path:privateFile}}),alias=read.result?.content?.[0]?.text.match(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/)?.[0];
    const opened=await post(first,{op:'open',consumerId:issued.value.consumer.id},token,'/api/mcp/consumer'),oldConnection=opened.value;await lease(first,issued.value.consumer.id,token,oldConnection);
    const pageReply=await post(first,{op:'request',consumerId:issued.value.consumer.id,...oldConnection,message:{jsonrpc:'2.0',id:'page',method:'tools/list',params:{}}},token,'/api/mcp/consumer'),page=pageReply.value;
    ok(alias&&page.result.nextCursor&&oldConnection.connectionId,'actual product serve produces protected stdio alias and authenticated connection cursor');
    first.child.kill('SIGKILL');await exited(first.child);
    blocker=http.createServer((req,res)=>{res.writeHead(503);res.end('{}');});await listenOwned(blocker,first.port);
    const second=await host(first.port);ok(second.port!==first.port&&second.instanceId!==first.instanceId,'real restarted host uses port fallback and a new instance identity');
    ok(Boolean((await client.send('tools/list')).error),'old relay does not silently reconnect or replay business after host restart');
    const oldRequest=await post(second,{op:'request',consumerId:issued.value.consumer.id,...oldConnection,message:{jsonrpc:'2.0',id:'stale',method:'tools/list',params:{cursor:page.result.nextCursor}}},token,'/api/mcp/consumer');
    ok(oldRequest.status===403,'restarted host refuses old connection and cursor even with same valid consumer token');
    const discoveryFile=path.join(data,'mcp-host-v1.json'),currentDiscovery=fs.readFileSync(discoveryFile,'utf8');fs.writeFileSync(discoveryFile,JSON.stringify({schema:1,host:'127.0.0.1',port:second.port,instanceId:first.instanceId}));
    const stale=relay(entry);ok(Boolean((await stale.send('initialize')).error),'stale discovery instance cannot authorize an independent connection');fs.writeFileSync(discoveryFile,currentDiscovery);
    const fresh=relay(entry);ok(Boolean((await fresh.send('initialize')).result),'same unchanged setup token discovers new actual host port without another password/configuration');
    const target=path.join(workspace,'stale-alias.txt'),reused=await fresh.send('tools/call',{name:'file_write',arguments:{path:target,content:alias}});
    ok(reused.result?.isError&&!fs.existsSync(target),'new host connection cannot restore alias from killed host memory');
    const freshRead=await fresh.send('tools/call',{name:'file_read',arguments:{path:privateFile}});ok(!freshRead.error&&freshRead.result&&!freshRead.result.isError&&Array.isArray(freshRead.result.content)&&freshRead.result.content.some(part=>part.type==='text'&&typeof part.text==='string'&&part.text.length>0)&&!JSON.stringify(freshRead).includes('restart-private@example.test'),'explicit new request after reconnect succeeds with nonempty actual file result and remains protected');
    const list=await post(second,{op:'list'});ok(list.status===200&&list.value.consumers.some(value=>value.id===issued.value.consumer.id)&&!list.text.includes(token),'durable consumer identity/grants survive host restart without token recovery');
    ok(!fs.existsSync(path.join(data,'privacy-scopes')),'actual restarted connection scopes leave no persistent original mappings');
  }catch(error){console.error(error.stack);t.fail('uncaught restart fixture error');}
  finally{if(cdp)cdp.close();if(browser)await killOwnTree(browser);if(browserProfile)stopRuyiTestBrowsers(browserProfile);for(const owned of lifelines)owned.destroy();for(const child of children)await killOwnTree(child);if(blocker){blocker.closeAllConnections();await closeOwned(blocker);}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});t.done();}
}
