const {api}=await import('/js/net.js');
const caps=await api('/api/capabilities');
const status=await api('/api/status');
const shot=await api('/api/tools/desktop_screenshot',{method:'POST',body:JSON.stringify({outputPath:"/private/tmp/ruyi-p6-closeout-final-79ido2bq/ruyi-p5-host-hWXyp8/capture.png"})});
const result=shot.result;
return {capture:caps.runtime?.capabilities?.['desktop.capture'],offered:status.tools.some(tool=>tool.name==='desktop_screenshot'),shot:{ok:result.ok,code:result.code,
width:result.width,height:result.height,scale:result.scale,scale_y:result.scale_y,coordinate_space:result.coordinate_space}};