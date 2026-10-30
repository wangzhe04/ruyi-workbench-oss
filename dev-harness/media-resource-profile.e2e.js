'use strict';
// Default: real HTTP with absent media resources, ordinary OFF delivery and ON
// typed refusal. --full-components: strict real-component image qualification;
// missing resources/fixtures FAIL. Never substitutes a processor or skips full.
require('./lib/self-isolate-home');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),vm=require('node:vm'),zlib=require('node:zlib');
const {createRunner}=require('./lib/harness'),{startFakeProvider,textFrames}=require('./lib/fake-openai-provider'),{releaseEnvironment}=require('./lib/release-checks'),{killOwnTree}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const WB=path.resolve(__dirname,'../ruyi-workbench'),ID='m4-image-cpython312-candidate-v2',full=process.argv.includes('--full-components');
const t=createRunner(full?'MEDIA IMAGE COMPONENT QUALIFICATION':'MEDIA RESOURCE PROFILE HTTP'),{ok}=t;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
const required=['blank','sensitive-text','sensitive-qr','sensitive-linear','transparent-hidden-rgb','metadata','explicit-regions',...Array.from({length:8},(_,index)=>'orientation-'+(index+1)),'bad-input','animation'];
async function request(port,route,{method='GET',body,token,signal,timeout=15000}={}) {
  const response=await fetch('http://127.0.0.1:'+port+route,{method,headers:{...(token?{'x-wcw-token':token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:signal||AbortSignal.timeout(timeout)});
  const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes);}catch{}
  return{status:response.status,headers:response.headers,bytes,json};
}
function fullInputs() {
  if(process.platform!=='win32')throw Error('qualification.windows_required');
  for(const key of ['RUYI_MEDIA_RUNTIME_ROOT','RUYI_MEDIA_SOURCES_ROOT','RUYI_MEDIA_OCR_LANGUAGE','RUYI_MEDIA_QUALIFICATION_FIXTURES'])if(!process.env[key])throw Error('qualification.missing_'+key);
  const file=process.env.RUYI_MEDIA_QUALIFICATION_FIXTURES;
  if(!path.isAbsolute(file))throw Error('qualification.fixture_path');
  const manifest=JSON.parse(fs.readFileSync(file));
  if(manifest.schema!==1||manifest.kind!=='public-synthetic-media-image-oracles'||!Array.isArray(manifest.cases))throw Error('qualification.fixture_shape');
  const names=new Set(manifest.cases.map(row=>row.id));
  if(names.size!==manifest.cases.length||required.some(name=>!names.has(name)))throw Error('qualification.fixture_matrix_incomplete');
  return required.map(id=>{
    const row=manifest.cases.find(value=>value.id===id);
    if(!path.isAbsolute(row.file)||!/^[a-f0-9]{64}$/.test(row.sha256)||!['success','refusal'].includes(row.expected))throw Error('qualification.fixture_shape');
    const bytes=fs.readFileSync(row.file);if(sha(bytes)!==row.sha256||bytes.length>8388608)throw Error('qualification.fixture_changed');
    const negative=['bad-input','animation'].includes(id);
    if(negative?(row.expected!=='refusal'||!/^privacy\./.test(row.code||'')):(row.expected!=='success'||!Array.isArray(row.pixels)||!row.pixels.length))throw Error('qualification.oracle_missing');
    if(!negative&&(!Number.isSafeInteger(row.width)||!Number.isSafeInteger(row.height)||row.width<1||row.height<1||row.width*row.height>8000000))throw Error('qualification.oracle_invalid');
    if(['sensitive-text','sensitive-qr','sensitive-linear','explicit-regions'].includes(id)&&(!row.pixels.some(pixel=>JSON.stringify(pixel.rgb)==='[0,0,0]')||!row.pixels.some(pixel=>JSON.stringify(pixel.rgb)!=='[0,0,0]')))throw Error('qualification.mask_and_public_oracles_required');
    return{...row,bytes};
  });
}
function previewPixels(bytes) {
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('qualification.preview_png');
  let offset=8,width,height;const parts=[],chunks=[];
  while(offset<bytes.length){const length=bytes.readUInt32BE(offset),name=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);chunks.push(name);if(offset+12+length>bytes.length)throw Error('qualification.png_truncated');if(name==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);if(data[8]!==8||data[9]!==2||data[12]!==0)throw Error('qualification.png_format');}if(name==='IDAT')parts.push(data);offset+=length+12;}
  if(offset!==bytes.length||chunks.join(',')!=='IHDR,IDAT,IEND')throw Error('qualification.metadata_remains');
  const raw=zlib.inflateSync(Buffer.concat(parts));if(raw.length!==(width*3+1)*height)throw Error('qualification.png_length');
  for(let y=0;y<height;y++)if(raw[y*(width*3+1)]!==0)throw Error('qualification.png_filter');
  return{width,height,pixel:(x,y)=>[...raw.subarray(y*(width*3+1)+1+x*3,y*(width*3+1)+4+x*3)]};
}
function frontendState(record,sessionId,api) {
  const source=fs.readFileSync(path.join(WB,'app/public/js/protected-image-state.js'),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
  const state={config:{privacyModeV1:'enhanced'},currentSession:{id:sessionId},attachments:[record]};
  const bridge=vm.runInNewContext(source+';({prepareProtectedImages});',{state,api,apiRaw:()=>{throw Error('unexpected preview');},t:key=>key,AbortController,crypto:crypto.webcrypto,TextEncoder,DataView,URL,Date});
  return{state,prepare:()=>bridge.prepareProtectedImages(state.attachments,sessionId)};
}
async function scenario(root,fake,{profile,fixtures}) {
  const home=path.join(root,profile),data=path.join(home,'data'),work=path.join(home,'workspace');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(work);
  const env=releaseEnvironment(home,data);for(const key of Object.keys(env))if(/^RUYI_MEDIA_/i.test(key))delete env[key];
  Object.assign(env,{RUYI_MEDIA_RESOURCE_PROFILE:profile,RUYI_MEDIA_RUNTIME_ROOT:fixtures?process.env.RUYI_MEDIA_RUNTIME_ROOT:path.join(home,'missing-runtime'),RUYI_MEDIA_SOURCES_ROOT:fixtures?process.env.RUYI_MEDIA_SOURCES_ROOT:path.join(home,'missing-sources'),RUYI_MEDIA_OCR_LANGUAGE:fixtures?process.env.RUYI_MEDIA_OCR_LANGUAGE:'en-US'});
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({configSchema:8,privacyModeV1:'off',privacyTechnicalV1:false,privacyRulesV1:[],credentialEncryptionV1:true,workDataEncryptionV1:false,defaultWorkspace:work,workspaces:[{path:work,read:true,write:true,execute:false}],permissionMode:'acceptEdits',includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,externalMcpServers:[],desktopMcp:{enabled:false,autodetect:false},allowDesktopTools:false,stewardEnabledV1:false,stewardThreadBriefV1:false,schedulerEnabledV1:false,contextAutoCompactEnabled:false,bridgeExternalToolsToProvider:false,importAgentInstructions:false,activeProvider:'fake',providers:[{id:'fake',type:'openai-compat',baseUrl:fake.url,apiKey:'',model:'fake-model',vision:true}]}));
  const port=await getFreePort();let child,closePromise,spawnError,closed=false,exited=false,exitCode,spawned=false;
  const awaitClosed=async()=>{let timer;try{await Promise.race([closePromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('qualification.close_deadline')),5000);})]);}finally{clearTimeout(timer);}};
  try {
    child=cp.spawn(process.execPath,['app/server.js','serve','--port',String(port)],{cwd:WB,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    closePromise=new Promise(resolve=>child.once('close',code=>{closed=true;resolve(code);}));
    child.once('spawn',()=>{spawned=true;});child.once('exit',code=>{exited=true;exitCode=code;});child.stdout.resume();child.stderr.resume();child.once('error',error=>{spawnError=error;});
    const deadline=Date.now()+45000;let health;
    while(Date.now()<deadline&&!closed){try{health=await request(port,'/health',{timeout:800});if(health.status===200)break;}catch{}await sleep(100);}
    if(health?.status!==200)throw spawnError||Error('qualification.server_health');
    const bootstrap=await request(port,'/api/bootstrap',{method:'POST',body:{}}),token=bootstrap.json?.token;if(!token)throw Error('qualification.bootstrap');
    const api=async(route,body,method='POST')=>request(port,route,{method,body,token,timeout:70000});
    const newSession=async title=>{const created=await api('/api/sessions',{title,cwd:work,engineRoute:{engine:'openai',providerId:'fake',model:'fake-model'}}),id=created.json?.session?.id;if(!id)throw Error('qualification.session');return id;};
    const offSessionId=await newSession('Public media OFF compatibility');
    const upload=async(bytes,name)=>{const result=await api('/api/upload',{name,data:bytes.toString('base64')});if(!result.json?.file)throw Error('qualification.upload');return result.json.file;};
    const original=await upload(PNG,'ordinary.png'),offBefore=fake.requests.length;
    const originalRead=await request(port,'/api/upload/content?id='+encodeURIComponent(original.id)+'&name='+encodeURIComponent(original.name),{token});
    ok(originalRead.status===200&&originalRead.bytes.equals(PNG),profile+': OFF HTTP preserves original upload bytes');
    await api('/api/chat/stream',{sessionId:offSessionId,message:'Describe the public fixture.',cwd:work,attachments:[original]});
    ok(fake.requests.slice(offBefore).some(row=>row.raw.includes(PNG.toString('base64'))),profile+': OFF ordinary image reaches the local provider');
    const settings=await api('/api/privacy/settings',{mode:'enhanced',technical:false,rules:[]});if(settings.json?.ok!==true)throw Error(settings.json?.error?.code||'qualification.settings');
    if(!fixtures){
      const sessionId=await newSession('Public media ON resource refusal');
      const before=fake.requests.length,refusal=await api('/api/media/images/prepare',{sessionId,id:original.id,name:original.name});
      const expected=profile===ID?'privacy.image_processor_resource_profile_pending':'privacy.image_processor_dependency_failed';
      ok(refusal.status===409&&refusal.json?.error?.code===expected,profile+': ON prepare returns the exact typed resource refusal');
      const front=frontendState(original,sessionId,async(route,options)=>{const result=await api(route,JSON.parse(options.body),options.method);if(result.status>=400)throw Object.assign(Error(result.json?.error?.code),{code:result.json?.error?.code});return result.json;});
      let rejected=false;try{await front.prepare();}catch(error){rejected=error.code===expected;}
      ok(rejected&&front.state.attachments[0]===original&&original.protectedImage===undefined&&original.previewUrl===undefined&&original.imageReviewRequired===true,profile+': real frontend prepare failure retains the attachment draft without send authority');
      await api('/api/chat/stream',{sessionId,message:'This protected send must refuse.',cwd:work,attachments:[original]});
      ok(fake.requests.length===before,profile+': failed protected preparation and raw send produce zero model POSTs');
      const unchanged=await request(port,'/api/upload/content?id='+encodeURIComponent(original.id)+'&name='+encodeURIComponent(original.name),{token});ok(unchanged.bytes.equals(PNG),profile+': ON refusal preserves the original file');
    }else{
      for(const fixture of fixtures){
        const sessionId=await newSession('Public media ON '+fixture.id);
        const record=await upload(fixture.bytes,fixture.id+'.'+(fixture.extension||'png')),before=fake.requests.length;
        let prepared=await api('/api/media/images/prepare',{sessionId,id:record.id,name:record.name});
        if(fixture.expected==='refusal'){ok(prepared.status===409&&prepared.json?.error?.code===fixture.code,fixture.id+': actual worker has the exact refusal');ok(fake.requests.length===before,fixture.id+': refusal has zero model POSTs');continue;}
        if(prepared.status!==200||!prepared.json?.manifest)throw Error('qualification.actual_prepare_'+fixture.id+':'+prepared.json?.error?.code);
        if(fixture.id==='explicit-regions'){
          const m=prepared.json.manifest;if(!Array.isArray(fixture.boxes)||!fixture.boxes.length)throw Error('qualification.region_oracle_missing');
          prepared=await api('/api/media/images/prepare',{sessionId,id:record.id,name:record.name,regions:{space:'canonical-pixels-v1',sourceHash:m.sourceHash,sourceRevision:m.sourceRevision,width:m.width,height:m.height,transformHash:m.transformHash,boxes:fixture.boxes}});
          if(prepared.status!==200)throw Error('qualification.actual_regions');
        }
        const issued=prepared.json,preview=await request(port,'/api/media/images/'+issued.id+'/preview?sessionId='+sessionId,{token}),pixels=previewPixels(preview.bytes);
        ok(preview.status===200&&sha(preview.bytes)===issued.manifest.payloadHash&&preview.headers.get('x-ruyi-payload-sha256')===issued.manifest.payloadHash,fixture.id+': preview is the actual protected PNG');
        ok(pixels.width===fixture.width&&pixels.height===fixture.height&&fixture.pixels.every(point=>Number.isSafeInteger(point.x)&&Number.isSafeInteger(point.y)&&point.x>=0&&point.y>=0&&point.x<pixels.width&&point.y<pixels.height&&JSON.stringify(pixels.pixel(point.x,point.y))===JSON.stringify(point.rgb)),fixture.id+': independent fixture pixels verify masks and retained public content');
        const mark=fake.requests.length;
        await api('/api/chat/stream',{sessionId,message:'Describe the protected public fixture.',cwd:work,attachments:[{...record,protectedImage:{reference:issued.reference}}]});
        const sent=fake.requests.slice(mark).flatMap(row=>[...row.raw.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(match=>Buffer.from(match[1],'base64')));
        ok(sent.length===1&&sha(sent[0])===sha(preview.bytes),fixture.id+': final model PNG equals the preview');
        const originalAfter=await request(port,'/api/upload/content?id='+encodeURIComponent(record.id)+'&name='+encodeURIComponent(record.name),{token});ok(sha(originalAfter.bytes)===fixture.sha256,fixture.id+': processing leaves the original bytes intact');
        const removed=await api('/api/media/images/'+issued.id,undefined,'DELETE');ok(removed.json?.ok===true,fixture.id+': explicit removal succeeds');
      }
    }
    // This fixture owns only the server it created. The shared helper verifies
    // descendants; actual close is awaited separately from the kill request.
    if(!exited&&!closed){const cleanup=killOwnTree(child);if(cleanup.skipped)throw Error('qualification.cleanup_unknown:'+cleanup.skipped);}
    await awaitClosed();
    ok(spawned&&exited&&closed&&exitCode!==undefined,profile+': owned server has actual spawn, exit and close');
  }finally{
    if(child&&!closed){if(!exited){const cleanup=killOwnTree(child);if(cleanup.skipped)throw Error('qualification.cleanup_unknown:'+cleanup.skipped);}await awaitClosed();}
  }
}
(async()=>{
  let fake,root;
  try{
    if(process.argv.slice(2).some(arg=>arg!=='--full-components'))throw Error('qualification.unknown_argument');
    if(process.platform!=='win32')throw Error('qualification.windows_dpapi_required');
    const fixtures=full?fullInputs():undefined;
    if(full){
      const profile=process.env.RUYI_MEDIA_RESOURCE_PROFILE||'legacy-full-4987-v1';
      if(profile!=='legacy-full-4987-v1'){
        const adapter=require('../ruyi-workbench/tools/verify-media-profile.cjs'),descriptor=JSON.parse(fs.readFileSync(path.join(WB,'resources/media-profiles',ID+'.json')));
        adapter.assertMediaProfileExecutable(adapter.captureMediaProfile({profileId:profile,workerHash:descriptor.worker.sha256,language:process.env.RUYI_MEDIA_OCR_LANGUAGE}));
      }else await require('../ruyi-workbench/tools/verify-media-artifacts.cjs').verifyMediaArtifacts(process.env.RUYI_MEDIA_RUNTIME_ROOT,process.env.RUYI_MEDIA_SOURCES_ROOT);
    }
    root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-media-profile-http-'));fake=await startFakeProvider({handler:()=>textFrames('Public fixture received.')});
    for(const profile of full?[process.env.RUYI_MEDIA_RESOURCE_PROFILE||'legacy-full-4987-v1']:['legacy-full-4987-v1',ID])await scenario(root,fake,{profile,fixtures});
  }catch(error){t.fail(error.stack||String(error));}
  finally{if(fake)await fake.close();if(root)console.log('Media HTTP evidence retained at '+root);t.done({exit:true});}
})();
