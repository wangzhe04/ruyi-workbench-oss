const {api}=await import('/js/net.js');
const invoke=async(name,args={})=>{
  const reply=await api('/api/tools/tool_invoke_exec',{method:'POST',body:JSON.stringify({name:'ai_computer_control__'+name,arguments:args})});
  return reply.result;
};
let diag=await invoke('diagnostics');
const directoryDeadline=Date.now()+15000;
while(!diag.ok && diag.code==='unknown-tool' && Date.now()<directoryDeadline){
  await new Promise(resolve=>setTimeout(resolve,100));
  diag=await invoke('diagnostics');
}
const capabilities=diag.capabilities?.['desktop.capture'];
if(!capabilities || (false ? !capabilities.axReady : !capabilities.inputReady)) return {capabilities,diagOK:diag.ok,diag,unavailable:true};
if(false&&!diag.capabilities?.['desktop.recording']?.manualReady) return {capabilities,manualCapabilities:diag.capabilities?.['desktop.recording'],unavailable:true};
const warm=false?await invoke('ocr_image',{path:"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/ocr-image.png"}):null;
const listed=await invoke('list_windows');
const row=listed.windows?.find(window=>window.pid===91472&&window.handle===9663);
if(!row) return {capabilities,error:'owned_window_missing'};
const focused=await invoke('focus_window',{target:row.target});
if(false && focused.ok){
  const markers={"prepare":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-prepare.json","prepared":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-prepared.json","ready":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-ready.json","done":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-done.json","collected":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-collected.json","cleared":"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-input-host-lkLdfO/manual-cleared.json"};
  const mark=async(name)=>{
    const value=await invoke('write_file',{path:markers[name],content:'ready'});
    if(!value.ok) throw new Error('Manual App marker write failed '+name);
  };
  const waitMarker=async(name)=>{
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if((await invoke('read_file',{path:markers[name]})).ok) return;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw new Error('Manual App marker timed out '+name);
  };
  await mark('prepare');
  await waitMarker('prepared');
  const started=await invoke('record_start',{target:row.target,source:'native_window_events',max_seconds:30,pointer_profile:"exact"});
  if(!started.ok) return {capabilities,focused,manual:{capabilities:diag.capabilities?.['desktop.recording'],started}};
  await mark('ready');
  await waitMarker('done');
  const collected=await invoke('record_stop',{save_as:'App手动示范宏'});
  await mark('collected');
  await waitMarker('cleared');
  const current=await invoke('get_active_window');
  const replayed=collected.complete&&current.ok?await invoke('macro_run',{recording:collected.recording,target:current.window.target}):null;
  const listed=await invoke('macro_list');
  const audit=await invoke('audit_tail',{n:100});
  return {capabilities,focused,manual:{capabilities:diag.capabilities?.['desktop.recording'],started,collected,replayed,listed,audit}};
}
if(false && focused.ok){
  const observed=await invoke('observe',{target:row.target,max_width:400});
  const b={};
  const region="";
  const acted=await invoke('act_and_verify',{target:row.target,action:{type:'click',x:b.x+b.width/2,y:b.y+b.height/2},region,settle_ms:200,return_image:'diff'});
  const replayed=await invoke('macro_run',{delay_ms:0,steps:[
    {tool:'observe',args:{target:row.target,max_width:300,include_uia:false}},
    {tool:'wait',args:{seconds:.02}},
    {tool:'ocr_find_text',args:{target:row.target,text:'COUNTS 0 0 1'}}
  ]});
  return {capabilities,focused,composed:{warm,observed,acted,replayed}};
}
if(false && focused.ok){
  const found=await invoke('ocr_find_text',{text:'中文保存',target:row.target});
  const chinese=await invoke('ocr_click',{text:'中文保存',target:row.target});
  const b={};
  const shot=await invoke('screenshot_region',{x:Math.round(b.x+b.width/2-80),y:Math.round(b.y+b.height/2-16),width:160,height:32,max_width:0});
  const templates=shot.ok?await invoke('find_all_templates',{template_b64:shot.image,confidence:.99,region:[row.x,row.y,row.width,row.height].join(',')}):null;
  const templateClick=templates?.ok?await invoke('vision_click',{template_b64:shot.image,threshold:.99,multiscale:false,target:row.target,nth:1}):null;
  return {capabilities,focused,visual:{warm,found,chinese,templates,templateClick}};
}
const recordStarted=false&&focused.ok?await invoke('record_start',{target:row.target,max_seconds:30}):null;
if(false&&recordStarted?.ok){
  await invoke('mouse_click',{target:row.target,...{"x":560,"y":497}});
  await invoke('hotkey',{target:row.target,keys:['cmd','a']});
}
const typed=!false&&focused.ok?await invoke('type_text',{text:"如意 App 输入链 中文😀",target:row.target,use_clipboard:false,interval:0}):null;
let ax=null;
if(false && focused.ok){
  const found=await invoke('ui_find',{target:row.target,control_type:'AXTextArea',max_results:2});
  const element=found.count===1?found.matches[0]:null;
  const written=element?await invoke('ui_invoke',{target:row.target,element_ref:element.element_ref,action:'set_value',text:'App AX fixture baseline'}):null;
  const restored=written?.ok?await invoke('ui_invoke',{target:row.target,element_ref:element.element_ref,action:'set_value',text:"如意 App 输入链 中文😀"}):null;
  ax={foundCount:found.count,element,written,restored};
}
const clicked=typed?.ok?await invoke('mouse_click',{...{"x":560,"y":742},target:row.target}):null;
const scrolled=clicked?.ok?await invoke('mouse_scroll',{...{"x":560,"y":742},target:row.target,clicks:-2}):null;
const collected=false&&recordStarted?.ok?await invoke('record_stop',{save_as:'App受控宏'}):null;
const current=false&&collected?.complete?await invoke('get_active_window'):null;
const replayed=current?.ok?await invoke('macro_run',{recording:collected.recording,target:current.window.target}):null;
return {capabilities,focused,typed,clicked,scrolled,ax,recording:false?{started:recordStarted,collected,replayed}:null};