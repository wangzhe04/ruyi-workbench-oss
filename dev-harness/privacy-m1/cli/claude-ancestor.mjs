// Diagnostic-only public runtime fixture. No directories are listed and no file
// contents are read. The application entrypoint is deliberately not continued.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const emit=value=>console.log(JSON.stringify({kind:'claude-fs-diagnostic',...value}));
emit({operation:'preload',runtime:typeof Bun==='object'?'Bun':'other',version:typeof Bun==='object'?Bun.version:null});
const cwd=process.cwd(),owned=process.env.RUYI_M1_OWNED_ROOT,projection=process.env.RUYI_M1_PROJECTION,paths=[];
let current=path.parse(cwd).root;paths.push({value:current,role:'volume-root',level:0});
for(const part of cwd.slice(current.length).split(/[\\/]/).filter(Boolean)){current=path.join(current,part);paths.push({value:current,role:current===cwd?'fixture-home':current===projection?'projection':current===owned?'owned-temp-root':'existing-ancestor',level:paths.length});}
paths.push({value:process.execPath,role:'program-entry',level:paths.length});
if(/^[A-Za-z]:\\/.test(cwd))paths.push({value:'\\\\?\\'+cwd,role:'extended-fixture-home',level:paths.length});
for(const target of paths)for(const [operation,call]of [['ancestor-stat',()=>fs.statSync(target.value)],['ancestor-lstat',()=>fs.lstatSync(target.value)],['ancestor-realpath',()=>fs.realpathSync(target.value)],['ancestor-realpath-native',()=>{if(typeof fs.realpathSync.native!=='function')throw Object.assign(new Error(),{code:'ENOSYS'});return fs.realpathSync.native(target.value);}]]){
  try{call();emit({operation,phase:'own-preflight',role:target.role,level:target.level,pathSha256:sha(target.value),ok:true,errorCode:null});}
  catch(error){emit({operation,phase:'own-preflight',role:target.role,level:target.level,pathSha256:sha(target.value),ok:false,errorCode:String(error.code||error.name||'unknown')});}
}
process.exit(0);
