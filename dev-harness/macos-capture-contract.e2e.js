'use strict';
require('./lib/self-isolate-home');
// P5-01 pure geometry and controlled native IPC failure paths. Never captures the desktop.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const {createRunner} = require('./lib/harness');
const {loadServerInternals} = require('./lib/server-internals');
const {fixtureChildEnv} = require('./lib/fixture-home');
const {buildMacAutomationHelper} = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS CAPTURE CONTRACT');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-p5-contract-'));
process.env.RUYI_HOME = path.join(root,'data');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg==';
const ready = {ok:true,protocolVersion:1,ready:true,authorization:'granted',locked:false,
  coordinate_space:'macos_global_points',monitors:[{index:0,x:0,y:0,width:1,height:1,scale:2,is_primary:true}]};
const frame = {ok:true,protocolVersion:1,png,width:2,height:2,coordinate_space:'macos_global_points',
  logical_bounds:{x:0,y:0,width:1,height:1}};
let client, runtime;
function fake(file,body) {
  fs.writeFileSync(file,'#!'+process.execPath+'\n'+
    'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const request=JSON.parse(input);'+body+'});\n',{mode:0o700});
}
function reply(file,result) { fake(file,'console.log('+JSON.stringify(JSON.stringify(result))+');'); }
(async()=>{
  try {
    if (process.platform!=='darwin') { console.log('SKIP native geometry/IPC needs macOS'); return; }
    const helper = buildMacAutomationHelper({output:path.join(root,'test-helper'),testing:true});
    const production = buildMacAutomationHelper({output:path.join(root,'production-helper')});
    const displays = [
      {index:0,id:1,x:0,y:0,width:100,height:80,scale:2,is_primary:true},
      {index:1,id:2,x:-120,y:-40,width:120,height:90,scale:1,is_primary:false},
    ];
    function plan(args) {
      const result = cp.spawnSync(helper,[],{input:JSON.stringify({version:1,op:'test_plan',displays,...args}),encoding:'utf8',timeout:3000});
      if (result.error) throw result.error;
      return JSON.parse(result.stdout);
    }
    let result = plan({monitor:'all'});
    t.ok(result.ok && result.bounds.x===-120 && result.bounds.y===-40 && result.bounds.width===220
      && result.bounds.height===120 && result.scale===2 && result.parts.length===2, 'production planner combines negative-origin mixed-scale displays');
    t.ok(result.parts[1].source.x===0 && result.parts[1].source.y===0 && result.parts[1].source.width===120,
      'secondary display crop uses local source coordinates');
    result = plan({monitor:1});
    t.ok(result.ok && result.scale===1 && result.bounds.x===-120 && result.parts.length===1,
      'non-Retina selected display retains one pixel per logical point');
    result = plan({region:[-130,-50,40,40]});
    t.ok(result.ok && result.clipped && result.bounds.x===-120 && result.bounds.y===-40
      && result.bounds.width===30 && result.bounds.height===30, 'negative-origin partial overflow clips using logical coordinates');
    result = plan({region:[-30,60,20,10]});
    t.ok(!result.ok && result.code==='region_outside_desktop', 'region inside bounding union but in a display gap fails');
    result = plan({region:[-9999,-9999,8,8]});
    t.ok(!result.ok && result.code==='region_outside_desktop', 'wholly off-desktop region fails before allocating pixels');
    result = plan({region:[0,0,0,8]});
    t.ok(!result.ok && result.code==='invalid_args', 'nonpositive region fails in production planner');
    const prod = cp.spawnSync(production,[],{input:JSON.stringify({version:1,op:'test_plan',displays}),encoding:'utf8',timeout:3000});
    t.ok(!JSON.parse(prod.stdout).ok, 'production binary excludes fixture-only protocol operations');
    for (const payload of [{version:true,op:'status'},{version:1,op:'status',unknown:true},null]) {
      const invalid = cp.spawnSync(production,[],{input:JSON.stringify(payload),encoding:'utf8',timeout:3000});
      t.ok(JSON.parse(invalid.stdout).code==='invalid_args', 'native protocol rejects malformed input before querying desktop');
    }
    const S = loadServerInternals(['MacDesktopAutomation','MacDesktopAutomationHooks','toolCall','defaultConfig',
      'buildOpenAiTools','McpStdioClient','ProcessRuntime','CONFIG_SCHEMA']);
    runtime = S.ProcessRuntime;
    const fakeHelper = path.join(root,'fake-helper');
    S.MacDesktopAutomationHooks.helperPath=()=>fakeHelper;
    const config = {...S.defaultConfig(),permissionMode:'bypass',allowDesktopTools:true,
      defaultWorkspace:root,workspaces:[{path:root}],desktopMcp:{enabled:false,autodetect:false}};
    reply(fakeHelper,ready);
    const state = await S.MacDesktopAutomation.capabilitySnapshot();
    t.ok(state.ready && state.authorization==='granted', 'valid native status is independently ready');
    t.ok(S.buildOpenAiTools(config,{runtime:{capabilities:{'desktop.capture':state}}}).some(tool=>tool.function.name==='desktop_screenshot'),
      'Provider discovery uses the capture capability snapshot');
    for (const response of [{...ready,ready:false,authorization:'denied'},{...ready,ready:false,locked:true},
      {...ready,ready:true,monitors:[]}]) {
      reply(fakeHelper,response);
      t.ok(!(await S.MacDesktopAutomation.capabilitySnapshot()).ready, 'permission denial and locked sessions retract readiness');
    }
    reply(fakeHelper,frame);
    const outputPath = path.join(root,'native.png');
    const sidecar = outputPath+'.vision.jpg';
    fs.writeFileSync(sidecar,'existing unrelated sidecar');
    result = await S.toolCall('desktop_screenshot',{outputPath},{config,session:{cwd:root}});
    t.ok(result.ok && result.image_base64===png && result.scale===2 && result.scale_y===2
      && fs.readFileSync(sidecar,'utf8')==='existing unrelated sidecar', 'Mac screenshot embeds its own PNG and preserves unrelated sidecar files');
    reply(fakeHelper,{...frame,logical_bounds:{x:0,y:0,width:0,height:1}});
    result = await S.toolCall('desktop_screenshot',{outputPath:path.join(root,'invalid.png')},{config,session:{cwd:root}});
    t.ok(!result.ok && result.code==='capture_failed' && !fs.existsSync(path.join(root,'invalid.png')), 'invalid native geometry cannot produce a file or claimed success');
    fake(fakeHelper,'setTimeout(()=>console.log('+JSON.stringify(JSON.stringify(frame))+'),1000);');
    const timed = await S.toolCall('desktop_screenshot',{outputPath:path.join(root,'timeout.png'),timeoutMs:25},{config,session:{cwd:root}});
    t.ok(!timed.ok && timed.code==='capture_timeout' && !fs.existsSync(path.join(root,'timeout.png')), 'normal screenshot entry point honours its timeout before writing');
    const abort = new AbortController();
    const pending = S.toolCall('desktop_screenshot',{outputPath:path.join(root,'aborted.png')},{config,session:{cwd:root},signal:abort.signal});
    setTimeout(()=>abort.abort(),30);
    result = await pending;
    t.ok(!result.ok && result.code==='aborted' && !fs.existsSync(path.join(root,'aborted.png')), 'normal screenshot cancellation reaps its leaf before returning');
    fake(fakeHelper,'process.stdout.write("x".repeat(65537));');
    result = await S.MacDesktopAutomation.request({op:'status'});
    t.ok(!result.ok && result.code==='capture_capacity', 'oversized native status output is bounded');
    reply(fakeHelper,null);
    t.ok((await S.MacDesktopAutomation.request({op:'status'})).code==='capture_failed', 'malformed native envelope fails closed');
    fs.unlinkSync(fakeHelper);
    t.ok(!(await S.MacDesktopAutomation.capabilitySnapshot()).ready, 'removing native helper retracts capture readiness');
    const childData=path.join(root,'child-data'); fs.mkdirSync(childData);
    fs.writeFileSync(path.join(childData,'config.json'),JSON.stringify({...config,configSchema:S.CONFIG_SCHEMA,
      schedulerEnabledV1:false,stewardEnabledV1:false,includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,
      enableMcpDropIn:false,externalMcpServers:[],providers:[]}));
    reply(fakeHelper,ready);
    client = new S.McpStdioClient({id:'fixture',command:process.execPath,
      args:[path.resolve(__dirname,'../ruyi-workbench/app/server.js'),'mcp'],
      env:{...fixtureChildEnv(),RUYI_HOME:childData,WIN_CLAUDE_WORKBENCH_HOME:childData,RUYI_MACOS_AUTOMATION_HELPER:fakeHelper}});
    await client.start();
    t.ok(client.listTools().some(tool=>tool.name==='desktop_screenshot'), 'real native MCP tools/list advertises ready capture');
    reply(fakeHelper,{...ready,ready:false,authorization:'denied'});
    t.ok(!(await client.refreshTools(5000)).some(tool=>tool.name==='desktop_screenshot'), 'same MCP process refresh retracts capture after permission loss');
    const stale = await client.callTool('tool_invoke_exec',{name:'desktop_screenshot',arguments:{}},5000);
    t.ok(!stale.ok && stale.code==='permission_denied', 'stale native MCP invocation reports permission loss');
    reply(fakeHelper,ready);
    t.ok((await client.refreshTools(5000)).some(tool=>tool.name==='desktop_screenshot'), 'permission recovery restores native MCP discovery without restart');
    fs.unlinkSync(fakeHelper);
    t.ok(!(await client.refreshTools(5000)).some(tool=>tool.name==='desktop_screenshot'), 'same MCP process refresh detects missing capture helper');
    let child=client.child;client.kill();
    await runtime.waitForCleanup(child,3000);
    const repo=path.resolve(__dirname,'../mcp/ai-computer-control');
    const python=process.env.RUYI_ACC_PYTHON || path.join(repo,'.venv/bin/python');
    const pythonEnv={...fixtureChildEnv(),PYTHONPATH:path.join(repo,'src'),WCW_DATA_DIR:path.join(root,'acc-data'),
      ACC_TOOLSETS:'desktop,vision',ACC_HIDE_TOOLS:'',RUYI_MACOS_AUTOMATION_HELPER:fakeHelper};
    const readyBody='console.log(JSON.stringify(request.op==="status"?'+JSON.stringify(ready)+':'+JSON.stringify(frame)+'));';
    fake(fakeHelper,readyBody);
    client=new S.McpStdioClient({id:'ai-computer-control',command:python,args:['-X','utf8','-m','ai_computer_control.server'],cwd:repo,env:pythonEnv});
    await client.start();
    t.ok(client.listTools().some(tool=>tool.name==='screenshot'),'real Python MCP lists ready capture tools');
    fake(fakeHelper,'console.log(JSON.stringify(request.op==="status"?'+JSON.stringify({...ready,ready:false,authorization:'denied'})+
      ':{ok:false,code:"permission_denied",error:"injected denied permission"}));');
    t.ok(!(await client.refreshTools(5000)).some(tool=>tool.name==='screenshot'),'Python MCP refresh retracts tools after permission loss');
    const denied=await client.callTool('screenshot',{},5000);
    t.ok(!denied.ok && denied.code==='permission_denied','stale Python MCP screenshot reports permission loss');
    fake(fakeHelper,readyBody);
    t.ok((await client.refreshTools(5000)).some(tool=>tool.name==='screenshot'),'Python MCP refresh recovers after permission restoration');
    fs.unlinkSync(fakeHelper);
    t.ok(!(await client.refreshTools(5000)).some(tool=>tool.name==='screenshot'),'Python MCP refresh retracts tools after helper removal');
    const noHelper=await client.callTool('screenshot',{},5000);
    t.ok(!noHelper.ok && noHelper.code==='dependency_missing','stale Python MCP screenshot reports helper removal');
    child=client.child;client.kill();await runtime.waitForCleanup(child,3000);
    fake(fakeHelper,readyBody);
    client=new S.McpStdioClient({id:'ai-computer-control',command:python,args:['-X','utf8','-m','ai_computer_control.server'],cwd:repo,
      env:{...pythonEnv,ACC_HIDE_TOOLS:'screenshot,screenshot_region,window_screenshot'}});
    await client.start();
    t.ok(!client.listTools().some(tool=>['screenshot','screenshot_region','window_screenshot'].includes(tool.name)),
      'ACC_HIDE_TOOLS removes Mac capture tools from the actual registry');
    t.ok(!(await client.callTool('screenshot',{},5000)).ok,'hidden Mac capture tool cannot be reached by direct call');
  } catch(error) { t.fail(error.stack || String(error)); }
  finally {
    if (client?.child) {
      const child=client.child;client.kill();
      const clean=await runtime.waitForCleanup(child,3000);
      t.ok(clean && !clean.incomplete,'native supervisor confirms MCP subtree cleanup');
      const deadline=Date.now()+5000;
      while(child.exitCode===null && child.signalCode===null && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
      t.ok(child.exitCode!==null || child.signalCode!==null, 'owned MCP process is reaped');
    }
    fs.rmSync(root,{recursive:true,force:true});t.done();
  }
})();
